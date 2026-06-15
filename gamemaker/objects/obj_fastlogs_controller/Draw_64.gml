/// @description FastLogs controller - Draw GUI
// Renders the overlay using PRIMITIVES (draw_rectangle/draw_text) and consumes clicks on zones.
// When the overlay is closed, fastlogs_ui_draw draws nothing on its own (except the active toast).
if (!FASTLOGS_ENABLED) { exit; }

if (script_exists(asset_get_index("fastlogs_ui_draw"))) fastlogs_ui_draw();
