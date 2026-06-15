/// @description scr_fastlogs_snapshot
// FastLogs GameMaker client - ПОЛНЫЙ СНИМОК ИГРЫ (фича SNAPSHOT).
// Назначение: ОДНИМ вызовом fastlogs_send_snapshot([opts]) собрать ОБЫЧНЫЙ ЛОГ-ОТЧЁТ (как
//   fastlogs_send: логи + контекст + breadcrumbs + срез устройства + опц. скриншот) И ВДОБАВОК
//   упаковать сохранения/данные игры в snapshot.zip, который ПРИКРЕПЛЯЕТСЯ К ТОМУ ЖЕ лог-отчёту
//   как вложение (kind="snapshot"). Результат: одна запись лога = читаемый отчёт + кнопка
//   "Download snapshot.zip" во вьюере.
//
// РАЗДЕЛЕНИЕ (важно, паритет с Unity SendSnapshot):
//   - ЛОГ-ОТЧЁТ (тело записи, видно во вьюере с фильтрами/секциями): логи + контекст +
//     breadcrumbs + срез устройства + опц. скриншот. Это СУЩЕСТВУЮЩИЙ путь отправки -
//     ПЕРЕИСПОЛЬЗУЕМ его без изменений (fastlogs_send -> fastlogs_build_payload_json).
//   - snapshot.zip (ВЛОЖЕНИЕ той же записи через logId, kind="snapshot"): ТОЛЬКО сейвы +
//     зарегистрированные данные. НЕ кладём в него собственные логи FastLogs (они УЖЕ являются
//     телом отчёта; включение их сюда рекурсивно дублировало бы данные).
//
// ИСТОЧНИК ПО УМОЛЧАНИЮ (работает из коробки, без регистрации): ВСЯ папка сейвов =
//   game_save_id (GM sandbox saves) рекурсивно, ИСКЛЮЧАЯ собственную дисковую папку FastLogs
//   (FASTLOGS_PERSIST_DIR - там лежат rolling-лог, settings.ini, pending/outbox, временный PNG
//   скриншота). Тоггл FASTLOGS_SNAPSHOT_INCLUDE_PERSISTENT (рантайм-override snapshotIncludePersistent).
//   snapshot.zip строится В ПАМЯТИ (grow-буфер), на диск (в game_save_id) НЕ пишется.
//
// РЕГИСТРАЦИЯ (добавляет источники ПОВЕРХ дефолтного): fastlogs_add_snapshot_source(path) /
//   fastlogs_add_snapshot_data(name, buffer_or_base64) / fastlogs_remove_snapshot_source(path) /
//   fastlogs_clear_snapshot_sources(). Глобальный реестр в global.__fastlogs.snapshot.
//
// КАП: по размеру ИТОГОВОГО snapshot.zip (FASTLOGS_MAX_SNAPSHOT_BYTES, дефолт = FASTLOGS_MAX_FILE_BYTES) -
//   тот же кап-механизм, что у файла/папки (проверяется в __fastlogs_send_buffer на клиенте и
//   сервером). Превышение -> вложение НЕ уходит (но лог-отчёт уже отправлен).
//
// PII: сейвы могут содержать персональные данные - это ОСОЗНАННОЕ ДЕЙСТВИЕ ДЕВА. Бинарь БЕЗ
//   скраба (инвариант файлового пути): redaction к блобу/именам файлов НЕ применяется, только кап.
//
// ГЕЙТИНГ: дев-онли, как и остальное (#if FASTLOGS_ENABLED / [Conditional] в ритейле). КАЖДАЯ
//   публичная функция при !FASTLOGS_ENABLED делает ранний return (no-op).
//
// ПОРЯДОК (почему logId узнаём асинхронно): logId присваивает СЕРВЕР в ответе на лог-отчёт
//   (Other_62 -> { id, url }). Поэтому snapshot.zip строится и шлётся НЕ сразу, а в КОЛБЭКЕ
//   после УСПЕХА лог-отчёта: ставим в http-состоянии log_on_done -> по успеху Other_62 зовёт его
//   с готовым logId -> мы строим zip и шлём через тот же файловый путь с logId+kind="snapshot".
//   Так вложение привязывается ИМЕННО к только что созданной записи (а не к чужой/устаревшей).
//
// REUSE, НЕ ДУБЛИРОВАТЬ (сверено по коду соседних скриптов):
//   scr_fastlogs_http:    fastlogs_send(opts)               - обычная отправка лог-отчёта
//                         fastlogs_files_post_internal(...)  - (косвенно через send_buffer)
//                         fastlogs_http_get_state()          - http-подсостояние (log_on_done хук)
//                         fastlogs_send_status(...)
//   scr_fastlogs_files:   __fastlogs_zip_store(entries)      - #6a zip-store в буфер (метод STORE)
//                         __fastlogs_send_buffer(buf,name,mime,opts) - кап -> base64 -> /api/files
//                         __fastlogs_strip_trailing_slash / __fastlogs_unique_name / __fastlogs_human_bytes
//   scr_fastlogs_core:    __fastlogs_state(), fastlogs_session_id()
//   FASTLOGS_* макросы:   scr_fastlogs_config
// Сверка GML-API: GM-NOTES.md (file_find_*/buffer_*/directory_exists - сверены).

// =====================================================================================
// КОНФИГ (локальные макросы фичи, чтобы не раздувать scr_fastlogs_config; интегратор может
//   переопределить рантаймом через fastlogs_init({...}) - см. __fastlogs_cfg в core).
// -------------------------------------------------------------------------------------
// Включать ли в snapshot.zip ВСЮ папку сейвов (game_save_id) по умолчанию. true -> дефолтный
//   источник активен (плюс зарегистрированные); false -> только зарегистрированные источники.
#macro FASTLOGS_SNAPSHOT_INCLUDE_PERSISTENT true
// Кап по размеру итогового snapshot.zip (байт). По умолчанию = FASTLOGS_MAX_FILE_BYTES (тот же
//   серверный MAX_FILE_BYTES). Кап применяется в __fastlogs_send_buffer (как у файла/папки).
#macro FASTLOGS_MAX_SNAPSHOT_BYTES FASTLOGS_MAX_FILE_BYTES

// =====================================================================================
// Внутреннее: лениво создать и вернуть подсостояние snapshot внутри global.__fastlogs.
//   sources : массив зарегистрированных источников-папок { path } (абсолютные/относительные пути).
//   data    : массив зарегистрированных байтовых данных { name, bytes_b64 } (имя в архиве + base64).
//   Храним в едином global.__fastlogs (как остальные подсостояния), чтобы публичное API звалось
//   из любого контекста без with/instance_find.
// =====================================================================================
function __fastlogs_snap_state() {
    var st = __fastlogs_state();   // core
    if (!variable_struct_exists(st, "snapshot") || !is_struct(st.snapshot)) {
        st.snapshot = {
            sources : [],   // [{ path }]
            data    : [],   // [{ name, bytes_b64 }]
        };
    }
    return st.snapshot;
}

// =====================================================================================
// fastlogs_add_snapshot_source(path) -> bool
// Зарегистрировать ДОПОЛНИТЕЛЬНУЮ папку-источник для snapshot.zip (поверх дефолтной папки сейвов).
//   path - путь к существующей папке (как у fastlogs_send_folder). Дубликаты не добавляются.
//   true если добавлено; false если no-op (выключено / пустой путь / уже есть).
// =====================================================================================
function fastlogs_add_snapshot_source(path) {
    if (!FASTLOGS_ENABLED) { return false; }
    if (!is_string(path) || string_length(path) == 0) { return false; }

    var snap = __fastlogs_snap_state();
    var norm = __fastlogs_strip_trailing_slash(path);   // нормализуем для сравнения (reuse files)
    for (var i = 0; i < array_length(snap.sources); i++) {
        if (snap.sources[i].path == norm) { return false; }   // уже зарегистрирован
    }
    array_push(snap.sources, { path: norm });
    return true;
}

// =====================================================================================
// fastlogs_add_snapshot_data(name, buffer_or_base64) -> bool
// Зарегистрировать произвольные ДАННЫЕ В ПАМЯТИ как файл внутри snapshot.zip (поверх папок).
//   name - имя файла в архиве (непустое). Второй аргумент:
//     - buffer (real, существующий)  -> кодируем его содержимое в base64 СЕЙЧАС (снимок данных;
//       вызывающий остаётся владельцем буфера, мы его НЕ удаляем и не держим ссылку);
//     - string                       -> трактуем как УЖЕ готовый base64 (как принимает
//       fastlogs_send_file через провайдер данных).
//   true если добавлено; false если no-op (выключено / пустое имя / неверные данные).
// =====================================================================================
function fastlogs_add_snapshot_data(name, buffer_or_base64) {
    if (!FASTLOGS_ENABLED) { return false; }
    if (!is_string(name) || string_length(name) == 0) { return false; }

    var b64 = "";
    if (is_string(buffer_or_base64)) {
        // Уже base64 - берём как есть (провайдер данных сам кодирует/предоставляет).
        b64 = buffer_or_base64;
    } else if (is_real(buffer_or_base64) && buffer_exists(buffer_or_base64)) {
        // Буфер - кодируем СНИМОК его содержимого сейчас (владелец буфера - вызывающий).
        var sz = buffer_get_size(buffer_or_base64);
        if (sz <= 0) { return false; }
        b64 = buffer_base64_encode(buffer_or_base64, 0, sz);
    } else {
        show_debug_message("[FastLogs] add_snapshot_data: invalid data for '" + string(name) + "'");
        return false;
    }
    if (!is_string(b64) || string_length(b64) == 0) { return false; }

    var snap = __fastlogs_snap_state();
    array_push(snap.data, { name: name, bytes_b64: b64 });
    return true;
}

// =====================================================================================
// fastlogs_remove_snapshot_source(path) -> bool
// Снять ранее зарегистрированную папку-источник. true если что-то удалено; false иначе/выключено.
// =====================================================================================
function fastlogs_remove_snapshot_source(path) {
    if (!FASTLOGS_ENABLED) { return false; }
    if (!is_string(path) || string_length(path) == 0) { return false; }

    var snap = __fastlogs_snap_state();
    var norm = __fastlogs_strip_trailing_slash(path);
    var removed = false;
    var kept = [];
    for (var i = 0; i < array_length(snap.sources); i++) {
        if (snap.sources[i].path == norm) { removed = true; }
        else { array_push(kept, snap.sources[i]); }
    }
    snap.sources = kept;
    return removed;
}

// =====================================================================================
// fastlogs_clear_snapshot_sources() -> void
// Очистить ВСЕ зарегистрированные источники-папки И данные. Дефолтный источник (папка сейвов)
//   этим НЕ затрагивается - он управляется FASTLOGS_SNAPSHOT_INCLUDE_PERSISTENT / opts.
// =====================================================================================
function fastlogs_clear_snapshot_sources() {
    if (!FASTLOGS_ENABLED) { return; }
    var snap = __fastlogs_snap_state();
    snap.sources = [];
    snap.data    = [];
}

// =====================================================================================
// fastlogs_send_snapshot([opts]) -> bool
// ОДИН вызов: отправить обычный ЛОГ-ОТЧЁТ И прикрепить к нему snapshot.zip (сейвы + источники).
//   opts (опц., struct) - пробрасывается в лог-отправку fastlogs_send (title/comment/screenshot/
//   retentionDays/extraDevice и т.п.), плюс снимок-специфичные поля:
//     includePersistent (bool) - override FASTLOGS_SNAPSHOT_INCLUDE_PERSISTENT для этого вызова;
//     snapshotName (string)    - имя архива во вложении (деф. "snapshot.zip");
//     snapshotTitle (string)   - title вложения (деф. "Game snapshot");
//     onSnapshotDone (function(result)) - колбэк завершения АПЛОАДА snapshot.zip (как onDone у
//                                файлового пути: { success, id, url, downloadUrl, statusCode, error }).
//   ВНИМАНИЕ: snapshot.zip строится и уходит ТОЛЬКО ПОСЛЕ УСПЕХА лог-отчёта (logId узнаём из
//     ответа сервера). Если лог-отчёт не доставлен - вложение не отправляется (привязывать не к чему).
//   Возврат: true если ЛОГ-отправка поставлена (как fastlogs_send); false если no-op (выключено /
//     нет endpoint / уже идёт отправка). Итог отправки и вложения приходит ПОЗЖЕ (тосты/колбэки).
// =====================================================================================
function fastlogs_send_snapshot(opts = undefined) {
    if (!FASTLOGS_ENABLED) { return false; }
    if (!is_struct(opts)) { opts = {}; }

    // Снимок-специфичные опции вынимаем СЕЙЧАС (до проброса в fastlogs_send), чтобы замкнуть их
    //   в отложенный колбэк построения zip. Дефолт includePersistent: opts -> рантайм-cfg -> макрос.
    var inc_persistent = FASTLOGS_SNAPSHOT_INCLUDE_PERSISTENT;
    try { inc_persistent = __fastlogs_cfg("snapshotIncludePersistent", FASTLOGS_SNAPSHOT_INCLUDE_PERSISTENT); }
    catch (_eci) { inc_persistent = FASTLOGS_SNAPSHOT_INCLUDE_PERSISTENT; }
    if (variable_struct_exists(opts, "includePersistent")) { inc_persistent = bool(opts.includePersistent); }

    var snap_name = (variable_struct_exists(opts, "snapshotName") && is_string(opts.snapshotName) && string_length(opts.snapshotName) > 0)
                  ? opts.snapshotName : "snapshot.zip";
    var snap_title = (variable_struct_exists(opts, "snapshotTitle") && is_string(opts.snapshotTitle) && string_length(opts.snapshotTitle) > 0)
                   ? opts.snapshotTitle : "Game snapshot";
    var snap_cb = (variable_struct_exists(opts, "onSnapshotDone") && is_method(opts.onSnapshotDone))
                ? opts.onSnapshotDone : undefined;

    // Пометить лог-отчёт в каталоге вьюера, если интегратор не задал свой title (необязательно,
    //   но помогает отличать снимки в списке). Не перетираем явный opts.title.
    if (!variable_struct_exists(opts, "title")) { opts.title = "Snapshot"; }

    // ОТЛОЖЕННЫЙ КОЛБЭК (вызовется из Other_62 по успеху лог-отчёта с готовым logId). Состояние
    //   снимка замыкаем в struct snap_ctx и привязываем method(snap_ctx, ...): внутри self ==
    //   snap_ctx - так колбэк не зависит от живого опционального opts (тот же приём, что
    //   method(...) у group-upload в scr_fastlogs_files). is_method() в Other_62 пройдёт (это
    //   bound-метод). Снимок-опции уже извлечены выше и попадают в snap_ctx.
    var snap_ctx = {
        include_persistent : bool(inc_persistent),
        name               : snap_name,
        title              : snap_title,
        on_done            : snap_cb,
    };
    var hs = fastlogs_http_get_state();
    hs.log_on_done = method(snap_ctx, function(log_id) {
        // self = snap_ctx (struct контекста снимка). log_id - id только что созданной записи.
        __fastlogs_snapshot_after_log(log_id, self.include_persistent, self.name, self.title, self.on_done);
    });

    // Запустить ОБЫЧНУЮ отправку лог-отчёта (переиспользуем без изменений). Если она не
    //   поставилась (no-op) - снимать хук, чтобы он не сработал на чужой следующей отправке.
    var started = fastlogs_send(opts);
    if (!started) {
        hs.log_on_done = undefined;
    }
    return started;
}

// =====================================================================================
// Внутреннее: вызывается из Other_62 ПОСЛЕ УСПЕХА лог-отчёта (с готовым logId). Строит
//   snapshot.zip (дефолтный источник + зарегистрированные) и шлёт его через файловый путь с
//   привязкой logId + kind="snapshot". best-effort: не должно ронять Async-обработчик.
//   include_persistent/name/title/on_done замкнуты при постановке снимка (см. fastlogs_send_snapshot).
// =====================================================================================
function __fastlogs_snapshot_after_log(log_id, include_persistent, name, title, on_done) {
    if (!FASTLOGS_ENABLED) { return; }
    if (!is_string(log_id) || string_length(log_id) == 0) {
        // Сервер не вернул id записи - привязать вложение не к чему. Не строим/не шлём.
        show_debug_message("[FastLogs] snapshot: log succeeded but no logId -> snapshot not attached");
        if (is_method(on_done)) {
            try { on_done({ success: false, id: "", url: "", downloadUrl: "", statusCode: 0, error: "no_log_id" }); }
            catch (_ecb0) {}
        }
        return;
    }

    // Собрать entries: дефолтная папка сейвов (если включена) + зарегистрированные источники.
    //   entries: [{ abs, rel }] с уникальными rel-именами (анти-коллизия как в send_files).
    var entries = [];
    var used = {};
    __fastlogs_snapshot_collect(entries, used, bool(include_persistent));

    var n_files = array_length(entries);

    // Зарегистрированные данные в памяти (base64) - добавим прямо в архив как отдельные записи.
    var snap = __fastlogs_snap_state();
    var n_data = array_length(snap.data);

    if (n_files == 0 && n_data == 0) {
        show_debug_message("[FastLogs] snapshot: nothing to archive (no save files / sources / data)");
        fastlogs_send_status("info", "Снимок пуст - нечего прикладывать", false);
        if (is_method(on_done)) {
            try { on_done({ success: false, id: "", url: "", downloadUrl: "", statusCode: 0, error: "empty_snapshot" }); }
            catch (_ecb1) {}
        }
        return;
    }

    // Построить snapshot.zip. Развилка по содержимому:
    //   - ТОЛЬКО файлы (нет data)        -> REUSE __fastlogs_zip_store (#6a, читает с диска);
    //   - есть зарегистрированные data    -> общий buffer-builder (файлы грузим, data декодируем
    //     из base64 - и то и другое в ОДИН архив, без записи на диск).
    //   Так дисковый zip_store переиспользуется в самом частом случае (только сейвы), а смешанный
    //   путь не зипует файлы дважды.
    var zip;
    if (n_data == 0) {
        // Только файлы (дефолтная папка сейвов + зарегистрированные источники).
        zip = __fastlogs_zip_store(entries);   // -1 если ни один файл не прочитался
    } else if (n_files == 0) {
        // Только зарегистрированные data (нет файловых источников).
        zip = __fastlogs_snapshot_zip_from_data(snap.data, used);
    } else {
        // Файлы + data в один архив (буферный builder, один проход).
        zip = __fastlogs_snapshot_zip_with_data(entries, snap.data, used);
    }

    if (!is_real(zip) || zip < 0) {
        show_debug_message("[FastLogs] snapshot: zip build returned no buffer");
        fastlogs_send_status("error", "Не удалось упаковать снимок", false);
        if (is_method(on_done)) {
            try { on_done({ success: false, id: "", url: "", downloadUrl: "", statusCode: 0, error: "zip_failed" }); }
            catch (_ecb3) {}
        }
        return;
    }

    // Опции файлового аплоада: привязка к logId + kind="snapshot" + имя/mime архива + колбэк.
    //   Кап: __fastlogs_send_buffer применит СВОЙ кап FASTLOGS_MAX_FILE_BYTES (= серверный
    //   MAX_FILE_BYTES). Кап снимка FASTLOGS_MAX_SNAPSHOT_BYTES проверяем ОТДЕЛЬНО ниже - он по
    //   умолчанию равен файловому, но если интегратор задал его МЕНЬШЕ, локальная проверка отрежет
    //   раньше; если БОЛЬШЕ - send_buffer всё равно ограничит файловым капом (он же серверный).
    var file_opts = {
        kind   : "snapshot",
        logId  : log_id,
        title  : title,
        name   : name,
        mime   : "application/zip",
    };
    if (is_method(on_done)) { file_opts.onDone = on_done; }

    // Кап snapshot.zip: если он отличается от FASTLOGS_MAX_FILE_BYTES (на который смотрит
    //   __fastlogs_send_buffer) и ИТОГ превышает кап снимка - честно отбиваемся здесь (send_buffer
    //   проверит ещё и свой кап). Это покрывает случай, когда интегратор задал кап снимка МЕНЬШЕ
    //   файлового. Когда они равны (дефолт) - просто полагаемся на проверку в send_buffer.
    var snap_cap = FASTLOGS_MAX_SNAPSHOT_BYTES;
    var zsize = buffer_get_size(zip);
    if (is_real(snap_cap) && snap_cap > 0 && zsize > snap_cap) {
        show_debug_message("[FastLogs] snapshot too large " + string(zsize) + " > cap " + string(snap_cap));
        fastlogs_send_status("error", "Снимок слишком большой ("
            + string(__fastlogs_human_bytes(zsize)) + " > "
            + string(__fastlogs_human_bytes(snap_cap)) + ")", false);
        buffer_delete(zip);
        if (is_method(on_done)) {
            try { on_done({ success: false, id: "", url: "", downloadUrl: "", statusCode: 0, error: "too_large" }); }
            catch (_ecb4) {}
        }
        return;
    }

    fastlogs_send_status("sending", "Отправка снимка...", false);

    // REUSE файлового аплоада: кап -> base64 -> JSON-тело -> POST /api/files (с logId+kind).
    //   send_buffer НЕ удаляет буфер (владелец - мы) -> удаляем после постановки.
    var ok = __fastlogs_send_buffer(zip, name, "application/zip", file_opts);
    buffer_delete(zip);

    if (!ok) {
        show_debug_message("[FastLogs] snapshot: file upload not queued (busy / cap / no endpoint)");
        // send_buffer уже поднял свой статус-тост; колбэк дёргать не обязаны (запрос не пошёл).
    }
}

// =====================================================================================
// Внутреннее: наполнить entries файлами для снимка. Дефолтный источник (папка сейвов
//   game_save_id, если include_default) ИСКЛЮЧАЯ собственную папку FastLogs (FASTLOGS_PERSIST_DIR),
//   ПЛЮС зарегистрированные источники-папки. rel-имена уникальны (анти-коллизия через used).
//   used - struct занятых rel-имён ВЕРХНЕГО уровня (защита от коллизий между источниками).
// =====================================================================================
function __fastlogs_snapshot_collect(entries, used, include_default) {
    // 1) Дефолтный источник: вся папка сейвов game_save_id, кроме папки FastLogs.
    if (include_default) {
        var save_root = __fastlogs_strip_trailing_slash(game_save_id);   // у game_save_id есть хвостовой /
        if (is_string(save_root) && string_length(save_root) > 0 && directory_exists(save_root)) {
            // Исключаем собственную дисковую папку FastLogs (rolling-лог/ini/pending/временный PNG) -
            //   её содержимое УЖЕ является телом отчёта и не должно дублироваться в архив.
            var excludes = {};
            var ex_dir = string_lower(FASTLOGS_PERSIST_DIR);   // относительное имя папки верхнего уровня
            variable_struct_set(excludes, ex_dir, true);
            // Собираем верхний уровень в подпапку "saves/" архива (читаемая структура), исключая FastLogs.
            //   Резервируем "saves" в used, чтобы зарегистрированный источник с таким basename не
            //   слился с дефолтной папкой (получит "saves (1)" через __fastlogs_unique_name).
            variable_struct_set(used, "saves", true);
            __fastlogs_snapshot_collect_dir(save_root, "saves", entries, used, excludes);
        } else {
            // Папка сейвов не перечисляется (см. ограничение консолей/HTML5 в GM-NOTES 2.9):
            //   дефолтный источник просто пуст. Зарегистрированные источники/данные всё равно уйдут.
            show_debug_message("[FastLogs] snapshot: default save folder not enumerable (game_save_id) - rely on registered sources");
        }
    }

    // 2) Зарегистрированные источники-папки (каждая - в подпапку по имени, для читаемости/анти-коллизии).
    var snap = __fastlogs_snap_state();
    for (var i = 0; i < array_length(snap.sources); i++) {
        var src = snap.sources[i].path;
        if (!is_string(src) || string_length(src) == 0) { continue; }
        if (!directory_exists(src)) {
            show_debug_message("[FastLogs] snapshot: registered source not found: " + src);
            continue;
        }
        // Уникальное имя подпапки источника в архиве (basename + анти-коллизия).
        var folder = __fastlogs_unique_name(used, __fastlogs_basename(src));
        variable_struct_set(used, folder, true);
        __fastlogs_snapshot_collect_dir(src, folder, entries, used, {});
    }
}

// =====================================================================================
// Внутреннее: рекурсивный сбор файлов каталога ПОД префиксом prefix внутри архива, с
//   ИСКЛЮЧЕНИЕМ имён верхнего уровня (excludes: struct lower-case имя -> true). Аналог
//   __fastlogs_collect_dir_files (scr_fastlogs_files), но с поддержкой исключений и стартовым
//   префиксом - НЕ трогаем оригинал (он принадлежит файловой фиче). rel = prefix + "/" + путь.
//   excludes применяется ТОЛЬКО к ВЕРХНЕМУ уровню base (так исключаем именно папку FastLogs).
// =====================================================================================
function __fastlogs_snapshot_collect_dir(base, prefix, entries, used, excludes) {
    __fastlogs_snapshot_collect_dir_rec(base, "", prefix, entries, excludes);
}

// Внутреннее: рекурсия сбора. sub - относительный путь от base ("" на верхнем уровне).
function __fastlogs_snapshot_collect_dir_rec(base, sub, prefix, entries, excludes) {
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

        // Исключения - только на ВЕРХНЕМ уровне (sub == ""): сравниваем имя без регистра.
        if (sub == "" && is_struct(excludes) && variable_struct_exists(excludes, string_lower(nm))) {
            continue;
        }

        var abs = dir + "/" + nm;
        var rel_sub = (sub == "") ? nm : (sub + "/" + nm);
        if (directory_exists(abs)) {
            __fastlogs_snapshot_collect_dir_rec(base, rel_sub, prefix, entries, excludes);   // рекурсия
        } else if (file_exists(abs)) {
            // rel в архиве = prefix + "/" + относительный путь (читаемая структура папок).
            var rel = (prefix == "") ? rel_sub : (prefix + "/" + rel_sub);
            array_push(entries, { abs: abs, rel: rel });
        }
    }
}

// =====================================================================================
// Внутреннее: материализовать зарегистрированные data (base64) во ВРЕМЕННЫЕ буферы и собрать
//   их как entries-для-zip нельзя (zip_store читает с диска), поэтому строим zip с data-записями
//   ОТДЕЛЬНО: декодируем base64 в буферы, пишем local headers + central directory вручную, как в
//   __fastlogs_zip_store, но из БУФЕРОВ В ПАМЯТИ. Возвращает grow-буфер zip (владелец - вызывающий)
//   или -1 при неудаче. used - struct занятых rel-имён (анти-коллизия имён data в архиве).
// =====================================================================================
function __fastlogs_snapshot_zip_from_data(data_list, used) {
    var bufs = __fastlogs_snapshot_materialize_data(data_list, used);
    if (array_length(bufs) == 0) { return -1; }
    var zip = __fastlogs_snapshot_zip_store_buffers(bufs);
    __fastlogs_snapshot_free_buffers(bufs);
    return zip;
}

// =====================================================================================
// Внутреннее: построить zip из ФАЙЛОВЫХ entries (с диска) И зарегистрированных data (из памяти)
//   в ОДИН архив. Реализуем через материализацию data во временные файлы НЕЛЬЗЯ (не пишем на
//   диск), поэтому идём смешанным путём: сначала собираем буферы (файлы грузим, data декодируем),
//   затем один общий zip-store по буферам. Возвращает grow-буфер или -1.
// =====================================================================================
function __fastlogs_snapshot_zip_with_data(file_entries, data_list, used) {
    var bufs = [];

    // Файлы: грузим в буферы (как делает zip_store внутри, но тут нам нужен общий проход с data).
    for (var i = 0; i < array_length(file_entries); i++) {
        var e = file_entries[i];
        var fbuf = buffer_load(e.abs);
        if (fbuf < 0) {
            show_debug_message("[FastLogs] snapshot: skip unreadable: " + string(e.abs));
            continue;
        }
        array_push(bufs, { rel: e.rel, buf: fbuf, own: true });
    }

    // Зарегистрированные data: декодируем base64 в буферы.
    var data_bufs = __fastlogs_snapshot_materialize_data(data_list, used);
    for (var j = 0; j < array_length(data_bufs); j++) {
        array_push(bufs, data_bufs[j]);   // уже { rel, buf, own:true }
    }

    if (array_length(bufs) == 0) {
        __fastlogs_snapshot_free_buffers(bufs);
        return -1;
    }
    var zip = __fastlogs_snapshot_zip_store_buffers(bufs);
    __fastlogs_snapshot_free_buffers(bufs);
    return zip;
}

// =====================================================================================
// Внутреннее: декодировать зарегистрированные data (base64) во временные буферы с уникальными
//   именами в архиве. Возвращает массив { rel, buf, own:true } (владелец освобождает буферы).
//   used - struct занятых rel-имён (анти-коллизия). Пустые/битые записи пропускаем.
// =====================================================================================
function __fastlogs_snapshot_materialize_data(data_list, used) {
    var out = [];
    for (var i = 0; i < array_length(data_list); i++) {
        var d = data_list[i];
        if (!is_struct(d) || !variable_struct_exists(d, "bytes_b64") || !is_string(d.bytes_b64)) { continue; }
        if (string_length(d.bytes_b64) == 0) { continue; }
        var nm = (variable_struct_exists(d, "name") && is_string(d.name) && string_length(d.name) > 0) ? d.name : "data.bin";
        var rel = __fastlogs_unique_name(used, nm);
        variable_struct_set(used, rel, true);

        var buf = buffer_base64_decode(d.bytes_b64);   // -> новый buffer_grow с декодированными байтами
        if (!is_real(buf) || buf < 0) {
            show_debug_message("[FastLogs] snapshot: base64 decode failed for data '" + nm + "'");
            continue;
        }
        array_push(out, { rel: rel, buf: buf, own: true });
    }
    return out;
}

// =====================================================================================
// Внутреннее: освободить буферы, которыми ВЛАДЕЕМ (own == true). Вызывается после zip-store.
// =====================================================================================
function __fastlogs_snapshot_free_buffers(bufs) {
    for (var i = 0; i < array_length(bufs); i++) {
        var b = bufs[i];
        if (is_struct(b) && variable_struct_exists(b, "own") && b.own
            && variable_struct_exists(b, "buf") && is_real(b.buf) && buffer_exists(b.buf)) {
            buffer_delete(b.buf);
        }
    }
}

// =====================================================================================
// Внутреннее: ZIP-STORE (метод 0, без компрессии) из набора БУФЕРОВ В ПАМЯТИ. Полный паритет
//   структуры с __fastlogs_zip_store (scr_fastlogs_files): на файл - Local File Header + сырые
//   данные; затем Central Directory; затем EOCD. Флаг 0x0800 (UTF-8 имена). CRC32 - PKZIP-стандарт
//   (buffer_crc32 ^ $FFFFFFFF, как __fastlogs_zip_crc32). DOS time/date - текущее локальное время.
//   buf_list: массив { rel (имя в архиве), buf (буфер источника) }. Возвращает grow-буфер zip
//   (усечённый до фактического размера) или -1, если ни одной валидной записи.
//   ПОЧЕМУ отдельная функция, а не reuse __fastlogs_zip_store: тот читает файлы С ДИСКА
//   (buffer_load по abs-пути); снимок-data живут В ПАМЯТИ -> нужен вариант "из буферов". Логика
//   записи заголовков идентична (DRY на уровне формата сверена с #6a и PKZIP APPNOTE).
//   ВНИМАНИЕ (drift): запись ZIP-заголовков здесь - байт-в-байт копия __fastlogs_zip_store
//   (scr_fastlogs_files). ЛЮБОЕ изменение ZIP-лэйаута в одном писателе ОБЯЗАТЕЛЬНО повторить во
//   втором. TODO (на сессию с GM IDE): свести к одному писателю - __fastlogs_zip_store принимает
//   список {rel, buf}, дисковый путь делает buffer_load в этот список (см. ревью снимка).
// =====================================================================================
function __fastlogs_snapshot_zip_store_buffers(buf_list) {
    var n = array_length(buf_list);
    if (n <= 0) { return -1; }

    var out = buffer_create(1024, buffer_grow, 1);
    var dos = __fastlogs_dos_datetime();   // { time, date } (reuse из files)
    var meta = array_create(n, undefined);

    for (var i = 0; i < n; i++) {
        var e = buf_list[i];
        var rel = e.rel;
        var fbuf = e.buf;
        if (!is_real(fbuf) || !buffer_exists(fbuf)) { meta[i] = undefined; continue; }

        var fsize = buffer_get_size(fbuf);
        var crc   = __fastlogs_zip_crc32(fbuf, fsize);   // reuse PKZIP CRC из files
        var lho   = buffer_tell(out);
        var name_bytes = string_byte_length(rel);

        // --- Local File Header (30 байт + имя) ---
        buffer_write(out, buffer_s32, 67324752);    // 0x04034b50
        buffer_write(out, buffer_u16, 20);          // version needed
        buffer_write(out, buffer_u16, 2048);        // flags (bit 11 = UTF-8 имя)
        buffer_write(out, buffer_u16, 0);           // method 0 = STORE
        buffer_write(out, buffer_u16, dos.time);
        buffer_write(out, buffer_u16, dos.date);
        buffer_write(out, buffer_u32, crc);
        buffer_write(out, buffer_s32, fsize);       // compressed (= uncompressed, STORE)
        buffer_write(out, buffer_s32, fsize);       // uncompressed
        buffer_write(out, buffer_u16, name_bytes);
        buffer_write(out, buffer_u16, 0);           // extra len
        if (name_bytes > 0) buffer_write(out, buffer_text, rel);

        // --- сырые данные (STORE) ---
        if (fsize > 0) __fastlogs_buffer_append(out, fbuf, 0, fsize);   // reuse аппендер из files

        meta[i] = { rel: rel, name_bytes: name_bytes, crc: crc, size: fsize, lho: lho };
    }

    var cd_start = buffer_tell(out);
    var cd_count = 0;
    for (var j = 0; j < n; j++) {
        var m = meta[j];
        if (is_undefined(m)) continue;

        // --- Central Directory File Header (46 байт + имя) ---
        buffer_write(out, buffer_s32, 33639248);    // 0x02014b50
        buffer_write(out, buffer_u16, 20);          // version made by
        buffer_write(out, buffer_u16, 20);          // version needed
        buffer_write(out, buffer_u16, 2048);        // flags (UTF-8 имя)
        buffer_write(out, buffer_u16, 0);           // method STORE
        buffer_write(out, buffer_u16, dos.time);
        buffer_write(out, buffer_u16, dos.date);
        buffer_write(out, buffer_u32, m.crc);
        buffer_write(out, buffer_s32, m.size);
        buffer_write(out, buffer_s32, m.size);
        buffer_write(out, buffer_u16, m.name_bytes);
        buffer_write(out, buffer_u16, 0);           // extra len
        buffer_write(out, buffer_u16, 0);           // comment len
        buffer_write(out, buffer_u16, 0);           // disk number start
        buffer_write(out, buffer_u16, 0);           // internal attrs
        buffer_write(out, buffer_s32, 0);           // external attrs
        buffer_write(out, buffer_s32, m.lho);       // offset of local header
        if (m.name_bytes > 0) buffer_write(out, buffer_text, m.rel);

        cd_count += 1;
    }

    if (cd_count == 0) {
        buffer_delete(out);
        return -1;
    }

    var cd_end  = buffer_tell(out);
    var cd_size = cd_end - cd_start;

    // --- End Of Central Directory (22 байта) ---
    buffer_write(out, buffer_s32, 101010256);   // 0x06054b50
    buffer_write(out, buffer_u16, 0);
    buffer_write(out, buffer_u16, 0);
    buffer_write(out, buffer_u16, cd_count);
    buffer_write(out, buffer_u16, cd_count);
    buffer_write(out, buffer_s32, cd_size);
    buffer_write(out, buffer_s32, cd_start);
    buffer_write(out, buffer_u16, 0);

    var total = buffer_tell(out);
    buffer_resize(out, total);   // усечь grow-резерв (иначе хвост попал бы в base64/кап)
    buffer_seek(out, buffer_seek_start, 0);
    return out;
}
