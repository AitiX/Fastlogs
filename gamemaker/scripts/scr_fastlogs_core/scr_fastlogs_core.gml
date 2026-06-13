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
            // АВТО-ОТПРАВКА ПРИ КРАШЕ (C): дедуп/троттл/лимит сессии.
            autosend_seen      : {},   // set сигнатур уже авто-отправленных стеков (дедуп за сессию)
            autosend_last_us   : -1,   // get_timer() последней авто-отправки (мкс), -1 = не было
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
// Внутреннее: можно ли сейчас авто-отправить этот краш? Применяет лимит сессии, троттл по
//   времени и дедуп по сигнатуре. Возвращает { allowed, reason }. При allowed=true помечает
//   сигнатуру как виденную, инкрементит счётчик и обновляет метку времени (фиксация состояния тут).
// =====================================================================================
function __fastlogs_autosend_allowed(sig) {
    var st = __fastlogs_state();

    // Лимит на сессию.
    if (st.autosend_count >= max(0, FASTLOGS_AUTOSEND_SESSION_LIMIT)) {
        return { allowed: false, reason: "session limit" };
    }
    // Дедуп: тот же стек уже авто-отправляли за эту сессию.
    if (FASTLOGS_AUTOSEND_DEDUP && is_struct(st.autosend_seen) && variable_struct_exists(st.autosend_seen, sig)) {
        return { allowed: false, reason: "dedup (same stack)" };
    }
    // Троттл по времени (любой стек).
    var now_us = get_timer();
    var thr = FASTLOGS_AUTOSEND_THROTTLE_SECONDS;
    if (is_real(thr) && thr > 0 && st.autosend_last_us >= 0) {
        if ((now_us - st.autosend_last_us) < thr * 1000000) {
            return { allowed: false, reason: "throttled" };
        }
    }
    // Разрешено -> зафиксировать состояние.
    if (FASTLOGS_AUTOSEND_DEDUP) variable_struct_set(st.autosend_seen, sig, true);
    st.autosend_last_us = now_us;
    st.autosend_count  += 1;
    return { allowed: true, reason: "" };
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

    // ДЕДУП + ТРОТТЛ + ЛИМИТ авто-отправки (C): чтобы повторяющийся краш не спамил сервер.
    var do_send = true;
    var skip_reason = "";
    try {
        var sig  = __fastlogs_exception_signature(ex);
        var gate = __fastlogs_autosend_allowed(sig);
        do_send     = gate.allowed;
        skip_reason = gate.reason;
    } catch (_eg) {
        do_send = true;   // не смогли посчитать гейт - не блокируем отправку
    }

    if (do_send) {
        // Best-effort авто-отправка (может не успеть до закрытия - это нормально).
        //   fastlogs_send сам поднимет статус-тост "Отправка..." (фича STATUS, B).
        try {
            fastlogs_send({ title: "Unhandled exception" });
        } catch (_e3) { /* проглатываем */ }
    } else {
        show_debug_message("[FastLogs] autosend on crash skipped: " + skip_reason);
        // Игра ещё жива (мы в колбэке) - короткий статус, не падая, если тост доступен.
        try {
            if (script_exists(asset_get_index("fastlogs_status_toast"))) {
                fastlogs_status_toast("info", "Краш записан (" + skip_reason + ")");
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
