/// @description scr_fastlogs_http
// FastLogs GameMaker client - HTTP (отправка payload на ингест-сервер).
// Назначение: fastlogs_send([opts]) собирает тело (payload-скрипт) и шлёт POST через
//   http_request с заголовками Content-Type + опц. Authorization Bearer; хранит request id
//   и состояние отправки; разбор ответа - в Async HTTP событии (Other_62.gml).
// Гейтинг: при !FASTLOGS_ENABLED все точки no-op (http_request НЕ вызывается).
//
// СОСТОЯНИЕ хранится в global.__fastlogs.http (консистентно с core/recorder/screenshot,
//   которые держат подсостояния в едином global.__fastlogs). Поля:
//     state         : "idle" | "sending" | "ok" | "error"
//     request_id    : real   - id текущего http_request (-1 если нет)
//     is_sending    : bool
//     last_url      : string - url последнего успешного лога ("" если нет)
//     last_status   : real   - последний http_status (0 если нет)
//     retry_count   : real   - сколько НЕМЕДЛЕННЫХ ретраев уже сделано для текущей отправки
//     pending_body  : string - тело текущего запроса (для ретрая)
//   RETRY-UNTIL-SUCCESS (отложенный повтор на alarm-таймере; фича RETRY):
//     dretry_active   : bool   - есть ли сейчас ОДНА (единственная) pending-отправка на повтор
//     dretry_body     : string - тело отчёта, который ждёт отложенного повтора
//     dretry_count    : real   - сколько отложенных повторов уже выполнено (для предела/счётчика)
//     dretry_seconds  : real   - сколько секунд осталось до следующей попытки (тик alarm раз/сек)
//   Один pending за раз: пока pending активен (или идёт отправка), новая ВНЕШНЯЯ
//     fastlogs_send БЛОКИРУЕТСЯ (no-op + статус), не отменяя pending (см. fastlogs_send).
//   Сам обратный отсчёт/перезапуск ведёт Alarm[0] контроллера (Other Alarm_0.gml), а не Step.
//
// ЗАВИСИМОСТИ (реальные имена - сверено по коду соседних скриптов):
//   __fastlogs_state()                  (core) - общий global-стейт
//   fastlogs_build_payload_json(opts)   (payload)
//   fastlogs_screenshot_request(cb)     (screenshot) - асинхронный захват кадра
//   FASTLOGS_* макросы                  (config)
//
// Сверено (GM-NOTES 2.1 + WebSearch июнь 2026): http_request(url, method, header_map /*ds_map
//   строк*/, body /*string*/) -> request id; заголовки key/value без двоеточия; карту можно
//   уничтожить сразу (GM копирует значения).

// Число ретраев по умолчанию (локальный макрос, чтобы не трогать config).
#macro FASTLOGS_HTTP_MAX_RETRIES 2

// =====================================================================================
// Внутреннее: лениво создать и вернуть подсостояние http внутри global.__fastlogs.
// =====================================================================================
function __fastlogs_http_state() {
    var st = __fastlogs_state();   // core
    if (!variable_struct_exists(st, "http") || !is_struct(st.http)) {
        st.http = {
            state        : "idle",
            request_id   : -1,
            is_sending   : false,
            last_url     : "",
            last_status  : 0,
            retry_count  : 0,
            pending_body : "",
            // RETRY-UNTIL-SUCCESS (отложенный повтор; фича RETRY).
            dretry_active  : false,
            dretry_body    : "",
            dretry_count   : 0,
            dretry_seconds : 0,
            // ПЕРСИСТ КРАШ-ОТЧЁТА (фича #1): путь pending-файла, привязанного к ТЕКУЩЕМУ
            //   in-flight запросу. На успехе Async-обработчик удалит этот файл из очереди.
            //   "" -> обычная отправка (не из очереди), удалять нечего.
            pending_file   : "",
            // ДРЕНАЖ OUTBOX (фича #1, "при первой возможности").
            //   FIX-1: PER_START-лимит (FASTLOGS_PENDING_RESEND_PER_START) применяется ТОЛЬКО к
            //   СТАРТ-бэкстопу (цепочке, инициированной fastlogs_pending_resend_all при init), чтобы
            //   не молотить весь outbox за один старт. ЖИВОЙ idle-дренаж (после обычной отправки/
            //   немедленного краша/по завершении старт-цепочки) этим счётчиком НЕ гейтится - тянет
            //   следующий pending, пока outbox непуст (объём ограничен FASTLOGS_PENDING_MAX/enforce_cap).
            init_chain_active : false,  // активна ли СТАРТ-цепочка дренажа (запущена resend_all)
            init_drain_count  : 0,      // сколько файлов дослано в рамках СТАРТ-цепочки (лимит PER_START)
        };
    }
    return st.http;
}

// =====================================================================================
// fastlogs_send([opts]) -> bool
// Собирает payload и ставит POST-запрос. true если запрос (или захват скриншота под него)
//   поставлен; false если no-op (выключено / нет endpoint / уже идёт отправка).
// opts (опц., struct): title, comment, retentionDays, screenshot, extraDevice (см. payload).
//   comment (string<=4000) - свободное описание проблемы тестером; уходит в поле comment.
//     opts целиком пробрасывается в payload (в т.ч. через сохранённый st.__http_pending_opts
//     на пути со скриншотом), так что comment доносится до тела автоматически.
// =====================================================================================
function fastlogs_send(opts = undefined) {
    if (!FASTLOGS_ENABLED) { return false; }

    // endpoint обязателен.
    if (!is_string(FASTLOGS_ENDPOINT) || string_length(FASTLOGS_ENDPOINT) == 0) {
        show_debug_message("[FastLogs] send skipped: FASTLOGS_ENDPOINT is empty");
        // Статус-подсказка игроку (фича QUICK-SEND/STATUS): не падаем, объясняем причину.
        fastlogs_send_status("error", "Ошибка: не задан endpoint", false);
        return false;
    }

    var hs = __fastlogs_http_state();

    // Запрет параллельной отправки (одна за раз).
    if (hs.is_sending) {
        show_debug_message("[FastLogs] send skipped: already sending");
        fastlogs_send_status("info", "Отправка уже идёт...", false);
        return false;
    }

    // RETRY-UNTIL-SUCCESS (фича RETRY): пока текущий отчёт не отправился успешно, новую
    //   ВНЕШНЮЮ отправку БЛОКИРУЕМ - включая окно ожидания между попытками отложенного
    //   повтора. Если сейчас ждёт pending-повтор (тикает по таймеру), не отменяем его и не
    //   стартуем новую отправку: показываем статус и выходим. ВНУТРЕННИЙ повтор идёт не
    //   через fastlogs_send (а через fastlogs_retry_tick -> fastlogs_http_post_internal),
    //   поэтому этот guard его не затрагивает и серия повторов продолжается.
    if (fastlogs_retry_is_pending()) {
        show_debug_message("[FastLogs] send skipped: retry pending (waiting to resend current report)");
        fastlogs_send_status("info", "Отправка уже идёт (ждём повтор)", false);
        return false;
    }

    if (!is_struct(opts)) { opts = {}; }

    // ПЕРФ (D): перед сбором payload сбросить батч записи на диск, чтобы файл/logText были
    //   согласованы (logText берётся из rec_text, но файл на диске тоже держим актуальным).
    if (script_exists(asset_get_index("fastlogs_recorder_flush"))) {
        try { fastlogs_recorder_flush(); } catch (_ef) { /* best-effort */ }
    }

    // STATUS (B): подняли "Отправка..." сразу - виден поверх игры даже без оверлея.
    fastlogs_send_status("sending", "Отправка...", false);

    // Нужен ли скриншот в этой отправке?
    //   приоритет: opts.screenshot (явный override) -> текущий тоггл состояния -> дефолт макроса.
    var st = __fastlogs_state();
    var want_shot = variable_struct_exists(st, "screenshot") ? bool(st.screenshot) : FASTLOGS_SCREENSHOT_DEFAULT;
    if (variable_struct_exists(opts, "screenshot")) { want_shot = bool(opts.screenshot); }

    // Помечаем занятость СРАЗУ, чтобы параллельный send отбился, пока идёт захват/запрос.
    hs.is_sending = true;
    hs.state      = "sending";
    hs.retry_count = 0;
    hs.pending_file = "";   // обычная отправка - не из pending-очереди (фича #1)

    if (want_shot) {
        // Асинхронный захват кадра (произойдёт в ближайшем Draw GUI End), затем отправка
        //   из колбэка. Колбэк получает готовый base64 (или "" при неудаче) - в любом случае
        //   собираем payload (payload сам подхватит fastlogs_screenshot_base64()).
        fastlogs_screenshot_request(function(_b64) {
            // На момент колбэка скриншот уже лежит в screenshot-состоянии - payload его прочтёт.
            fastlogs_http_dispatch(undefined);
        });
        // opts нужно донести до колбэка - сохраним их в состоянии (колбэк-функция выше
        //   замыкается на глоб. состояние, а не на локальные opts).
        st.__http_pending_opts = opts;
        return true;
    }

    // Без скриншота - собираем и шлём немедленно.
    return fastlogs_http_dispatch(opts);
}

// =====================================================================================
// fastlogs_quick_send([opts]) -> bool  (фича QUICK-SEND, A)
// Быстрая отправка ТЕКУЩЕЙ записи БЕЗ открытия оверлея (fire-and-forget): вызывается из
//   хоткея/жеста быстрой отправки или напрямую из кода интегратора. Тонкая обёртка над
//   fastlogs_send: добавляет дружелюбный статус-тост и НЕ требует UI.
// Поведение по краю (контракт A): если нет ни одной записи лога - не отправляем пустоту,
//   показываем статус-подсказку и не падаем. Запись (recording) для отправки НЕ обязательна:
//   logText берётся из кольца в памяти даже когда персист-запись выключена.
// Возврат: true если отправка/захват поставлены; false если no-op (пусто/нет endpoint/занято).
// =====================================================================================
function fastlogs_quick_send(opts = undefined) {
    if (!FASTLOGS_ENABLED) { return false; }
    if (!is_struct(opts)) { opts = {}; }

    // Нет логов вообще -> нечего слать. Подсказка вместо пустого отчёта (не падаем).
    var have_logs = false;
    if (script_exists(asset_get_index("fastlogs_get_counts"))) {
        var c = fastlogs_get_counts();
        if (is_struct(c)) {
            var e = variable_struct_exists(c, "error") ? c.error : 0;
            var w = variable_struct_exists(c, "warn")  ? c.warn  : 0;
            var l = variable_struct_exists(c, "log")   ? c.log   : 0;
            have_logs = (e + w + l) > 0;
        }
    }
    if (!have_logs) {
        fastlogs_send_status("info", "Нет логов для отправки", false);
        return false;
    }

    // Тег быстрой отправки в title (если интегратор не задал свой) - помогает различать в каталоге.
    if (!variable_struct_exists(opts, "title")) { opts.title = "Quick send"; }
    return fastlogs_send(opts);
}

// =====================================================================================
// fastlogs_pending_send(body_json, file_path) -> bool  (фича #1: досыл pending-краша)
// Отправить УЖЕ ГОТОВОЕ JSON-тело отчёта из дисковой очереди (recorder.pending). На успехе
//   Async-обработчик (Other_62) удалит file_path из очереди (по hs.pending_file). НЕ строит
//   payload заново (тело уже несёт timestampUtc/logText/counts/comment/tester/context/breadcrumbs
//   момента краха). НЕ снимает скриншот. Уважает single-flight: если уже идёт отправка или
//   ждёт отложенный повтор - возвращает false (файл остаётся в очереди, подхватится позже).
// Возврат: true если запрос поставлен; false если no-op (выключено / нет endpoint / занято / пусто).
// =====================================================================================
function fastlogs_pending_send(body_json, file_path) {
    if (!FASTLOGS_ENABLED) { return false; }
    if (!is_string(FASTLOGS_ENDPOINT) || string_length(FASTLOGS_ENDPOINT) == 0) { return false; }
    if (!is_string(body_json) || string_length(body_json) == 0) { return false; }

    var hs = __fastlogs_http_state();
    // Single-flight: не вмешиваемся в идущую отправку/ожидание повтора (файл ждёт следующего раза).
    if (hs.is_sending || fastlogs_retry_is_pending()) { return false; }

    hs.is_sending   = true;
    hs.state        = "sending";
    hs.retry_count  = 0;
    hs.pending_body = body_json;
    // Привязать файл к этому запросу: на успехе Async-обработчик удалит именно его.
    hs.pending_file = is_string(file_path) ? file_path : "";

    // Лёгкий статус (не обязателен на старте, но информативен, если оверлей/тост подключён).
    fastlogs_send_status("sending", "Досыл отчёта о краше...", false);

    return fastlogs_http_post_internal(body_json);
}

// =====================================================================================
// Внутреннее: собрать тело (с уже готовым скриншотом, если был) и поставить POST.
//   opts == undefined -> взять сохранённые st.__http_pending_opts (путь после захвата).
//   true если http_request вызван.
// =====================================================================================
function fastlogs_http_dispatch(opts) {
    if (!FASTLOGS_ENABLED) { return false; }
    var st = __fastlogs_state();
    var hs = __fastlogs_http_state();

    if (is_undefined(opts)) {
        opts = variable_struct_exists(st, "__http_pending_opts") ? st.__http_pending_opts : {};
    }
    if (!is_struct(opts)) { opts = {}; }

    var body = fastlogs_build_payload_json(opts);
    if (!is_string(body) || string_length(body) == 0) {
        show_debug_message("[FastLogs] send aborted: empty payload");
        hs.is_sending = false;
        hs.state      = "error";
        // STATUS (B): снять «висящий» тост "Отправка..." -> ошибка (без повтора: тело пустое).
        fastlogs_send_status("error", "Ошибка: пустой отчёт", false);
        return false;
    }

    hs.pending_body = body;
    return fastlogs_http_post_internal(body);
}

// =====================================================================================
// Внутреннее: ставит один POST-запрос с готовым телом. true если http_request вызван.
// Используется и для первичной отправки, и для ретраев (тело уже собрано).
// =====================================================================================
function fastlogs_http_post_internal(body) {
    var hs = __fastlogs_http_state();

    // Заголовки: ds_map строк (НЕ struct). Ключ/значение без двоеточия.
    var headers = ds_map_create();
    ds_map_add(headers, "Content-Type", "application/json");
    if (is_string(FASTLOGS_TOKEN) && string_length(FASTLOGS_TOKEN) > 0) {
        ds_map_add(headers, "Authorization", "Bearer " + FASTLOGS_TOKEN);
    }

    // Таймаут соединения (best-effort; влияет на последующие запросы).
    // // TODO verify: применяется ли http_set_connect_timeout к уже идущим или только новым запросам.
    if (is_real(FASTLOGS_HTTP_TIMEOUT_MS) && FASTLOGS_HTTP_TIMEOUT_MS > 0) {
        http_set_connect_timeout(FASTLOGS_HTTP_TIMEOUT_MS);
    }

    var req = http_request(FASTLOGS_ENDPOINT, "POST", headers, body);

    // Карту можно уничтожить сразу - GM копирует значения заголовков.
    ds_map_destroy(headers);

    if (!is_real(req)) {
        show_debug_message("[FastLogs] http_request returned non-real id");
        hs.is_sending = false;
        hs.state      = "error";
        // STATUS (B): снять «висящий» тост "Отправка..." -> ошибка с возможностью повтора.
        fastlogs_send_status("error", "Ошибка: запрос не создан", true);
        return false;
    }

    hs.request_id  = req;
    hs.is_sending  = true;
    hs.state       = "sending";
    hs.last_status = 0;

    show_debug_message("[FastLogs] POST -> " + FASTLOGS_ENDPOINT + " (req id " + string(req) + ", body " + string(string_byte_length(body)) + " bytes)");
    return true;
}

// =====================================================================================
// fastlogs_http_retry() -> bool
// Повторяет последнюю отправку, если ещё остались попытки. Вызывается из Async HTTP
//   обработчика (Other_62.gml) при сетевой ошибке/5xx. true если ретрай поставлен.
// =====================================================================================
function fastlogs_http_retry() {
    if (!FASTLOGS_ENABLED) { return false; }
    var hs = __fastlogs_http_state();

    if (hs.retry_count >= FASTLOGS_HTTP_MAX_RETRIES) {
        show_debug_message("[FastLogs] retries exhausted (" + string(hs.retry_count) + ")");
        return false;
    }
    if (!is_string(hs.pending_body) || string_length(hs.pending_body) == 0) {
        return false;
    }
    hs.retry_count += 1;
    show_debug_message("[FastLogs] retry " + string(hs.retry_count) + "/" + string(FASTLOGS_HTTP_MAX_RETRIES));
    // Повторно используем уже собранное тело (тот же snapshot - корректно для ретрая).
    return fastlogs_http_post_internal(hs.pending_body);
}

// =====================================================================================
// RETRY-UNTIL-SUCCESS (отложенный повтор на alarm-таймере; фича RETRY).
// -------------------------------------------------------------------------------------
// Идея: когда отправка финально провалилась (после немедленных ретраев аплоадера),
//   ставим ОДИН pending-отчёт на повтор каждые FASTLOGS_RETRY_INTERVAL_SEC секунд и
//   повторяем, пока не пройдёт успешно (либо до предела FASTLOGS_RETRY_MAX).
// Таймер: Alarm[0] контроллера (obj_fastlogs_controller). Тикаем раз в СЕКУНДУ - это
//   позволяет обновлять статус "Повтор через Ns..." без работы в каждом кадре и без
//   аллокаций. Когда счётчик секунд дошёл до 0 - запускаем сам повтор.
// Один pending за раз: планирование заменяет тело и сбрасывает счётчик секунд; пока pending
//   активен, новая ручная fastlogs_send БЛОКИРУЕТСЯ и pending не трогает (см. fastlogs_send).
// =====================================================================================

// Внутреннее: взвести Alarm[0] контроллера на ~1 секунду (тик обратного отсчёта).
//   Переводим секунды в кадры по реальному game speed (как тост-таймер). // TODO verify
//   alarm[]: счётчик в шагах объекта, GM сам декрементирует каждый Step и вызывает
//   событие Alarm[0] по достижении 0 (механизм движка, НЕ опрос в нашем коде).
function __fastlogs_retry_arm_alarm() {
    if (!instance_exists(obj_fastlogs_controller)) { return false; }
    var frames = 60;   // фолбэк ~1 c при 60 fps
    if (script_exists(asset_get_index("fastlogs_ui_toast_frames_for"))) {
        frames = fastlogs_ui_toast_frames_for(1);   // 1 секунда -> кадры по текущему fps
    } else {
        var fps = game_get_speed(gamespeed_fps);
        if (is_real(fps) && fps > 0) frames = round(fps);
    }
    // Один взвод alarm на единственном persistent-контроллере.
    with (obj_fastlogs_controller) { alarm[0] = frames; }
    return true;
}

// =====================================================================================
// fastlogs_retry_schedule(body) -> bool
// Поставить (или ЗАМЕНИТЬ) единственный pending-отчёт на отложенный повтор. true если
//   запланировано. no-op если отложенный повтор выключен (интервал 0) или тело пустое.
// Вызывается из Async HTTP обработчика, когда немедленные ретраи исчерпаны/неуместны.
// =====================================================================================
function fastlogs_retry_schedule(body) {
    if (!FASTLOGS_ENABLED) { return false; }
    // Интервал 0 -> отложенный повтор выключен (поведение как раньше: ручной "Повторить").
    if (!is_real(FASTLOGS_RETRY_INTERVAL_SEC) || FASTLOGS_RETRY_INTERVAL_SEC <= 0) { return false; }
    if (!is_string(body) || string_length(body) == 0) { return false; }

    var hs = __fastlogs_http_state();
    // Один pending за раз: новое планирование заменяет тело и перезапускает отсчёт.
    hs.dretry_active  = true;
    hs.dretry_body    = body;
    hs.dretry_seconds = FASTLOGS_RETRY_INTERVAL_SEC;
    // dretry_count НЕ сбрасываем здесь: это продолжение серии повторов того же отчёта
    //   (счётчик растёт по факту каждой выполненной отложенной попытки в fastlogs_retry_tick).

    show_debug_message("[FastLogs] retry-until-success scheduled in " + string(FASTLOGS_RETRY_INTERVAL_SEC) + "s (attempt " + string(hs.dretry_count + 1) + ")");
    // Поднять статус сразу, чтобы тестер видел отсчёт, не дожидаясь первого тика.
    fastlogs_send_status("sending", "Повтор через " + string(FASTLOGS_RETRY_INTERVAL_SEC) + "s...", false);

    if (!__fastlogs_retry_arm_alarm()) {
        // Контроллера нет (не должно случаться при FASTLOGS_ENABLED) - не теряем pending,
        //   но без таймера он не тикнет; помечаем для диагностики.
        show_debug_message("[FastLogs] retry scheduled but controller instance missing - alarm not armed");
    }
    return true;
}

// =====================================================================================
// fastlogs_retry_tick() -> void
// Один тик обратного отсчёта отложенного повтора. Вызывается раз в СЕКУНДУ из Alarm[0]
//   контроллера (НЕ каждый кадр). Уменьшает счётчик секунд; обновляет статус
//   "Повтор через Ns..."; по достижении нуля запускает сам повтор (тем же телом).
//   Перевзводит alarm на следующую секунду, пока pending активен.
// =====================================================================================
function fastlogs_retry_tick() {
    if (!FASTLOGS_ENABLED) { return; }
    var hs = __fastlogs_http_state();
    if (!hs.dretry_active) { return; }   // нет pending - тик ничего не делает

    // Если в этот момент уже идёт отправка (например, пользователь вручную нажал Отправить),
    //   не вмешиваемся: текущий pending был отменён при ручном send. Подстраховка.
    if (hs.is_sending) { return; }

    hs.dretry_seconds -= 1;

    if (hs.dretry_seconds > 0) {
        // Ещё ждём: обновляем статус и перевзводим alarm на следующую секунду.
        fastlogs_send_status("sending", "Повтор через " + string(hs.dretry_seconds) + "s...", false);
        __fastlogs_retry_arm_alarm();
        return;
    }

    // Время вышло - выполняем отложенный повтор тем же телом.
    hs.dretry_count += 1;
    show_debug_message("[FastLogs] retry-until-success attempt " + string(hs.dretry_count));

    var body = hs.dretry_body;
    if (!is_string(body) || string_length(body) == 0) {
        // Тело пропало - нечего повторять, гасим pending.
        fastlogs_retry_cancel();
        return;
    }

    // Сбрасываем счётчик немедленных ретраев под новую попытку и шлём.
    //   pending остаётся активным: если эта попытка снова провалится, Async-обработчик
    //   перепланирует её снова (fastlogs_retry_schedule), продолжая серию.
    hs.retry_count   = 0;
    hs.pending_body  = body;
    hs.state         = "sending";
    fastlogs_send_status("sending", "Повтор отправки...", false);
    fastlogs_http_post_internal(body);
    // НЕ перевзводим alarm здесь: исход (успех/новый pending) решает Async HTTP обработчик.
}

// =====================================================================================
// fastlogs_retry_cancel() -> void
// Отменить текущий pending отложенный повтор (если есть) и сбросить его счётчики.
//   Вызывается при финальном успехе, при терминальной ошибке и при пропаже тела повтора.
// =====================================================================================
function fastlogs_retry_cancel() {
    if (!FASTLOGS_ENABLED) { return; }
    var hs = __fastlogs_http_state();
    hs.dretry_active  = false;
    hs.dretry_body    = "";
    hs.dretry_seconds = 0;
    hs.dretry_count   = 0;
    // Снять взведённый alarm контроллера, чтобы старый отсчёт не выстрелил.
    if (instance_exists(obj_fastlogs_controller)) {
        with (obj_fastlogs_controller) { alarm[0] = -1; }   // -1 = alarm выключен
    }
}

// =====================================================================================
// fastlogs_retry_is_pending() -> bool
// true если сейчас есть отчёт, ожидающий отложенного повтора. false при !FASTLOGS_ENABLED.
// =====================================================================================
function fastlogs_retry_is_pending() {
    if (!FASTLOGS_ENABLED) { return false; }
    return bool(__fastlogs_http_state().dretry_active);
}

// =====================================================================================
// fastlogs_is_sending() -> bool
// true пока есть незавершённый запрос. false при !FASTLOGS_ENABLED.
// =====================================================================================
function fastlogs_is_sending() {
    if (!FASTLOGS_ENABLED) { return false; }
    return bool(__fastlogs_http_state().is_sending);
}

// =====================================================================================
// fastlogs_last_url() -> string
// URL последнего успешно созданного лога (из ответа сервера). "" если ещё нет.
// =====================================================================================
function fastlogs_last_url() {
    if (!FASTLOGS_ENABLED) { return ""; }
    var u = __fastlogs_http_state().last_url;
    return is_string(u) ? u : "";
}

// =====================================================================================
// Внутреннее (для Async HTTP события): доступ к http-состоянию.
// =====================================================================================
function fastlogs_http_get_state() {
    return __fastlogs_http_state();
}

// =====================================================================================
// Внутреннее: безопасно поднять статус-тост (фича STATUS, B), не делая http зависимым от
//   overlay-модуля жёстко. Если overlay не подключён - просто no-op. kind: info/sending/ok/error.
// =====================================================================================
function fastlogs_send_status(kind, text, retry, url = "") {
    if (!FASTLOGS_ENABLED) { return; }
    if (!script_exists(asset_get_index("fastlogs_status_toast"))) { return; }
    var opt = { retry: bool(retry) };
    if (is_string(url) && string_length(url) > 0) { opt.url = url; }
    fastlogs_status_toast(kind, text, opt);
}
