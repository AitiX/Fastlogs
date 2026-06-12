/// @description FastLogs controller - Draw GUI
// Отрисовка оверлея ПРИМИТИВАМИ (draw_rectangle/draw_text) и потребление кликов по зонам.
// При закрытом оверлее fastlogs_ui_draw сам ничего не рисует (кроме активного тоста).
if (!FASTLOGS_ENABLED) { exit; }

if (script_exists(asset_get_index("fastlogs_ui_draw"))) fastlogs_ui_draw();
