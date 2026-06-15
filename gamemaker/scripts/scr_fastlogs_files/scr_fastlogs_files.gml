/// @description scr_fastlogs_files
// FastLogs GameMaker client - ОТПРАВКА ФАЙЛА / ПАПКИ (фича SEND-FILE).
// Назначение: из кода отправить произвольный ФАЙЛ или ПАПКУ на сервер и получить короткую
//   ссылку (как у отчёта), скачать через вьюер кнопкой Download. Часть ЯДРА плагина (любой проект).
//
// ТРАНСПОРТ: JSON + base64 на ОТДЕЛЬНЫЙ POST <BASE_URL>/api/files (НЕ multipart, НЕ внутри
//   лог-отчёта). Тело: { appId, platform, appVersion, name, mime, fileBase64, kind?, logId?,
//   groupId?, title?, retentionDays? }. Сам POST/разбор ответа - в scr_fastlogs_http
//   (fastlogs_files_post_internal) + Other_62 (ветка request_kind=="file").
//
// КАП: по DECODED-размеру блоба (FASTLOGS_MAX_FILE_BYTES, дефолт 25 MB) - проверяется НА
//   КЛИЕНТЕ до base64 (и на сервере). Для папки кап считается по размеру ИТОГОВОГО .zip.
//
// ПАПКА: зипуется НА КЛИЕНТЕ в ОДИН .zip методом STORE (без компрессии) - вручную в буфере,
//   для ПАРИТЕТА с Unity (один .zip). Структура ZIP (local headers + CRC32 + central directory
//   + EOCD) сверена с YAL-GameMaker/zip-writer и спецификацией PKZIP APPNOTE. buffer_crc32
//   возвращает CRC ДО финального XOR -> для ZIP нужен `^ $FFFFFFFF` (см. __fastlogs_zip_crc32).
//   Запасной вариант (group-upload по groupId) НЕ используется: zip-store подтверждён рабочим.
//
// PII: бинарь БЕЗ скраба (явный инвариант - redaction к блобу/именам файлов НЕ применяется,
//   только кап по размеру). Это сознательно: файл/сейв должны дойти как есть.
//
// ГЕЙТИНГ: КАЖДАЯ публичная функция при !FASTLOGS_ENABLED делает ранний return false.
//
// ЗАВИСИМОСТИ (реальные имена, сверено по коду соседних скриптов):
//   scr_fastlogs_http:    fastlogs_files_post_internal(body, [on_done]), fastlogs_send_status(...)
//   scr_fastlogs_device:  fastlogs_platform_string()
//   FASTLOGS_* макросы:   scr_fastlogs_config
// Сверка GML-API: GM-NOTES.md (buffer_*/file_find_*/buffer_crc32 - сверены WebSearch июнь 2026).

// =====================================================================================
// fastlogs_send_file(path, [opts]) -> bool
// Отправить ОДИН файл по пути path. opts (опц., struct): title, logId, groupId, mime,
//   retentionDays, kind, name (переопределить имя), onDone (колбэк результата).
// true если запрос поставлен; false если no-op (выключено / нет файла / превышен кап / нет
//   endpoint / уже идёт отправка).
// =====================================================================================
function fastlogs_send_file(path, opts = undefined) {
    if (!FASTLOGS_ENABLED) { return false; }
    if (!is_struct(opts)) { opts = {}; }

    if (!is_string(path) || string_length(path) == 0 || !file_exists(path)) {
        show_debug_message("[FastLogs] send_file: file not found: " + string(path));
        fastlogs_send_status("error", "Файл не найден", false);
        return false;
    }

    var buf = buffer_load(path);
    if (buf < 0) {
        show_debug_message("[FastLogs] send_file: buffer_load failed: " + path);
        fastlogs_send_status("error", "Не удалось прочитать файл", false);
        return false;
    }

    var name = variable_struct_exists(opts, "name") && is_string(opts.name) && string_length(opts.name) > 0
             ? opts.name
             : __fastlogs_basename(path);
    var mime = variable_struct_exists(opts, "mime") && is_string(opts.mime) && string_length(opts.mime) > 0
             ? opts.mime
             : __fastlogs_guess_mime(name);

    // Дефолтный kind="file" для паритета с Unity (SendFile -> "file"); явный opts.kind не трогаем.
    if (!variable_struct_exists(opts, "kind")) { opts.kind = "file"; }

    var ok = __fastlogs_send_buffer(buf, name, mime, opts);
    buffer_delete(buf);
    return ok;
}

// =====================================================================================
// fastlogs_send_folder(path, [opts]) -> bool
// Зазиповать папку path (рекурсивно, метод STORE) в один .zip и отправить. opts как у
//   fastlogs_send_file (name по умолчанию = <имя папки>.zip, mime = application/zip).
// true если запрос поставлен; false если no-op (выключено / нет папки / пусто / кап / занято).
// =====================================================================================
function fastlogs_send_folder(path, opts = undefined) {
    if (!FASTLOGS_ENABLED) { return false; }
    if (!is_struct(opts)) { opts = {}; }

    if (!is_string(path) || string_length(path) == 0 || !directory_exists(path)) {
        show_debug_message("[FastLogs] send_folder: directory not found: " + string(path));
        fastlogs_send_status("error", "Папка не найдена", false);
        return false;
    }

    // Собрать список файлов папки (рекурсивно). entries: [{ abs, rel }].
    var base = __fastlogs_strip_trailing_slash(path);
    var entries = [];
    __fastlogs_collect_dir_files(base, "", entries);
    if (array_length(entries) == 0) {
        show_debug_message("[FastLogs] send_folder: no files in: " + path);
        fastlogs_send_status("info", "Папка пуста", false);
        return false;
    }

    // Зип-store всех файлов в один буфер (rel-пути сохраняют структуру внутри архива).
    var zip = __fastlogs_zip_store(entries);
    if (zip < 0) {
        show_debug_message("[FastLogs] send_folder: zip build failed");
        fastlogs_send_status("error", "Не удалось упаковать папку", false);
        return false;
    }

    var name = variable_struct_exists(opts, "name") && is_string(opts.name) && string_length(opts.name) > 0
             ? opts.name
             : (__fastlogs_basename(base) + ".zip");
    var mime = variable_struct_exists(opts, "mime") && is_string(opts.mime) && string_length(opts.mime) > 0
             ? opts.mime
             : "application/zip";

    // Дефолтный kind="folder" для паритета с Unity (SendFolder -> "folder"); явный opts.kind не трогаем.
    if (!variable_struct_exists(opts, "kind")) { opts.kind = "folder"; }

    var ok = __fastlogs_send_buffer(zip, name, mime, opts);
    buffer_delete(zip);
    return ok;
}

// =====================================================================================
// fastlogs_send_files(paths, [opts]) -> bool
// Зазиповать НЕСКОЛЬКО файлов (массив путей) в один .zip (метод STORE) и отправить.
//   Имена в архиве - basename каждого пути (при коллизии добавляется числовой суффикс).
//   opts как у send_file (name по умолчанию = "files.zip", mime = application/zip).
// true если запрос поставлен; false если no-op (выключено / пусто / нет валидных файлов / кап).
// =====================================================================================
function fastlogs_send_files(paths, opts = undefined) {
    if (!FASTLOGS_ENABLED) { return false; }
    if (!is_struct(opts)) { opts = {}; }
    if (!is_array(paths) || array_length(paths) == 0) {
        show_debug_message("[FastLogs] send_files: empty paths");
        return false;
    }

    // Собрать entries: [{ abs, rel }] с уникальными rel-именами (basename + анти-коллизия).
    var entries = [];
    var used = {};
    for (var i = 0; i < array_length(paths); i++) {
        var p = paths[i];
        if (!is_string(p) || string_length(p) == 0 || !file_exists(p)) {
            show_debug_message("[FastLogs] send_files: skip missing: " + string(p));
            continue;
        }
        var nm = __fastlogs_basename(p);
        var rel = __fastlogs_unique_name(used, nm);
        variable_struct_set(used, rel, true);
        array_push(entries, { abs: p, rel: rel });
    }
    if (array_length(entries) == 0) {
        show_debug_message("[FastLogs] send_files: no valid files");
        fastlogs_send_status("error", "Нет файлов для отправки", false);
        return false;
    }

    var zip = __fastlogs_zip_store(entries);
    if (zip < 0) {
        show_debug_message("[FastLogs] send_files: zip build failed");
        fastlogs_send_status("error", "Не удалось упаковать файлы", false);
        return false;
    }

    var name = variable_struct_exists(opts, "name") && is_string(opts.name) && string_length(opts.name) > 0
             ? opts.name
             : "files.zip";
    var mime = variable_struct_exists(opts, "mime") && is_string(opts.mime) && string_length(opts.mime) > 0
             ? opts.mime
             : "application/zip";

    // Дефолтный kind="folder" для паритета с Unity (SendFiles -> "folder"); явный opts.kind не трогаем.
    if (!variable_struct_exists(opts, "kind")) { opts.kind = "folder"; }

    var ok = __fastlogs_send_buffer(zip, name, mime, opts);
    buffer_delete(zip);
    return ok;
}

// =====================================================================================
// Внутреннее: общий путь "буфер -> кап -> base64 -> JSON-тело -> POST /api/files".
//   buf не уничтожаем (владелец - вызывающий). true если запрос поставлен.
// =====================================================================================
function __fastlogs_send_buffer(buf, name, mime, opts) {
    var size = buffer_get_size(buf);
    if (size <= 0) {
        show_debug_message("[FastLogs] send: empty payload (0 bytes)");
        fastlogs_send_status("error", "Пустой файл", false);
        return false;
    }

    // КАП по DECODED-размеру (ДО base64). Кап на клиенте И на сервере (контракт).
    var cap = FASTLOGS_MAX_FILE_BYTES;
    if (is_real(cap) && cap > 0 && size > cap) {
        show_debug_message("[FastLogs] send: file too large " + string(size) + " > cap " + string(cap));
        fastlogs_send_status("error", "Файл слишком большой ("
            + string(__fastlogs_human_bytes(size)) + " > "
            + string(__fastlogs_human_bytes(cap)) + ")", false);
        return false;
    }

    // base64 чистый (без data:) - как скриншот (buffer_base64_encode), БЕЗ PII-скраба (инвариант).
    var b64 = buffer_base64_encode(buf, 0, size);
    if (!is_string(b64) || string_length(b64) == 0) {
        show_debug_message("[FastLogs] send: base64 encode failed");
        fastlogs_send_status("error", "Ошибка кодирования файла", false);
        return false;
    }

    var body = __fastlogs_build_file_body(name, mime, b64, opts);
    if (!is_string(body) || string_length(body) == 0) { return false; }

    fastlogs_send_status("sending", "Отправка файла...", false);

    var on_done = variable_struct_exists(opts, "onDone") && is_method(opts.onDone) ? opts.onDone : undefined;
    return fastlogs_files_post_internal(body, on_done);
}

// =====================================================================================
// Внутреннее: собрать JSON-тело /api/files по контракту. Пустые опц. поля опускаем.
// =====================================================================================
function __fastlogs_build_file_body(name, mime, file_base64, opts) {
    // appVersion: макрос -> GM_version (как в payload-билдере).
    var app_version = FASTLOGS_APP_VERSION;
    if (!is_string(app_version) || string_length(app_version) == 0) {
        app_version = string(GM_version);
    }

    var body = {};
    body.appId      = FASTLOGS_APP_ID;
    body.platform   = fastlogs_platform_string();   // тот же маппер, что у лог-отчёта
    body.appVersion = app_version;
    body.name       = name;
    body.mime       = mime;
    body.fileBase64 = file_base64;

    // kind (опц.) - тип вложения (напр. "file"/"save"). Пустое опускаем.
    if (variable_struct_exists(opts, "kind") && is_string(opts.kind) && string_length(opts.kind) > 0) {
        body.kind = opts.kind;
    }
    // logId (опц.) - привязка к существующему лог-отчёту (показ в attachments вьюера).
    if (variable_struct_exists(opts, "logId") && is_string(opts.logId) && string_length(opts.logId) > 0) {
        body.logId = opts.logId;
    }
    // groupId (опц.) - группировка нескольких аплоадов (запасной group-upload путь).
    if (variable_struct_exists(opts, "groupId") && is_string(opts.groupId) && string_length(opts.groupId) > 0) {
        body.groupId = opts.groupId;
    }
    // title (опц., <=120) - подпись.
    if (variable_struct_exists(opts, "title") && is_string(opts.title) && string_length(opts.title) > 0) {
        var t = opts.title;
        if (string_length(t) > 120) { t = string_copy(t, 1, 120); }
        body.title = t;
    }
    // retentionDays (опц.) - per-request override; <1 не шлём (-1 = дефолт сервера).
    var ret = variable_struct_exists(opts, "retentionDays") ? opts.retentionDays : FASTLOGS_RETENTION_DAYS;
    if (is_real(ret) && ret >= 1) { body.retentionDays = floor(ret); }

    return json_stringify(body);
}

// =====================================================================================
// ZIP-STORE (без компрессии) В БУФЕР. entries: массив { abs, rel } - абсолютный путь файла
//   и его путь ВНУТРИ архива (rel, с прямыми слешами). Возвращает grow-буфер с полным .zip
//   (владелец - вызывающий, buffer_delete после отправки) либо -1 при неудаче.
// Структура (PKZIP APPNOTE, метод 0=STORE): для каждого файла - Local File Header + сырые
//   данные; затем Central Directory (по записи на файл); затем End Of Central Directory.
//   Флаг 0x0800 (UTF-8 имена) выставлен -> не-ASCII rel-пути валидны. CRC32 - PKZIP-стандарт
//   (buffer_crc32 ^ $FFFFFFFF). DOS time/date - текущее локальное время (или 0, безопасно).
// =====================================================================================
function __fastlogs_zip_store(entries) {
    var n = array_length(entries);
    if (n <= 0) { return -1; }

    var out = buffer_create(1024, buffer_grow, 1);
    var dos = __fastlogs_dos_datetime();   // { time, date }

    // Метаданные для central directory: на каждый файл сохраняем смещение local header,
    //   crc, размер и имя (в байтах). central directory пишем после данных.
    var meta = array_create(n, undefined);

    for (var i = 0; i < n; i++) {
        var e = entries[i];
        var abs = e.abs;
        var rel = e.rel;

        var fbuf = buffer_load(abs);
        if (fbuf < 0) {
            // Не удалось прочитать файл - пропускаем, но не валим весь архив.
            show_debug_message("[FastLogs] zip: skip unreadable: " + string(abs));
            meta[i] = undefined;
            continue;
        }
        var fsize = buffer_get_size(fbuf);
        var crc   = __fastlogs_zip_crc32(fbuf, fsize);
        var lho   = buffer_tell(out);   // смещение local header этого файла

        var name_bytes = string_byte_length(rel);

        // --- Local File Header (30 байт фикс + имя) ---
        buffer_write(out, buffer_s32, 67324752);    // 0x04034b50 signature
        buffer_write(out, buffer_u16, 20);          // version needed to extract (2.0)
        buffer_write(out, buffer_u16, 2048);        // general purpose flags (bit 11 = UTF-8 имя)
        buffer_write(out, buffer_u16, 0);           // compression method 0 = STORE
        buffer_write(out, buffer_u16, dos.time);    // last mod file time (DOS)
        buffer_write(out, buffer_u16, dos.date);    // last mod file date (DOS)
        buffer_write(out, buffer_u32, crc);         // CRC-32 (PKZIP-стандарт)
        buffer_write(out, buffer_s32, fsize);       // compressed size (= uncompressed, STORE)
        buffer_write(out, buffer_s32, fsize);       // uncompressed size
        buffer_write(out, buffer_u16, name_bytes);  // file name length (байт)
        buffer_write(out, buffer_u16, 0);           // extra field length
        if (name_bytes > 0) buffer_write(out, buffer_text, rel);   // file name (UTF-8, без \0)

        // --- сырые данные файла (STORE) ---
        //   buffer_copy НЕ авто-растит grow-буфер и НЕ двигает seek назначения (сверено с
        //   YAL zip-writer zip_impl_write) -> ресайзим вручную перед копированием и сдвигаем seek.
        if (fsize > 0) __fastlogs_buffer_append(out, fbuf, 0, fsize);

        buffer_delete(fbuf);

        meta[i] = { rel: rel, name_bytes: name_bytes, crc: crc, size: fsize, lho: lho };
    }

    // Смещение начала central directory.
    var cd_start = buffer_tell(out);

    var cd_count = 0;
    for (var j = 0; j < n; j++) {
        var m = meta[j];
        if (is_undefined(m)) continue;   // пропущенный (нечитаемый) файл

        // --- Central Directory File Header (46 байт фикс + имя) ---
        buffer_write(out, buffer_s32, 33639248);    // 0x02014b50 signature
        buffer_write(out, buffer_u16, 20);          // version made by
        buffer_write(out, buffer_u16, 20);          // version needed
        buffer_write(out, buffer_u16, 2048);        // flags (UTF-8 имя)
        buffer_write(out, buffer_u16, 0);           // method 0 = STORE
        buffer_write(out, buffer_u16, dos.time);    // mod time
        buffer_write(out, buffer_u16, dos.date);    // mod date
        buffer_write(out, buffer_u32, m.crc);       // CRC-32
        buffer_write(out, buffer_s32, m.size);      // compressed size
        buffer_write(out, buffer_s32, m.size);      // uncompressed size
        buffer_write(out, buffer_u16, m.name_bytes);// file name length
        buffer_write(out, buffer_u16, 0);           // extra field length
        buffer_write(out, buffer_u16, 0);           // file comment length
        buffer_write(out, buffer_u16, 0);           // disk number start
        buffer_write(out, buffer_u16, 0);           // internal file attributes
        buffer_write(out, buffer_s32, 0);           // external file attributes
        buffer_write(out, buffer_s32, m.lho);       // relative offset of local header
        if (m.name_bytes > 0) buffer_write(out, buffer_text, m.rel);   // file name

        cd_count += 1;
    }

    if (cd_count == 0) {
        // Ни одного читаемого файла не попало в архив.
        buffer_delete(out);
        return -1;
    }

    var cd_end  = buffer_tell(out);
    var cd_size = cd_end - cd_start;

    // --- End Of Central Directory (22 байта) ---
    buffer_write(out, buffer_s32, 101010256);   // 0x06054b50 signature
    buffer_write(out, buffer_u16, 0);           // number of this disk
    buffer_write(out, buffer_u16, 0);           // disk with start of central directory
    buffer_write(out, buffer_u16, cd_count);    // entries in central dir on this disk
    buffer_write(out, buffer_u16, cd_count);    // total entries in central dir
    buffer_write(out, buffer_s32, cd_size);     // size of central directory
    buffer_write(out, buffer_s32, cd_start);    // offset of central dir from start
    buffer_write(out, buffer_u16, 0);           // ZIP file comment length

    // Усечь grow-буфер до фактически записанного размера (иначе хвост резервной ёмкости попал бы
    //   в base64/кап). buffer_resize до позиции конца записи.
    var total = buffer_tell(out);
    buffer_resize(out, total);
    buffer_seek(out, buffer_seek_start, 0);
    return out;
}

// =====================================================================================
// Внутреннее: CRC-32 PKZIP-стандарта для участка [0, size) буфера. buffer_crc32 в GM
//   возвращает значение ДО финального XOR -> приводим к стандарту `^ $FFFFFFFF`. Результат
//   маскируем в беззнаковый 32-битный (buffer_u32 ожидает 0..$FFFFFFFF). Сверено: YAL zip-writer
//   делает ровно `buffer_crc32(...) ^ 0xFFFFFFFF`.
// =====================================================================================
function __fastlogs_zip_crc32(buf, size) {
    if (size <= 0) {
        // CRC пустых данных по стандарту = 0.
        return 0;
    }
    var c = buffer_crc32(buf, 0, size);
    // XOR в стандарт + маска в 32 бита беззнаковое (битовые операции GML - 64-битные int).
    return (c ^ $FFFFFFFF) & $FFFFFFFF;
}

// =====================================================================================
// Внутреннее: дописать [src_pos, src_pos+src_len) из src в КОНЕЦ позиции записи dst (grow).
//   buffer_copy не растит grow-буфер и не двигает seek dst -> ресайзим вручную (удвоением) и
//   сдвигаем seek сами. Аналог YAL zip_impl_write. Для буферных типов buffer_write выше grow
//   работает сам, но buffer_copy - нет, поэтому отдельный хелпер только для сырых данных.
// =====================================================================================
function __fastlogs_buffer_append(dst, src, src_pos, src_len) {
    if (src_len <= 0) return;
    var dst_pos  = buffer_tell(dst);
    var dst_next = dst_pos + src_len;
    var dst_size = buffer_get_size(dst);
    if (dst_next > dst_size) {
        do { dst_size *= 2; } until (dst_next <= dst_size);
        buffer_resize(dst, dst_size);
    }
    buffer_copy(src, src_pos, src_len, dst, dst_pos);
    buffer_seek(dst, buffer_seek_start, dst_next);
}

// =====================================================================================
// Внутреннее: рекурсивно собрать файлы каталога. base - абсолютный корень; sub - относительный
//   префикс внутри архива ("" на верхнем уровне). Заполняет out массивом { abs, rel }.
//   rel использует прямые слеши (ZIP-конвенция). Пропускает "." и "..".
// =====================================================================================
function __fastlogs_collect_dir_files(base, sub, out) {
    var dir = (sub == "") ? base : (base + "/" + sub);
    // fa_directory -> file_find_first вернёт И файлы, И подкаталоги; различаем directory_exists.
    var fname = file_find_first(dir + "/*.*", fa_directory);
    var found = [];
    while (fname != "") {
        if (fname != "." && fname != "..") array_push(found, fname);
        fname = file_find_next();
    }
    file_find_close();   // ОБЯЗАТЕЛЬНО до рекурсии (один активный поиск за раз)

    for (var i = 0; i < array_length(found); i++) {
        var nm  = found[i];
        var abs = dir + "/" + nm;
        var rel = (sub == "") ? nm : (sub + "/" + nm);
        if (directory_exists(abs)) {
            __fastlogs_collect_dir_files(base, rel, out);   // рекурсия в подкаталог
        } else if (file_exists(abs)) {
            array_push(out, { abs: abs, rel: rel });
        }
    }
}

// =====================================================================================
// Хелперы путей/имён/mime/времени.
// =====================================================================================

// basename: последний сегмент пути (после последнего / или \).
function __fastlogs_basename(path) {
    if (!is_string(path)) return "";
    var p = __fastlogs_strip_trailing_slash(path);
    var slash = max(__fastlogs_last_pos("/", p), __fastlogs_last_pos("\\", p));
    if (slash <= 0) return p;
    return string_delete(p, 1, slash);
}

// Срезать завершающие слеши (game_save_id и пути папок часто оканчиваются на /).
function __fastlogs_strip_trailing_slash(path) {
    var p = path;
    while (string_length(p) > 1) {
        var last = string_char_at(p, string_length(p));
        if (last == "/" || last == "\\") { p = string_copy(p, 1, string_length(p) - 1); }
        else break;
    }
    return p;
}

// Позиция ПОСЛЕДНЕГО вхождения substr в str (0 если нет). string_pos ищет первое -> идём вперёд.
function __fastlogs_last_pos(substr, str) {
    var last = 0;
    var from = 1;
    var sl = string_length(substr);
    while (true) {
        var idx = string_pos_ext(substr, str, from);
        if (idx <= 0) break;
        last = idx;
        from = idx + sl;
    }
    return last;
}

// Уникальное имя в архиве: если name уже занято в used - добавляем " (k)" перед расширением.
function __fastlogs_unique_name(used, name) {
    if (!variable_struct_exists(used, name)) return name;
    var dot = __fastlogs_last_pos(".", name);
    var stem = (dot > 1) ? string_copy(name, 1, dot - 1) : name;
    var ext  = (dot > 1) ? string_copy(name, dot, string_length(name) - dot + 1) : "";
    var k = 1;
    var candidate = name;
    while (variable_struct_exists(used, candidate)) {
        candidate = stem + " (" + string(k) + ")" + ext;
        k += 1;
    }
    return candidate;
}

// Угадать MIME по расширению имени (минимальный набор; иначе application/octet-stream).
function __fastlogs_guess_mime(name) {
    var dot = __fastlogs_last_pos(".", name);
    if (dot <= 0) return "application/octet-stream";
    var ext = string_lower(string_copy(name, dot + 1, string_length(name) - dot));
    switch (ext) {
        case "txt":  case "log": case "ini": case "csv": return "text/plain";
        case "json": return "application/json";
        case "xml":  return "application/xml";
        case "png":  return "image/png";
        case "jpg":  case "jpeg": return "image/jpeg";
        case "gif":  return "image/gif";
        case "bmp":  return "image/bmp";
        case "webp": return "image/webp";
        case "zip":  return "application/zip";
        case "gz":   return "application/gzip";
        case "wav":  return "audio/wav";
        case "ogg":  return "audio/ogg";
        case "mp3":  return "audio/mpeg";
        case "mp4":  return "video/mp4";
        case "pdf":  return "application/pdf";
        case "yy":   case "yyp": return "application/json";
        case "sav":  case "save": case "dat": return "application/octet-stream";
    }
    return "application/octet-stream";
}

// DOS date/time для ZIP (локальное время). time = (h<<11)|(m<<5)|(s/2);
//   date = ((year-1980)<<9)|(month<<5)|day. Если год вне диапазона DOS - 0 (валидно, "не задано").
function __fastlogs_dos_datetime() {
    var dt = date_current_datetime();
    var y  = date_get_year(dt);
    var mo = date_get_month(dt);
    var d  = date_get_day(dt);
    var h  = date_get_hour(dt);
    var mi = date_get_minute(dt);
    var s  = date_get_second(dt);

    if (y < 1980 || y > 2107) { return { time: 0, date: 0 }; }
    var dos_time = (h << 11) | (mi << 5) | (s div 2);
    var dos_date = ((y - 1980) << 9) | (mo << 5) | d;
    return { time: dos_time, date: dos_date };
}

// Человекочитаемый размер (для сообщений об ошибке капа).
function __fastlogs_human_bytes(bytes) {
    if (bytes >= 1048576) return string(round(bytes / 1048576 * 10) / 10) + " MB";
    if (bytes >= 1024)    return string(round(bytes / 1024 * 10) / 10) + " KB";
    return string(bytes) + " B";
}
