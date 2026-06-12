/// @description scr_fastlogs_clipboard
// FastLogs GameMaker client - БУФЕР ОБМЕНА.
// Обёртка clipboard_set_text + тост "скопировано" в оверлее.
//   clipboard_set_text поддержан на Windows/Ubuntu/macOS/Android/iOS/HTML5/OperaGX,
//   НЕ на консолях (PS/Switch/Xbox) - поэтому гейтим по платформе (fastlogs_clipboard_available).
//   На консолях copy просто no-op + тост "недоступно".
//
// Все точки входа: ранний выход при !FASTLOGS_ENABLED.
// Сверка GML-API: GM-NOTES.md (clipboard_* подтверждены поиском, июнь 2026).

/// @returns {bool} доступен ли системный буфер обмена на текущей платформе
function fastlogs_clipboard_available() {
    // Консоли не поддерживают clipboard - исключаем их.
    switch (os_type) {
        case os_ps4:
        case os_ps5:
        case os_switch:
        case os_xboxone:
        case os_xboxseriesxs:
            return false;
        default:
            // На остальных (Windows/macOS/Linux/Android/iOS/HTML5) - поддержано.
            return true;
    }
}

/// Копировать произвольный текст в буфер обмена + тост. no-op при !FASTLOGS_ENABLED.
/// @param {string} text - что копировать
/// @param {string} [toast] - текст тоста (по умолчанию "скопировано")
/// @returns {bool} удалось ли скопировать
function fastlogs_copy_text(text, toast) {
    if (!FASTLOGS_ENABLED) return false;
    var msg = (argument_count > 1) ? toast : "скопировано";
    if (!fastlogs_clipboard_available()) {
        // Платформа без буфера обмена (консоль) - сообщаем в оверлее.
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

/// Копировать URL последнего лога (используется кнопкой "Копировать" в оверлее).
/// @returns {bool} удалось ли
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
