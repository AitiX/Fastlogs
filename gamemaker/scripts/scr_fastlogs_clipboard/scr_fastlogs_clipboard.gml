/// @description scr_fastlogs_clipboard
// FastLogs GameMaker client - CLIPBOARD.
// Wrapper around clipboard_set_text + a "copied" toast in the overlay.
//   clipboard_set_text is supported on Windows/Ubuntu/macOS/Android/iOS/HTML5/OperaGX,
//   NOT on consoles (PS/Switch/Xbox) - so we gate by platform (fastlogs_clipboard_available).
//   On consoles, copy is simply a no-op + an "unavailable" toast.
//
// All entry points: early-out when !FASTLOGS_ENABLED.
// GML-API reference: GM-NOTES.md (clipboard_* confirmed by search, June 2026).

/// @returns {bool} whether the system clipboard is available on the current platform
function fastlogs_clipboard_available() {
    // Consoles do not support clipboard - exclude them.
    switch (os_type) {
        case os_ps4:
        case os_ps5:
        case os_switch:
        case os_xboxone:
        case os_xboxseriesxs:
            return false;
        default:
            // All others (Windows/macOS/Linux/Android/iOS/HTML5) - supported.
            return true;
    }
}

/// Copy arbitrary text to the clipboard + show a toast. no-op when !FASTLOGS_ENABLED.
/// @param {string} text - text to copy
/// @param {string} [toast] - toast message (defaults to "copied" if omitted)
/// @returns {bool} whether the copy succeeded
function fastlogs_copy_text(text, toast) {
    if (!FASTLOGS_ENABLED) return false;
    var msg = (argument_count > 1) ? toast : "скопировано";
    if (!fastlogs_clipboard_available()) {
        // Platform without clipboard support (console) - notify via overlay.
        if (script_exists(asset_get_index("fastlogs_ui_toast"))) fastlogs_ui_toast("буфер недоступен");
        return false;
    }
    if (string(text) == "") {
        if (script_exists(asset_get_index("fastlogs_ui_toast"))) fastlogs_ui_toast("нечего копировать");
        return false;
    }
    clipboard_set_text(string(text));
    if (script_exists(asset_get_index("fastlogs_ui_toast"))) fastlogs_ui_toast(msg);
    return true;
}

/// Copy the URL of the last log (used by the "Copy" button in the overlay).
/// @returns {bool} whether the copy succeeded
function fastlogs_copy_url() {
    if (!FASTLOGS_ENABLED) return false;
    var url = "";
    if (script_exists(asset_get_index("fastlogs_last_url"))) url = fastlogs_last_url();
    if (url == "") {
        if (script_exists(asset_get_index("fastlogs_ui_toast"))) fastlogs_ui_toast("ссылки ещё нет");
        return false;
    }
    return fastlogs_copy_text(url, "ссылка скопирована");
}
