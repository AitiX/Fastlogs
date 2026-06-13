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

if (ok && !net_error) {
    // RETRY-UNTIL-SUCCESS (фича RETRY): успех - финал. Гасим любой pending отложенный повтор
    //   и его alarm (этот успех мог прийти как раз от отложенной попытки). Существующий
    //   success-тост ниже уведомит тестера об итоговом успехе.
    if (script_exists(asset_get_index("fastlogs_retry_cancel"))) {
        fastlogs_retry_cancel();
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
} else {
    // Ошибка: 4xx/5xx или сетевой обрыв.
    show_debug_message("[FastLogs] ingest FAILED status=" + string(status) + " http_status=" + string(http_status) + " result=" + string(result));

    // Ретраим только сетевые ошибки и 5xx (4xx - проблема в теле, ретрай не поможет
    //   ни немедленно, ни отложенно -> такие сразу терминальный тост-ошибка).
    var retryable = net_error || (is_real(http_status) && http_status >= 500);

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
