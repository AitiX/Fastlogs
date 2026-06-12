/// @description FastLogs controller - Draw GUI End
// Надёжная точка захвата скриншота (GM-NOTES 2.2: screen_save/surface_save рекомендованы здесь).
// Если был запрошен скриншот (fastlogs_screenshot_request) - снимаем кадр именно сейчас.
if (!FASTLOGS_ENABLED) { exit; }

if (script_exists(asset_get_index("fastlogs_screenshot_tick_draw_end"))) fastlogs_screenshot_tick_draw_end();
