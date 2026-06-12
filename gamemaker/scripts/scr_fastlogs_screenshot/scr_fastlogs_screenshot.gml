/// @description scr_fastlogs_screenshot
// FastLogs GameMaker client - ЗАХВАТ СКРИНШОТА (чистый base64 PNG для payload, без data:).
//
// КОНВЕЙЕР (GM-NOTES 2.2):
//   1) Снять кадр в Draw GUI End (8/65) - надёжная точка по докам (screen_save рекомендован там).
//      Источник пикселей - application_surface (если включён) или весь экран.
//   2) Даунскейл до лимита: рисуем application_surface растянуто в свой ВРЕМЕННЫЙ surface
//      нужного размера (НЕ surface_resize у application_surface - его размер применится только
//      со следующего кадра, подтверждено докой surface_resize).
//   3) surface_save(temp_surf, tmp.png) -> PNG-файл в game_save_id.
//   4) buffer_load(tmp.png) -> buffer_base64_encode(buf,0,size) -> чистый base64 PNG.
//   5) file_delete временного PNG, surface_free/buffer_delete.
//
// ПЛАТФОРМЫ:
//   - surface_save/screen_save СИНХРОННЫ и НЕ генерируют Async Save/Load (это событие шлют только
//     buffer_save_async/buffer_load_async - подтверждено докой GM, июнь 2026). Поэтому читаем файл
//     в ТОТ ЖЕ кадр сразу после записи; если файла нет - деградируем (base64="") и финишируем,
//     НЕ вставая в ожидание async (иначе on_done никогда не дёрнется и send зависнет навсегда).
//   - HTML5: screen_save/surface_save в PNG ограничены; base64 здесь может быть недоступен
//     -> возвращаем "" (скриншот просто не прикладывается). // TODO verify HTML5 surface_save.
//
// ПО УМОЛЧАНИЮ ВЫКЛ: захват инициируется только когда тоггл скриншота включён и идёт send.
// Все точки входа: ранний выход при !FASTLOGS_ENABLED.
//
// Сверка GML-API: GM-NOTES.md. surface_* / buffer_* / screen_save подтверждены поиском (июнь 2026).

// Максимальная сторона скриншота после даунскейла (px). Контракт MAX_SCREENSHOT ~2 MB PNG -
//   даунскейл уменьшает вес. // TODO verify оптимальный лимит под 2 MB.
#macro FASTLOGS_SHOT_MAX_SIDE   1280

/// Состояние захвата скриншота (ленивая инициализация). Хранит ожидающий запрос и результат.
function fastlogs_shot_state() {
    if (!variable_global_exists("__fastlogs_shot")) {
        global.__fastlogs_shot = {
            request:   false,   // запрошен захват в ближайшем Draw GUI End
            tmp_path:  "",      // путь временного PNG (используется и удаляется в тот же кадр)
            base64:    "",      // последний результат (чистый base64 PNG) или ""
            ready:     false,   // base64 готов к использованию
            on_done:   undefined, // колбэк(base64) после готовности (например, продолжить send)
        };
    }
    return global.__fastlogs_shot;
}

/// Запросить захват скриншота в ближайшем Draw GUI End. opt_callback(base64) вызовется по готовности.
/// @param {function} [opt_callback] - вызвать с готовым base64 (или "" при неудаче)
function fastlogs_screenshot_request(opt_callback) {
    if (!FASTLOGS_ENABLED) return;
    var st = fastlogs_shot_state();
    st.request = true;
    st.ready   = false;
    st.base64  = "";
    st.on_done = (argument_count > 0) ? opt_callback : undefined;
}

/// @returns {bool} готов ли результат последнего захвата
function fastlogs_screenshot_is_ready() {
    if (!FASTLOGS_ENABLED) return false;
    return fastlogs_shot_state().ready;
}

/// @returns {string} чистый base64 PNG последнего захвата ("" если нет/неудача)
function fastlogs_screenshot_base64() {
    if (!FASTLOGS_ENABLED) return "";
    return fastlogs_shot_state().base64;
}

/// Вызывать из Draw GUI End (Draw_65.gml). Если есть запрос - снимает кадр.
function fastlogs_screenshot_tick_draw_end() {
    if (!FASTLOGS_ENABLED) return;
    var st = fastlogs_shot_state();
    if (!st.request) return;
    st.request = false;
    fastlogs_screenshot_capture_now(st);
}

/// Непосредственный захват: даунскейл application_surface -> surface_save -> base64 (синхронно).
function fastlogs_screenshot_capture_now(st) {
    // HTML5: surface_save в PNG/base64 ненадёжен - не пытаемся (скриншот пропускаем).
    if (os_browser != browser_not_a_browser) {
        st.ready  = true;
        st.base64 = "";
        fastlogs_screenshot_finish(st);
        return;
    }

    var src = application_surface;
    if (!surface_exists(src)) {
        // App surface может быть выключен - тогда используем screen_save целиком в файл.
        fastlogs_screenshot_via_screen_save(st);
        return;
    }

    var sw = surface_get_width(src);
    var sh = surface_get_height(src);
    if (sw <= 0 || sh <= 0) { st.ready = true; st.base64 = ""; fastlogs_screenshot_finish(st); return; }

    // Расчёт целевого размера с сохранением пропорций под FASTLOGS_SHOT_MAX_SIDE.
    var scale = min(1, FASTLOGS_SHOT_MAX_SIDE / max(sw, sh));
    var tw = max(1, round(sw * scale));
    var th = max(1, round(sh * scale));

    var tmp_surf = surface_create(tw, th);
    surface_set_target(tmp_surf);
    draw_clear_alpha(c_black, 0);
    // Рисуем исходный app surface растянуто в целевой размер.
    draw_surface_stretched(src, 0, 0, tw, th);
    surface_reset_target();

    var path = game_save_id + FASTLOGS_PERSIST_DIR + "/" + FASTLOGS_SCREENSHOT_TMP;
    fastlogs_screenshot_ensure_dir();
    st.tmp_path = path;

    // surface_save СИНХРОНЕН (файл готов после возврата вызова). Читаем сразу же.
    surface_save(tmp_surf, path);
    surface_free(tmp_surf);

    // Всегда финишируем в этом же кадре. read_file сам деградирует к base64="" если файла
    //   нет / buffer_load вернул -1 - но on_done будет вызван в любом случае (send не зависнет).
    fastlogs_screenshot_read_file(st, path);
}

/// Альтернатива через screen_save (когда app surface недоступен). Тоже даёт PNG-файл.
function fastlogs_screenshot_via_screen_save(st) {
    var path = game_save_id + FASTLOGS_PERSIST_DIR + "/" + FASTLOGS_SCREENSHOT_TMP;
    fastlogs_screenshot_ensure_dir();
    st.tmp_path = path;
    // screen_save сохраняет PNG финального рендера (без даунскейла - размер экрана). Синхронен.
    screen_save(path);
    // Читаем в этом же кадре; при неудаче read_file даст base64="" и всё равно дёрнет on_done.
    fastlogs_screenshot_read_file(st, path);
}

/// Читает PNG-файл в буфер и кодирует в base64 (чистые PNG-байты, без data:).
function fastlogs_screenshot_read_file(st, path) {
    var ok = false;
    try {
        var b = buffer_load(path);
        if (b != -1) {
            var sz = buffer_get_size(b);
            st.base64 = buffer_base64_encode(b, 0, sz);
            buffer_delete(b);
            ok = true;
        }
    } catch (_e) {
        ok = false;
    }
    if (!ok) st.base64 = "";
    st.ready   = true;
    // Удалить временный PNG (не оставляем мусор в sandbox).
    if (file_exists(path)) file_delete(path);
    fastlogs_screenshot_finish(st);
}

/// Колбэк завершения: дёрнуть on_done(base64), если задан.
function fastlogs_screenshot_finish(st) {
    if (!is_undefined(st.on_done)) {
        var cb = st.on_done;
        st.on_done = undefined;
        cb(st.base64);
    }
}

// ПРИМЕЧАНИЕ: ранее здесь была fastlogs_screenshot_on_async_save() для дочитывания файла в
//   событии Async Save/Load. Удалена намеренно: surface_save/screen_save синхронны и НЕ шлют
//   это событие (его генерируют только buffer_save_async/buffer_load_async). Захват полностью
//   завершается в том же кадре в fastlogs_screenshot_read_file, поэтому async-ветка не нужна.

/// Гарантировать существование каталога персиста (для временного PNG).
function fastlogs_screenshot_ensure_dir() {
    var dir = game_save_id + FASTLOGS_PERSIST_DIR;
    if (!directory_exists(dir)) directory_create(dir);
}
