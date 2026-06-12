/// @description FastLogs controller - Async Save/Load (eventType 7 / eventNum 63)
// Завершение асинхронных файловых операций (buffer_save_async / buffer_load_async).
// СЕЙЧАС НЕ ИСПОЛЬЗУЕТСЯ: скриншот пишется синхронно (surface_save/screen_save) и читается в том
//   же кадре, рекордер тоже синхронен - ни один путь не шлёт это событие. Оставлено как заглушка
//   на случай будущего async-персиста; событие должно оставаться в obj (eventType 7 / eventNum 63).
if (!FASTLOGS_ENABLED) { exit; }

// Здесь пока нет async-операций FastLogs. При добавлении buffer_*_async сопоставлять async_load[? "id"].
