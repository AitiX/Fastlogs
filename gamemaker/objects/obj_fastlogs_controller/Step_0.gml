/// @description FastLogs controller - Step
// Опрос ввода (hotkey/геймпад/тач/мышь -> toggle оверлея / быстрая отправка, заполнение
//   указателя для кликов). Клики по зонам оверлея/тоста потребляются в Draw GUI (Draw_64).
// ПЕРФ (D): здесь же дешёвый тик батч-флаша записи на диск (по таймеру, без аллокаций когда пусто).
if (!FASTLOGS_ENABLED) { exit; }

// Единый опрос ввода. Заполняет global.__fastlogs_ui.px/py/pressed и обрабатывает хоткеи/жесты.
if (script_exists(asset_get_index("fastlogs_input_poll"))) fastlogs_input_poll();

// ПЕРФ (D): сбросить накопленный батч записи на диск, если подошёл интервал таймера.
//   Дёшево: ранний выход внутри, когда батч пуст (никакого file IO/аллокаций в кадре).
if (script_exists(asset_get_index("fastlogs_recorder_tick"))) fastlogs_recorder_tick();
