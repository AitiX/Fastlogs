/// @description FastLogs controller - Async HTTP (eventType 7 / eventNum 62)
// Разбор ответа ингеста. Сверяем async_load[? "id"] с http-состоянием (request_id);
//   при status<=0 (финал) читаем http_status: 2xx (контракт - 201) = успех -> json_parse(result)
//   -> {id,url} -> заполняем last_url, копируем ссылку. Ошибки -> ретрай (сеть/5xx) или Error.
// Состояние http в global.__fastlogs.http (см. scr_fastlogs_http: fastlogs_http_get_state()).
// Сверено (GM-NOTES 2.1 + WebSearch июнь 2026):
//   async_load["status"]: 1 = качается, 0 = готово, <0 = ошибка;
//   async_load["id"], ["http_status"], ["result"](string), ["response_headers"](ds_map).
if (!FASTLOGS_ENABLED) { exit; }

var hs = fastlogs_http_get_state();   // http-подсостояние

// Это событие приходит на ВСЕ http-запросы игры. Реагируем только на свой.
var ev_id = async_load[? "id"];
if (is_undefined(ev_id)) { exit; }
if (ev_id != hs.request_id) { exit; }       // не наш запрос

var status      = async_load[? "status"];
var http_status = async_load[? "http_status"];
var result      = async_load[? "result"];

// status == 1 -> данные ещё качаются (прогресс). Ждём финала (0) или ошибки (<0).
if (is_real(status) && status == 1) { exit; }

// --- ФИНАЛ запроса (status <= 0) ---
hs.is_sending  = false;
hs.request_id  = -1;
hs.last_status = is_real(http_status) ? http_status : 0;

// Успешный ingest по контракту -> 201 Created (принимаем любой 2xx).
var ok       = is_real(http_status) && (http_status >= 200 && http_status < 300);
// status < 0 -> сетевая ошибка/обрыв (http_status может быть 0).
var net_error = is_real(status) && (status < 0);

// =====================================================================================
// ОТПРАВКА ФАЙЛА/ПАПКИ (фича SEND-FILE): СВОЯ короткая ветка для request_kind=="file".
//   Сервер POST /api/files отвечает 201 { id, url, downloadUrl, expiresAt }. Без retry-until-
//   success / дренажа outbox / poison-pill - это логика ТОЛЬКО для лог-отчётов. Тут: разобрать
//   ответ, дёрнуть file_on_done(result), показать тост (Готово+ссылка / Ошибка). Никаких
//   немедленных ретраев (файл тяжёлый; повтор - явным повторным вызовом из кода интегратора).
// =====================================================================================
if (hs.request_kind == "file") {
    hs.request_kind = "";   // сбрасываем тип in-flight запроса

    var f_cb = hs.file_on_done;
    hs.file_on_done = undefined;

    var f_id   = "";
    var f_url  = "";
    var f_durl = "";
    if (ok && !net_error && is_string(result) && string_length(result) > 0) {
        var fp = undefined;
        try { fp = json_parse(result); } catch (_efp) { fp = undefined; }
        if (is_struct(fp)) {
            if (variable_struct_exists(fp, "id")          && is_string(fp.id))          { f_id   = fp.id; }
            if (variable_struct_exists(fp, "url")         && is_string(fp.url))         { f_url  = fp.url; }
            if (variable_struct_exists(fp, "downloadUrl") && is_string(fp.downloadUrl)) { f_durl = fp.downloadUrl; }
        }
    }

    if (ok && !net_error) {
        hs.state = "ok";
        // Короткая ссылка вьюера (url) - как у лог-отчёта; download отдельной кнопкой во вьюере.
        if (string_length(f_url) > 0) { hs.last_url = f_url; }
        show_debug_message("[FastLogs] file upload OK (" + string(http_status) + ") id=" + f_id + " url=" + f_url);

        // COPY-ON-SEND: авто-копируем короткую ссылку (best-effort, как у лог-отправки).
        var f_copied = false;
        if (FASTLOGS_COPY_ON_SEND && string_length(f_url) > 0
            && script_exists(asset_get_index("fastlogs_copy_url"))) {
            try { f_copied = fastlogs_copy_url(); } catch (_efc) { f_copied = false; }
        }
        if (script_exists(asset_get_index("fastlogs_status_toast"))) {
            if (string_length(f_url) > 0) {
                var f_text = f_copied ? "Файл отправлен (ссылка скопирована)" : "Файл отправлен";
                fastlogs_status_toast("ok", f_text, { url: f_url });
            } else {
                fastlogs_status_toast("ok", "Файл отправлен");
            }
        }
    } else {
        hs.state = "error";
        show_debug_message("[FastLogs] file upload FAILED status=" + string(status)
            + " http_status=" + string(http_status) + " result=" + string(result));
        if (script_exists(asset_get_index("fastlogs_status_toast"))) {
            var f_reason;
            if (net_error)                                    f_reason = "сеть недоступна";
            else if (is_real(http_status) && http_status > 0) f_reason = "HTTP " + string(http_status);
            else                                              f_reason = "неизвестно";
            fastlogs_status_toast("error", "Ошибка отправки файла: " + f_reason, { retry: false });
        }
    }

    // Колбэк интегратора/фасада (если задан) с готовым результатом.
    if (is_method(f_cb)) {
        try {
            f_cb({
                success     : (ok && !net_error),
                id          : f_id,
                url         : f_url,
                downloadUrl : f_durl,
                statusCode  : (is_real(http_status) ? http_status : 0),
                error       : (ok && !net_error) ? "" : (net_error ? "network" : ("http_" + string(http_status))),
            });
        } catch (_ecb) { /* колбэк не должен ронять обработчик */ }
    }
    exit;   // file-ветка завершена; лог-логика ниже не выполняется
}

if (ok && !net_error) {
    // RETRY-UNTIL-SUCCESS (фича RETRY): успех - финал. Гасим любой pending отложенный повтор
    //   и его alarm (этот успех мог прийти как раз от отложенной попытки). Существующий
    //   success-тост ниже уведомит тестера об итоговом успехе.
    if (script_exists(asset_get_index("fastlogs_retry_cancel"))) {
        fastlogs_retry_cancel();
    }

    // ПЕРСИСТ КРАШ-ОТЧЁТА (фича #1): если этот успешный отчёт пришёл из дисковой очереди
    //   pending - удалить его файл (доставлен). Путь привязан к запросу в hs.pending_file.
    //   Запоминаем путь только что доставленного файла, чтобы дренаж-цепочка ниже не
    //   попыталась переслать его повторно (и чтобы знать, что это была pending/дренаж-отправка).
    var just_sent_file = is_string(hs.pending_file) ? hs.pending_file : "";
    if (string_length(just_sent_file) > 0) {
        if (script_exists(asset_get_index("fastlogs_pending_delete"))) {
            fastlogs_pending_delete(just_sent_file);
        }
        hs.pending_file = "";
    }

    // Тело ответа: { "id", "url", "rawUrl", "expiresAt" }.
    var url = "";
    var log_id = "";
    if (is_string(result) && string_length(result) > 0) {
        // json_parse в struct-режиме (option_legacy_json_parsing=false).
        var parsed = undefined;
        try {
            parsed = json_parse(result);
        } catch (_e) {
            parsed = undefined;                 // тело не JSON -> деградируем мягко
        }
        if (is_struct(parsed)) {
            if (variable_struct_exists(parsed, "url") && is_string(parsed.url)) { url = parsed.url; }
            if (variable_struct_exists(parsed, "id")  && is_string(parsed.id))  { log_id = parsed.id; }
        }
    }

    hs.state = "ok";
    if (string_length(url) > 0) {
        hs.last_url = url;
        show_debug_message("[FastLogs] ingest OK (" + string(http_status) + ") id=" + log_id + " url=" + url);

        // COPY-ON-SEND: при включённом флаге авто-копируем короткую ссылку в буфер устройства.
        //   best-effort; clipboard-скрипт сам гейтит платформу (консоли -> no-op).
        //   На WebGL копирование требует user-gesture и тут может не сработать - НЕ падаем
        //   (исключение проглатываем), кнопка "Копировать" в оверлее остаётся как fallback.
        var copied = false;
        if (FASTLOGS_COPY_ON_SEND && script_exists(asset_get_index("fastlogs_copy_url"))) {
            try {
                copied = fastlogs_copy_url();
            } catch (_ce) {
                copied = false;                 // WebGL без жеста / платформенный отказ - не падаем
            }
        }
        // STATUS (B): тост "Готово" + ссылка поверх игры, даже без открытого оверлея.
        //   Ссылка уже авто-скопирована (copied) - в тосте даём её показ + клик для повторной копии.
        if (script_exists(asset_get_index("fastlogs_status_toast"))) {
            var ok_text = copied ? "Готово (ссылка скопирована)" : "Готово";
            fastlogs_status_toast("ok", ok_text, { url: url });
        }
        // Комментарий ушёл с отчётом -> очищаем поле, чтобы он не уходил повторно (фича COMMENT).
        if (script_exists(asset_get_index("fastlogs_comment_clear"))) {
            fastlogs_comment_clear();
        }
    } else {
        show_debug_message("[FastLogs] ingest OK (" + string(http_status) + ") but no url in response: " + string(result));
        // Успех, но сервер не вернул url - всё равно "Готово" (без ссылки).
        if (script_exists(asset_get_index("fastlogs_status_toast"))) {
            fastlogs_status_toast("ok", "Готово");
        }
    }

    // ПОЛНЫЙ СНИМОК (фича SNAPSHOT): если на эту отправку был навешен log_on_done (поставлен
    //   fastlogs_send_snapshot), зовём его ОДИН раз с готовым logId - он построит snapshot.zip и
    //   поставит его аплоад как вложение ИМЕННО к этой записи (kind="snapshot"). Делаем это ДО
    //   дренажа outbox: snapshot.zip займёт single-flight первым, дренаж подхватится следующим
    //   успехом. is_sending уже сброшен выше -> аплоад снимка может встать в очередь. Колбэк
    //   снимает сам себя (читаем в локаль и обнуляем в состоянии), чтобы не сработать повторно на
    //   чужой следующей отправке. best-effort: снимок не должен ронять Async-обработчик.
    var snap_cb = is_method(hs.log_on_done) ? hs.log_on_done : undefined;
    hs.log_on_done = undefined;
    if (is_method(snap_cb)) {
        try { snap_cb(log_id); } catch (_esnap) { /* колбэк снимка не должен ронять обработчик */ }
    }

    // ДРЕНАЖ OUTBOX "ПРИ ПЕРВОЙ ВОЗМОЖНОСТИ" (фича #1): отправка успешно завершилась и клиент
    //   теперь простаивает (is_sending уже сброшен выше). Если в outbox остались файлы (краши,
    //   захваченные во время занятости/троттла/сверх капа доставки) - дошлём СЛЕДУЮЩИЙ по одному,
    //   мягко. Это и есть цепочка: каждый успех тянет следующий файл, пока очередь не опустеет
    //   (раньше resend_all упирался в single-flight и слал лишь один за сессию). Не дублируем
    //   только что отправленный (передаём just_sent_file в exclude).
    //
    //   FIX-1 (idle-дренаж не должен глохнуть): PER_START-лимит (FASTLOGS_PENDING_RESEND_PER_START)
    //   применяем ТОЛЬКО к СТАРТ-цепочке (init_chain_active, запущенной fastlogs_pending_resend_all
    //   при init) - чтобы старт не молотил весь outbox за раз. ЖИВОЙ idle-дренаж (после обычной
    //   отправки/немедленного краша или ПОСЛЕ завершения старт-цепочки) этим лимитом НЕ гейтится:
    //   тянем следующий pending, пока outbox непуст. Раньше единый session-cumulative drain_count
    //   против PER_START(=5) НИКОГДА не сбрасывался и общий со стартом -> после 5 досылок за сессию
    //   idle-цепочка вставала до перезапуска (ослабляло «при первой возможности»). Объём всё равно
    //   ограничен FASTLOGS_PENDING_MAX/enforce_cap, поэтому idle-цепочка не может молотить бесконечно.
    var retry_pending = script_exists(asset_get_index("fastlogs_retry_is_pending"))
                      && fastlogs_retry_is_pending();
    if (!retry_pending) {   // не вмешиваемся, если запланирован отложенный повтор
        if (script_exists(asset_get_index("fastlogs_pending_drain_next"))) {
            if (hs.init_chain_active) {
                // СТАРТ-цепочка: соблюдаем PER_START. 0/отриц. -> без предела (тогда старт = idle).
                var per = FASTLOGS_PENDING_RESEND_PER_START;
                var unlimited = (!is_real(per) || per <= 0);
                if (unlimited || hs.init_drain_count < per) {
                    if (fastlogs_pending_drain_next(just_sent_file)) {
                        hs.init_drain_count += 1;   // ещё один файл старт-бэкстопа
                    } else {
                        // Outbox пуст или слой занят -> старт-цепочка завершена. Снимаем флаг,
                        //   дальнейшие успехи пойдут как живой idle-дренаж (без PER_START).
                        hs.init_chain_active = false;
                    }
                } else {
                    // PER_START исчерпан за этот старт -> завершаем СТАРТ-цепочку (бэкстоп). Остаток
                    //   outbox доедет живым idle-дренажём (он не гейтится) или на следующем старте.
                    hs.init_chain_active = false;
                }
            } else {
                // ЖИВОЙ idle-дренаж: тянем следующий pending БЕЗ лимита, пока outbox непуст.
                //   single-flight внутри fastlogs_pending_send: если занято - вернёт false (подхватим позже).
                fastlogs_pending_drain_next(just_sent_file);
            }
        }
    }
} else {
    // Ошибка: 4xx/5xx или сетевой обрыв.
    show_debug_message("[FastLogs] ingest FAILED status=" + string(status) + " http_status=" + string(http_status) + " result=" + string(result));

    // Ретраим только сетевые ошибки и 5xx (4xx - проблема в теле, ретрай не поможет
    //   ни немедленно, ни отложенно -> такие сразу терминальный тост-ошибка).
    //   Транзиентным считаем: сеть/обрыв (net_error||status<=0) ИЛИ http_status>=500.
    var retryable = net_error || (is_real(http_status) && http_status >= 500) || (is_real(status) && status <= 0);

    // POISON-PILL (фича #1): если это была отправка pending-файла из дискового outbox
    //   (hs.pending_file задан) и ошибка ПОСТОЯННАЯ непереходящая (4xx: 400/401/403/413/415,
    //   т.е. !retryable) - файл вечно слать бессмысленно: УДАЛЯЕМ его из outbox (+лог), чтобы
    //   он не блокировал дренаж навсегда. Для ТРАНЗИЕНТНЫХ (сеть/0/5xx) файл ОСТАВЛЯЕМ -
    //   доедет на следующем старте/при простое. Делаем это ДО ретраев/планировщика, т.к. для
    //   4xx ретраи не ставятся (retryable=false) и это терминал для данного файла.
    if (!retryable && is_string(hs.pending_file) && string_length(hs.pending_file) > 0) {
        show_debug_message("[FastLogs] poison-pill: dropping pending file (permanent HTTP "
            + string(http_status) + "): " + hs.pending_file);
        if (script_exists(asset_get_index("fastlogs_pending_delete"))) {
            fastlogs_pending_delete(hs.pending_file);
        }
        hs.pending_file = "";   // отвязали: файла больше нет
    }

    // 1) Сначала - НЕМЕДЛЕННЫЕ ретраи аплоадера (мгновенные, до FASTLOGS_HTTP_MAX_RETRIES).
    var retried = false;
    if (retryable) {
        retried = fastlogs_http_retry();        // ставит новый запрос, переустанавливает is_sending
    }

    if (retried) {
        // Авто-ретрай (немедленный) поставлен - держим статус "Отправка..." (повтор N/2).
        if (script_exists(asset_get_index("fastlogs_status_toast"))) {
            fastlogs_status_toast("sending", "Отправка... (повтор)");
        }
    } else {
        // 2) Немедленные ретраи исчерпаны/неуместны. RETRY-UNTIL-SUCCESS (фича RETRY):
        //   для транзиентных ошибок (сеть/5xx) ставим ОТЛОЖЕННЫЙ повтор на таймере, пока
        //   не пройдёт успешно (или пока не упрёмся в предел FASTLOGS_RETRY_MAX). Один
        //   pending за раз обеспечивается самим планировщиком (заменяет тело/отсчёт).
        //   4xx сюда не попадает (retryable=false) -> сразу терминальный тост-ошибка.
        var scheduled = false;
        if (retryable && script_exists(asset_get_index("fastlogs_retry_schedule"))) {
            // Предел отложенных повторов: 0 = без предела; >0 = после стольких сдаёмся.
            var under_limit = (!is_real(FASTLOGS_RETRY_MAX) || FASTLOGS_RETRY_MAX <= 0)
                            || (hs.dretry_count < FASTLOGS_RETRY_MAX);
            if (under_limit) {
                scheduled = fastlogs_retry_schedule(hs.pending_body);
            }
        }

        if (scheduled) {
            // Отложенный повтор поставлен - НЕ ошибка для тестера: показываем отсчёт
            //   "Повтор через Ns..." (его поднимает сам fastlogs_retry_schedule).
            //   Дальнейший отсчёт ведёт Alarm[0] (fastlogs_retry_tick), без работы в кадре.
        } else {
            // Отложенный повтор выключен/неуместен/предел исчерпан - терминальная ошибка.
            //   Гасим любой остаточный pending, чтобы состояние было чистым.
            if (script_exists(asset_get_index("fastlogs_retry_cancel"))) {
                fastlogs_retry_cancel();
            }
            // ПОЛНЫЙ СНИМОК (фича SNAPSHOT): лог-отчёт окончательно не доставлен -> привязывать
            //   вложение не к чему. Снимаем отложенный хук снимка, чтобы он НЕ сработал на чужой
            //   следующей успешной отправке (на retryable-ошибках хук НЕ трогаем: тот же отчёт ещё
            //   будет повторён немедленно/отложенно и при успехе снимок прикрепится корректно).
            hs.log_on_done = undefined;
            hs.state = "error";
            // STATUS (B): тост "Ошибка: <причина>" + кликабельная зона "Повторить" поверх игры.
            if (script_exists(asset_get_index("fastlogs_status_toast"))) {
                var reason;
                if (net_error)                                  reason = "сеть недоступна";
                else if (is_real(http_status) && http_status > 0) reason = "HTTP " + string(http_status);
                else                                            reason = "неизвестно";
                fastlogs_status_toast("error", "Ошибка: " + reason, { retry: true });
            }
        }
    }
}
