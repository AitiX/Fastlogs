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
            // ПЕРФ (D): инкрементальный байтовый размер rec_text. Поддерживается при каждой
            //   дозаписи (+= string_byte_length(piece)), чтобы НЕ сканировать весь rec_text
            //   (до ~1 MB) на каждой строке. Полный O(n) скан (__fastlogs_rotate_text) зовётся
            //   только когда счётчик превысил лимит. После ротации счётчик пересинхронизируется.
            rec_bytes     : 0,       // байтовый размер rec_text (амортизированный O(1) учёт)
            session_mark  : false,   // записан ли маркер текущей сессии в файл
            session_guid  : "",      // guid текущей сессии (для маркера)
            file_path     : FASTLOGS_PERSIST_DIR + "/" + FASTLOGS_PERSIST_FILE,
            ini_path      : FASTLOGS_PERSIST_DIR + "/settings.ini",
            disk_ok       : true,    // false если файловые операции упали (тогда работаем in-memory)
            // ПЕРФ (D): БАТЧ записи на диск. Строки копятся тут и сбрасываются пачкой по
            //   таймеру/лимиту/перед отправкой/при краше - НЕ full-file IO на каждую строку.
            pending       : "",      // несброшенные на диск строки (уже учтены в rec_text)
            pending_bytes : 0,       // байтовый размер батча (для лимита FASTLOGS_PERSIST_FLUSH_MAX_BYTES)
            last_flush_us : -1,      // get_timer() последнего сброса (мкс); -1 = ещё не сбрасывали
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
// Внутреннее: применить ротацию к тексту (обрезать старое начало по лимиту, целостно по \n).
//   Возвращает структуру { text, bytes }: (возможно укороченный) текст и его точный байтовый
//   размер. Размер считается ЗДЕСЬ (за один проход внутри редкой ротации), чтобы вызывающий
//   мог пересинхронизировать инкрементальный счётчик rec_bytes без отдельного O(n) скана.
//   После обрезки в начале ставится пометка усечения. known_bytes (если >=0) - уже известный
//   байтовый размер text, чтобы не сканировать его повторно на входе.
// =====================================================================================
function __fastlogs_rotate_ex(text, known_bytes = -1) {
    var limit = max(1024, FASTLOGS_PERSIST_MAX_BYTES);
    var bytes = (known_bytes >= 0) ? known_bytes : string_byte_length(text);
    if (bytes <= limit) return { text : text, bytes : bytes };

    // Оставляем хвост ~половину лимита, чтобы не ротировать на каждой строке.
    var keep_bytes = limit div 2;
    // Идём с конца, отрезая по строкам, пока укладываемся в keep_bytes.
    var tail = text;
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
    var prefix    = "... [fastlogs: старые строки усечены при ротации] ...\n";
    var out_text  = prefix + tail;
    return { text : out_text, bytes : string_byte_length(out_text) };
}

// Обёртка прежней сигнатуры (используется на пути подгрузки персиста, где счётчик не важен).
function __fastlogs_rotate_text(text) {
    return __fastlogs_rotate_ex(text, -1).text;
}

// =====================================================================================
// Внутреннее: дозаписать одну готовую строку лога в rec_text и в БАТЧ (pending).
//   ПЕРФ (D): НЕ трогает диск на каждую строку. Строка копится в rs.pending; фактический
//   сброс пачкой делает __fastlogs_flush_pending (по таймеру из tick, по лимиту, перед
//   отправкой/при краше). Ротация rec_text всё ещё применяется в памяти; при ротации помечаем
//   батч как "нужна полная перезапись" (rewrite), т.к. дозапись хвоста после обрезки невалидна.
//   immediate=true (краш-путь) -> синхронно сбросить сразу же, не дожидаясь таймера.
// =====================================================================================
function __fastlogs_append_line(line, immediate = false) {
    var rs = __fastlogs_rec_state();
    var piece = line + "\n";

    // ПЕРФ (D): дозапись и инкрементальный учёт байтов - O(piece), БЕЗ скана всего rec_text.
    rs.rec_text  += piece;
    var piece_bytes = string_byte_length(piece);
    rs.rec_bytes += piece_bytes;

    // Полную O(n)-ротацию зовём ТОЛЬКО когда инкрементальный счётчик превысил лимит
    //   (редкое событие). Обычная строка -> дешёвая ветка ниже без скана rec_text.
    var rotated = false;
    var limit = max(1024, FASTLOGS_PERSIST_MAX_BYTES);
    if (rs.rec_bytes > limit) {
        var rot = __fastlogs_rotate_ex(rs.rec_text, rs.rec_bytes);   // считает точный размер внутри
        rotated      = (rot.bytes != rs.rec_bytes);
        rs.rec_text  = rot.text;
        rs.rec_bytes = rot.bytes;   // пересинхрон счётчика по факту ротации (без отдельного скана)
    }

    if (!FASTLOGS_PERSIST_ENABLED || !rs.disk_ok) return;

    if (rotated) {
        // Ротация: хвостовая дозапись невалидна (старое начало обрезано). Сбросим батч полной
        //   перезаписью файла целиком актуальным rec_text. Делаем сразу (ротация редкая).
        rs.pending       = "";
        rs.pending_bytes = 0;
        rs.last_flush_us = get_timer();
        try {
            __fastlogs_ensure_dir();
            __fastlogs_write_text_file(rs.file_path, rs.rec_text);
        } catch (_e) {
            rs.disk_ok = false;
        }
        return;
    }

    // Обычный путь: копим строку в батч (НИКАКОГО file IO здесь).
    rs.pending       += piece;
    rs.pending_bytes += string_byte_length(piece);

    // Сброс батча: немедленно (краш) либо при превышении лимита размера батча.
    if (immediate || rs.pending_bytes >= max(1, FASTLOGS_PERSIST_FLUSH_MAX_BYTES)) {
        __fastlogs_flush_pending();
    }
}

// =====================================================================================
// Внутреннее: сбросить батч (rs.pending) на диск ОДНОЙ дозаписью в хвост файла.
//   Это и есть единственная точка per-flush file IO (вместо per-log). Безопасно при пустом
//   батче (no-op). При ошибке диска -> in-memory режим (disk_ok=false), данные остаются в rec_text.
// =====================================================================================
function __fastlogs_flush_pending() {
    var rs = __fastlogs_rec_state();
    rs.last_flush_us = get_timer();
    if (string_length(rs.pending) == 0) return;
    if (!FASTLOGS_PERSIST_ENABLED || !rs.disk_ok) { rs.pending = ""; rs.pending_bytes = 0; return; }

    var batch = rs.pending;
    rs.pending       = "";
    rs.pending_bytes = 0;
    try {
        __fastlogs_ensure_dir();
        __fastlogs_append_to_file(rs.file_path, batch);   // одна дозапись пачкой в хвост
    } catch (_e) {
        rs.disk_ok = false;   // дальше только память; отправка всё равно сработает (rec_text цел)
    }
}

// =====================================================================================
// fastlogs_recorder_tick() - вызывать каждый Step из контроллера. ПЕРФ (D): дешёвая проверка
//   таймера; сбрасывает батч на диск не чаще раза в FASTLOGS_PERSIST_FLUSH_SECONDS. Без аллокаций
//   в кадре когда батч пуст (ранний выход). no-op при !FASTLOGS_ENABLED / выключенном персисте.
// =====================================================================================
function fastlogs_recorder_tick() {
    if (!FASTLOGS_ENABLED) return;
    if (!FASTLOGS_PERSIST_ENABLED) return;
    // Не создаём состояние, если рекордера ещё нет (тик дешёвый и безопасный).
    var st = __fastlogs_state();
    if (!variable_struct_exists(st, "rec") || !is_struct(st.rec)) return;
    var rs = st.rec;
    if (string_length(rs.pending) == 0) return;   // нечего сбрасывать -> ноль работы

    var flush_secs = FASTLOGS_PERSIST_FLUSH_SECONDS;
    if (!is_real(flush_secs) || flush_secs <= 0) {
        // 0 -> писать сразу (без батча по таймеру).
        __fastlogs_flush_pending();
        return;
    }
    var now_us = get_timer();
    if (rs.last_flush_us < 0) { rs.last_flush_us = now_us; }   // первая засечка
    if ((now_us - rs.last_flush_us) >= flush_secs * 1000000) {
        __fastlogs_flush_pending();
    }
}

// =====================================================================================
// fastlogs_recorder_flush() - публичный принудительный сброс батча на диск (перед отправкой,
//   чтобы logText/файл были актуальны). Безопасно при пустом батче.
// =====================================================================================
function fastlogs_recorder_flush() {
    if (!FASTLOGS_ENABLED) return;
    var st = __fastlogs_state();
    if (!variable_struct_exists(st, "rec") || !is_struct(st.rec)) return;
    __fastlogs_flush_pending();
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
        // Подгрузить накопленный лог прошлых сессий. Через _ex, чтобы сразу засинхронить
        //   инкрементальный счётчик rec_bytes (один скан здесь, дальше учёт амортизированный).
        var prev_text = __fastlogs_read_text_file(rs.file_path);
        if (prev_text != "") {
            var rot = __fastlogs_rotate_ex(prev_text, -1);
            rs.rec_text  = rot.text;
            rs.rec_bytes = rot.bytes;
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
    // Гарантированно сбросить всё накопленное (включая батч из обычной записи) синхронно на диск:
    //   при краше игра закроется после колбэка, таймерный сброс уже не сработает.
    __fastlogs_flush_pending();
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
    rs.rec_bytes    = 0;     // синхронно с rec_text сбрасываем инкрементальный счётчик
    rs.session_mark = false;
    if (FASTLOGS_PERSIST_ENABLED && rs.disk_ok) {
        try {
            if (file_exists(rs.file_path)) file_delete(rs.file_path);
        } catch (_e) { rs.disk_ok = false; }
    }
}

// =====================================================================================
// ПЕРСИСТ КРАШ-ОТЧЁТА + ДОСЫЛ ПРИ СТАРТЕ (фича #1, PENDING-QUEUE).
// -------------------------------------------------------------------------------------
// Модель: при авто-отправке по краху сначала СИНХРОННО пишем ГОТОВОЕ JSON-тело payload в
//   отдельный файл в каталоге pending (внутри game_save_id), затем пытаемся отправить.
//   На успех файл удаляем (по запомненному пути). На старте сканируем каталог и досылаем
//   неотправленное - так жёсткий краш, убивший процесс до завершения HTTP, доедет позже.
//   Кап очереди FASTLOGS_PENDING_MAX (старые сверх лимита отбрасываем).
//   Файлы - сырой UTF-8 JSON (через те же буферные хелперы, что и лог).
// =====================================================================================

// Каталог pending относительно game_save_id (как остальные пути рекордера).
function __fastlogs_pending_dir() {
    return FASTLOGS_PERSIST_DIR + "/" + FASTLOGS_PENDING_DIR;
}

// Убедиться, что каталог pending существует (родительский + сам).
function __fastlogs_pending_ensure_dir() {
    __fastlogs_ensure_dir();                       // FASTLOGS_PERSIST_DIR
    var d = __fastlogs_pending_dir();
    if (!directory_exists(d)) directory_create(d);
}

// Список файлов pending (ОТНОСИТЕЛЬНЫЕ пути dir+"/"+name), отсортированных по имени.
//   Имя файла начинается с zero-padded времени -> лексикографический порядок = хронологический.
function __fastlogs_pending_list() {
    var out = [];
    var d = __fastlogs_pending_dir();
    if (!directory_exists(d)) return out;
    // file_find_first(mask, attr): mask с путём; attr=0 -> только обычные файлы. Возвращает ИМЯ.
    var fname = file_find_first(d + "/*.json", 0);
    while (fname != "") {
        if (fname != "." && fname != "..") array_push(out, d + "/" + fname);
        fname = file_find_next();
    }
    file_find_close();
    array_sort(out, true);                          // по возрастанию имени (хронологически)
    return out;
}

// Применить кап очереди: удалить старейшие файлы сверх FASTLOGS_PENDING_MAX.
function __fastlogs_pending_enforce_cap() {
    var cap = max(1, FASTLOGS_PENDING_MAX);
    var files = __fastlogs_pending_list();          // отсортированы: старые первыми
    var over = array_length(files) - cap;
    for (var i = 0; i < over; i++) {
        try { if (file_exists(files[i])) file_delete(files[i]); } catch (_e) { /* best-effort */ }
    }
}

// =====================================================================================
// fastlogs_pending_write(body_json) -> string (путь файла) | ""
//   Синхронно записать готовое JSON-тело отчёта в очередь pending. Возвращает относительный
//   путь созданного файла (для последующего удаления на успехе) или "" при неудаче/выкл.
//   Имя: crash_<UTC-компактно>_<guid8>.json (сортируемое по времени).
// =====================================================================================
function fastlogs_pending_write(body_json) {
    if (!FASTLOGS_ENABLED) return "";
    if (!is_string(body_json) || string_length(body_json) == 0) return "";
    var rs = __fastlogs_rec_state();
    if (!rs.disk_ok) return "";

    var path = "";
    try {
        __fastlogs_pending_ensure_dir();
        // Компактная сортируемая метка времени из UTC ISO (убираем не-алфанумерику).
        var ts = __fastlogs_utc_iso();
        ts = string_replace_all(ts, "-", "");
        ts = string_replace_all(ts, ":", "");
        ts = string_replace_all(ts, "T", "");
        ts = string_replace_all(ts, "Z", "");
        var guid8 = string_copy(__fastlogs_make_guid(), 1, 8);
        path = __fastlogs_pending_dir() + "/crash_" + ts + "_" + guid8 + ".json";
        __fastlogs_write_text_file(path, body_json);   // сырой UTF-8 (как лог-файл)
        // После добавления применим кап (отбросим старейшие сверх лимита).
        __fastlogs_pending_enforce_cap();
    } catch (_e) {
        rs.disk_ok = false;
        return "";
    }
    return path;
}

// =====================================================================================
// fastlogs_pending_delete(path) -> void
//   Удалить один pending-файл по запомненному пути (на успешной отправке этого отчёта).
// =====================================================================================
function fastlogs_pending_delete(path) {
    if (!FASTLOGS_ENABLED) return;
    if (!is_string(path) || string_length(path) == 0) return;
    try { if (file_exists(path)) file_delete(path); } catch (_e) { /* best-effort */ }
}

// =====================================================================================
// fastlogs_pending_drain_next([exclude_path]) -> bool (поставлена ли отправка ОДНОГО файла)
//   Дренаж outbox ПО ОДНОМУ: найти старейший pending-файл (кроме exclude_path - только что
//   отправленного, чтобы не переслать его повторно) и поставить ОДНУ его отправку. Уважает
//   single-flight внутри fastlogs_pending_send (если занято/ждёт повтор - вернёт false, файл
//   остаётся в очереди). Битые/пустые файлы по пути удаляет, чтобы не застревали.
//   ЦЕПОЧКА: следующий файл запускает Async success-обработчик (Other_62) после завершения
//   предыдущего - так за сессию дренируется несколько файлов, а не один (раньше resend_all в
//   цикле упирался в single-flight, и все итерации кроме первой были no-op).
//   Возврат: true если запрос поставлен (есть что досылать и слой свободен); иначе false.
// =====================================================================================
function fastlogs_pending_drain_next(exclude_path = "") {
    if (!FASTLOGS_ENABLED) return false;
    if (!script_exists(asset_get_index("fastlogs_pending_send"))) return false;

    var files = __fastlogs_pending_list();          // старые первыми
    var ex = is_string(exclude_path) ? exclude_path : "";

    for (var i = 0; i < array_length(files); i++) {
        var fp = files[i];
        if (fp == ex) continue;                     // не пересылаем только что отправленный
        var body = __fastlogs_read_text_file(fp);
        if (!is_string(body) || string_length(body) == 0) {
            // Битый/пустой файл - удаляем, чтобы не застревал в очереди, и пробуем следующий.
            fastlogs_pending_delete(fp);
            continue;
        }
        // Одна отправка (http-слой удалит файл на успехе по этому пути). Single-flight внутри:
        //   если сейчас занято/ждёт повтор - вернёт false, выходим (подхватится позже).
        return fastlogs_pending_send(body, fp);
    }
    return false;                                   // очередь пуста (или остались только битые)
}

// =====================================================================================
// fastlogs_pending_resend_all() -> bool (запущена ли первая отправка цепочки)
//   ДРЕНАЖ НА СТАРТЕ (фича #1, бэкстоп). Вызывается из fastlogs_init на старте. Запускает ОДНУ
//   первую отправку дренаж-цепочки; СЛЕДУЮЩИЕ файлы досылает Async success-обработчик (Other_62)
//   по одному, пока в outbox есть файлы (в пределах FASTLOGS_PENDING_RESEND_PER_START за старт,
//   см. ограничитель в Other_62). Так за сессию дренируется несколько, а не один.
//   ПРЕЖДЕ: тут был цикл по fastlogs_pending_send, но single-flight (is_sending) делал все
//   итерации кроме первой no-op - реально слался лишь один файл. Теперь явная цепочка.
//   Каждый отчёт уже несёт готовое тело (timestampUtc/logText/counts/comment/tester/context/
//   breadcrumbs), поэтому шлём его как есть. Зависит от fastlogs_pending_send(body, file_path).
// =====================================================================================
function fastlogs_pending_resend_all() {
    if (!FASTLOGS_ENABLED) return false;
    // FIX-1: пометить эту цепочку как СТАРТ-бэкстоп. Лимит FASTLOGS_PENDING_RESEND_PER_START
    //   применяется в Other_62 ТОЛЬКО пока активна старт-цепочка (init_chain_active);
    //   живой idle-дренаж (после неё) этим лимитом не гейтится. Сбрасываем счётчик старта.
    if (script_exists(asset_get_index("fastlogs_http_get_state"))) {
        var hs = fastlogs_http_get_state();
        hs.init_chain_active = true;
        hs.init_drain_count  = 0;
    }
    // Старт цепочки: первый файл. Следующие подхватит Other_62 (success) через drain_next.
    var started = fastlogs_pending_drain_next("");
    if (!started) {
        // Нечего слать (outbox пуст) или слой занят -> старт-цепочки фактически нет.
        if (script_exists(asset_get_index("fastlogs_http_get_state"))) {
            fastlogs_http_get_state().init_chain_active = false;
        }
    } else {
        // Первый файл старт-цепочки поставлен -> учитываем его в PER_START-счётчике старта.
        if (script_exists(asset_get_index("fastlogs_http_get_state"))) {
            fastlogs_http_get_state().init_drain_count += 1;
        }
    }
    return started;
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
