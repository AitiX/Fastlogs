/// @description FastLogs controller - Create
// When !FASTLOGS_ENABLED the controller is not created (instance_destroy immediately).
// Initializes UI state and loads persisted overlay settings.
// NOTE: ring buffer / counters / recording / exception handler are initialized by scr_fastlogs_core
//   (its build) - only overlay/input/screenshot/clipboard concerns are handled here.
if (!FASTLOGS_ENABLED) { instance_destroy(); exit; }

// Lazy initialization of UI state (overlay/input) and loading ini settings.
//   fastlogs_ui_state creates global.__fastlogs_ui; settings_load applies the screenshot toggle.
if (script_exists(asset_get_index("fastlogs_ui_state")))         fastlogs_ui_state();
if (script_exists(asset_get_index("fastlogs_ui_settings_load"))) fastlogs_ui_settings_load();

// Initialize screenshot capture state (lazy, but created upfront).
if (script_exists(asset_get_index("fastlogs_shot_state")))       fastlogs_shot_state();
