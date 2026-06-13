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
        // Тост в оверлее, если он доступен. Если ссылку скопировали - отметим это.
        if (script_exists(asset_get_index("fastlogs_ui_toast"))) {
            fastlogs_ui_toast(copied ? "лог отправлен, ссылка скопирована" : "лог отправлен");
        }
        // Комментарий ушёл с отчётом -> очищаем поле, чтобы он не уходил повторно (фича COMMENT).
        if (script_exists(asset_get_index("fastlogs_comment_clear"))) {
            fastlogs_comment_clear();
        }
    } else {
        show_debug_message("[FastLogs] ingest OK (" + string(http_status) + ") but no url in response: " + string(result));
    }
} else {
    // Ошибка: 4xx/5xx или сетевой обрыв.
    show_debug_message("[FastLogs] ingest FAILED status=" + string(status) + " http_status=" + string(http_status) + " result=" + string(result));

    // Ретраим только сетевые ошибки и 5xx (4xx - проблема в теле, ретрай не поможет).
    var retryable = net_error || (is_real(http_status) && http_status >= 500);
    var retried = false;
    if (retryable) {
        retried = fastlogs_http_retry();        // ставит новый запрос, переустанавливает is_sending
    }
    if (!retried) {
        hs.state = "error";
        if (script_exists(asset_get_index("fastlogs_ui_toast"))) {
            fastlogs_ui_toast("ошибка отправки");
        }
    }
}
