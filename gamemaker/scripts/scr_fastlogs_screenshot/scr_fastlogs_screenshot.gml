/// @description scr_fastlogs_screenshot
// FastLogs GameMaker client - SCREENSHOT CAPTURE (pure base64 PNG for payload, no data: prefix).
//
// PIPELINE (GM-NOTES 2.2):
//   1) Capture frame in Draw GUI End (8/65) - reliable point per docs (screen_save recommended there).
//      Pixel source - application_surface (if enabled) or the full screen.
//   2) Downscale to limit: draw application_surface stretched into a TEMPORARY surface
//      of the required size (NOT surface_resize on application_surface - its size takes effect only
//      on the next frame, confirmed by surface_resize docs).
//   3) surface_save(temp_surf, tmp.png) -> PNG file in game_save_id.
//   4) buffer_load(tmp.png) -> buffer_base64_encode(buf,0,size) -> pure base64 PNG.
//   5) file_delete the temporary PNG, surface_free/buffer_delete.
//
// PLATFORMS:
//   - surface_save/screen_save are SYNCHRONOUS and do NOT raise Async Save/Load (that event is only
//     sent by buffer_save_async/buffer_load_async - confirmed by GM docs, June 2026). Therefore we
//     read the file IN THE SAME frame immediately after writing; if the file is missing - we degrade
//     (base64="") and finish, NOT waiting for async (otherwise on_done never fires and send hangs forever).
//   - HTML5: screen_save/surface_save to PNG is limited; base64 may be unavailable here
//     -> return "" (screenshot is simply not attached). // TODO verify HTML5 surface_save.
//
// DISABLED BY DEFAULT: capture is initiated only when the screenshot toggle is on and a send is in progress.
// All entry points: early exit when !FASTLOGS_ENABLED.
//
// GML API reference: GM-NOTES.md. surface_* / buffer_* / screen_save confirmed by search (June 2026).

// Maximum side of the screenshot after downscaling (px). Contract MAX_SCREENSHOT ~2 MB PNG -
//   downscaling reduces file size. // TODO verify optimal limit for 2 MB.
#macro FASTLOGS_SHOT_MAX_SIDE   1280

/// Screenshot capture state (lazy initialization). Stores the pending request and result.
function fastlogs_shot_state() {
    if (!variable_global_exists("__fastlogs_shot")) {
        global.__fastlogs_shot = {
            request:   false,   // capture requested in the next Draw GUI End
            tmp_path:  "",      // path of the temporary PNG (used and deleted in the same frame)
            base64:    "",      // last result (pure base64 PNG) or ""
            ready:     false,   // base64 is ready to use
            on_done:   undefined, // callback(base64) after ready (e.g. to continue send)
        };
    }
    return global.__fastlogs_shot;
}

/// Request a screenshot capture in the next Draw GUI End. opt_callback(base64) is called when ready.
/// @param {function} [opt_callback] - called with the ready base64 (or "" on failure)
function fastlogs_screenshot_request(opt_callback) {
    if (!FASTLOGS_ENABLED) return;
    var st = fastlogs_shot_state();
    st.request = true;
    st.ready   = false;
    st.base64  = "";
    st.on_done = (argument_count > 0) ? opt_callback : undefined;
}

/// @returns {bool} whether the result of the last capture is ready
function fastlogs_screenshot_is_ready() {
    if (!FASTLOGS_ENABLED) return false;
    return fastlogs_shot_state().ready;
}

/// @returns {string} pure base64 PNG of the last capture ("" if none/failed)
function fastlogs_screenshot_base64() {
    if (!FASTLOGS_ENABLED) return "";
    return fastlogs_shot_state().base64;
}

/// Call from Draw GUI End (Draw_65.gml). If a request is pending - captures the frame.
function fastlogs_screenshot_tick_draw_end() {
    if (!FASTLOGS_ENABLED) return;
    var st = fastlogs_shot_state();
    if (!st.request) return;
    st.request = false;
    fastlogs_screenshot_capture_now(st);
}

/// Actual capture: downscale application_surface -> surface_save -> base64 (synchronous).
function fastlogs_screenshot_capture_now(st) {
    // HTML5: surface_save to PNG/base64 is unreliable - skip attempt (screenshot omitted).
    if (os_browser != browser_not_a_browser) {
        st.ready  = true;
        st.base64 = "";
        fastlogs_screenshot_finish(st);
        return;
    }

    var src = application_surface;
    if (!surface_exists(src)) {
        // App surface may be disabled - fall back to screen_save into a file.
        fastlogs_screenshot_via_screen_save(st);
        return;
    }

    var sw = surface_get_width(src);
    var sh = surface_get_height(src);
    if (sw <= 0 || sh <= 0) { st.ready = true; st.base64 = ""; fastlogs_screenshot_finish(st); return; }

    // Calculate target size preserving aspect ratio under FASTLOGS_SHOT_MAX_SIDE.
    var scale = min(1, FASTLOGS_SHOT_MAX_SIDE / max(sw, sh));
    var tw = max(1, round(sw * scale));
    var th = max(1, round(sh * scale));

    var tmp_surf = surface_create(tw, th);
    surface_set_target(tmp_surf);
    draw_clear_alpha(c_black, 0);
    // Draw the source app surface stretched to the target size.
    draw_surface_stretched(src, 0, 0, tw, th);
    surface_reset_target();

    var path = game_save_id + FASTLOGS_PERSIST_DIR + "/" + FASTLOGS_SCREENSHOT_TMP;
    fastlogs_screenshot_ensure_dir();
    st.tmp_path = path;

    // surface_save is SYNCHRONOUS (file is ready after the call returns). Read immediately.
    surface_save(tmp_surf, path);
    surface_free(tmp_surf);

    // Always finish in the same frame. read_file degrades to base64="" if the file
    //   is missing / buffer_load returned -1 - but on_done is called either way (send won't hang).
    fastlogs_screenshot_read_file(st, path);
}

/// Fallback via screen_save (when app surface is unavailable). Also produces a PNG file.
function fastlogs_screenshot_via_screen_save(st) {
    var path = game_save_id + FASTLOGS_PERSIST_DIR + "/" + FASTLOGS_SCREENSHOT_TMP;
    fastlogs_screenshot_ensure_dir();
    st.tmp_path = path;
    // screen_save writes a PNG of the final render (no downscaling - screen size). Synchronous.
    screen_save(path);
    // Read in the same frame; on failure read_file returns base64="" and still fires on_done.
    fastlogs_screenshot_read_file(st, path);
}

/// Reads the PNG file into a buffer and encodes it as base64 (raw PNG bytes, no data: prefix).
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
    // Delete the temporary PNG (leave no junk in the sandbox).
    if (file_exists(path)) file_delete(path);
    fastlogs_screenshot_finish(st);
}

/// Completion callback: fire on_done(base64) if set.
function fastlogs_screenshot_finish(st) {
    if (!is_undefined(st.on_done)) {
        var cb = st.on_done;
        st.on_done = undefined;
        cb(st.base64);
    }
}

// NOTE: fastlogs_screenshot_on_async_save() previously lived here to read the file in the
//   Async Save/Load event. Removed intentionally: surface_save/screen_save are synchronous and
//   do NOT raise that event (only buffer_save_async/buffer_load_async do). Capture completes
//   entirely in the same frame inside fastlogs_screenshot_read_file, so the async branch is not needed.

/// Ensure the persist directory exists (for the temporary PNG).
function fastlogs_screenshot_ensure_dir() {
    var dir = game_save_id + FASTLOGS_PERSIST_DIR;
    if (!directory_exists(dir)) directory_create(dir);
}
