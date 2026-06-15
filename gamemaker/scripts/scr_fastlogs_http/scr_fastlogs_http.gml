/// @description scr_fastlogs_http
// FastLogs GameMaker client - HTTP (sends payload to the ingest server).
// Purpose: fastlogs_send([opts]) assembles the body (payload script) and sends a POST via
//   http_request with Content-Type + optional Authorization Bearer headers; stores the request id
//   and send state; response parsing is in the Async HTTP event (Other_62.gml).
// Gating: when !FASTLOGS_ENABLED all entry points are no-ops (http_request is NOT called).
//
// STATE is stored in global.__fastlogs.http (consistent with core/recorder/screenshot,
//   which keep their sub-states in the shared global.__fastlogs). Fields:
//     state         : "idle" | "sending" | "ok" | "error"
//     request_id    : real   - current http_request id (-1 if none)
//     is_sending    : bool
//     last_url      : string - url of the last successful log ("" if none)
//     last_status   : real   - last http_status (0 if none)
//     retry_count   : real   - number of IMMEDIATE retries already made for the current send
//     pending_body  : string - body of the current request (for retry)
//   RETRY-UNTIL-SUCCESS (deferred retry on alarm timer; RETRY feature):
//     dretry_active   : bool   - whether there is currently ONE (single) pending retry
//     dretry_body     : string - body of the report waiting for a deferred retry
//     dretry_count    : real   - number of deferred retries already performed (for limit/counter)
//     dretry_seconds  : real   - seconds remaining until the next attempt (alarm ticks once/sec)
//   One pending at a time: while a pending is active (or a send is in progress), a new EXTERNAL
//     fastlogs_send is BLOCKED (no-op + status), without cancelling the pending (see fastlogs_send).
//   The countdown/restart itself is driven by the controller's Alarm[0] (Other Alarm_0.gml), not Step.
//
// DEPENDENCIES (real names - verified against neighbouring scripts):
//   __fastlogs_state()                  (core) - shared global state
//   fastlogs_build_payload_json(opts)   (payload)
//   fastlogs_screenshot_request(cb)     (screenshot) - async frame capture
//   FASTLOGS_* macros                   (config)
//
// Verified (GM-NOTES 2.1 + WebSearch June 2026): http_request(url, method, header_map /*ds_map
//   of strings*/, body /*string*/) -> request id; headers key/value without colon; the map can be
//   destroyed immediately (GM copies the values).

// Default retry count (local macro to avoid touching config).
#macro FASTLOGS_HTTP_MAX_RETRIES 2

// =====================================================================================
// Internal: lazily create and return the http sub-state inside global.__fastlogs.
// =====================================================================================
function __fastlogs_http_state() {
    var st = __fastlogs_state();   // core
    if (!variable_struct_exists(st, "http") || !is_struct(st.http)) {
        st.http = {
            state        : "idle",
            request_id   : -1,
            is_sending   : false,
            last_url     : "",
            last_status  : 0,
            retry_count  : 0,
            pending_body : "",
            // RETRY-UNTIL-SUCCESS (deferred retry; RETRY feature).
            dretry_active  : false,
            dretry_body    : "",
            dretry_count   : 0,
            dretry_seconds : 0,
            // CRASH-REPORT PERSIST (feature #1): path of the pending file tied to the CURRENT
            //   in-flight request. On success the Async handler will delete this file from the queue.
            //   "" -> regular send (not from queue), nothing to delete.
            pending_file   : "",
            // OUTBOX DRAIN (feature #1, "at first opportunity").
            //   FIX-1: PER_START limit (FASTLOGS_PENDING_RESEND_PER_START) applies ONLY to the
            //   STARTUP backstop (the chain initiated by fastlogs_pending_resend_all at init), to
            //   avoid hammering the entire outbox in a single start. The LIVE idle drain (after a
            //   regular send / immediate crash / after the startup chain finishes) is NOT gated by
            //   this counter - it pulls the next pending until the outbox is empty (volume is capped
            //   by FASTLOGS_PENDING_MAX/enforce_cap).
            init_chain_active : false,  // whether the STARTUP drain chain is active (resend_all launched)
            init_drain_count  : 0,      // files resent within the STARTUP chain (PER_START limit)
        };
    }
    return st.http;
}

// =====================================================================================
// fastlogs_send([opts]) -> bool
// Assembles the payload and queues a POST request. true if the request (or screenshot capture
//   for it) was queued; false if no-op (disabled / no endpoint / send already in progress).
// opts (optional, struct): title, comment, retentionDays, screenshot, extraDevice (see payload).
//   comment (string<=4000) - free-form problem description from a tester; goes into the comment field.
//     opts is forwarded to the payload in full (including via the saved st.__http_pending_opts
//     on the screenshot path), so comment reaches the body automatically.
// =====================================================================================
function fastlogs_send(opts = undefined) {
    if (!FASTLOGS_ENABLED) { return false; }

    // endpoint is required.
    if (!is_string(FASTLOGS_ENDPOINT) || string_length(FASTLOGS_ENDPOINT) == 0) {
        show_debug_message("[FastLogs] send skipped: FASTLOGS_ENDPOINT is empty");
        // Status hint to the player (QUICK-SEND/STATUS feature): don't crash, explain the reason.
        fastlogs_send_status("error", "Ошибка: не задан endpoint", false);
        return false;
    }

    var hs = __fastlogs_http_state();

    // Prevent parallel sends (one at a time).
    if (hs.is_sending) {
        show_debug_message("[FastLogs] send skipped: already sending");
        fastlogs_send_status("info", "Отправка уже идёт...", false);
        return false;
    }

    // RETRY-UNTIL-SUCCESS (RETRY feature): while the current report has not been sent successfully,
    //   BLOCK a new EXTERNAL send - including the waiting window between deferred retry attempts.
    //   If a pending retry is currently waiting (ticking on the timer), don't cancel it and don't
    //   start a new send: show status and exit. The INTERNAL retry goes not through fastlogs_send
    //   (but through fastlogs_retry_tick -> fastlogs_http_post_internal), so this guard does not
    //   affect it and the retry series continues.
    if (fastlogs_retry_is_pending()) {
        show_debug_message("[FastLogs] send skipped: retry pending (waiting to resend current report)");
        fastlogs_send_status("info", "Отправка уже идёт (ждём повтор)", false);
        return false;
    }

    if (!is_struct(opts)) { opts = {}; }

    // PERF (D): before assembling the payload, flush the recorder batch to disk so the
    //   file/logText are consistent (logText is taken from rec_text, but we also keep
    //   the on-disk file up to date).
    if (script_exists(asset_get_index("fastlogs_recorder_flush"))) {
        try { fastlogs_recorder_flush(); } catch (_ef) { /* best-effort */ }
    }

    // STATUS (B): raise "Sending..." immediately - visible above the game even without the overlay.
    fastlogs_send_status("sending", "Отправка...", false);

    // Is a screenshot needed for this send?
    //   priority: opts.screenshot (explicit override) -> current toggle state -> macro default.
    var st = __fastlogs_state();
    var want_shot = variable_struct_exists(st, "screenshot") ? bool(st.screenshot) : FASTLOGS_SCREENSHOT_DEFAULT;
    if (variable_struct_exists(opts, "screenshot")) { want_shot = bool(opts.screenshot); }

    // Mark busy IMMEDIATELY so a concurrent send is rejected while capture/request is in flight.
    hs.is_sending = true;
    hs.state      = "sending";
    hs.retry_count = 0;
    hs.pending_file = "";   // regular send - not from the pending queue (feature #1)

    if (want_shot) {
        // Async frame capture (will happen in the nearest Draw GUI End), then send
        //   from the callback. The callback receives the ready base64 (or "" on failure) -
        //   in either case we assemble the payload (the payload will pick up fastlogs_screenshot_base64() itself).
        fastlogs_screenshot_request(function(_b64) {
            // By the time the callback fires, the screenshot is already in the screenshot state - the payload will read it.
            fastlogs_http_dispatch(undefined);
        });
        // opts must reach the callback - save them in state (the callback function above
        //   closes over global state, not local opts).
        st.__http_pending_opts = opts;
        return true;
    }

    // No screenshot - assemble and send immediately.
    return fastlogs_http_dispatch(opts);
}

// =====================================================================================
// fastlogs_quick_send([opts]) -> bool  (QUICK-SEND feature, A)
// Quick send of the CURRENT recording WITHOUT opening the overlay (fire-and-forget): called from
//   a hotkey/gesture or directly from integrator code. Thin wrapper over fastlogs_send: adds a
//   friendly status toast and does NOT require UI.
// Edge behavior (contract A): if there are no log entries at all - don't send an empty payload,
//   show a status hint and don't crash. A recording is NOT required for sending:
//   logText is taken from the in-memory ring even when persistent recording is disabled.
// Returns: true if the send/capture was queued; false if no-op (empty/no endpoint/busy).
// =====================================================================================
function fastlogs_quick_send(opts = undefined) {
    if (!FASTLOGS_ENABLED) { return false; }
    if (!is_struct(opts)) { opts = {}; }

    // No logs at all -> nothing to send. Show hint instead of an empty report (don't crash).
    var have_logs = false;
    if (script_exists(asset_get_index("fastlogs_get_counts"))) {
        var c = fastlogs_get_counts();
        if (is_struct(c)) {
            var e = variable_struct_exists(c, "error") ? c.error : 0;
            var w = variable_struct_exists(c, "warn")  ? c.warn  : 0;
            var l = variable_struct_exists(c, "log")   ? c.log   : 0;
            have_logs = (e + w + l) > 0;
        }
    }
    if (!have_logs) {
        fastlogs_send_status("info", "Нет логов для отправки", false);
        return false;
    }

    // Quick-send tag in title (if the integrator didn't set their own) - helps distinguish in the dashboard.
    if (!variable_struct_exists(opts, "title")) { opts.title = "Quick send"; }
    return fastlogs_send(opts);
}

// =====================================================================================
// fastlogs_pending_send(body_json, file_path) -> bool  (feature #1: pending crash resend)
// Send an ALREADY BUILT JSON report body from the disk queue (recorder.pending). On success
//   the Async handler (Other_62) will delete file_path from the queue (via hs.pending_file).
//   Does NOT rebuild the payload (the body already carries timestampUtc/logText/counts/comment/
//   tester/context/breadcrumbs from the moment of crash). Does NOT take a screenshot.
//   Respects single-flight: if a send is already in progress or a deferred retry is waiting -
//   returns false (the file stays in the queue, will be picked up later).
// Returns: true if the request was queued; false if no-op (disabled / no endpoint / busy / empty).
// =====================================================================================
function fastlogs_pending_send(body_json, file_path) {
    if (!FASTLOGS_ENABLED) { return false; }
    if (!is_string(FASTLOGS_ENDPOINT) || string_length(FASTLOGS_ENDPOINT) == 0) { return false; }
    if (!is_string(body_json) || string_length(body_json) == 0) { return false; }

    var hs = __fastlogs_http_state();
    // Single-flight: don't interfere with an ongoing send/retry wait (file waits for next time).
    if (hs.is_sending || fastlogs_retry_is_pending()) { return false; }

    hs.is_sending   = true;
    hs.state        = "sending";
    hs.retry_count  = 0;
    hs.pending_body = body_json;
    // Bind the file to this request: on success the Async handler will delete exactly this file.
    hs.pending_file = is_string(file_path) ? file_path : "";

    // Light status (not required at start, but informative if an overlay/toast is connected).
    fastlogs_send_status("sending", "Досыл отчёта о краше...", false);

    return fastlogs_http_post_internal(body_json);
}

// =====================================================================================
// Internal: assemble the body (with already-ready screenshot, if any) and queue the POST.
//   opts == undefined -> use saved st.__http_pending_opts (path taken after capture).
//   true if http_request was called.
// =====================================================================================
function fastlogs_http_dispatch(opts) {
    if (!FASTLOGS_ENABLED) { return false; }
    var st = __fastlogs_state();
    var hs = __fastlogs_http_state();

    if (is_undefined(opts)) {
        opts = variable_struct_exists(st, "__http_pending_opts") ? st.__http_pending_opts : {};
    }
    if (!is_struct(opts)) { opts = {}; }

    var body = fastlogs_build_payload_json(opts);
    if (!is_string(body) || string_length(body) == 0) {
        show_debug_message("[FastLogs] send aborted: empty payload");
        hs.is_sending = false;
        hs.state      = "error";
        // STATUS (B): dismiss the hanging "Sending..." toast -> error (no retry: body is empty).
        fastlogs_send_status("error", "Ошибка: пустой отчёт", false);
        return false;
    }

    hs.pending_body = body;
    return fastlogs_http_post_internal(body);
}

// =====================================================================================
// Internal: queues a single POST request with a ready body. true if http_request was called.
// Used for both the initial send and retries (body is already assembled).
// =====================================================================================
function fastlogs_http_post_internal(body) {
    var hs = __fastlogs_http_state();

    // Headers: ds_map of strings (NOT a struct). Key/value without colon.
    var headers = ds_map_create();
    ds_map_add(headers, "Content-Type", "application/json");
    if (is_string(FASTLOGS_TOKEN) && string_length(FASTLOGS_TOKEN) > 0) {
        ds_map_add(headers, "Authorization", "Bearer " + FASTLOGS_TOKEN);
    }

    // Connection timeout (best-effort; affects subsequent requests).
    // // TODO verify: does http_set_connect_timeout apply to already-in-flight requests or only new ones.
    if (is_real(FASTLOGS_HTTP_TIMEOUT_MS) && FASTLOGS_HTTP_TIMEOUT_MS > 0) {
        http_set_connect_timeout(FASTLOGS_HTTP_TIMEOUT_MS);
    }

    var req = http_request(FASTLOGS_ENDPOINT, "POST", headers, body);

    // The map can be destroyed immediately - GM copies the header values.
    ds_map_destroy(headers);

    if (!is_real(req)) {
        show_debug_message("[FastLogs] http_request returned non-real id");
        hs.is_sending = false;
        hs.state      = "error";
        // STATUS (B): dismiss the hanging "Sending..." toast -> error with retry option.
        fastlogs_send_status("error", "Ошибка: запрос не создан", true);
        return false;
    }

    hs.request_id  = req;
    hs.is_sending  = true;
    hs.state       = "sending";
    hs.last_status = 0;

    show_debug_message("[FastLogs] POST -> " + FASTLOGS_ENDPOINT + " (req id " + string(req) + ", body " + string(string_byte_length(body)) + " bytes)");
    return true;
}

// =====================================================================================
// fastlogs_http_retry() -> bool
// Retries the last send if attempts remain. Called from the Async HTTP handler
//   (Other_62.gml) on a network error/5xx. true if the retry was queued.
// =====================================================================================
function fastlogs_http_retry() {
    if (!FASTLOGS_ENABLED) { return false; }
    var hs = __fastlogs_http_state();

    if (hs.retry_count >= FASTLOGS_HTTP_MAX_RETRIES) {
        show_debug_message("[FastLogs] retries exhausted (" + string(hs.retry_count) + ")");
        return false;
    }
    if (!is_string(hs.pending_body) || string_length(hs.pending_body) == 0) {
        return false;
    }
    hs.retry_count += 1;
    show_debug_message("[FastLogs] retry " + string(hs.retry_count) + "/" + string(FASTLOGS_HTTP_MAX_RETRIES));
    // Reuse the already-assembled body (same snapshot - correct for a retry).
    return fastlogs_http_post_internal(hs.pending_body);
}

// =====================================================================================
// RETRY-UNTIL-SUCCESS (deferred retry on alarm timer; RETRY feature).
// -------------------------------------------------------------------------------------
// Idea: when a send finally fails (after the uploader's immediate retries), we put ONE
//   pending report up for retry every FASTLOGS_RETRY_INTERVAL_SEC seconds and keep retrying
//   until it succeeds (or until the FASTLOGS_RETRY_MAX limit is reached).
// Timer: Alarm[0] of the controller (obj_fastlogs_controller). We tick once per SECOND -
//   this lets us update the "Retry in Ns..." status without running every frame and without
//   allocations. When the second counter reaches 0, the retry itself is fired.
// One pending at a time: scheduling replaces the body and resets the second counter; while
//   a pending is active, a new manual fastlogs_send is BLOCKED and does not touch the pending
//   (see fastlogs_send).
// =====================================================================================

// Internal: arm the controller's Alarm[0] for ~1 second (countdown tick).
//   Converts seconds to frames using the real game speed (same as the toast timer). // TODO verify
//   alarm[]: a step counter on the object; GM decrements it every Step and fires
//   the Alarm[0] event when it reaches 0 (engine mechanism, NOT polling in our code).
function __fastlogs_retry_arm_alarm() {
    if (!instance_exists(obj_fastlogs_controller)) { return false; }
    var frames = 60;   // fallback ~1 s at 60 fps
    if (script_exists(asset_get_index("fastlogs_ui_toast_frames_for"))) {
        frames = fastlogs_ui_toast_frames_for(1);   // 1 second -> frames at current fps
    } else {
        var _fps = game_get_speed(gamespeed_fps);
        if (is_real(_fps) && _fps > 0) frames = round(_fps);
    }
    // Single alarm arm on the one persistent controller.
    with (obj_fastlogs_controller) { alarm[0] = frames; }
    return true;
}

// =====================================================================================
// fastlogs_retry_schedule(body) -> bool
// Set (or REPLACE) the single pending report for a deferred retry. true if scheduled.
//   no-op if deferred retry is disabled (interval 0) or the body is empty.
// Called from the Async HTTP handler when immediate retries are exhausted/inappropriate.
// =====================================================================================
function fastlogs_retry_schedule(body) {
    if (!FASTLOGS_ENABLED) { return false; }
    // Interval 0 -> deferred retry disabled (behaviour as before: manual "Retry").
    if (!is_real(FASTLOGS_RETRY_INTERVAL_SEC) || FASTLOGS_RETRY_INTERVAL_SEC <= 0) { return false; }
    if (!is_string(body) || string_length(body) == 0) { return false; }

    var hs = __fastlogs_http_state();
    // One pending at a time: new scheduling replaces the body and restarts the countdown.
    hs.dretry_active  = true;
    hs.dretry_body    = body;
    hs.dretry_seconds = FASTLOGS_RETRY_INTERVAL_SEC;
    // dretry_count is NOT reset here: this is a continuation of the retry series for the same
    //   report (the counter grows each time a deferred attempt is executed in fastlogs_retry_tick).

    show_debug_message("[FastLogs] retry-until-success scheduled in " + string(FASTLOGS_RETRY_INTERVAL_SEC) + "s (attempt " + string(hs.dretry_count + 1) + ")");
    // Raise status immediately so the tester sees the countdown without waiting for the first tick.
    fastlogs_send_status("sending", "Повтор через " + string(FASTLOGS_RETRY_INTERVAL_SEC) + "s...", false);

    if (!__fastlogs_retry_arm_alarm()) {
        // Controller does not exist (should not happen when FASTLOGS_ENABLED) - the pending is not
        //   lost, but without the timer it won't tick; mark for diagnostics.
        show_debug_message("[FastLogs] retry scheduled but controller instance missing - alarm not armed");
    }
    return true;
}

// =====================================================================================
// fastlogs_retry_tick() -> void
// One countdown tick for the deferred retry. Called once per SECOND from the controller's
//   Alarm[0] (NOT every frame). Decrements the second counter; updates the
//   "Retry in Ns..." status; fires the retry itself (with the same body) when the counter
//   reaches zero. Re-arms the alarm for the next second while a pending is active.
// =====================================================================================
function fastlogs_retry_tick() {
    if (!FASTLOGS_ENABLED) { return; }
    var hs = __fastlogs_http_state();
    if (!hs.dretry_active) { return; }   // no pending - tick does nothing

    // If a send is already in progress at this moment (e.g. the user pressed Send manually),
    //   don't interfere: the current pending was cancelled by the manual send. Safety net.
    if (hs.is_sending) { return; }

    hs.dretry_seconds -= 1;

    if (hs.dretry_seconds > 0) {
        // Still waiting: update status and re-arm the alarm for the next second.
        fastlogs_send_status("sending", "Повтор через " + string(hs.dretry_seconds) + "s...", false);
        __fastlogs_retry_arm_alarm();
        return;
    }

    // Time is up - execute the deferred retry with the same body.
    hs.dretry_count += 1;
    show_debug_message("[FastLogs] retry-until-success attempt " + string(hs.dretry_count));

    var body = hs.dretry_body;
    if (!is_string(body) || string_length(body) == 0) {
        // Body is gone - nothing to retry, cancel the pending.
        fastlogs_retry_cancel();
        return;
    }

    // Reset the immediate retry counter for the new attempt and send.
    //   pending remains active: if this attempt fails again, the Async handler will
    //   reschedule it (fastlogs_retry_schedule), continuing the series.
    hs.retry_count   = 0;
    hs.pending_body  = body;
    hs.state         = "sending";
    fastlogs_send_status("sending", "Повтор отправки...", false);
    fastlogs_http_post_internal(body);
    // Do NOT re-arm the alarm here: the outcome (success/new pending) is decided by the Async HTTP handler.
}

// =====================================================================================
// fastlogs_retry_cancel() -> void
// Cancel the current pending deferred retry (if any) and reset its counters.
//   Called on final success, on a terminal error, and when the retry body disappears.
// =====================================================================================
function fastlogs_retry_cancel() {
    if (!FASTLOGS_ENABLED) { return; }
    var hs = __fastlogs_http_state();
    hs.dretry_active  = false;
    hs.dretry_body    = "";
    hs.dretry_seconds = 0;
    hs.dretry_count   = 0;
    // Disarm the controller's alarm so the old countdown does not fire.
    if (instance_exists(obj_fastlogs_controller)) {
        with (obj_fastlogs_controller) { alarm[0] = -1; }   // -1 = alarm disabled
    }
}

// =====================================================================================
// fastlogs_retry_is_pending() -> bool
// true if there is currently a report waiting for a deferred retry. false when !FASTLOGS_ENABLED.
// =====================================================================================
function fastlogs_retry_is_pending() {
    if (!FASTLOGS_ENABLED) { return false; }
    return bool(__fastlogs_http_state().dretry_active);
}

// =====================================================================================
// fastlogs_is_sending() -> bool
// true while there is an unfinished request. false when !FASTLOGS_ENABLED.
// =====================================================================================
function fastlogs_is_sending() {
    if (!FASTLOGS_ENABLED) { return false; }
    return bool(__fastlogs_http_state().is_sending);
}

// =====================================================================================
// fastlogs_last_url() -> string
// URL of the last successfully created log (from the server response). "" if none yet.
// =====================================================================================
function fastlogs_last_url() {
    if (!FASTLOGS_ENABLED) { return ""; }
    var u = __fastlogs_http_state().last_url;
    return is_string(u) ? u : "";
}

// =====================================================================================
// Internal (for the Async HTTP event): access to the http state.
// =====================================================================================
function fastlogs_http_get_state() {
    return __fastlogs_http_state();
}

// =====================================================================================
// Internal: safely raise a status toast (STATUS feature, B) without making http hard-depend
//   on the overlay module. If the overlay is not connected - simply no-op. kind: info/sending/ok/error.
// =====================================================================================
function fastlogs_send_status(kind, text, retry, url = "") {
    if (!FASTLOGS_ENABLED) { return; }
    if (!script_exists(asset_get_index("fastlogs_status_toast"))) { return; }
    var opt = { retry: bool(retry) };
    if (is_string(url) && string_length(url) > 0) { opt.url = url; }
    fastlogs_status_toast(kind, text, opt);
}
