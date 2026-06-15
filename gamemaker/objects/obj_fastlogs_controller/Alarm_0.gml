/// @description FastLogs controller - Alarm[0] (eventType 2 / eventNum 0)
// RETRY-UNTIL-SUCCESS (RETRY feature): deferred retry send timer.
// Fires once per SECOND while a pending report awaiting retry exists (armed in scr_fastlogs_http:
//   __fastlogs_retry_arm_alarm). Each tick decrements the countdown, updates the status
//   "Retry in Ns..." and triggers the retry itself when it reaches zero. PERF: this is an engine
//   alarm, not a per-frame poll - FastLogs does no work and allocates nothing between ticks.
// Verified against GM-NOTES 1.6: Alarm[0] = eventType 2 / eventNum 0 -> file Alarm_0.gml; GM
//   decrements alarm[0] every Step and fires this event when it reaches 0.
if (!FASTLOGS_ENABLED) { exit; }

// All countdown/restart/retry logic lives in scr_fastlogs_http (single source of truth for
//   HTTP state). The tick itself re-arms the alarm for the next second while pending is active.
if (script_exists(asset_get_index("fastlogs_retry_tick"))) {
    fastlogs_retry_tick();
}
