/// @description scr_fastlogs_payload
// FastLogs GameMaker client - PAYLOAD (сборка JSON тела по CONTRACT.md).
// Назначение: собрать struct тела запроса строго по контракту, опустить пустые поля,
//   усечь logText по лимиту, опционально вложить screenshotPng (base64 без data:),
//   и сериализовать через json_stringify.
// Гейтинг: при !FASTLOGS_ENABLED возвращаем "" / {} (no-op).
//
// ЗАВИСИМОСТИ (реальные имена из соседних скриптов FastLogs - сверено по коду):
//   scr_fastlogs_core:
//     - fastlogs_get_counts()                 -> { error, warn, log } за сессию
//   scr_fastlogs_recorder:
//     - fastlogs_recorder_get_logtext()       -> string накопленного лога (персист+кольцо)
//     - __fastlogs_utc_iso()                  -> string "YYYY-MM-DDThh:mm:ssZ" (UTC) [приватная, но
//                                                стабильная; DRY - не дублируем логику дат]
//   scr_fastlogs_device (этот же билдер):
//     - fastlogs_collect_device([extra])      -> struct device{}
//     - fastlogs_platform_string()            -> string platform
//   scr_fastlogs_screenshot:
//     - fastlogs_screenshot_base64()          -> string готовый base64 PNG ("" если нет)
//   Локальные хелперы компакта/усечения реализованы НИЖЕ (ответственность payload по
//   PUBLIC-API: "усечение logText, опускание пустых полей").

// =====================================================================================
// fastlogs_build_payload([opts]) -> struct
// Собирает struct тела запроса по CONTRACT.md. Пустые поля device убираются.
// opts (опц., struct): title(string<=120), retentionDays(int), screenshot(bool override),
//   extraDevice(struct).
// ВАЖНО про screenshot: фактический захват кадра асинхронный (Draw GUI End) и инициируется
//   в http-слое ДО вызова build_payload; здесь мы лишь ЧИТАЕМ уже готовый base64.
// =====================================================================================
function fastlogs_build_payload(opts = undefined) {
    if (!FASTLOGS_ENABLED) { return {}; }
    if (!is_struct(opts)) { opts = {}; }

    // --- appVersion: из конфига или GM_version ---
    var app_version = FASTLOGS_APP_VERSION;
    if (!is_string(app_version) || string_length(app_version) == 0) {
        app_version = string(GM_version);                 // фолбэк на версию проекта
    }

    // --- counts (за сессию) ---
    var counts = fastlogs_get_counts();                   // core: { error, warn, log }
    if (!is_struct(counts)) { counts = { error: 0, warn: 0, log: 0 }; }

    // --- logText + усечение по лимиту ---
    var raw_log = fastlogs_recorder_get_logtext();        // recorder: накопленный текст
    if (!is_string(raw_log)) { raw_log = ""; }
    var cut = fastlogs_truncate_log(raw_log, FASTLOGS_MAX_LOG_BYTES); // { text, truncated }
    var log_text = cut.text;
    if (cut.truncated) {
        // Пометка об усечении (контракт: усечён по MAX_LOG_BYTES с пометкой).
        log_text += "\n...[FastLogs] logText truncated at " + string(FASTLOGS_MAX_LOG_BYTES) + " bytes...";
    }
    // PII (#3): чистим logText ПОСЛЕ усечения (меньше текста сканировать) и до отправки.
    //   fastlogs_redact сам гейтится по FASTLOGS_SCRUB_PII/override (выкл -> возвращает как есть).
    if (script_exists(asset_get_index("fastlogs_redact"))) {
        log_text = fastlogs_redact(log_text);
    }

    // --- device ---
    var extra_device = variable_struct_exists(opts, "extraDevice") ? opts.extraDevice : undefined;
    var device = fastlogs_collect_device(extra_device);   // device-скрипт

    // --- сборка корневого struct СТРОГО по контракту ---
    var body = {};
    body.appId        = FASTLOGS_APP_ID;                  // ОБЯЗ.
    body.platform     = fastlogs_platform_string();       // ОБЯЗ. (device-скрипт)
    body.appVersion   = app_version;                      // ОБЯЗ.
    body.timestampUtc = __fastlogs_utc_iso();             // ОБЯЗ. UTC ISO-8601 (recorder)
    body.counts       = {
        error: is_real(counts.error) ? counts.error : 0,
        warn:  is_real(counts.warn)  ? counts.warn  : 0,
        log:   is_real(counts.log)   ? counts.log   : 0,
    };
    body.logText      = log_text;                         // ОБЯЗ.
    body.logEncoding  = FASTLOGS_LOG_ENCODING;            // ОБЯЗ. "plain"
    body.device       = fastlogs_struct_compact(device);  // ОБЯЗ. (пустые поля опущены)

    // --- screenshotPng (ОПЦ.): чистый base64 PNG без data: ---
    // Захват уже инициирован http-слоем; здесь читаем результат. Если ещё/неуспешно - опускаем.
    //   opts.screenshot==false (явно) -> НЕ кладём скриншот даже если в кэше остался прошлый
    //   (важно для краш-отчёта #1: screenshot:false -> чистый отчёт без тяжёлого PNG).
    var allow_shot = !(variable_struct_exists(opts, "screenshot") && opts.screenshot == false);
    if (allow_shot) {
        var b64 = fastlogs_screenshot_base64();           // screenshot-скрипт ("" если нет)
        if (is_string(b64) && string_length(b64) > 0) {
            body.screenshotPng = b64;
        }
    }

    // --- retentionDays (ОПЦ.) ---
    var ret = FASTLOGS_RETENTION_DAYS;
    if (variable_struct_exists(opts, "retentionDays")) { ret = opts.retentionDays; }
    if (is_real(ret) && ret >= 1) { body.retentionDays = floor(ret); } // -1 = не слать

    // --- title (ОПЦ., <=120) ---
    if (variable_struct_exists(opts, "title")) {
        var t = opts.title;
        if (is_string(t) && string_length(t) > 0) {
            if (string_length(t) > 120) { t = string_copy(t, 1, 120); }
            body.title = t;
        }
    }

    // --- comment (ОПЦ., <=4000): свободное описание проблемы тестером, из opts отправки ---
    // Контракт: пустые поля опускать (не слать null/""). Поэтому кладём только непустое.
    if (variable_struct_exists(opts, "comment")) {
        var cm = opts.comment;
        if (is_string(cm) && string_length(cm) > 0) {
            if (string_length(cm) > 4000) { cm = string_copy(cm, 1, 4000); }
            body.comment = cm;
        }
    }

    // --- tester (ОПЦ., <=120): имя тестера из конфига; уходит с КАЖДЫМ отчётом ---
    // Источник: runtime-override fastlogs_init({ tester }) -> иначе макрос FASTLOGS_TESTER.
    // Пустое не отправляем (контракт: опускать пустые).
    var tester = __fastlogs_cfg("tester", FASTLOGS_TESTER);
    if (is_string(tester) && string_length(tester) > 0) {
        if (string_length(tester) > 120) { tester = string_copy(tester, 1, 120); }
        body.tester = tester;
    }

    // --- sessionId (ОПЦ., #9): GUID ТЕКУЩЕГО запуска; уходит с КАЖДЫМ отчётом ---
    // Источник: fastlogs_session_id() (core; генерируется в fastlogs_init). Поле называется
    //   РОВНО 'sessionId' (сервер уже принимает). Пустое опускаем (контракт: не слать пустые).
    if (script_exists(asset_get_index("fastlogs_session_id"))) {
        var sess = fastlogs_session_id();
        if (is_string(sess) && string_length(sess) > 0) {
            body.sessionId = sess;
        }
    }

    // --- sentViaCode (ОПЦ., bool; батч B): TRUE -> отчёт инициирован из КОДА игры (fastlogs_send/
    //   quick-send напрямую из кода интегратора, авто-отправка по паттерну, авто-отправка по крашу),
    //   FALSE/опущено -> отправка из кнопки "Отправить" в оверлее (ручной send тестером). Источник -
    //   opts.sentViaCode, который проставляют ТОЛЬКО кодовые точки входа (fastlogs_quick_send,
    //   pattern-autosend, крэш-колбэк); оверлейный send его НЕ ставит. Поле называется РОВНО
    //   'sentViaCode' (паритет с Unity-клиентом и сервером/вьюером). По контракту "опускать пустые":
    //   кладём поле ТОЛЬКО когда true (сервер трактует отсутствие как false) - так payload не пухнет.
    //   callerFile/callerLine батча B НЕ кладём: в GML нет переносимой интроспекции места вызова
    //   (нет аналога C# CallerFilePath/CallerLineNumber). Фейковые значения слать нельзя - поля
    //   ОПУСКАЕМ для GM-клиента осознанно (см. PUBLIC-API / decisions). Сервер/вьюер показывают
    //   badge "code" по самому sentViaCode; file:line - бонус только для движков, где он доступен.
    if (variable_struct_exists(opts, "sentViaCode") && opts.sentViaCode == true) {
        body.sentViaCode = true;
    }

    // --- context (ОПЦ., object string->string; фича #2): едет с КАЖДЫМ отчётом ---
    // Контракт: пустое опускать. Значения чистим redaction (#3). Сервер капает ~4KB суммарно.
    if (script_exists(asset_get_index("fastlogs_context_snapshot"))) {
        var ctx = fastlogs_context_snapshot();            // НОВЫЙ struct-копия (можно мутировать)
        if (is_struct(ctx) && variable_struct_names_count(ctx) > 0) {
            var do_scrub = script_exists(asset_get_index("fastlogs_redact"));
            var cnames = variable_struct_get_names(ctx);
            for (var ci = 0; ci < array_length(cnames); ci++) {
                var ck = cnames[ci];
                var cv = variable_struct_get(ctx, ck);
                cv = is_string(cv) ? cv : string(cv);
                if (do_scrub) { cv = fastlogs_redact(cv); }   // чистим ЗНАЧЕНИЯ контекста
                variable_struct_set(ctx, ck, cv);
            }
            // Компакт уберёт пустые значения (контракт: не слать пустые).
            var ctx_c = fastlogs_struct_compact(ctx);
            if (is_struct(ctx_c) && variable_struct_names_count(ctx_c) > 0) {
                body.context = ctx_c;
            }
        }
    }

    // --- breadcrumbs (ОПЦ., массив {t,m,lvl}; фича #2): катящийся буфер последних N ---
    // Контракт: пустое опускать; lvl in info|warn|error (опц.). Тексты m чистим redaction (#3).
    //   Сервер капает 100 шт и ~16KB (клиент уже держит кап FASTLOGS_BREADCRUMB_MAX).
    if (script_exists(asset_get_index("fastlogs_breadcrumbs_snapshot"))) {
        var crumbs = fastlogs_breadcrumbs_snapshot();     // массив НОВЫХ копий (можно мутировать)
        if (is_array(crumbs) && array_length(crumbs) > 0) {
            var do_scrub2 = script_exists(asset_get_index("fastlogs_redact"));
            var out_crumbs = [];
            for (var bi = 0; bi < array_length(crumbs); bi++) {
                var cr = crumbs[bi];
                if (!is_struct(cr)) continue;
                var item = {};
                var ct = variable_struct_exists(cr, "t")   ? cr.t   : "";
                var cm = variable_struct_exists(cr, "m")   ? cr.m   : "";
                var cl = variable_struct_exists(cr, "lvl") ? cr.lvl : "";
                if (do_scrub2) { cm = fastlogs_redact(string(cm)); }
                // Контракт: m обязателен у элемента; t и lvl опциональны. Без m крошку НЕ шлём.
                if (!is_string(cm) || string_length(cm) == 0) continue;
                if (is_string(ct) && string_length(ct) > 0) item.t = ct;   // порядок: t, m, lvl
                item.m = cm;
                if (is_string(cl) && string_length(cl) > 0) item.lvl = cl;
                array_push(out_crumbs, item);
            }
            if (array_length(out_crumbs) > 0) {
                body.breadcrumbs = out_crumbs;
            }
        }
    }

    return body;
}

// =====================================================================================
// fastlogs_build_payload_json([opts]) -> string
// Готовая JSON-строка тела запроса для http_request. "" при !FASTLOGS_ENABLED.
// =====================================================================================
function fastlogs_build_payload_json(opts = undefined) {
    if (!FASTLOGS_ENABLED) { return ""; }
    var body = fastlogs_build_payload(opts);
    // json_stringify: struct/array -> строка. Функции структа не сериализуются (их тут нет).
    //   prettify не нужен (минимизируем размер тела).
    return json_stringify(body);
}

// =====================================================================================
// fastlogs_truncate_log(text, max_bytes) -> { text, truncated }
// Усекает text до <= max_bytes (UTF-8 байт), сохраняя целостность строк по \n где можно.
// Контракт: counts - за сессию; logText усечён по MAX_LOG_BYTES с пометкой (пометку
//   добавляет вызывающий). Усекаем КОНЕЦ строки не оставляем оборванный multibyte-символ.
// =====================================================================================
function fastlogs_truncate_log(text, max_bytes) {
    var res = { text: text, truncated: false };
    if (!is_string(text)) { res.text = ""; return res; }
    var blen = string_byte_length(text);                  // байты UTF-8 (GM хранит строки в UTF-8)
    if (blen <= max_bytes) { return res; }

    res.truncated = true;
    // Оставляем ХВОСТ лога (свежие записи важнее старых) на ~max_bytes.
    // Идём с конца, отрезая старое начало по \n, пока не уложимся в лимит.
    var tail = text;
    // Грубый быстрый рез: пока байтов слишком много - удаляем до первого \n с начала.
    // (string_delete оперирует СИМВОЛАМИ; для UTF-8 это безопасно - не рвёт символ.)
    var guard = 0;
    while (string_byte_length(tail) > max_bytes && guard < 100000) {
        var nl = string_pos("\n", tail);
        if (nl <= 0) {
            // Нет \n - режем по символам с начала примерно на перебор.
            var over_chars = string_length(tail) - max_bytes; // оценка сверху (1 байт ~ 1 символ)
            tail = string_delete(tail, 1, max(1, over_chars));
            break;
        }
        tail = string_delete(tail, 1, nl);                // удалить до и включая первый \n
        guard++;
    }
    res.text = tail;
    return res;
}

// =====================================================================================
// fastlogs_struct_compact(value) -> value
// РЕКУРСИВНО убирает "пустые" поля из struct/array по инварианту контракта 3:
//   опускаем "" (пустые строки), undefined, пустые struct {} и пустые array [].
// ВНИМАНИЕ: НОЛЬ (0) и false НЕ удаляем - это валидные значения (battery 0.0, genuine false).
//   (Контракт говорит про "пустые/недоступные" - device-скрипт уже не кладёт заведомо
//    недоступные нули, так что оставшиеся числа осмысленны.)
// =====================================================================================
function fastlogs_struct_compact(value) {
    if (is_struct(value)) {
        var out = {};
        var names = variable_struct_get_names(value);
        for (var i = 0; i < array_length(names); i++) {
            var k = names[i];
            var v = fastlogs_struct_compact(variable_struct_get(value, k));
            if (fastlogs_is_empty_value(v)) { continue; }
            out[$ k] = v;
        }
        return out;
    }
    if (is_array(value)) {
        var arr = [];
        for (var j = 0; j < array_length(value); j++) {
            var av = fastlogs_struct_compact(value[j]);
            if (fastlogs_is_empty_value(av)) { continue; }
            array_push(arr, av);
        }
        return arr;
    }
    return value;
}

// "Пустое" значение для компакта: undefined, "" (пустая строка), пустой struct/array.
//   Числа (включая 0) и bool - НЕ пустые.
function fastlogs_is_empty_value(v) {
    if (is_undefined(v)) { return true; }
    if (is_string(v))  { return (string_length(v) == 0); }
    if (is_struct(v))  { return (variable_struct_names_count(v) == 0); }
    if (is_array(v))   { return (array_length(v) == 0); }
    return false;
}
