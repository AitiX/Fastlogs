/// @description FastLogs controller - Draw GUI End
// Reliable screenshot capture point (GM-NOTES 2.2: screen_save/surface_save are recommended here).
// If a screenshot was requested (fastlogs_screenshot_request) - capture the frame right now.
if (!FASTLOGS_ENABLED) { exit; }

if (script_exists(asset_get_index("fastlogs_screenshot_tick_draw_end"))) fastlogs_screenshot_tick_draw_end();
