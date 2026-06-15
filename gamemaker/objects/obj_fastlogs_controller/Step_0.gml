/// @description FastLogs controller - Step
// Input poll (hotkey/gamepad/touch/mouse -> overlay toggle / quick send, pointer fill
//   for clicks). Clicks on overlay/toast zones are consumed in Draw GUI (Draw_64).
// PERF (D): cheap batch-flush tick for writing to disk also happens here (timer-based, no allocations when empty).
if (!FASTLOGS_ENABLED) { exit; }

// Unified input poll. Fills global.__fastlogs_ui.px/py/pressed and handles hotkeys/gestures.
if (script_exists(asset_get_index("fastlogs_input_poll"))) fastlogs_input_poll();

// PERF (D): flush the accumulated write batch to disk if the timer interval has elapsed.
//   Cheap: early exit inside when the batch is empty (no file IO/allocations in frame).
if (script_exists(asset_get_index("fastlogs_recorder_tick"))) fastlogs_recorder_tick();
