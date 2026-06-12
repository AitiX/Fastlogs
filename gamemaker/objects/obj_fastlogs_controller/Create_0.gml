/// @description FastLogs controller - Create
// При !FASTLOGS_ENABLED контроллер не создаётся (instance_destroy сразу).
// Инициализация состояния UI и подгрузка персиста настроек оверлея.
// ПРИМЕЧАНИЕ: кольцо/счётчики/recording/exception handler инициализирует scr_fastlogs_core
//   (его билд) - здесь только то, что относится к overlay/input/screenshot/clipboard.
if (!FASTLOGS_ENABLED) { instance_destroy(); exit; }

// Ленивая инициализация UI-состояния (overlay/input) и подгрузка ini-настроек.
//   fastlogs_ui_state создаёт global.__fastlogs_ui; settings_load применяет тоггл скриншота.
if (script_exists(asset_get_index("fastlogs_ui_state")))         fastlogs_ui_state();
if (script_exists(asset_get_index("fastlogs_ui_settings_load"))) fastlogs_ui_settings_load();

// Инициализация состояния захвата скриншота (ленивое, но создадим заранее).
if (script_exists(asset_get_index("fastlogs_shot_state")))       fastlogs_shot_state();
