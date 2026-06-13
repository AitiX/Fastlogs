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
//     retry_count   : real   - сколько ретраев уже сделано для текущей отправки
//     pending_body  : string - тело текущего запроса (для ретрая)
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
        return false;
    }

    var hs = __fastlogs_http_state();

    // Запрет параллельной отправки (одна за раз).
    if (hs.is_sending) {
        show_debug_message("[FastLogs] send skipped: already sending");
        return false;
    }

    if (!is_struct(opts)) { opts = {}; }

    // Нужен ли скриншот в этой отправке?
    //   приоритет: opts.screenshot (явный override) -> текущий тоггл состояния -> дефолт макроса.
    var st = __fastlogs_state();
    var want_shot = variable_struct_exists(st, "screenshot") ? bool(st.screenshot) : FASTLOGS_SCREENSHOT_DEFAULT;
    if (variable_struct_exists(opts, "screenshot")) { want_shot = bool(opts.screenshot); }

    // Помечаем занятость СРАЗУ, чтобы параллельный send отбился, пока идёт захват/запрос.
    hs.is_sending = true;
    hs.state      = "sending";
    hs.retry_count = 0;

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
