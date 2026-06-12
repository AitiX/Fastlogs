/// @description scr_fastlogs_recorder
// FastLogs GameMaker client - ПЕРСИСТЕНТНАЯ ЗАПИСЬ.
// Реализует: fastlogs_record_start/stop/set/is_recording/clear; запись лога на диск
//   (game_save_id, rolling-файл с лимитом FASTLOGS_PERSIST_MAX_BYTES, маркер сессии);
//   СОХРАНЕНИЕ МЕЖДУ СЕССИЯМИ (на старте подгружает прошлые сессии); отдачу накопленного
//   logText для отправки. По умолчанию запись ВЫКЛ (включается start/set(true) или конфигом).
//
// Модель персиста (один rolling-файл, синхронная дозапись через буфер):
//   - Путь: FASTLOGS_PERSIST_DIR + "/" + FASTLOGS_PERSIST_FILE (относительно game_save_id).
//   - На старте файл целиком читается в строковый аккумулятор rec_text (прошлые сессии).
//   - При активной записи каждый flog синхронно дозаписывается И в rec_text, И в файл.
//   - Маркер сессии (guid + UTC + краткое устройство) пишется один раз при первом включении
//     записи в сессии, чтобы в файле было видно границу запусков.
//   - Ротация: если файл превышает лимит - обрезаем СТАРОЕ начало (оставляем хвост ~половину
//     лимита), целостность строк по \n.
//   - Флаг записи персистится в ini (FASTLOGS_PERSIST_DIR/settings.ini), восстанавливается на
//     старте: если в прошлой сессии запись была включена - продолжаем писать.
//
// Всё под FASTLOGS_ENABLED: при !FASTLOGS_ENABLED все точки делают ранний выход.
// Локальные хелперы времени/файла помечены "// REPLACEABLE: util" - при готовом
//   scr_fastlogs_util их можно заменить на общие fastlogs_util_*.
// Сверять GML-API по GM-NOTES.md / актуальной документации; неуверенное помечать // TODO verify.

// =====================================================================================
// Внутреннее: лениво создать и вернуть подсостояние recorder внутри global.__fastlogs.
// =====================================================================================
function __fastlogs_rec_state() {
    var st = __fastlogs_state();   // из scr_fastlogs_core
    if (!variable_struct_exists(st, "rec") || !is_struct(st.rec)) {
        st.rec = {
            loaded        : false,   // прошла ли подгрузка персиста на старте
            rec_text      : "",      // накопленный текст лога (прошлые + текущая сессия)
            session_mark  : false,   // записан ли маркер текущей сессии в файл
            session_guid  : "",      // guid текущей сессии (для маркера)
            file_path     : FASTLOGS_PERSIST_DIR + "/" + FASTLOGS_PERSIST_FILE,
            ini_path      : FASTLOGS_PERSIST_DIR + "/settings.ini",
            disk_ok       : true,    // false если файловые операции упали (тогда работаем in-memory)
        };
    }
    return st.rec;
}

// =====================================================================================
// REPLACEABLE: util. UTC ISO-8601 timestamp "YYYY-MM-DDThh:mm:ssZ".
// date_current_datetime() возвращает момент в БАЗОВОЙ таймзоне; ставим UTC на время чтения
//   компонентов, затем возвращаем прежнюю таймзону. (date_set_timezone/timezone_utc -
//   ПОДТВЕРЖДЕНО; компоненты date_get_* принимают datetime-значение.)
// =====================================================================================
function __fastlogs_utc_iso() {
    var prev = date_get_timezone();
    date_set_timezone(timezone_utc);
    var dt = date_current_datetime();
    var y  = date_get_year(dt);
    var mo = date_get_month(dt);
    var d  = date_get_day(dt);
    var h  = date_get_hour(dt);
    var mi = date_get_minute(dt);
    var s  = date_get_second(dt);
    date_set_timezone(prev);

    var p2 = function(n) { return (n < 10 ? "0" : "") + string(n); };
    return string(y) + "-" + p2(mo) + "-" + p2(d) + "T" + p2(h) + ":" + p2(mi) + ":" + p2(s) + "Z";
}

// REPLACEABLE: util. Метка времени для одной строки лога "[hh:mm:ss]" (UTC).
function __fastlogs_utc_clock() {
    var prev = date_get_timezone();
    date_set_timezone(timezone_utc);
    var dt = date_current_datetime();
    var h  = date_get_hour(dt);
    var mi = date_get_minute(dt);
    var s  = date_get_second(dt);
    date_set_timezone(prev);
    var p2 = function(n) { return (n < 10 ? "0" : "") + string(n); };
    return p2(h) + ":" + p2(mi) + ":" + p2(s);
}

// REPLACEABLE: util. Текстовая метка уровня для строки лога.
function __fastlogs_level_tag(level) {
    switch (level) {
        case FASTLOGS_LEVEL_ERROR: return "ERROR";
        case FASTLOGS_LEVEL_WARN:  return "WARN";
        default:                   return "LOG";
    }
}

// REPLACEABLE: util. Отформатировать запись кольца { time, level, text } в строку лога.
//   Формат: "[hh:mm:ss] LEVEL: text". Многострочный text оставляем как есть.
function __fastlogs_format_record(rec) {
    return "[" + __fastlogs_utc_clock() + "] " + __fastlogs_level_tag(rec.level) + ": " + string(rec.text);
}

// REPLACEABLE: util. Убедиться, что каталог персиста существует (относительно game_save_id).
function __fastlogs_ensure_dir() {
    if (!directory_exists(FASTLOGS_PERSIST_DIR)) {
        directory_create(FASTLOGS_PERSIST_DIR);   // путь относителен game_save_id
    }
}

// REPLACEABLE: util. Прочитать весь текстовый файл (UTF-8) через буфер. "" если нет/ошибка.
//   Файл пишется как сырой UTF-8 без нулевого терминатора (buffer_text), поэтому для чтения
//   "до конца строкой" дописываем один \0 в конец grow-буфера и читаем buffer_string с 0.
//   (buffer_string читает UTF-8 до нулевого байта - ПОДТВЕРЖДЕНО; buffer_text для ЧТЕНИЯ
//    фиксированной длины из manual не даёт, поэтому идём через buffer_string.)
function __fastlogs_read_text_file(rel_path) {
    if (!file_exists(rel_path)) return "";
    var buf = buffer_load(rel_path);   // grow-буфер, align 1; путь относителен game_save_id
    if (buf < 0) return "";
    var sz = buffer_get_size(buf);
    if (sz <= 0) { buffer_delete(buf); return ""; }
    buffer_seek(buf, buffer_seek_end, 0);
    buffer_write(buf, buffer_u8, 0);   // нулевой терминатор для корректного buffer_string
    var out = buffer_peek(buf, 0, buffer_string);   // прочитать всю строку с начала, не сдвигая
    buffer_delete(buf);
    return out;
}

// REPLACEABLE: util. Перезаписать текстовый файл строкой целиком (UTF-8, без терминатора).
//   buffer_save_ext(buffer, filename, offset, size) - сохраняет участок [offset, offset+size).
//   // TODO verify точный порядок аргументов buffer_save_ext в 2024.x (manual отдаёт 403).
function __fastlogs_write_text_file(rel_path, text) {
    var bytes = string_byte_length(text);
    var buf   = buffer_create(max(1, bytes), buffer_grow, 1);
    if (bytes > 0) buffer_write(buf, buffer_text, text);   // buffer_text: байты строки БЕЗ \0
    buffer_save_ext(buf, rel_path, 0, buffer_tell(buf));   // сохранить только записанные байты
    buffer_delete(buf);
}

// =====================================================================================
// Внутреннее: применить ротацию к rec_text (обрезать старое начало по лимиту, целостно по \n).
//   Возвращает (возможно укороченный) текст. После обрезки в начале ставится пометка усечения.
// =====================================================================================
function __fastlogs_rotate_text(text) {
    var limit = max(1024, FASTLOGS_PERSIST_MAX_BYTES);
    var bytes = string_byte_length(text);
    if (bytes <= limit) return text;

    // Оставляем хвост ~половину лимита, чтобы не ротировать на каждой строке.
    var keep_bytes = limit div 2;
    // Грубо переводим байты в символы для string_copy: для не-ASCII это приблизительно,
    //   но безопасно (берём заведомо не больше, чем есть символов).
    var total_chars = string_length(text);
    // Идём с конца, отрезая по строкам, пока укладываемся в keep_bytes.
    var tail = text;
    var cut_from = 1;
    // Найдём позицию, начиная с которой хвост <= keep_bytes (по символам, оценка сверху).
    // Простой приём: пока байтовая длина велика - режем по первому \n блоками.
    while (string_byte_length(tail) > keep_bytes) {
        var nl = string_pos("\n", tail);
        if (nl <= 0) {
            // Нет переводов строк - режем жёстко по символам.
            var over = string_byte_length(tail) - keep_bytes;
            // отрезаем примерно over символов с начала (оценка: 1 байт ~ 1 символ для ASCII)
            tail = string_delete(tail, 1, max(1, over));
            break;
        }
        tail = string_delete(tail, 1, nl);   // удалить до и включая первый \n
    }
    return "... [fastlogs: старые строки усечены при ротации] ...\n" + tail;
}

// =====================================================================================
// Внутреннее: дозаписать одну готовую строку лога в rec_text и (синхронно) в файл.
//   Применяет ротацию. При ошибке диска переключается в in-memory режим (disk_ok=false),
//   запись продолжает копиться в rec_text.
// =====================================================================================
function __fastlogs_append_line(line) {
    var rs = __fastlogs_rec_state();
    var piece = line + "\n";

    rs.rec_text += piece;
    var before = string_byte_length(rs.rec_text);
    rs.rec_text = __fastlogs_rotate_text(rs.rec_text);
    var rotated = (string_byte_length(rs.rec_text) != before);

    if (!FASTLOGS_PERSIST_ENABLED || !rs.disk_ok) return;

    try {
        __fastlogs_ensure_dir();
        if (rotated) {
            // После ротации перезаписываем файл целиком актуальным rec_text.
            __fastlogs_write_text_file(rs.file_path, rs.rec_text);
        } else {
            // Быстрый путь: дозапись в конец файла без чтения целого.
            __fastlogs_append_to_file(rs.file_path, piece);
        }
    } catch (_e) {
        rs.disk_ok = false;   // дальше работаем только в памяти, отправка всё равно сработает
    }
}

// REPLACEABLE: util. Дозаписать строку в конец файла (читает текущий буфер, пишет в хвост).
//   GM не даёт append-режима для буферов файла напрямую - грузим, seek в конец, дописываем.
function __fastlogs_append_to_file(rel_path, text) {
    var buf;
    if (file_exists(rel_path)) {
        buf = buffer_load(rel_path);            // grow, align 1
        if (buf < 0) buf = buffer_create(1, buffer_grow, 1);
        buffer_seek(buf, buffer_seek_end, 0);   // в конец существующих данных
    } else {
        buf = buffer_create(1, buffer_grow, 1);
    }
    if (string_byte_length(text) > 0) buffer_write(buf, buffer_text, text);
    buffer_save_ext(buf, rel_path, 0, buffer_tell(buf));   // // TODO verify порядок аргументов buffer_save_ext
    buffer_delete(buf);
}

// REPLACEABLE: util. Простой guid сессии (без зависимостей). Время + случайность.
function __fastlogs_make_guid() {
    var a = string(date_current_datetime());
    var b = string(irandom(999999999));
    var c = string(get_timer());
    return md5_string_utf8(a + "-" + b + "-" + c);   // md5_string_utf8 - встроенная
}

// =====================================================================================
// Внутреннее: записать маркер начала сессии в файл (один раз за сессию, при первом включении
//   записи). Содержит guid + UTC + краткое устройство, чтобы в файле были видны границы.
// =====================================================================================
function __fastlogs_write_session_marker() {
    var rs = __fastlogs_rec_state();
    if (rs.session_mark) return;
    rs.session_mark = true;
    if (rs.session_guid == "") rs.session_guid = __fastlogs_make_guid();

    var dev = "os_type=" + string(os_type) + " ver=" + string(os_version);
    var line = "===== FASTLOGS SESSION " + rs.session_guid
             + " | " + __fastlogs_utc_iso()
             + " | " + dev + " =====";
    __fastlogs_append_line(line);
}

// =====================================================================================
// Внутреннее: подгрузить персист прошлых сессий и восстановить флаг записи.
//   Вызывается из fastlogs_init (core). Идемпотентно (loaded-флаг).
// =====================================================================================
function fastlogs_recorder_load_persisted() {
    if (!FASTLOGS_ENABLED) return;
    var rs = __fastlogs_rec_state();
    if (rs.loaded) return;
    rs.loaded = true;
    rs.session_guid = __fastlogs_make_guid();

    if (!FASTLOGS_PERSIST_ENABLED) return;

    try {
        // Подгрузить накопленный лог прошлых сессий.
        var prev_text = __fastlogs_read_text_file(rs.file_path);
        if (prev_text != "") {
            rs.rec_text = __fastlogs_rotate_text(prev_text);
        }

        // Восстановить флаг записи из ini.
        if (file_exists(rs.ini_path)) {
            ini_open(rs.ini_path);
            var was_recording = ini_read_real("recorder", "recording", 0);
            ini_close();
            if (was_recording >= 1) {
                // Продолжаем запись прошлой сессии (без повторного персиста ini внутри set).
                __fastlogs_state().recording = true;
                __fastlogs_write_session_marker();
            }
        }
    } catch (_e) {
        rs.disk_ok = false;   // диск недоступен - работаем in-memory
    }
}

// =====================================================================================
// Внутреннее: персист флага записи в ini (вызывается из fastlogs_record_set).
// =====================================================================================
function __fastlogs_persist_recording_flag(enabled) {
    if (!FASTLOGS_PERSIST_ENABLED) return;
    var rs = __fastlogs_rec_state();
    if (!rs.disk_ok) return;
    try {
        __fastlogs_ensure_dir();
        ini_open(rs.ini_path);
        ini_write_real("recorder", "recording", enabled ? 1 : 0);
        ini_close();
    } catch (_e) {
        rs.disk_ok = false;
    }
}

// =====================================================================================
// fastlogs_recorder_on_record(rec) - вызывается из flog ПОСЛЕ записи в кольцо.
//   Пишет строку на диск ТОЛЬКО при активной записи. flog ничего не персистит, когда выкл.
// =====================================================================================
function fastlogs_recorder_on_record(rec) {
    if (!FASTLOGS_ENABLED) return;
    var st = __fastlogs_state();
    if (!st.recording) return;   // запись выключена -> на диск ничего не идёт

    var rs = __fastlogs_rec_state();
    if (!rs.session_mark) __fastlogs_write_session_marker();
    __fastlogs_append_line(__fastlogs_format_record(rec));
}

// =====================================================================================
// fastlogs_recorder_flush_crash() - синхронный аварийный флаш ВСЕГО кольца на диск.
//   Используется из обработчика необработанного исключения: пишем даже если запись была
//   выключена, чтобы при краше состояние сохранилось (отправится на следующем запуске).
// =====================================================================================
function fastlogs_recorder_flush_crash() {
    if (!FASTLOGS_ENABLED) return;
    var rs = __fastlogs_rec_state();
    if (!rs.session_mark) {
        // Принудительно отметить сессию (на случай, если запись была выключена).
        rs.session_mark = false;
        __fastlogs_write_session_marker();
    }
    // Слить весь текущий снимок кольца (хронологически) в персист.
    var snap = fastlogs_ring_snapshot();   // из core
    for (var i = 0; i < array_length(snap); i++) {
        __fastlogs_append_line(__fastlogs_format_record(snap[i]));
    }
}

// =====================================================================================
// ПУБЛИЧНОЕ API записи (контракт PUBLIC-API).
// =====================================================================================

// Включить запись (эквивалент set(true)).
function fastlogs_record_start() {
    if (!FASTLOGS_ENABLED) return;
    fastlogs_record_set(true);
}

// Выключить запись (накопленное на диске остаётся).
function fastlogs_record_stop() {
    if (!FASTLOGS_ENABLED) return;
    fastlogs_record_set(false);
}

// Включить/выключить запись. Персистит флаг (ini) при FASTLOGS_PERSIST_ENABLED.
function fastlogs_record_set(enabled) {
    if (!FASTLOGS_ENABLED) return;
    var st = __fastlogs_state();
    var en = bool(enabled);
    if (st.recording == en) {
        // Идемпотентно, но всё равно убедимся, что флаг персиста синхронен.
        __fastlogs_persist_recording_flag(en);
        return;
    }
    st.recording = en;
    if (en) {
        var rs = __fastlogs_rec_state();
        if (!rs.session_mark) __fastlogs_write_session_marker();   // отметить старт записи
    }
    __fastlogs_persist_recording_flag(en);
}

// Текущее состояние записи. При !FASTLOGS_ENABLED -> false.
function fastlogs_is_recording() {
    if (!FASTLOGS_ENABLED) return false;
    return __fastlogs_state().recording;
}

// Очистить накопленный персист (память + файл на диске). В отличие от fastlogs_clear()
//   (которое чистит только кольцо), это стирает rolling-файл записи.
function fastlogs_record_clear() {
    if (!FASTLOGS_ENABLED) return;
    var rs = __fastlogs_rec_state();
    rs.rec_text     = "";
    rs.session_mark = false;
    if (FASTLOGS_PERSIST_ENABLED && rs.disk_ok) {
        try {
            if (file_exists(rs.file_path)) file_delete(rs.file_path);
        } catch (_e) { rs.disk_ok = false; }
    }
}

// =====================================================================================
// fastlogs_recorder_get_logtext() -> string
//   Отдаёт текст логов для payload logText. Источник по приоритету:
//     1) накопленный персист rec_text (прошлые + текущая сессия), если он непустой -
//        это главный источник, т.к. содержит историю между сессиями;
//     2) иначе - снимок текущего кольца в памяти (когда запись ни разу не включалась).
//   Усечение по FASTLOGS_MAX_LOG_BYTES делает payload-билдер (контракт), но на всякий случай
//   тут НЕ режем - отдаём полный накопленный текст, payload усечёт с пометкой.
//   logEncoding в payload остаётся "plain" (FASTLOGS_LOG_ENCODING) - текст не сжимаем.
// =====================================================================================
function fastlogs_recorder_get_logtext() {
    if (!FASTLOGS_ENABLED) return "";
    var rs = __fastlogs_rec_state();
    if (string_length(rs.rec_text) > 0) {
        return rs.rec_text;
    }
    // Фолбэк: запись не велась - собрать из кольца в памяти.
    var snap = fastlogs_ring_snapshot();   // из core
    var out = "";
    for (var i = 0; i < array_length(snap); i++) {
        out += __fastlogs_format_record(snap[i]) + "\n";
    }
    return out;
}
