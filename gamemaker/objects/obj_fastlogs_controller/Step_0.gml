/// @description FastLogs controller - Step
// Опрос ввода (hotkey/геймпад/тач/мышь -> toggle оверлея, заполнение указателя для кликов).
// Клики по зонам оверлея потребляются в Draw GUI (Draw_64) этого же кадра по hit-rects.
if (!FASTLOGS_ENABLED) { exit; }

// Единый опрос ввода. Заполняет global.__fastlogs_ui.px/py/pressed и обрабатывает хоткеи/жесты.
if (script_exists(asset_get_index("fastlogs_input_poll"))) fastlogs_input_poll();
