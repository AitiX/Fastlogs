/// @description scr_fastlogs_core
// FastLogs GameMaker client - ЯДРО.
// Реализует: константы уровней, состояние (global.__fastlogs), fastlogs_init,
//   flog/fastlogs_log/warn/error, кольцевой буфер, счётчики сессии, fastlogs_clear,
//   fastlogs_get_counts, fastlogs_set_screenshot (флаг), регистрацию exception handler.
// Всё под FASTLOGS_ENABLED: при !FASTLOGS_ENABLED публичные точки делают ранний выход (no-op),
//   геттеры возвращают безопасные дефолты.
// Состояние хранится в ОДНОМ глобальном struct global.__fastlogs (а не в instance-переменных
//   контроллера) - так публичные функции вызываются из любого контекста без with/instance_find.
//   Контроллер obj_fastlogs_controller лишь обслуживает события (Step/Draw/Async).
// Сверять GML-API по GM-NOTES.md / актуальной документации; неуверенное помечать // TODO verify.

// =====================================================================================
// Константы уровней (контракт PUBLIC-API). Заводим как макросы тут (config их не задаёт).
// =====================================================================================
#macro FASTLOGS_LEVEL_LOG   0
#macro FASTLOGS_LEVEL_WARN  1
#macro FASTLOGS_LEVEL_ERROR 2

// =====================================================================================
// Внутреннее: лениво создать и вернуть глобальное состояние.
// Безопасно к вызову до fastlogs_init (ленивая инициализация), чтобы интегратор не падал
//   на порядке вызовов. Не делает гейтинг сам - вызывающий уже проверил FASTLOGS_ENABLED.
// =====================================================================================
function __fastlogs_state() {
    if (!variable_global_exists("__fastlogs") || !is_struct(global.__fastlogs)) {
        var ring_size = max(1, FASTLOGS_RING_SIZE);
        global.__fastlogs = {
            inited       : false,           // прошёл ли fastlogs_init
            // Кольцевой буфер записей лога. Каждый элемент: { time, level, text } или undefined.
            ring         : array_create(ring_size, undefined),
            ring_size    : ring_size,
            head         : 0,               // индекс следующей записи (куда писать)
            count        : 0,               // сколько валидных записей (<= ring_size)
            // Счётчики ЗА СЕССИЮ (не в пределах кольца) - идут в payload counts.
            cnt_error    : 0,
            cnt_warn     : 0,
            cnt_log      : 0,
            // Флаги, общие для модулей.
            recording    : false,           // фактическое состояние записи (управляет recorder)
            screenshot   : FASTLOGS_SCREENSHOT_DEFAULT, // включать ли скриншот в след. payload
            // Рантайм-оверрайды из fastlogs_init(config) (перекрывают макросы config).
            cfg          : {},
            // ЗАХВАТ КРАША (всегда персистим в outbox ДО guard'ов доставки). Дедуп ЗАХВАТА
            //   ОТДЕЛЬНЫЙ от дедупа доставки: чтобы цикл одинаковых крашей не заспамил файлы,
            //   но при этом захват не зависел от троттла/капа/занятости отправки.
            capture_last_sig   : "",   // сигнатура последнего ЗАХВАЧЕННОГО (записанного на диск) стека
            capture_last_us    : -1,   // get_timer() последнего захвата (мкс), -1 = не было; окно = троттл
            // ДОСТАВКА (немедленная авто-отправка по крашу, C): дедуп/троттл/лимит сессии.
            //   Влияет ТОЛЬКО на немедленный аплоад, НЕ на захват.
            //   FIX-3 (паритет с Unity): дедуп доставки теперь ОКОННЫЙ, а не «навсегда за сессию».
            //   autosend_last_sent_us - карта sig -> get_timer() последней ДОСТАВКИ этого стека (мкс).
            //   Тот же стек подавляется, только если его последняя доставка была МЕНЕЕ окна
            //   minGap*2 назад (FASTLOGS_AUTOSEND_SUPPRESS_WINDOW_SECONDS); позже окна - доставим снова.
            autosend_last_sent_us : {},   // sig -> us последней авто-ДОСТАВКИ (оконный дедуп доставки)
            autosend_last_us   : -1,   // get_timer() последней авто-ОТПРАВКИ (мкс), -1 = не было
            autosend_count     : 0,    // сколько авто-отправок сделано за сессию (лимит)
            // Поля recorder/http заполняют свои подсостояния лениво в своих модулях.
        };
    }
    return global.__fastlogs;
}

// =====================================================================================
// Внутреннее: получить эффективное значение настройки.
// Сначала смотрит рантайм-оверрайд из fastlogs_init(config), иначе возвращает default_value
//   (обычно соответствующий FASTLOGS_* макрос подставляет вызывающий).
// =====================================================================================
function __fastlogs_cfg(key, default_value) {
    var st = __fastlogs_state();
    if (is_struct(st.cfg) && variable_struct_exists(st.cfg, key)) {
        var v = variable_struct_get(st.cfg, key);
        if (!is_undefined(v)) return v;
    }
    return default_value;
}

// =====================================================================================
// fastlogs_init([config_struct]) - идемпотентная инициализация.
// Создаёт persistent obj_fastlogs_controller (если ещё нет), инициализирует состояние,
//   подгружает персист прошлых сессий, регистрирует exception_unhandled_handler.
// Возврат: instance id контроллера, либо noone при !FASTLOGS_ENABLED.
// =====================================================================================
function fastlogs_init(config_struct = undefined) {
    if (!FASTLOGS_ENABLED) return noone;

    var st = __fastlogs_state();

    // Слить переданный конфиг (мягко: только заданные поля).
    if (is_struct(config_struct)) {
        var keys = variable_struct_get_names(config_struct);
        for (var i = 0; i < array_length(keys); i++) {
            var k = keys[i];
            variable_struct_set(st.cfg, k, variable_struct_get(config_struct, k));
        }
    }

    // Создать контроллер один раз. object_index гарантирует один экземпляр-обработчик.
    if (!instance_exists(obj_fastlogs_controller)) {
        // depth не важен (нет Draw в мире); persistent задан в .yy.
        instance_create_depth(0, 0, 0, obj_fastlogs_controller);
    }

    if (!st.inited) {
        st.inited = true;

        // Применить автостарт записи (учитывая рантайм-оверрайд autoStartRecording).
        var auto_rec = __fastlogs_cfg("autoStartRecording", FASTLOGS_AUTO_START_RECORDING);

        // Подгрузить персист прошлых сессий и восстановить флаг записи (если так настроено).
        // Реализация в scr_fastlogs_recorder; безопасна к вызову (внутри сама гейтится).
        fastlogs_recorder_load_persisted();

        // Применить скриншот-дефолт из конфига, если задан.
        st.screenshot = __fastlogs_cfg("screenshot", FASTLOGS_SCREENSHOT_DEFAULT);

        if (auto_rec) {
            fastlogs_record_set(true);
        }

        // ПЕРСИСТ КРАШ-ОТЧЁТА (фича #1): просканировать дисковую очередь pending и ДОСЛАТЬ
        //   неотправленные краш-отчёты прошлых сессий (так жёсткий краш доедет на этом запуске).
        //   Не блокирует поток надолго: за старт досылается не более FASTLOGS_PENDING_RESEND_PER_START,
        //   single-flight -> реально стартует одна отправка, остальные подхватятся позже. best-effort.
        try {
            if (script_exists(asset_get_index("fastlogs_pending_resend_all"))) {
                fastlogs_pending_resend_all();
            }
        } catch (_ep) { /* проглатываем: досыл не должен мешать старту */ }

        // Регистрация перехвата необработанных исключений (best-effort: персист на диск,
        //   попытка отправки; игра всё равно закроется после колбэка - см. GM-NOTES 2.4).
        if (FASTLOGS_AUTOSEND_ON_EXCEPTION) {
            // exception_unhandled_handler принимает method/function; колбэк получает
            //   exception struct { message, longMessage, script, stacktrace }. ПОДТВЕРЖДЕНО.
            exception_unhandled_handler(__fastlogs_on_unhandled_exception);
        }
    }

    return instance_exists(obj_fastlogs_controller) ? instance_find(obj_fastlogs_controller, 0) : noone;
}

// =====================================================================================
// Внутреннее: сигнатура исключения для ДЕДУПА (C). Берём script + первые кадры стектрейса
//   (не само сообщение - оно может содержать переменные значения), хешируем в стабильный ключ.
//   md5-hex используем как ключ set'а; префикс 's' -> гарантированно валидное имя поля структа.
// =====================================================================================
function __fastlogs_exception_signature(ex) {
    var sig = "";
    try {
        if (is_struct(ex)) {
            if (variable_struct_exists(ex, "script")) sig += string(ex.script);
            if (variable_struct_exists(ex, "stacktrace") && is_array(ex.stacktrace)) {
                var stk = ex.stacktrace;
                var lim = min(array_length(stk), 8);   // первых нескольких кадров достаточно
                for (var i = 0; i < lim; i++) sig += "|" + string(stk[i]);
            }
            // Если ни script, ни stacktrace недоступны - падаём на message (грубее, но что есть).
            if (sig == "" && variable_struct_exists(ex, "message")) sig += string(ex.message);
        } else {
            sig = string(ex);
        }
    } catch (_e) {
        sig = "";
    }
    if (sig == "") sig = "unknown";
    return "s" + md5_string_utf8(sig);
}

// =====================================================================================
// Внутреннее: нужно ли ЗАХВАТИТЬ (персистить в outbox) этот краш? Дедуп ЗАХВАТА отдельный от
//   дедупа доставки: если ТОТ ЖЕ стек уже захвачен в пределах окна троттла (minGap), новый файл
//   НЕ пишем (чтобы цикл крашей не заспамил outbox). Иначе - захватываем (и фиксируем состояние).
//   Окно = FASTLOGS_AUTOSEND_THROTTLE_SECONDS (как у доставки). Возвращает bool (true -> писать файл).
//   ВАЖНО: это НЕ зависит от капа/занятости/лимита сессии - только от собственного окна дедупа.
// =====================================================================================
function __fastlogs_capture_allowed(sig) {
    var st = __fastlogs_state();
    var now_us = get_timer();
    var win = FASTLOGS_AUTOSEND_THROTTLE_SECONDS;   // окно дедупа захвата = троттл
    // Тот же стек в пределах окна -> пропускаем повторный захват (дедуп захвата).
    if (FASTLOGS_AUTOSEND_DEDUP
        && is_string(st.capture_last_sig) && st.capture_last_sig != ""
        && st.capture_last_sig == sig
        && st.capture_last_us >= 0
        && is_real(win) && win > 0
        && (now_us - st.capture_last_us) < win * 1000000) {
        return false;
    }
    // Разрешаем захват -> фиксируем состояние ОТДЕЛЬНОГО дедупа захвата.
    st.capture_last_sig = sig;
    st.capture_last_us  = now_us;
    return true;
}

// =====================================================================================
// Внутреннее: можно ли сейчас НЕМЕДЛЕННО авто-ОТПРАВИТЬ (доставить) этот краш? Применяет лимит
//   сессии, троттл по времени и дедуп ДОСТАВКИ по сигнатуре. Возвращает { allowed, reason }. При
//   allowed=true помечает сигнатуру как отправленную, инкрементит счётчик и обновляет метку
//   времени (фиксация состояния доставки тут). НЕ влияет на захват - захват уже сделан выше.
// =====================================================================================
function __fastlogs_autosend_allowed(sig) {
    var st = __fastlogs_state();
    var now_us = get_timer();

    // Лимит на сессию (канон Unity = 10, см. FASTLOGS_AUTOSEND_SESSION_LIMIT).
    if (st.autosend_count >= max(0, FASTLOGS_AUTOSEND_SESSION_LIMIT)) {
        return { allowed: false, reason: "session limit" };
    }
    // ДЕДУП ДОСТАВКИ ОКОННЫЙ (FIX-3, паритет с Unity): подавляем тот же стек, только если его
    //   последняя ДОСТАВКА была МЕНЕЕ окна minGap*2 назад. Раньше окна повтор подавлялся;
    //   позже окна - доставляем снова (раньше было «навсегда за сессию» -> глушило до перезапуска).
    if (FASTLOGS_AUTOSEND_DEDUP && is_struct(st.autosend_last_sent_us)
        && variable_struct_exists(st.autosend_last_sent_us, sig)) {
        var last_sent = variable_struct_get(st.autosend_last_sent_us, sig);
        var win = FASTLOGS_AUTOSEND_SUPPRESS_WINDOW_SECONDS;   // = throttle*2 (minGap*2)
        if (is_real(last_sent) && last_sent >= 0
            && is_real(win) && win > 0
            && (now_us - last_sent) < win * 1000000) {
            return { allowed: false, reason: "dedup (same stack within window)" };
        }
    }
    // Троттл по времени (любой стек).
    var thr = FASTLOGS_AUTOSEND_THROTTLE_SECONDS;
    if (is_real(thr) && thr > 0 && st.autosend_last_us >= 0) {
        if ((now_us - st.autosend_last_us) < thr * 1000000) {
            return { allowed: false, reason: "throttled" };
        }
    }
    // Разрешено -> зафиксировать состояние ОКОННОГО дедупа (метка времени доставки этого стека).
    if (FASTLOGS_AUTOSEND_DEDUP) variable_struct_set(st.autosend_last_sent_us, sig, now_us);
    st.autosend_last_us = now_us;
    st.autosend_count  += 1;
    return { allowed: true, reason: "" };
}

// =====================================================================================
// Внутреннее (FIX-2): МИНИМАЛЬНЫЙ фолбэк-захват краша, НЕ зависящий от fastlogs_build_payload.
//   Зовётся в крэш-колбэке, ТОЛЬКО если основной билдер (fastlogs_build_payload_json) вернул ""
//   (упал внутри сбора device/context/screenshot и т.п.). Собирает минимальное контрактное тело
//   напрямую из доступного, чтобы краш НЕ терялся, даже когда билдер недоступен.
//   Источники: appId/appVersion/platform/timestampUtc/counts/logText/logEncoding (+ title/comment/
//   tester если есть). logText = накопленный текст recorder/кольца, если он есть; иначе -
//   message+stacktrace самого исключения ex. Всё текстовое прогоняем через fastlogs_redact
//   (как обычный путь). Если МИНИМУМА нет (пустой endpoint ИЛИ пустой appId - слать некуда/нечем
//   идентифицировать) - честно возвращаем "" (ничего не пишем). best-effort, не кидаем наружу.
//   GML-функции для сверки по Manual: json_stringify, get_timer/date_*, asset_get_index/script_exists.
// =====================================================================================
function __fastlogs_build_fallback_crash_json(ex, opts = undefined) {
    if (!FASTLOGS_ENABLED) { return ""; }
    if (!is_struct(opts)) { opts = {}; }

    // Гейт минимума: endpoint (куда слать) + appId (чем идентифицировать). Источник - макросы,
    //   как у happy-path (fastlogs_build_payload + http-слой шлют на FASTLOGS_ENDPOINT/FASTLOGS_APP_ID),
    //   чтобы гейт фолбэка совпадал с реальной отправкой (иначе мог бы пройти на cfg, а send упасть).
    var endpoint = FASTLOGS_ENDPOINT;
    var app_id   = FASTLOGS_APP_ID;
    if (!is_string(endpoint) || string_length(endpoint) == 0) { return ""; }   // некуда слать
    if (!is_string(app_id)   || string_length(app_id)   == 0) { return ""; }   // нечем идентифицировать

    // appVersion: макрос -> GM_version (как в payload-билдере).
    var app_version = FASTLOGS_APP_VERSION;
    if (!is_string(app_version) || string_length(app_version) == 0) {
        app_version = string(GM_version);
    }

    // platform: используем тот же маппер, что и билдер; если недоступен - безопасный "Other".
    var platform = "Other";
    try {
        if (script_exists(asset_get_index("fastlogs_platform_string"))) {
            platform = fastlogs_platform_string();
        }
    } catch (_ep) { platform = "Other"; }
    if (!is_string(platform) || string_length(platform) == 0) { platform = "Other"; }

    // timestampUtc = сейчас (UTC ISO). __fastlogs_utc_iso - в recorder; фолбэк, если недоступен.
    var ts_utc = "";
    try {
        if (script_exists(asset_get_index("__fastlogs_utc_iso"))) {
            ts_utc = __fastlogs_utc_iso();
        }
    } catch (_et) { ts_utc = ""; }
    if (!is_string(ts_utc) || string_length(ts_utc) == 0) {
        // Грубый фолбэк формата UTC ISO без зависимостей recorder.
        var prevtz = date_get_timezone();
        date_set_timezone(timezone_utc);
        var dt = date_current_datetime();
        var p2 = function(n) { return (n < 10 ? "0" : "") + string(n); };
        ts_utc = string(date_get_year(dt)) + "-" + p2(date_get_month(dt)) + "-" + p2(date_get_day(dt))
               + "T" + p2(date_get_hour(dt)) + ":" + p2(date_get_minute(dt)) + ":" + p2(date_get_second(dt)) + "Z";
        date_set_timezone(prevtz);
    }

    // counts: то, что есть за сессию.
    var counts = { error: 0, warn: 0, log: 0 };
    try {
        var c = fastlogs_get_counts();
        if (is_struct(c)) {
            counts.error = is_real(c.error) ? c.error : 0;
            counts.warn  = is_real(c.warn)  ? c.warn  : 0;
            counts.log   = is_real(c.log)   ? c.log   : 0;
        }
    } catch (_ecn) { /* нули */ }

    // logText: сырой текст recorder/кольца, если есть; иначе message+stacktrace исключения.
    var log_text = "";
    try {
        if (script_exists(asset_get_index("fastlogs_recorder_get_logtext"))) {
            log_text = fastlogs_recorder_get_logtext();
        }
    } catch (_elt) { log_text = ""; }
    if (!is_string(log_text)) { log_text = ""; }
    if (string_length(log_text) == 0) {
        // Нет накопленного лога -> собираем минимум из самого исключения.
        var em = "UNHANDLED EXCEPTION";
        try {
            if (is_struct(ex)) {
                var m = variable_struct_exists(ex, "longMessage") ? string(ex.longMessage) : "";
                if (m == "" && variable_struct_exists(ex, "message")) m = string(ex.message);
                var scn = variable_struct_exists(ex, "script") ? string(ex.script) : "";
                em = "UNHANDLED EXCEPTION: " + m + (scn != "" ? (" @ " + scn) : "");
                if (variable_struct_exists(ex, "stacktrace") && is_array(ex.stacktrace)) {
                    var stk = ex.stacktrace;
                    for (var i = 0; i < array_length(stk); i++) em += "\n    at " + string(stk[i]);
                }
            } else {
                em = "UNHANDLED EXCEPTION: " + string(ex);
            }
        } catch (_eem) { em = "UNHANDLED EXCEPTION"; }
        log_text = em;
    }
    // Усечение по лимиту (как в билдере), если хелпер доступен; иначе шлём как есть.
    try {
        if (script_exists(asset_get_index("fastlogs_truncate_log"))) {
            var cut = fastlogs_truncate_log(log_text, FASTLOGS_MAX_LOG_BYTES);
            if (is_struct(cut)) {
                log_text = cut.text;
                if (cut.truncated) {
                    log_text += "\n...[FastLogs] logText truncated at " + string(FASTLOGS_MAX_LOG_BYTES) + " bytes...";
                }
            }
        }
    } catch (_ecut) { /* без усечения */ }

    // REDACTION (как обычный путь): logText прогоняем через fastlogs_redact (сам гейтится по SCRUB_PII).
    try {
        if (script_exists(asset_get_index("fastlogs_redact"))) {
            log_text = fastlogs_redact(log_text);
        }
    } catch (_er) { /* оставляем как есть */ }

    // --- сборка минимального контрактного тела (порядок/поля как у билдера) ---
    var body = {};
    body.appId        = app_id;
    body.platform     = platform;
    body.appVersion   = app_version;
    body.timestampUtc = ts_utc;
    body.counts       = counts;
    body.logText      = log_text;
    body.logEncoding  = FASTLOGS_LOG_ENCODING;
    // device ОБЯЗАТЕЛЕН по контракту (сервер: 400 bad_request "device must be an object",
    //   см. server/src/routes/ingest.js). Полный сбор device мог упасть (это и привело в
    //   фолбэк), поэтому шлём пустой объект {} - валиден по контракту (паритет с Unity, где
    //   MiniJson.WriteDevice всегда пишет device:{}). Без этого поля фолбэк-файл получил бы
    //   4xx -> poison-pill -> краш ПОТЕРЯН (то самое, что FIX-2 должен предотвратить).
    body.device       = {};

    // title (опц., <=120) - из crash_opts.
    if (variable_struct_exists(opts, "title")) {
        var t = opts.title;
        if (is_string(t) && string_length(t) > 0) {
            if (string_length(t) > 120) { t = string_copy(t, 1, 120); }
            body.title = t;
        }
    }

    // comment (опц., <=4000) - из opts или runtime cfg; чистим redaction.
    var comment = variable_struct_exists(opts, "comment") ? opts.comment : __fastlogs_cfg("comment", "");
    if (is_string(comment) && string_length(comment) > 0) {
        if (string_length(comment) > 4000) { comment = string_copy(comment, 1, 4000); }
        try { if (script_exists(asset_get_index("fastlogs_redact"))) { comment = fastlogs_redact(comment); } } catch (_erc) {}
        if (is_string(comment) && string_length(comment) > 0) { body.comment = comment; }
    }

    // tester (опц., <=120) - cfg -> макрос; чистим redaction (как защита, обычно имя).
    var tester = __fastlogs_cfg("tester", FASTLOGS_TESTER);
    if (is_string(tester) && string_length(tester) > 0) {
        if (string_length(tester) > 120) { tester = string_copy(tester, 1, 120); }
        try { if (script_exists(asset_get_index("fastlogs_redact"))) { tester = fastlogs_redact(tester); } } catch (_ert) {}
        if (is_string(tester) && string_length(tester) > 0) { body.tester = tester; }
    }

    return json_stringify(body);
}

// =====================================================================================
// Внутреннее: колбэк необработанного исключения (фича AUTO-SEND, C).
// Пишет ошибку в лог (с гарантированным флашем на диск через recorder), затем АВТО-отправка
//   с дедупом по стеку + троттлингом + лимитом сессии (повторяющееся исключение не спамит).
//   Async-отправка может не успеть до закрытия игры -> главное персист на диск, реальная
//   отправка добьётся на следующем запуске (накопленный logText). Если игра жива - тост.
// =====================================================================================
function __fastlogs_on_unhandled_exception(ex) {
    // Не полагаемся на FASTLOGS_ENABLED тут - handler регистрируется только когда включено.
    var msg = "UNHANDLED EXCEPTION";
    try {
        if (is_struct(ex)) {
            var m  = variable_struct_exists(ex, "longMessage") ? string(ex.longMessage) : "";
            if (m == "" && variable_struct_exists(ex, "message")) m = string(ex.message);
            var sc = variable_struct_exists(ex, "script") ? string(ex.script) : "";
            msg = "UNHANDLED EXCEPTION: " + m + (sc != "" ? (" @ " + sc) : "");
            // Стектрейс - массив строк; добавим отдельными записями.
            if (variable_struct_exists(ex, "stacktrace") && is_array(ex.stacktrace)) {
                var stk = ex.stacktrace;
                for (var i = 0; i < array_length(stk); i++) {
                    msg += "\n    at " + string(stk[i]);
                }
            }
        } else {
            msg = "UNHANDLED EXCEPTION: " + string(ex);
        }
    } catch (_e) {
        // Колбэк исключений не должен сам кидать - проглатываем.
    }

    // Запишем как error (инкремент счётчика + кольцо + флаш на диск, если запись включена).
    flog(msg, FASTLOGS_LEVEL_ERROR);

    // Принудительный флаш на диск даже если запись была выключена: при краше важно сохранить.
    // Реализация в recorder - дозаписывает ВСЁ кольцо в персист-файл синхронно (включая батч).
    try {
        fastlogs_recorder_flush_crash();
    } catch (_e2) { /* проглатываем */ }

    // -------------------------------------------------------------------------------------
    // РАЗДЕЛЕНИЕ ЗАХВАТА И ДОСТАВКИ (решение "захватывать всегда").
    // -------------------------------------------------------------------------------------
    // Сигнатура стека нужна и для дедупа захвата, и для дедупа доставки.
    var sig = "unknown";
    try { sig = __fastlogs_exception_signature(ex); } catch (_eg) { sig = "unknown"; }

    // (1) ЗАХВАТ ВСЕГДА: СНАЧАЛА синхронно строим готовое тело отчёта и БЕЗУСЛОВНО (до любых
    //   guard'ов троттл/кап/занято/дедуп-доставки) персистим его в дисковый outbox. Так
    //   необработанный краш НЕ теряется НИКОГДА в enabled-билде - даже во время занятости,
    //   сверх капа доставки или в окне троттла. Тело уже включает logText/срез/counts/comment/
    //   tester/context/breadcrumbs и redaction (fastlogs_build_payload_json). Без скриншота
    //   (для краша тяжело). best-effort, не кидаем из колбэка.
    //   Дедуп ЗАХВАТА (ОТДЕЛЬНЫЙ от дедупа доставки): если ТОТ ЖЕ стек уже захвачен в окне
    //   троттла - новый файл НЕ пишем (чтобы цикл крашей не заспамил outbox). Кап outbox
    //   (FASTLOGS_PENDING_MAX + TrimToCap внутри fastlogs_pending_write) бьёт по числу файлов
    //   в любом случае.
    var crash_opts = { title: "Unhandled exception", screenshot: false };
    var crash_body = "";
    try {
        if (script_exists(asset_get_index("fastlogs_build_payload_json"))) {
            crash_body = fastlogs_build_payload_json(crash_opts);
        }
    } catch (_eb) { crash_body = ""; }

    // (1a) ФОЛБЭК-ЗАХВАТ (FIX-2): билдер мог упасть/вернуть "" (например, исключение внутри
    //   сбора device/context). РАНЬШЕ тогда fastlogs_pending_write НЕ звался и краш ТЕРЯЛСЯ.
    //   Теперь строим МИНИМАЛЬНОЕ контрактное тело напрямую из доступного, НЕ полагаясь на
    //   билдер: appId/appVersion/platform/timestampUtc/counts/logText/logEncoding (+ title/
    //   comment/tester если есть). logText = сырой текст recorder/буфера если есть, иначе
    //   message+stack самого исключения. Прогоняем через тот же fastlogs_redact. Если минимума
    //   нет (нет endpoint/appId - слать некуда/нечем идентифицировать) - честно ничего ("").
    if (!is_string(crash_body) || string_length(crash_body) == 0) {
        try {
            crash_body = __fastlogs_build_fallback_crash_json(ex, crash_opts);
        } catch (_efb) { crash_body = ""; }
        if (is_string(crash_body) && string_length(crash_body) > 0) {
            show_debug_message("[FastLogs] crash capture: builder failed -> using minimal fallback body");
        }
    }

    var pending_path = "";
    var captured     = false;
    if (is_string(crash_body) && string_length(crash_body) > 0) {
        var do_capture = true;
        try { do_capture = __fastlogs_capture_allowed(sig); } catch (_ec) { do_capture = true; }
        if (do_capture) {
            try {
                if (script_exists(asset_get_index("fastlogs_pending_write"))) {
                    pending_path = fastlogs_pending_write(crash_body);   // ВСЕГДА: СНАЧАЛА на диск
                    captured = (is_string(pending_path) && string_length(pending_path) > 0);
                }
            } catch (_ew) { pending_path = ""; }
        } else {
            show_debug_message("[FastLogs] crash capture skipped: dedup (same stack within throttle window)");
        }
    }

    // (2) ДОСТАВКА (немедленная отправка + тост) гейтится троттл/кап/занято/дедуп-ДОСТАВКИ.
    //   Это влияет ТОЛЬКО на немедленный аплоад, НЕ на захват выше. Захваченный файл в любом
    //   случае доедет: либо этим немедленным аплоадом (удалит ИМЕННО свой файл на успехе),
    //   либо дренажом при простое / досылом на следующем старте.
    var do_send = true;
    var skip_reason = "";
    try {
        var gate = __fastlogs_autosend_allowed(sig);
        do_send     = gate.allowed;
        skip_reason = gate.reason;
    } catch (_eg2) {
        do_send = true;   // не смогли посчитать гейт - не блокируем отправку
    }

    if (do_send) {
        // Попытка немедленной отправки (best-effort; может не успеть до закрытия игры).
        //   СВЯЗКА ФАЙЛА: передаём pending_path только что захваченного файла, чтобы успешный
        //   аплоад удалил ИМЕННО его (никаких удалений чужого/устаревшего; не оставляем файл-сироту).
        //   Если захват не состоялся (дедуп/диск) и pending_path пуст - обычная отправка тела как есть.
        try {
            if (is_string(crash_body) && string_length(crash_body) > 0
                && script_exists(asset_get_index("fastlogs_pending_send"))) {
                // fastlogs_pending_send сам поднимет статус-тост; single-flight внутри.
                fastlogs_pending_send(crash_body, pending_path);
            } else {
                // Фолбэк: тело не собралось/нет pending-слоя - обычная отправка.
                fastlogs_send(crash_opts);
            }
        } catch (_e3) { /* проглатываем */ }
    } else {
        // Доставка зарезана guard'ом, но КРАШ УЖЕ ЗАХВАЧЕН на диск (если не дедуп захвата) -
        //   он доедет дренажом/на старте. Сообщаем тестеру, что не потеряли.
        var note = captured ? "Краш записан (" + skip_reason + ", отправим позже)"
                            : "Краш записан (" + skip_reason + ")";
        show_debug_message("[FastLogs] autosend on crash deferred: " + skip_reason
            + (captured ? " (captured to outbox: " + pending_path + ")" : ""));
        try {
            if (script_exists(asset_get_index("fastlogs_status_toast"))) {
                fastlogs_status_toast("info", note);
            }
        } catch (_e4) { /* проглатываем */ }
    }

    // Возвращать ничего полезного не нужно - игра закроется (если краш фатальный).
}

// =====================================================================================
// flog(message, [level]) - основная точка логирования (+ алиас fastlogs_log ниже).
// В память (кольцо) пишет всегда при FASTLOGS_ENABLED; на диск - только если запись включена
//   (это делает recorder в fastlogs_recorder_on_record). Инкрементит счётчик уровня за сессию.
// =====================================================================================
function flog(message, level = FASTLOGS_LEVEL_LOG) {
    if (!FASTLOGS_ENABLED) return;

    var st = __fastlogs_state();

    var lvl = is_real(level) ? clamp(floor(level), FASTLOGS_LEVEL_LOG, FASTLOGS_LEVEL_ERROR)
                             : FASTLOGS_LEVEL_LOG;
    var txt = string(message);   // приведение любого типа к строке
    var t   = date_current_datetime();

    // Счётчики за сессию.
    switch (lvl) {
        case FASTLOGS_LEVEL_ERROR: st.cnt_error++; break;
        case FASTLOGS_LEVEL_WARN:  st.cnt_warn++;  break;
        default:                   st.cnt_log++;   break;
    }

    // Запись в кольцо. ПЕРФ (D): ПЕРЕИСПОЛЬЗУЕМ struct в слоте, если он уже создан (мутируем
    //   поля вместо аллокации нового struct на каждый лог). Аллокация происходит только при
    //   первом заполнении кольца; дальше - in-place перезапись. Это безопасно: recorder
    //   синхронно потребляет rec тут же, а старый rec в слоте уже был отформатирован/слит
    //   на прошлом обороте (snapshot/flush держат ссылки лишь во время синхронного потребления).
    var rec = st.ring[st.head];
    if (is_struct(rec)) {
        rec.time  = t;
        rec.level = lvl;
        rec.text  = txt;
    } else {
        rec = { time: t, level: lvl, text: txt };
        st.ring[st.head] = rec;
    }
    st.head = (st.head + 1) mod st.ring_size;
    if (st.count < st.ring_size) st.count++;

    // Персист на диск - только при активной записи. Делегируем recorder'у (он гейтит сам).
    fastlogs_recorder_on_record(rec);
}

// Удобные обёртки с фиксированным уровнем (контракт PUBLIC-API).
function fastlogs_log(message)   { flog(message, FASTLOGS_LEVEL_LOG);   }
function fastlogs_warn(message)  { flog(message, FASTLOGS_LEVEL_WARN);  }
function fastlogs_error(message) { flog(message, FASTLOGS_LEVEL_ERROR); }

// =====================================================================================
// fastlogs_clear() - очистить кольцо в памяти и счётчики сессии.
// Персист-файл на диске НЕ трогает (история между сессиями сохраняется).
// =====================================================================================
function fastlogs_clear() {
    if (!FASTLOGS_ENABLED) return;
    var st = __fastlogs_state();
    for (var i = 0; i < st.ring_size; i++) st.ring[i] = undefined;
    st.head      = 0;
    st.count     = 0;
    st.cnt_error = 0;
    st.cnt_warn  = 0;
    st.cnt_log   = 0;
}

// =====================================================================================
// fastlogs_get_counts() -> { error, warn, log } - счётчики ЗА СЕССИЮ (как payload counts).
// При !FASTLOGS_ENABLED -> нули.
// =====================================================================================
function fastlogs_get_counts() {
    if (!FASTLOGS_ENABLED) return { error: 0, warn: 0, log: 0 };
    var st = __fastlogs_state();
    return { error: st.cnt_error, warn: st.cnt_warn, log: st.cnt_log };
}

// =====================================================================================
// fastlogs_set_screenshot(enabled) - тоггл включения скриншота в следующий fastlogs_send.
// Фактический захват кадра делает payload/http через util (screen_save -> buffer_load ->
//   buffer_base64_encode), см. GM-NOTES 2.2.
// =====================================================================================
function fastlogs_set_screenshot(enabled) {
    if (!FASTLOGS_ENABLED) return;
    var st = __fastlogs_state();
    st.screenshot = bool(enabled);
}

// =====================================================================================
// Внутренние геттеры состояния для других модулей (recorder/payload/http/overlay).
// Возвращают снимок кольца как массив записей в ХРОНОЛОГИЧЕСКОМ порядке (старые -> новые).
// =====================================================================================
function fastlogs_ring_snapshot() {
    var st = __fastlogs_state();
    var out = [];
    if (st.count <= 0) return out;
    // Старейший элемент: если кольцо заполнено - это head; иначе - 0.
    var start = (st.count >= st.ring_size) ? st.head : 0;
    for (var i = 0; i < st.count; i++) {
        var idx = (start + i) mod st.ring_size;
        var rec = st.ring[idx];
        if (!is_undefined(rec)) array_push(out, rec);
    }
    return out;
}
