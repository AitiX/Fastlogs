/// @description scr_fastlogs_overlay
// FastLogs GameMaker client - OVERLAY (drawn with primitives, no sprites).
// Draws: E/W/L counters with color, a "Send" button, a "Screenshot" toggle, a URL area +
//   a "Copy" button, and an INDEPENDENT settings panel (endpoint/appId display, screenshot
//   toggle, autosend, Start/Stop Recording with indicator, Clear, buffer capacity).
// Layout scales to display_get_gui_width/height. Large tap zones (hit-test).
// Settings are persisted via ini_* (see fastlogs_ui_settings_load/save).
//
// ARCHITECTURE: all UI state is held in global.__fastlogs_ui (lazy initialization),
//   so that overlay/input are self-contained and safe to call before fastlogs_init
//   (PUBLIC-API invariant). Public functions are no-op when !FASTLOGS_ENABLED.
//
// GML-API reference: GM-NOTES.md. Drawing (draw_rectangle/draw_text/draw_set_*),
//   display_get_gui_* and ini_* are standard functions (confirmed by search, June 2026).

// =====================================================================================
// UI STATE (lazy initialization). Stores overlay flags, hover/pressed zones,
//   button rectangles (hit-rects) gathered this frame, and the ini-settings cache.
// =====================================================================================
function fastlogs_ui_state() {
    if (!variable_global_exists("__fastlogs_ui")) {
        global.__fastlogs_ui = {
            open:            false,   // whether the overlay is visible
            settings_open:   false,   // whether the settings panel is visible
            // Click zones for the CURRENT frame: array of structs {x1,y1,x2,y2,id}.
            //   Populated during drawing (Draw GUI), read by input on the next poll.
            hit:             [],
            // Input pointer in GUI coordinates for this frame (filled by input).
            px:              0,
            py:              0,
            pressed:         false,   // whether a pressed tap occurred this frame
            hover_id:        "",      // id of the zone under the pointer (for highlight)
            __prev_touches:  0,       // touch count in the previous frame (for gesture edge detection)
            // Toast (clipboard + STATUS, B): text + frame timer until hidden + type/extra fields.
            toast_text:      "",
            toast_frames:    0,       // frames until hidden (0 -> no toast). -1 -> hold (sending).
            toast_kind:      "info",  // "info" | "sending" | "ok" | "error"
            toast_url:       "",      // link for the "ok" toast (shown + click copies it)
            toast_retry:     false,   // whether to show the "Retry" hint/zone (toast "error")
            // Tester comment (feature COMMENT). Accumulated inline via keyboard_string;
            //   goes into opts.comment on send. Contract: <=4000 characters.
            comment_text:    "",      // currently entered text
            comment_editing: false,   // whether input mode is active (focus on comment field)
            // Settings (ini persist). Values loaded by fastlogs_ui_settings_load().
            settings_loaded: false,
            cfg_screenshot:  FASTLOGS_SCREENSHOT_DEFAULT,
            cfg_autosend:    false,                       // auto-send on button press (UI level)
            cfg_ring_size:   FASTLOGS_RING_SIZE,          // buffer capacity (display/edit)
            cfg_scrub_pii:   FASTLOGS_SCRUB_PII,          // PII scrubbing (#3); DEFAULT private (true)
        };
    }
    return global.__fastlogs_ui;
}

// =====================================================================================
// OVERLAY PUBLIC API (PUBLIC-API.md): open/close/toggle. no-op when !FASTLOGS_ENABLED.
// =====================================================================================
function fastlogs_open() {
    if (!FASTLOGS_ENABLED) return;
    var ui = fastlogs_ui_state();
    if (!ui.settings_loaded) fastlogs_ui_settings_load();
    ui.open = true;
}

function fastlogs_close() {
    if (!FASTLOGS_ENABLED) return;
    fastlogs_ui_state().open = false;
}

function fastlogs_toggle() {
    if (!FASTLOGS_ENABLED) return;
    var ui = fastlogs_ui_state();
    if (ui.open) fastlogs_close(); else fastlogs_open();
}

/// @returns {bool} whether the overlay is currently open
function fastlogs_is_open() {
    if (!FASTLOGS_ENABLED) return false;
    return fastlogs_ui_state().open;
}

// =====================================================================================
// TESTER COMMENT (feature COMMENT). Multi-line inline input via keyboard_string.
//   keyboard_string was chosen as the reliable approach for inline accumulation in the overlay
//   (desktop/HTML5); the native get_string_async is single-line/modal on some platforms -
//   not suitable.
//   // TODO verify keyboard_string availability on target consoles (they usually use an on-screen
//   keyboard via get_string_async; COMMENT could be omitted for consoles).
// =====================================================================================

// Maximum comment length (contract: <=4000). Local macro to avoid touching config.
#macro FASTLOGS_COMMENT_MAX 4000

/// @returns {string} the currently entered tester comment ("" if empty)
function fastlogs_comment_get() {
    if (!FASTLOGS_ENABLED) return "";
    return fastlogs_ui_state().comment_text;
}

/// Clear the comment and exit input mode (e.g. after a successful send).
function fastlogs_comment_clear() {
    if (!FASTLOGS_ENABLED) return;
    var ui = fastlogs_ui_state();
    ui.comment_text    = "";
    ui.comment_editing = false;
}

/// Enter/exit comment input mode. On entry, keyboard_string is synchronized
///   with the current text so editing continues from where it left off.
/// @param {bool} on
function fastlogs_comment_set_editing(on) {
    if (!FASTLOGS_ENABLED) return;
    var ui = fastlogs_ui_state();
    ui.comment_editing = bool(on);
    if (ui.comment_editing) {
        // keyboard_string is the built-in input accumulator string (handles backspace).
        //   Seed it with the current text so editing resumes from the existing content.
        keyboard_string = ui.comment_text;
    }
}

/// Poll comment input. Call every Step WHILE the overlay is open and the field has focus.
///   Accumulates characters from keyboard_string; Enter appends a newline (multi-line);
///   truncates to FASTLOGS_COMMENT_MAX. Called from fastlogs_input_poll (input script).
function fastlogs_comment_poll_input() {
    if (!FASTLOGS_ENABLED) return;
    var ui = fastlogs_ui_state();
    if (!ui.open || !ui.comment_editing) return;

    // 1) Base text = current keyboard_string (GM handles printing and backspace itself).
    //    On platforms without keyboard_string it stays empty - the field simply receives no input.
    var s = is_string(keyboard_string) ? keyboard_string : "";

    // 2) Multi-line: GM puts printable characters into keyboard_string; Enter usually does NOT
    //    appear in keyboard_string. We catch Enter separately and insert "\n".
    //    We do this by appending the newline directly into the keyboard_string accumulator so that
    //    a subsequent backspace also removes it correctly.
    //    // TODO verify: on some runtimes keyboard_string may itself contain \r/\n from Enter
    //    (which would cause a double newline) - check when importing into the IDE on the target platform.
    if (keyboard_check_pressed(vk_enter)) {
        keyboard_string += "\n";
        s = keyboard_string;
    }

    // 3) Length limit (contract <=4000). Trim the accumulator so that UI and send stay in sync.
    if (string_length(s) > FASTLOGS_COMMENT_MAX) {
        s = string_copy(s, 1, FASTLOGS_COMMENT_MAX);
        keyboard_string = s;
    }

    ui.comment_text = s;
}

// =====================================================================================
// SETTINGS PERSISTENCE (ini_*). File is stored in game_save_id (sandbox). Platform-safe:
//   ini_* are standard; on consoles/HTML5 we simply fall back to defaults if reading fails.
//   Setting keys are stored in the [fastlogs] section. Settings are applied to the runtime via
//   public setters (fastlogs_set_screenshot), without touching private module state.
// =====================================================================================
function fastlogs_ui_settings_load() {
    if (!FASTLOGS_ENABLED) return;
    var ui = fastlogs_ui_state();
    try {
        // FASTLOGS_PERSIST_FILE lives in FASTLOGS_PERSIST_DIR; settings are placed alongside it in .ini.
        var fname = fastlogs_ui_ini_path();
        ini_open(fname);
        ui.cfg_screenshot = (ini_read_real("fastlogs", "screenshot", FASTLOGS_SCREENSHOT_DEFAULT ? 1 : 0) >= 1);
        ui.cfg_autosend   = (ini_read_real("fastlogs", "autosend",   0) >= 1);
        ui.cfg_ring_size  = ini_read_real("fastlogs", "ring_size",   FASTLOGS_RING_SIZE);
        // PII scrubbing (#3): default is private (FASTLOGS_SCRUB_PII). A saved value overrides it.
        ui.cfg_scrub_pii  = (ini_read_real("fastlogs", "scrub_pii",  FASTLOGS_SCRUB_PII ? 1 : 0) >= 1);
        ini_close();
    } catch (_e) {
        // On platforms without ini write support - silently stay on defaults.
        ui.cfg_screenshot = FASTLOGS_SCREENSHOT_DEFAULT;
        ui.cfg_autosend   = false;
        ui.cfg_ring_size  = FASTLOGS_RING_SIZE;
        ui.cfg_scrub_pii  = FASTLOGS_SCRUB_PII;
    }
    ui.settings_loaded = true;
    // Apply the loaded screenshot toggle to the runtime via the public setter.
    if (script_exists(asset_get_index("fastlogs_set_screenshot"))) {
        fastlogs_set_screenshot(ui.cfg_screenshot);
    }
    // Apply the loaded PII scrubbing toggle to the runtime config (#3) so the payload reads it.
    fastlogs_ui_apply_scrub_pii(ui.cfg_scrub_pii);
}

/// Apply the PII scrubbing toggle to the runtime config (st.cfg.scrubPii) so fastlogs_redact respects it.
///   Writes directly into the shared cfg via the same mechanism as fastlogs_init({scrubPii}).
/// @param {bool} on
function fastlogs_ui_apply_scrub_pii(on) {
    if (!FASTLOGS_ENABLED) return;
    if (!script_exists(asset_get_index("__fastlogs_state"))) return;
    var st = __fastlogs_state();
    if (!is_struct(st.cfg)) st.cfg = {};
    st.cfg.scrubPii = bool(on);
}

function fastlogs_ui_settings_save() {
    if (!FASTLOGS_ENABLED) return;
    var ui = fastlogs_ui_state();
    try {
        var fname = fastlogs_ui_ini_path();
        ini_open(fname);
        ini_write_real("fastlogs", "screenshot", ui.cfg_screenshot ? 1 : 0);
        ini_write_real("fastlogs", "autosend",   ui.cfg_autosend ? 1 : 0);
        ini_write_real("fastlogs", "ring_size",  ui.cfg_ring_size);
        ini_write_real("fastlogs", "scrub_pii",  ui.cfg_scrub_pii ? 1 : 0);   // PII scrubbing (#3)
        ini_close();
    } catch (_e) {
        // Writing unavailable (console/sandbox) - ignore; settings live only for the session.
    }
}

/// @returns {string} path to the overlay settings ini file inside game_save_id
function fastlogs_ui_ini_path() {
    // game_save_id already includes a trailing slash (GM-NOTES 2.6).
    // Placed in the same folder as the persist log, named settings.ini.
    return game_save_id + FASTLOGS_PERSIST_DIR + "/settings.ini";
}

// =====================================================================================
// TOAST STATUS (feature STATUS, B). Lightweight notification shown over the game EVEN without
//   the overlay open. Drawn only when there is something to show (toast_frames != 0) -
//   otherwise zero work in Draw.
//   Types: "info" (neutral), "sending" (held while a send is in progress), "ok" (success + link),
//   "error" (reason + "Retry" hint/zone). Durations from FASTLOGS_TOAST_*.
// =====================================================================================

/// @returns {real} frames for the given duration in seconds (based on actual game speed)
function fastlogs_ui_toast_frames_for(seconds) {
    // game_get_speed(gamespeed_fps) - target logic FPS; fallback to 60 if unavailable/0.
    var _fps = 60;
    try {
        var f = game_get_speed(gamespeed_fps);
        if (is_real(f) && f > 0) _fps = f;
    } catch (_e) { _fps = 60; }
    return max(1, round(seconds * _fps));
}

/// Basic toast (backward compatibility: clipboard calls fastlogs_ui_toast(text)).
///   This is a short info toast. no-op when !FASTLOGS_ENABLED or toast is disabled.
function fastlogs_ui_toast(text) {
    if (!FASTLOGS_ENABLED) return;
    fastlogs_status_toast("info", string(text));
}

/// Status toast with type. kind: "info"|"sending"|"ok"|"error". opt - struct { url, retry }.
///   "sending" is held until the next status (timer -1). Others expire on a timer.
/// @param {string} kind
/// @param {string} text
/// @param {struct} [opt] { url:string, retry:bool }
function fastlogs_status_toast(kind, text, opt = undefined) {
    if (!FASTLOGS_ENABLED) return;
    if (!FASTLOGS_TOAST_ENABLED) return;
    var ui = fastlogs_ui_state();
    ui.toast_text  = string(text);
    ui.toast_kind  = is_string(kind) ? kind : "info";
    ui.toast_url   = (is_struct(opt) && variable_struct_exists(opt, "url")   && is_string(opt.url)) ? opt.url   : "";
    ui.toast_retry = (is_struct(opt) && variable_struct_exists(opt, "retry")) ? bool(opt.retry) : false;

    switch (ui.toast_kind) {
        case "sending":
            ui.toast_frames = -1;   // hold until send completes (cleared by the next status)
            break;
        case "error":
            ui.toast_frames = fastlogs_ui_toast_frames_for(FASTLOGS_TOAST_ERROR_SECONDS);
            break;
        default: // info / ok
            ui.toast_frames = fastlogs_ui_toast_frames_for(FASTLOGS_TOAST_SECONDS);
            break;
    }
}

/// Hide the toast immediately (e.g. when the overlay is opened manually).
function fastlogs_status_toast_clear() {
    if (!FASTLOGS_ENABLED) return;
    var ui = fastlogs_ui_state();
    ui.toast_frames = 0;
    ui.toast_text   = "";
    ui.toast_retry  = false;
    ui.toast_url    = "";
}

// =====================================================================================
// DRAWING. Called from Draw GUI (obj_fastlogs_controller -> Draw_64.gml).
//   Populates ui.hit with zones for subsequent input. Applies presses accumulated
//   by input THIS frame (ui.pressed/ui.px/ui.py) right here, so clicks respond
//   to the same coordinates/zones as drawn (single source of truth - hit-rects).
// =====================================================================================
function fastlogs_ui_draw() {
    if (!FASTLOGS_ENABLED) return;
    var ui = fastlogs_ui_state();

    // Decrement the toast frame counter even when the overlay is closed. toast_frames == -1 -> hold (sending).
    if (ui.toast_frames > 0) ui.toast_frames -= 1;

    if (!ui.open) {
        // Overlay is closed: draw ONLY the toast and only if it is active (otherwise zero work -
        //   no hit-rect collection, no draw state). Toast is visible over the game (feature STATUS, B).
        if (ui.toast_frames != 0) {
            // Fresh click zones only for the toast (retry/copy link).
            ui.hit = [];
            var old_col_t  = draw_get_colour();
            var old_alpha_t = draw_get_alpha();
            var old_hal_t  = draw_get_halign();
            var old_val_t  = draw_get_valign();
            fastlogs_ui_draw_toast(ui);
            // Consume click on toast zones (Retry/Copy) if a tap occurred this frame.
            if (ui.pressed) {
                var hid_t = fastlogs_ui_hit_test(ui, ui.px, ui.py);
                if (hid_t != "") fastlogs_ui_action(hid_t, ui);
                ui.pressed = false;
            }
            draw_set_colour(old_col_t);
            draw_set_alpha(old_alpha_t);
            draw_set_halign(old_hal_t);
            draw_set_valign(old_val_t);
        }
        return;
    }

    // Fresh zone list for this frame.
    ui.hit = [];

    var gw = display_get_gui_width();
    var gh = display_get_gui_height();

    // Element scale: base for ~1080p, no smaller than the minimum touch size.
    var ui_scale = max(1, min(gw, gh) / 720);
    var btn_h    = max(FASTLOGS_BTN_MIN_SIZE, round(56 * ui_scale));
    var pad      = max(8, round(12 * ui_scale));
    var fsize    = max(1, ui_scale);

    // Save and set draw state (restored at the end to avoid breaking the game).
    var old_col   = draw_get_colour();
    var old_alpha = draw_get_alpha();
    var old_hal   = draw_get_halign();
    var old_val   = draw_get_valign();

    draw_set_halign(fa_left);
    draw_set_valign(fa_top);

    // --- Main panel (top-left). Width ~ half the screen, within reasonable bounds.
    var panel_w = clamp(round(gw * 0.42), 360, gw - pad * 2);
    var panel_x = pad;
    var panel_y = pad;
    var x1 = panel_x;
    var _y = panel_y;

    // Panel height is the sum of the rows below; for simplicity we draw the background tall enough.
    // +1 row for "Tester:" (line_h) and +comment field (comment_h) on top of the original 5 button rows.
    var line_h    = round(28 * ui_scale);          // height of a single-line label
    var comment_h = btn_h * 2;                      // height of the multi-line comment field
    var panel_h = btn_h * 5 + pad * 9 + line_h + comment_h;
    fastlogs_ui_panel_bg(x1, _y, x1 + panel_w, _y + panel_h);

    var inner_x = x1 + pad;
    var inner_w = panel_w - pad * 2;
    var cy = _y + pad;

    // Header.
    draw_set_alpha(1);
    draw_set_colour(FASTLOGS_COL_TEXT);
    fastlogs_ui_text(inner_x, cy, "FastLogs", fsize * 1.2);
    // Settings button (gear) and close button in the top-right corner of the panel.
    var gear_x2 = x1 + panel_w - pad;
    var gear_x1 = gear_x2 - btn_h;
    fastlogs_ui_button(gear_x1, cy - 4, gear_x2, cy - 4 + btn_h, "Настройки", "settings_toggle", fsize, ui);
    cy += btn_h + pad;

    // --- E/W/L counters (with color). Fetched from the public getter; safe if no data yet.
    var counts = fastlogs_ui_get_counts_safe();
    var third  = inner_w / 3;
    fastlogs_ui_counter(inner_x,             cy, third - pad, btn_h, "E", counts.error, FASTLOGS_COL_ERROR, fsize);
    fastlogs_ui_counter(inner_x + third,     cy, third - pad, btn_h, "W", counts.warn,  FASTLOGS_COL_WARN,  fsize);
    fastlogs_ui_counter(inner_x + third * 2, cy, third - pad, btn_h, "L", counts.log,   FASTLOGS_COL_LOG,   fsize);
    cy += btn_h + pad;

    // --- Tester name (from config FASTLOGS_TESTER / runtime-override). Read-only display.
    //   Helps the tester confirm their name will be included with the report (feature TESTER).
    var tester_name = fastlogs_ui_tester_safe();
    draw_set_colour(FASTLOGS_COL_LOG);
    fastlogs_ui_text(inner_x, cy, "Тестер:", fsize);
    draw_set_colour(FASTLOGS_COL_TEXT);
    var tester_shown = (tester_name == "") ? "(не задан в конфиге)" : tester_name;
    fastlogs_ui_text_clipped(inner_x + round(110 * ui_scale), cy, tester_shown, fsize, inner_w - round(110 * ui_scale));
    cy += line_h + pad * 0.5;

    // --- Tester comment field (feature COMMENT). Click on field -> input mode (keyboard_string).
    //   Multi-line text; goes into opts.comment on send. Accent border when focused.
    draw_set_colour(FASTLOGS_COL_LOG);
    fastlogs_ui_text(inner_x, cy, "Комментарий (опишите проблему):", fsize);
    cy += line_h;
    var cmt_y1 = cy;
    var cmt_y2 = cy + comment_h;
    // Field background.
    draw_set_colour(FASTLOGS_COL_BTN);
    draw_set_alpha(1);
    draw_rectangle(inner_x, cmt_y1, inner_x + inner_w, cmt_y2, false);
    // Border: accent if editing, regular otherwise.
    draw_set_colour(ui.comment_editing ? FASTLOGS_COL_ACCENT : FASTLOGS_COL_BTN_HOVER);
    draw_rectangle(inner_x, cmt_y1, inner_x + inner_w, cmt_y2, true);
    // Comment text or placeholder. Multi-line (draw_text wraps on "\n").
    var cmt = ui.comment_text;
    if (cmt == "") {
        draw_set_colour(FASTLOGS_COL_LOG);
        fastlogs_ui_text(inner_x + pad * 0.5, cmt_y1 + pad * 0.5, ui.comment_editing ? "Печатайте... (Enter - новая строка)" : "Нажмите, чтобы ввести", fsize);
    } else {
        draw_set_colour(FASTLOGS_COL_TEXT);
        // Cursor indicator in input mode (blinking on a frame timer).
        var cursor = (ui.comment_editing && ((current_time div 500) mod 2 == 0)) ? "_" : "";
        // draw_text renders multi-line on "\n" natively; scaling is via transformed.
        draw_text_transformed(inner_x + pad * 0.5, cmt_y1 + pad * 0.5, cmt + cursor, fsize, fsize, 0);
    }
    // Click zone for the entire field -> input focus.
    fastlogs_ui_register_hit(ui, inner_x, cmt_y1, inner_x + inner_w, cmt_y2, "comment_focus");
    cy = cmt_y2 + pad;

    // --- "Send" button + "Screenshot" toggle (large zone).
    var half = inner_w / 2;
    var sending = fastlogs_ui_is_sending_safe();
    var send_label = sending ? "Отправка..." : "Отправить";
    fastlogs_ui_button(inner_x, cy, inner_x + half - pad, cy + btn_h, send_label, "send", fsize, ui);

    var shot_on = ui.cfg_screenshot;
    fastlogs_ui_toggle(inner_x + half, cy, inner_x + inner_w, cy + btn_h, "Скриншот", shot_on, "toggle_screenshot", fsize, ui);
    cy += btn_h + pad;

    // --- URL area + "Copy" button.
    var url = fastlogs_ui_last_url_safe();
    var copy_w = max(btn_h * 2, round(140 * ui_scale));
    var url_x2 = inner_x + inner_w - copy_w - pad;
    // URL field background.
    draw_set_colour(FASTLOGS_COL_BTN);
    draw_set_alpha(1);
    draw_rectangle(inner_x, cy, url_x2, cy + btn_h, false);
    draw_set_colour(FASTLOGS_COL_TEXT);
    var url_shown = (url == "") ? "(ещё нет ссылки)" : url;
    fastlogs_ui_text_clipped(inner_x + pad * 0.5, cy + btn_h * 0.5 - 8 * fsize, url_shown, fsize, url_x2 - inner_x - pad);
    fastlogs_ui_button(url_x2 + pad, cy, inner_x + inner_w, cy + btn_h, "Копировать", "copy", fsize, ui);
    cy += btn_h + pad;

    // --- Bottom row: Recording indicator + Start/Stop, Clear.
    var rec_on = fastlogs_ui_is_recording_safe();
    // Recording indicator (circle/square) + label.
    var ind_size = round(btn_h * 0.4);
    draw_set_colour(rec_on ? FASTLOGS_COL_ERROR : FASTLOGS_COL_BTN);
    draw_set_alpha(1);
    draw_rectangle(inner_x, cy + (btn_h - ind_size) * 0.5, inner_x + ind_size, cy + (btn_h + ind_size) * 0.5, false);
    draw_set_colour(FASTLOGS_COL_TEXT);
    fastlogs_ui_text(inner_x + ind_size + pad * 0.5, cy + btn_h * 0.5 - 8 * fsize, rec_on ? "REC" : "off", fsize);

    var rec_btn_x1 = inner_x + ind_size + pad + round(70 * ui_scale);
    var rec_btn_x2 = rec_btn_x1 + round(160 * ui_scale);
    fastlogs_ui_button(rec_btn_x1, cy, rec_btn_x2, cy + btn_h, rec_on ? "Stop Rec" : "Start Rec", "toggle_record", fsize, ui);
    fastlogs_ui_button(rec_btn_x2 + pad, cy, inner_x + inner_w, cy + btn_h, "Clear", "clear", fsize, ui);
    cy += btn_h + pad;

    // --- Settings panel (independent, on top). Draw if open.
    if (ui.settings_open) {
        fastlogs_ui_draw_settings(gw, gh, ui_scale, btn_h, pad, fsize, ui);
    }

    // --- Toast (including the "held" status "Sending..." with toast_frames == -1).
    if (ui.toast_frames != 0) fastlogs_ui_draw_toast(ui);

    // Apply accumulated input against this frame's zones (after all hit-rects are collected).
    if (ui.pressed) {
        var hid = fastlogs_ui_hit_test(ui, ui.px, ui.py);
        // A click outside the comment field removes input focus (so typing doesn't go nowhere).
        if (ui.comment_editing && hid != "comment_focus") {
            fastlogs_comment_set_editing(false);
        }
        if (hid != "") fastlogs_ui_action(hid, ui);
        ui.pressed = false; // consumed
    }

    // Restore draw state.
    draw_set_colour(old_col);
    draw_set_alpha(old_alpha);
    draw_set_halign(old_hal);
    draw_set_valign(old_val);
}

// =====================================================================================
// SETTINGS PANEL (independent). Displays endpoint/appId (read-only), toggles, and buffer counter.
// =====================================================================================
function fastlogs_ui_draw_settings(gw, gh, ui_scale, btn_h, pad, fsize, ui) {
    var panel_w = clamp(round(gw * 0.5), 420, gw - pad * 2);
    var panel_h = btn_h * 8 + pad * 10;     // +1 row for the "PII Scrubbing" toggle (#3)
    var x1 = gw - panel_w - pad;            // right side
    var y1 = pad;
    fastlogs_ui_panel_bg(x1, y1, x1 + panel_w, y1 + panel_h);

    var ix = x1 + pad;
    var iw = panel_w - pad * 2;
    var cy = y1 + pad;

    draw_set_colour(FASTLOGS_COL_TEXT);
    draw_set_alpha(1);
    fastlogs_ui_text(ix, cy, "Настройки FastLogs", fsize * 1.1);
    // Close settings.
    fastlogs_ui_button(x1 + panel_w - pad - btn_h * 2, cy - 4, x1 + panel_w - pad, cy - 4 + btn_h, "Закрыть", "settings_close", fsize, ui);
    cy += btn_h + pad;

    // Endpoint (read-only display).
    draw_set_colour(FASTLOGS_COL_LOG);
    fastlogs_ui_text(ix, cy, "Endpoint:", fsize);
    draw_set_colour(FASTLOGS_COL_TEXT);
    var ep = (FASTLOGS_ENDPOINT == "") ? "(не задан)" : FASTLOGS_ENDPOINT;
    fastlogs_ui_text_clipped(ix + round(120 * ui_scale), cy, ep, fsize, iw - round(120 * ui_scale));
    cy += round(28 * ui_scale) + pad * 0.5;

    // AppId (read-only display).
    draw_set_colour(FASTLOGS_COL_LOG);
    fastlogs_ui_text(ix, cy, "AppId:", fsize);
    draw_set_colour(FASTLOGS_COL_TEXT);
    var aid = (FASTLOGS_APP_ID == "") ? "(не задан)" : FASTLOGS_APP_ID;
    fastlogs_ui_text_clipped(ix + round(120 * ui_scale), cy, aid, fsize, iw - round(120 * ui_scale));
    cy += round(28 * ui_scale) + pad;

    // "Screenshot" toggle.
    fastlogs_ui_toggle(ix, cy, ix + iw, cy + btn_h, "Скриншот в payload", ui.cfg_screenshot, "set_toggle_screenshot", fsize, ui);
    cy += btn_h + pad;

    // "Autosend" toggle (UI level: allow auto-send - e.g. on exception).
    fastlogs_ui_toggle(ix, cy, ix + iw, cy + btn_h, "Autosend", ui.cfg_autosend, "set_toggle_autosend", fsize, ui);
    cy += btn_h + pad;

    // "PII Scrubbing" toggle (#3). DEFAULT private (ON). ON -> email/IP/tokens/long numbers -> [redacted].
    fastlogs_ui_toggle(ix, cy, ix + iw, cy + btn_h, "Чистка PII (приватность)", ui.cfg_scrub_pii, "set_toggle_scrub_pii", fsize, ui);
    cy += btn_h + pad;

    // Start/Stop Recording with indicator.
    var rec_on = fastlogs_ui_is_recording_safe();
    fastlogs_ui_toggle(ix, cy, ix + iw, cy + btn_h, rec_on ? "Recording: ON" : "Recording: OFF", rec_on, "toggle_record", fsize, ui);
    cy += btn_h + pad;

    // Buffer capacity (display + -/+ buttons). Changes only the UI cache (ui.cfg_ring_size);
    //   actual ring size application is on the core side, if it reads this value.
    draw_set_colour(FASTLOGS_COL_TEXT);
    fastlogs_ui_text(ix, cy + btn_h * 0.5 - 8 * fsize, "Буфер: " + string(ui.cfg_ring_size), fsize);
    var bx2 = ix + iw;
    fastlogs_ui_button(bx2 - btn_h, cy, bx2, cy + btn_h, "+", "ring_inc", fsize, ui);
    fastlogs_ui_button(bx2 - btn_h * 2 - pad, cy, bx2 - btn_h - pad, cy + btn_h, "-", "ring_dec", fsize, ui);
    // Clear is also convenient right here.
    fastlogs_ui_button(ix, cy, ix + round(120 * ui_scale), cy + btn_h, "Clear", "clear", fsize, ui);
}

// =====================================================================================
// HIT-TEST AND ACTION HANDLING
// =====================================================================================

/// @returns {string} id of the zone under the point (last added, i.e. topmost), or ""
function fastlogs_ui_hit_test(ui, px, py) {
    // Iterate from the end: later-drawn zones (settings panel/toast) overlap earlier ones.
    var n = array_length(ui.hit);
    for (var i = n - 1; i >= 0; i--) {
        var r = ui.hit[i];
        if (px >= r.x1 && px <= r.x2 && py >= r.y1 && py <= r.y2) return r.id;
    }
    return "";
}

/// Execute the action for a zone id. Uses ONLY the public API of other modules.
function fastlogs_ui_action(id, ui) {
    switch (id) {
        case "settings_toggle": ui.settings_open = !ui.settings_open; break;
        case "settings_close":  ui.settings_open = false; break;

        case "comment_focus":
            // Click on comment field -> enable input mode (keyboard_string).
            fastlogs_comment_set_editing(true);
            break;

        case "send":
            // Pass the entered comment into the send call (opts.comment). We don't include an empty one -
            //   the payload would drop it anyway, but we avoid cluttering opts. Remove input focus.
            fastlogs_comment_set_editing(false);
            if (script_exists(asset_get_index("fastlogs_send"))) {
                var send_opts = {};
                var cmt_send = fastlogs_comment_get();
                if (is_string(cmt_send) && string_length(cmt_send) > 0) {
                    send_opts.comment = cmt_send;
                }
                fastlogs_send(send_opts);
            }
            break;

        case "copy":
            // URL copying is delegated to the clipboard module (it also shows the toast).
            if (script_exists(asset_get_index("fastlogs_copy_url"))) fastlogs_copy_url();
            break;

        case "toast_copy_url":
            // Click on the "Done" toast with a link -> copy it (feature STATUS, B).
            if (script_exists(asset_get_index("fastlogs_copy_url"))) fastlogs_copy_url();
            break;

        case "toast_retry":
            // Click on the "Error" toast -> retry the send with the same body (feature STATUS, B).
            //   This toast with a "Retry" button is shown only on a TERMINAL error
            //   (no pending deferred retry) - so fastlogs_send won't be blocked here
            //   and will collect a fresh payload. If a send/pending is already in progress - it will be rejected.
            if (script_exists(asset_get_index("fastlogs_send"))) {
                fastlogs_send({ title: "Retry send" });
            }
            break;

        case "toggle_screenshot":
        case "set_toggle_screenshot":
            ui.cfg_screenshot = !ui.cfg_screenshot;
            if (script_exists(asset_get_index("fastlogs_set_screenshot"))) fastlogs_set_screenshot(ui.cfg_screenshot);
            fastlogs_ui_settings_save();
            break;

        case "set_toggle_autosend":
            ui.cfg_autosend = !ui.cfg_autosend;
            fastlogs_ui_settings_save();
            break;

        case "set_toggle_scrub_pii":
            // PII scrubbing (#3): toggle -> apply to runtime config + persist to ini.
            ui.cfg_scrub_pii = !ui.cfg_scrub_pii;
            fastlogs_ui_apply_scrub_pii(ui.cfg_scrub_pii);
            fastlogs_ui_settings_save();
            break;

        case "toggle_record":
            if (script_exists(asset_get_index("fastlogs_is_recording")) &&
                script_exists(asset_get_index("fastlogs_record_set"))) {
                fastlogs_record_set(!fastlogs_is_recording());
            }
            break;

        case "clear":
            if (script_exists(asset_get_index("fastlogs_clear"))) fastlogs_clear();
            fastlogs_ui_toast("очищено");
            break;

        case "ring_inc":
            ui.cfg_ring_size = min(100000, ui.cfg_ring_size + 500);
            fastlogs_ui_settings_save();
            break;

        case "ring_dec":
            ui.cfg_ring_size = max(100, ui.cfg_ring_size - 500);
            fastlogs_ui_settings_save();
            break;
    }
}

// =====================================================================================
// DRAWING PRIMITIVES (helpers). All draw via draw_rectangle/draw_text and register zones.
// =====================================================================================

/// Panel background with transparency.
function fastlogs_ui_panel_bg(x1, y1, x2, y2) {
    draw_set_colour(FASTLOGS_COL_PANEL);
    draw_set_alpha(FASTLOGS_BG_ALPHA);
    draw_rectangle(x1, y1, x2, y2, false);
    // Border.
    draw_set_alpha(1);
    draw_set_colour(FASTLOGS_COL_BTN_HOVER);
    draw_rectangle(x1, y1, x2, y2, true);
}

/// Text with scale (via draw_text_transformed for size independent of the font asset).
function fastlogs_ui_text(x, y, str, scale) {
    // draw_text_transformed(x,y,string,xscale,yscale,angle) - standard function.
    draw_text_transformed(x, y, str, scale, scale, 0);
}

/// Text clipped to a maximum width (roughly by character count - to prevent a long URL from overflowing).
function fastlogs_ui_text_clipped(x, y, str, scale, max_w) {
    var s = str;
    // Character width estimate ~ string_width of the current font; guard against division by zero.
    var sw = string_width(s) * scale;
    if (sw > max_w && string_length(s) > 0 && max_w > 0) {
        var keep = max(1, floor(string_length(s) * (max_w / sw)) - 1);
        s = string_copy(s, 1, keep) + "...";
    }
    fastlogs_ui_text(x, y, s, scale);
}

/// Button with hover highlight and click zone registration.
function fastlogs_ui_button(x1, y1, x2, y2, label, id, scale, ui) {
    var hot = (fastlogs_ui_hit_test_point(ui, x1, y1, x2, y2));
    draw_set_colour(hot ? FASTLOGS_COL_BTN_HOVER : FASTLOGS_COL_BTN);
    draw_set_alpha(1);
    draw_rectangle(x1, y1, x2, y2, false);
    draw_set_colour(FASTLOGS_COL_ACCENT);
    draw_rectangle(x1, y1, x2, y2, true);
    draw_set_colour(FASTLOGS_COL_TEXT);
    // Center text.
    draw_set_halign(fa_center);
    draw_set_valign(fa_middle);
    fastlogs_ui_text((x1 + x2) * 0.5, (y1 + y2) * 0.5, label, scale);
    draw_set_halign(fa_left);
    draw_set_valign(fa_top);
    fastlogs_ui_register_hit(ui, x1, y1, x2, y2, id);
}

/// Toggle (on/off) with color state indication.
function fastlogs_ui_toggle(x1, y1, x2, y2, label, is_on, id, scale, ui) {
    draw_set_colour(is_on ? FASTLOGS_COL_ACCENT : FASTLOGS_COL_BTN);
    draw_set_alpha(is_on ? 0.85 : 1);
    draw_rectangle(x1, y1, x2, y2, false);
    draw_set_alpha(1);
    draw_set_colour(FASTLOGS_COL_TEXT);
    draw_rectangle(x1, y1, x2, y2, true);
    draw_set_halign(fa_center);
    draw_set_valign(fa_middle);
    fastlogs_ui_text((x1 + x2) * 0.5, (y1 + y2) * 0.5, label + (is_on ? "  [ON]" : "  [off]"), scale);
    draw_set_halign(fa_left);
    draw_set_valign(fa_top);
    fastlogs_ui_register_hit(ui, x1, y1, x2, y2, id);
}

/// Level counter (colored block with a letter and number).
function fastlogs_ui_counter(x1, y1, w, h, letter, value, col, scale) {
    draw_set_colour(FASTLOGS_COL_BTN);
    draw_set_alpha(1);
    draw_rectangle(x1, y1, x1 + w, y1 + h, false);
    draw_set_colour(col);
    draw_set_halign(fa_center);
    draw_set_valign(fa_middle);
    fastlogs_ui_text((x1 + x1 + w) * 0.5, (y1 + y1 + h) * 0.5, letter + ": " + string(value), scale);
    draw_set_halign(fa_left);
    draw_set_valign(fa_top);
}

/// Toast notification centered at the bottom (feature STATUS, B). Border color by type; for "ok" shows
///   a link and a clickable copy zone, for "error" - a "Retry" zone.
///   Registers click zones in ui.hit (consumed by fastlogs_ui_draw in both branches).
function fastlogs_ui_draw_toast(ui) {
    if (ui.toast_text == "") return;
    var gw = display_get_gui_width();
    var gh = display_get_gui_height();

    var kind = variable_struct_exists(ui, "toast_kind") ? ui.toast_kind : "info";
    // Border/accent color by status type.
    var accent = FASTLOGS_COL_ACCENT;
    switch (kind) {
        case "sending": accent = FASTLOGS_COL_WARN;   break;   // "Sending..."
        case "ok":      accent = FASTLOGS_COL_ACCENT; break;   // success (green)
        case "error":   accent = FASTLOGS_COL_ERROR;  break;   // error (red)
        default:        accent = FASTLOGS_COL_BTN_HOVER; break; // info (neutral)
    }

    // Secondary line below the main text: link (ok) or retry hint (error).
    var url   = variable_struct_exists(ui, "toast_url")   ? ui.toast_url   : "";
    var retry = variable_struct_exists(ui, "toast_retry") ? ui.toast_retry : false;
    var has_url   = (kind == "ok")    && is_string(url) && string_length(url) > 0;
    var has_retry = (kind == "error") && retry;

    var main_w = string_width(ui.toast_text);
    var sub_text = "";
    if (has_url)   sub_text = url + "   (нажмите - копировать)";
    if (has_retry) sub_text = "Нажмите, чтобы повторить отправку";
    var sub_w = (sub_text != "") ? string_width(sub_text) : 0;

    var tw = max(main_w, sub_w) + 40;
    var th = (sub_text != "") ? 74 : 48;
    var tx = (gw - tw) * 0.5;
    var ty = gh - th - 40;

    draw_set_colour(FASTLOGS_COL_PANEL);
    draw_set_alpha(0.9);
    draw_rectangle(tx, ty, tx + tw, ty + th, false);
    draw_set_alpha(1);
    draw_set_colour(accent);
    draw_rectangle(tx, ty, tx + tw, ty + th, true);

    // Main status text.
    draw_set_colour(FASTLOGS_COL_TEXT);
    draw_set_halign(fa_center);
    draw_set_valign(fa_middle);
    var main_cy = (sub_text != "") ? (ty + 18) : ((ty + ty + th) * 0.5);
    draw_text((tx + tx + tw) * 0.5, main_cy, ui.toast_text);

    // Secondary line + clickable zone (copy link / retry).
    if (sub_text != "") {
        draw_set_colour(has_retry ? FASTLOGS_COL_ERROR : FASTLOGS_COL_ACCENT);
        draw_text((tx + tx + tw) * 0.5, ty + th - 20, sub_text);
        // The entire toast panel is clickable for the corresponding action.
        if (has_url)   fastlogs_ui_register_hit(ui, tx, ty, tx + tw, ty + th, "toast_copy_url");
        if (has_retry) fastlogs_ui_register_hit(ui, tx, ty, tx + tw, ty + th, "toast_retry");
    }

    draw_set_halign(fa_left);
    draw_set_valign(fa_top);
}

/// Registers a click zone (for subsequent/current hit-test).
function fastlogs_ui_register_hit(ui, x1, y1, x2, y2, id) {
    array_push(ui.hit, { x1: x1, y1: y1, x2: x2, y2: y2, id: id });
}

/// Hover highlight: is the input pointer (ui.px/py) inside the rectangle?
function fastlogs_ui_hit_test_point(ui, x1, y1, x2, y2) {
    return (ui.px >= x1 && ui.px <= x2 && ui.py >= y1 && ui.py <= y2);
}

// =====================================================================================
// SAFE GETTERS (do not crash if the corresponding module has not been populated by the builder yet).
//   We use script_exists(asset_get_index(...)) before calling other modules' public functions.
// =====================================================================================
function fastlogs_ui_get_counts_safe() {
    if (script_exists(asset_get_index("fastlogs_get_counts"))) {
        var c = fastlogs_get_counts();
        // Guard against incomplete struct.
        return {
            error: variable_struct_exists(c, "error") ? c.error : 0,
            warn:  variable_struct_exists(c, "warn")  ? c.warn  : 0,
            log:   variable_struct_exists(c, "log")   ? c.log   : 0,
        };
    }
    return { error: 0, warn: 0, log: 0 };
}

function fastlogs_ui_is_sending_safe() {
    if (script_exists(asset_get_index("fastlogs_is_sending"))) return fastlogs_is_sending();
    return false;
}

function fastlogs_ui_last_url_safe() {
    if (script_exists(asset_get_index("fastlogs_last_url"))) return fastlogs_last_url();
    return "";
}

function fastlogs_ui_is_recording_safe() {
    if (script_exists(asset_get_index("fastlogs_is_recording"))) return fastlogs_is_recording();
    return false;
}

/// @returns {string} tester name taking into account runtime-override (fastlogs_init({tester})), otherwise the macro
function fastlogs_ui_tester_safe() {
    // __fastlogs_cfg (core) takes into account the override from fastlogs_init; if core is not yet loaded -
    //   fall back to the FASTLOGS_TESTER macro itself.
    var t = FASTLOGS_TESTER;
    if (script_exists(asset_get_index("__fastlogs_cfg"))) {
        t = __fastlogs_cfg("tester", FASTLOGS_TESTER);
    }
    return is_string(t) ? t : "";
}
