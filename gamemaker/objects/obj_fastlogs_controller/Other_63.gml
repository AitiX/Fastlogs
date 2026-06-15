/// @description FastLogs controller - Async Save/Load (eventType 7 / eventNum 63)
// Completion of async file operations (buffer_save_async / buffer_load_async).
// NOT CURRENTLY USED: screenshot is written synchronously (surface_save/screen_save) and read in the
//   same frame; the recorder is also synchronous - no code path sends this event. Left as a stub
//   for future async persistence; the event must remain on obj (eventType 7 / eventNum 63).
if (!FASTLOGS_ENABLED) { exit; }

// No async FastLogs operations here yet. When adding buffer_*_async, match against async_load[? "id"].
