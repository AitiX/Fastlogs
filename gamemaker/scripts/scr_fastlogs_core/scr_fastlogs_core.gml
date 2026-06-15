/// @description scr_fastlogs_core
// FastLogs GameMaker client - CORE.
// Implements: level constants, state (global.__fastlogs), fastlogs_init,
//   flog/fastlogs_log/warn/error, ring buffer, session counters, fastlogs_clear,
//   fastlogs_get_counts, fastlogs_set_screenshot (flag), exception handler registration.
// Everything gated on FASTLOGS_ENABLED: when !FASTLOGS_ENABLED public entry points do an early return (no-op),
//   getters return safe defaults.
// State is stored in ONE global struct global.__fastlogs (not in instance variables
//   of the controller) - so public functions can be called from any context without with/instance_find.
//   The controller obj_fastlogs_controller only handles events (Step/Draw/Async).
// Cross-reference GML API against GM-NOTES.md / current documentation; mark uncertain things as // TODO verify.

// =====================================================================================
// Level constants (PUBLIC-API contract). Defined as macros here (config does not set them).
// =====================================================================================
#macro FASTLOGS_LEVEL_LOG   0
#macro FASTLOGS_LEVEL_WARN  1
#macro FASTLOGS_LEVEL_ERROR 2

// =====================================================================================
// Internal: lazily create and return the global state.
// Safe to call before fastlogs_init (lazy initialization), so the integrator does not crash
//   on call order. Does not do its own gating - the caller has already checked FASTLOGS_ENABLED.
// =====================================================================================
function __fastlogs_state() {
    if (!variable_global_exists("__fastlogs") || !is_struct(global.__fastlogs)) {
        var ring_size = max(1, FASTLOGS_RING_SIZE);
        global.__fastlogs = {
            inited       : false,           // whether fastlogs_init has run
            // Ring buffer of log entries. Each element: { time, level, text } or undefined.
            ring         : array_create(ring_size, undefined),
            ring_size    : ring_size,
            head         : 0,               // index of the next entry (write position)
            count        : 0,               // number of valid entries (<= ring_size)
            // PER-SESSION counters (not scoped to the ring) - go into payload counts.
            cnt_error    : 0,
            cnt_warn     : 0,
            cnt_log      : 0,
            // Flags shared across modules.
            recording    : false,           // actual recording state (managed by recorder)
            screenshot   : FASTLOGS_SCREENSHOT_DEFAULT, // whether to include a screenshot in the next payload
            // Runtime overrides from fastlogs_init(config) (override config macros).
            cfg          : {},
            // CRASH CAPTURE (always persist to outbox BEFORE delivery guards). Capture dedup is
            //   SEPARATE from delivery dedup: so a crash loop does not spam files, but capture
            //   does not depend on throttle/cap/sender busy state.
            capture_last_sig   : "",   // signature of the last CAPTURED (written to disk) stack
            capture_last_us    : -1,   // get_timer() of last capture (us), -1 = none; window = throttle
            // DELIVERY (immediate auto-send on crash, C): dedup/throttle/session limit.
            //   Affects ONLY immediate upload, NOT capture.
            //   FIX-3 (parity with Unity): delivery dedup is now WINDOWED, not "forever per session".
            //   autosend_last_sent_us - map of sig -> get_timer() of last DELIVERY of that stack (us).
            //   The same stack is suppressed only if its last delivery was LESS than the window
            //   minGap*2 ago (FASTLOGS_AUTOSEND_SUPPRESS_WINDOW_SECONDS); after the window - deliver again.
            autosend_last_sent_us : {},   // sig -> us of last auto-DELIVERY (windowed delivery dedup)
            autosend_last_us   : -1,   // get_timer() of last auto-SEND (us), -1 = none
            autosend_count     : 0,    // number of auto-sends done this session (limit)
            // recorder/http fields populate their sub-states lazily in their own modules.
        };
    }
    return global.__fastlogs;
}

// =====================================================================================
// Internal: get the effective value of a setting.
// Checks the runtime override from fastlogs_init(config) first, otherwise returns default_value
//   (normally the caller passes the corresponding FASTLOGS_* macro).
// =====================================================================================
function __fastlogs_cfg(key, default_value) {
    var st = __fastlogs_state();
    if (is_struct(st.cfg) && variable_struct_exists(st.cfg, key)) {
        var v = variable_struct_get(st.cfg, key);
        if (!is_undefined(v)) return v;
    }
    return default_value;
}

// =====================================================================================
// fastlogs_init([config_struct]) - idempotent initialization.
// Creates a persistent obj_fastlogs_controller (if not already present), initializes state,
//   loads persisted data from previous sessions, registers exception_unhandled_handler.
// Returns: controller instance id, or noone when !FASTLOGS_ENABLED.
// =====================================================================================
function fastlogs_init(config_struct = undefined) {
    if (!FASTLOGS_ENABLED) return noone;

    var st = __fastlogs_state();

    // Merge the provided config (soft: only the fields that are set).
    if (is_struct(config_struct)) {
        var keys = variable_struct_get_names(config_struct);
        for (var i = 0; i < array_length(keys); i++) {
            var k = keys[i];
            variable_struct_set(st.cfg, k, variable_struct_get(config_struct, k));
        }
    }

    // Create the controller once. object_index guarantees a single handler instance.
    if (!instance_exists(obj_fastlogs_controller)) {
        // depth does not matter (no Draw in world); persistent is set in .yy.
        instance_create_depth(0, 0, 0, obj_fastlogs_controller);
    }

    if (!st.inited) {
        st.inited = true;

        // Apply auto-start recording (respecting the autoStartRecording runtime override).
        var auto_rec = __fastlogs_cfg("autoStartRecording", FASTLOGS_AUTO_START_RECORDING);

        // Load persisted data from previous sessions and restore the recording flag (if configured).
        // Implementation in scr_fastlogs_recorder; safe to call (internally self-gated).
        fastlogs_recorder_load_persisted();

        // Apply screenshot default from config, if set.
        st.screenshot = __fastlogs_cfg("screenshot", FASTLOGS_SCREENSHOT_DEFAULT);

        if (auto_rec) {
            fastlogs_record_set(true);
        }

        // CRASH REPORT PERSIST (feature #1): scan the pending disk queue and RE-SEND
        //   unsent crash reports from previous sessions (so a hard crash gets delivered on this launch).
        //   Does not block the thread for long: at most FASTLOGS_PENDING_RESEND_PER_START resends are
        //   started at launch; single-flight -> only one send actually starts, others are picked up later. best-effort.
        try {
            if (script_exists(asset_get_index("fastlogs_pending_resend_all"))) {
                fastlogs_pending_resend_all();
            }
        } catch (_ep) { /* swallow: resend must not interfere with startup */ }

        // Register unhandled exception capture (best-effort: persist to disk,
        //   attempt to send; the game will close after the callback anyway - see GM-NOTES 2.4).
        if (FASTLOGS_AUTOSEND_ON_EXCEPTION) {
            // exception_unhandled_handler accepts a method/function; the callback receives an
            //   exception struct { message, longMessage, script, stacktrace }. CONFIRMED.
            exception_unhandled_handler(__fastlogs_on_unhandled_exception);
        }
    }

    return instance_exists(obj_fastlogs_controller) ? instance_find(obj_fastlogs_controller, 0) : noone;
}

// =====================================================================================
// Internal: exception signature for DEDUP (C). Takes script + first few frames of the stack trace
//   (not the message itself - it may contain variable values), hashes to a stable key.
//   md5-hex used as set key; prefix 's' -> guaranteed valid struct field name.
// =====================================================================================
function __fastlogs_exception_signature(ex) {
    var sig = "";
    try {
        if (is_struct(ex)) {
            if (variable_struct_exists(ex, "script")) sig += string(ex.script);
            if (variable_struct_exists(ex, "stacktrace") && is_array(ex.stacktrace)) {
                var stk = ex.stacktrace;
                var lim = min(array_length(stk), 8);   // a few frames is enough
                for (var i = 0; i < lim; i++) sig += "|" + string(stk[i]);
            }
            // If neither script nor stacktrace is available - fall back to message (coarser, but it's what we have).
            if (sig == "" && variable_struct_exists(ex, "message")) sig += string(ex.message);
        } else {
            sig = string(ex);
        }
    } catch (_e) {
        sig = "";
    }
    if (sig == "") sig = "unknown";
    return "s" + md5_string_utf8(sig);
}

// =====================================================================================
// Internal: should we CAPTURE (persist to outbox) this crash? Capture dedup is separate from
//   delivery dedup: if THE SAME stack was already captured within the throttle window (minGap), a new
//   file is NOT written (to prevent a crash loop from spamming the outbox). Otherwise - capture (and record state).
//   Window = FASTLOGS_AUTOSEND_THROTTLE_SECONDS (same as delivery). Returns bool (true -> write file).
//   IMPORTANT: this does NOT depend on cap/busy/session limit - only on its own capture dedup window.
// =====================================================================================
function __fastlogs_capture_allowed(sig) {
    var st = __fastlogs_state();
    var now_us = get_timer();
    var win = FASTLOGS_AUTOSEND_THROTTLE_SECONDS;   // capture dedup window = throttle
    // Same stack within window -> skip duplicate capture (capture dedup).
    if (FASTLOGS_AUTOSEND_DEDUP
        && is_string(st.capture_last_sig) && st.capture_last_sig != ""
        && st.capture_last_sig == sig
        && st.capture_last_us >= 0
        && is_real(win) && win > 0
        && (now_us - st.capture_last_us) < win * 1000000) {
        return false;
    }
    // Allow capture -> record state of SEPARATE capture dedup.
    st.capture_last_sig = sig;
    st.capture_last_us  = now_us;
    return true;
}

// =====================================================================================
// Internal: can we immediately auto-SEND (deliver) this crash right now? Applies session limit,
//   time throttle, and DELIVERY dedup by signature. Returns { allowed, reason }. When
//   allowed=true marks the signature as sent, increments the counter, and updates the timestamp
//   (delivery state is recorded here). Does NOT affect capture - capture is already done above.
// =====================================================================================
function __fastlogs_autosend_allowed(sig) {
    var st = __fastlogs_state();
    var now_us = get_timer();

    // Per-session limit (Unity canon = 10, see FASTLOGS_AUTOSEND_SESSION_LIMIT).
    if (st.autosend_count >= max(0, FASTLOGS_AUTOSEND_SESSION_LIMIT)) {
        return { allowed: false, reason: "session limit" };
    }
    // WINDOWED DELIVERY DEDUP (FIX-3, parity with Unity): suppress the same stack only if its
    //   last DELIVERY was LESS than the minGap*2 window ago. Before the window repeat was suppressed;
    //   after the window - deliver again (previously it was "forever per session" -> silenced until restart).
    if (FASTLOGS_AUTOSEND_DEDUP && is_struct(st.autosend_last_sent_us)
        && variable_struct_exists(st.autosend_last_sent_us, sig)) {
        var last_sent = variable_struct_get(st.autosend_last_sent_us, sig);
        var win = FASTLOGS_AUTOSEND_SUPPRESS_WINDOW_SECONDS;   // = throttle*2 (minGap*2)
        if (is_real(last_sent) && last_sent >= 0
            && is_real(win) && win > 0
            && (now_us - last_sent) < win * 1000000) {
            return { allowed: false, reason: "dedup (same stack within window)" };
        }
    }
    // Time throttle (any stack).
    var thr = FASTLOGS_AUTOSEND_THROTTLE_SECONDS;
    if (is_real(thr) && thr > 0 && st.autosend_last_us >= 0) {
        if ((now_us - st.autosend_last_us) < thr * 1000000) {
            return { allowed: false, reason: "throttled" };
        }
    }
    // Allowed -> record WINDOWED dedup state (delivery timestamp for this stack).
    if (FASTLOGS_AUTOSEND_DEDUP) variable_struct_set(st.autosend_last_sent_us, sig, now_us);
    st.autosend_last_us = now_us;
    st.autosend_count  += 1;
    return { allowed: true, reason: "" };
}

// =====================================================================================
// Internal (FIX-2): MINIMAL fallback crash capture, NOT depending on fastlogs_build_payload.
//   Called in the crash callback ONLY if the main builder (fastlogs_build_payload_json) returned ""
//   (crashed internally while collecting device/context/screenshot etc.). Builds a minimal contract body
//   directly from what is available, so the crash is NOT lost even when the builder is unavailable.
//   Sources: appId/appVersion/platform/timestampUtc/counts/logText/logEncoding (+ title/comment/
//   tester if present). logText = accumulated text from recorder/ring if available; otherwise -
//   message+stacktrace of the exception itself. All text is run through fastlogs_redact
//   (same as the normal path). If the minimum is absent (empty endpoint OR empty appId - nowhere to
//   send / nothing to identify with) - honestly returns "" (nothing written). best-effort, does not throw.
//   GML functions to verify against Manual: json_stringify, get_timer/date_*, asset_get_index/script_exists.
// =====================================================================================
function __fastlogs_build_fallback_crash_json(ex, opts = undefined) {
    if (!FASTLOGS_ENABLED) { return ""; }
    if (!is_struct(opts)) { opts = {}; }

    // Minimum gate: endpoint (where to send) + appId (how to identify). Source - macros,
    //   same as the happy-path (fastlogs_build_payload + http layer send to FASTLOGS_ENDPOINT/FASTLOGS_APP_ID),
    //   so the fallback gate matches the actual send (otherwise it could pass on cfg but fail on send).
    var endpoint = FASTLOGS_ENDPOINT;
    var app_id   = FASTLOGS_APP_ID;
    if (!is_string(endpoint) || string_length(endpoint) == 0) { return ""; }   // nowhere to send
    if (!is_string(app_id)   || string_length(app_id)   == 0) { return ""; }   // nothing to identify with

    // appVersion: macro -> GM_version (same as in payload builder).
    var app_version = FASTLOGS_APP_VERSION;
    if (!is_string(app_version) || string_length(app_version) == 0) {
        app_version = string(GM_version);
    }

    // platform: use the same mapper as the builder; if unavailable - safe "Other".
    var platform = "Other";
    try {
        if (script_exists(asset_get_index("fastlogs_platform_string"))) {
            platform = fastlogs_platform_string();
        }
    } catch (_ep) { platform = "Other"; }
    if (!is_string(platform) || string_length(platform) == 0) { platform = "Other"; }

    // timestampUtc = now (UTC ISO). __fastlogs_utc_iso - in recorder; fallback if unavailable.
    var ts_utc = "";
    try {
        if (script_exists(asset_get_index("__fastlogs_utc_iso"))) {
            ts_utc = __fastlogs_utc_iso();
        }
    } catch (_et) { ts_utc = ""; }
    if (!is_string(ts_utc) || string_length(ts_utc) == 0) {
        // Rough UTC ISO fallback without recorder dependencies.
        var prevtz = date_get_timezone();
        date_set_timezone(timezone_utc);
        var dt = date_current_datetime();
        var p2 = function(n) { return (n < 10 ? "0" : "") + string(n); };
        ts_utc = string(date_get_year(dt)) + "-" + p2(date_get_month(dt)) + "-" + p2(date_get_day(dt))
               + "T" + p2(date_get_hour(dt)) + ":" + p2(date_get_minute(dt)) + ":" + p2(date_get_second(dt)) + "Z";
        date_set_timezone(prevtz);
    }

    // counts: whatever is available for this session.
    var counts = { error: 0, warn: 0, log: 0 };
    try {
        var c = fastlogs_get_counts();
        if (is_struct(c)) {
            counts.error = is_real(c.error) ? c.error : 0;
            counts.warn  = is_real(c.warn)  ? c.warn  : 0;
            counts.log   = is_real(c.log)   ? c.log   : 0;
        }
    } catch (_ecn) { /* zeros */ }

    // logText: raw text from recorder/ring if available; otherwise message+stacktrace of the exception.
    var log_text = "";
    try {
        if (script_exists(asset_get_index("fastlogs_recorder_get_logtext"))) {
            log_text = fastlogs_recorder_get_logtext();
        }
    } catch (_elt) { log_text = ""; }
    if (!is_string(log_text)) { log_text = ""; }
    if (string_length(log_text) == 0) {
        // No accumulated log -> build minimum from the exception itself.
        var em = "UNHANDLED EXCEPTION";
        try {
            if (is_struct(ex)) {
                var m = variable_struct_exists(ex, "longMessage") ? string(ex.longMessage) : "";
                if (m == "" && variable_struct_exists(ex, "message")) m = string(ex.message);
                var scn = variable_struct_exists(ex, "script") ? string(ex.script) : "";
                em = "UNHANDLED EXCEPTION: " + m + (scn != "" ? (" @ " + scn) : "");
                if (variable_struct_exists(ex, "stacktrace") && is_array(ex.stacktrace)) {
                    var stk = ex.stacktrace;
                    for (var i = 0; i < array_length(stk); i++) em += "\n    at " + string(stk[i]);
                }
            } else {
                em = "UNHANDLED EXCEPTION: " + string(ex);
            }
        } catch (_eem) { em = "UNHANDLED EXCEPTION"; }
        log_text = em;
    }
    // Truncate to limit (same as in builder) if helper is available; otherwise send as-is.
    try {
        if (script_exists(asset_get_index("fastlogs_truncate_log"))) {
            var cut = fastlogs_truncate_log(log_text, FASTLOGS_MAX_LOG_BYTES);
            if (is_struct(cut)) {
                log_text = cut.text;
                if (cut.truncated) {
                    log_text += "\n...[FastLogs] logText truncated at " + string(FASTLOGS_MAX_LOG_BYTES) + " bytes...";
                }
            }
        }
    } catch (_ecut) { /* no truncation */ }

    // REDACTION (same as normal path): run logText through fastlogs_redact (self-gated by SCRUB_PII).
    try {
        if (script_exists(asset_get_index("fastlogs_redact"))) {
            log_text = fastlogs_redact(log_text);
        }
    } catch (_er) { /* leave as-is */ }

    // --- build minimal contract body (field order/fields same as builder) ---
    var body = {};
    body.appId        = app_id;
    body.platform     = platform;
    body.appVersion   = app_version;
    body.timestampUtc = ts_utc;
    body.counts       = counts;
    body.logText      = log_text;
    body.logEncoding  = FASTLOGS_LOG_ENCODING;
    // device is REQUIRED by contract (server: 400 bad_request "device must be an object",
    //   see server/src/routes/ingest.js). Full device collection may have crashed (which is why
    //   we are in the fallback), so we send an empty object {} - valid per contract (parity with Unity where
    //   MiniJson.WriteDevice always writes device:{}). Without this field the fallback file would get
    //   a 4xx -> poison-pill -> crash LOST (exactly what FIX-2 is meant to prevent).
    body.device       = {};

    // title (optional, <=120) - from crash_opts.
    if (variable_struct_exists(opts, "title")) {
        var t = opts.title;
        if (is_string(t) && string_length(t) > 0) {
            if (string_length(t) > 120) { t = string_copy(t, 1, 120); }
            body.title = t;
        }
    }

    // comment (optional, <=4000) - from opts or runtime cfg; run through redaction.
    var comment = variable_struct_exists(opts, "comment") ? opts.comment : __fastlogs_cfg("comment", "");
    if (is_string(comment) && string_length(comment) > 0) {
        if (string_length(comment) > 4000) { comment = string_copy(comment, 1, 4000); }
        try { if (script_exists(asset_get_index("fastlogs_redact"))) { comment = fastlogs_redact(comment); } } catch (_erc) {}
        if (is_string(comment) && string_length(comment) > 0) { body.comment = comment; }
    }

    // tester (optional, <=120) - cfg -> macro; run through redaction (as protection, usually a name).
    var tester = __fastlogs_cfg("tester", FASTLOGS_TESTER);
    if (is_string(tester) && string_length(tester) > 0) {
        if (string_length(tester) > 120) { tester = string_copy(tester, 1, 120); }
        try { if (script_exists(asset_get_index("fastlogs_redact"))) { tester = fastlogs_redact(tester); } } catch (_ert) {}
        if (is_string(tester) && string_length(tester) > 0) { body.tester = tester; }
    }

    return json_stringify(body);
}

// =====================================================================================
// Internal: unhandled exception callback (feature AUTO-SEND, C).
// Writes the error to the log (with guaranteed flush to disk via recorder), then AUTO-sends
//   with stack dedup + throttling + session limit (a repeating exception does not spam).
//   Async send may not complete before the game closes -> the main goal is disk persistence,
//   the actual send will complete on the next launch (accumulated logText). If the game survives - toast.
// =====================================================================================
function __fastlogs_on_unhandled_exception(ex) {
    // Do not rely on FASTLOGS_ENABLED here - the handler is only registered when enabled.
    var msg = "UNHANDLED EXCEPTION";
    try {
        if (is_struct(ex)) {
            var m  = variable_struct_exists(ex, "longMessage") ? string(ex.longMessage) : "";
            if (m == "" && variable_struct_exists(ex, "message")) m = string(ex.message);
            var sc = variable_struct_exists(ex, "script") ? string(ex.script) : "";
            msg = "UNHANDLED EXCEPTION: " + m + (sc != "" ? (" @ " + sc) : "");
            // Stacktrace - array of strings; append as separate entries.
            if (variable_struct_exists(ex, "stacktrace") && is_array(ex.stacktrace)) {
                var stk = ex.stacktrace;
                for (var i = 0; i < array_length(stk); i++) {
                    msg += "\n    at " + string(stk[i]);
                }
            }
        } else {
            msg = "UNHANDLED EXCEPTION: " + string(ex);
        }
    } catch (_e) {
        // Exception callbacks must not throw themselves - swallow.
    }

    // Write as error (session counter increment + ring + flush to disk if recording is on).
    flog(msg, FASTLOGS_LEVEL_ERROR);

    // Force flush to disk even if recording was off: on crash, saving data is critical.
    // Implementation in recorder - synchronously appends the FULL ring to the persist file (including batch).
    try {
        fastlogs_recorder_flush_crash();
    } catch (_e2) { /* swallow */ }

    // -------------------------------------------------------------------------------------
    // SEPARATION OF CAPTURE AND DELIVERY ("always capture" decision).
    // -------------------------------------------------------------------------------------
    // Stack signature is needed for both capture dedup and delivery dedup.
    var sig = "unknown";
    try { sig = __fastlogs_exception_signature(ex); } catch (_eg) { sig = "unknown"; }

    // (1) ALWAYS CAPTURE: FIRST synchronously build the full report body and UNCONDITIONALLY
    //   (before any throttle/cap/busy/delivery-dedup guards) persist it to the disk outbox. This way
    //   an unhandled crash is NEVER lost in an enabled build - even during busy state, beyond the
    //   delivery cap, or within a throttle window. The body already includes logText/snapshot/counts/comment/
    //   tester/context/breadcrumbs and redaction (fastlogs_build_payload_json). No screenshot
    //   (heavy for a crash). best-effort, do not throw from callback.
    //   CAPTURE DEDUP (SEPARATE from delivery dedup): if THE SAME stack was already captured within the
    //   throttle window - a new file is NOT written (to prevent a crash loop from spamming the outbox). Cap of outbox
    //   (FASTLOGS_PENDING_MAX + TrimToCap inside fastlogs_pending_write) limits file count in any case.
    var crash_opts = { title: "Unhandled exception", screenshot: false };
    var crash_body = "";
    try {
        if (script_exists(asset_get_index("fastlogs_build_payload_json"))) {
            crash_body = fastlogs_build_payload_json(crash_opts);
        }
    } catch (_eb) { crash_body = ""; }

    // (1a) FALLBACK CAPTURE (FIX-2): the builder may have crashed/returned "" (e.g., exception inside
    //   device/context collection). PREVIOUSLY fastlogs_pending_write was NOT called and the crash was LOST.
    //   Now we build a MINIMAL contract body directly from what is available, NOT relying on the
    //   builder: appId/appVersion/platform/timestampUtc/counts/logText/logEncoding (+ title/
    //   comment/tester if present). logText = raw text from recorder/buffer if available, otherwise
    //   message+stack of the exception itself. Run through the same fastlogs_redact. If minimum is
    //   absent (no endpoint/appId - nowhere to send / nothing to identify with) - honestly return "".
    if (!is_string(crash_body) || string_length(crash_body) == 0) {
        try {
            crash_body = __fastlogs_build_fallback_crash_json(ex, crash_opts);
        } catch (_efb) { crash_body = ""; }
        if (is_string(crash_body) && string_length(crash_body) > 0) {
            show_debug_message("[FastLogs] crash capture: builder failed -> using minimal fallback body");
        }
    }

    var pending_path = "";
    var captured     = false;
    if (is_string(crash_body) && string_length(crash_body) > 0) {
        var do_capture = true;
        try { do_capture = __fastlogs_capture_allowed(sig); } catch (_ec) { do_capture = true; }
        if (do_capture) {
            try {
                if (script_exists(asset_get_index("fastlogs_pending_write"))) {
                    pending_path = fastlogs_pending_write(crash_body);   // ALWAYS: disk first
                    captured = (is_string(pending_path) && string_length(pending_path) > 0);
                }
            } catch (_ew) { pending_path = ""; }
        } else {
            show_debug_message("[FastLogs] crash capture skipped: dedup (same stack within throttle window)");
        }
    }

    // (2) DELIVERY (immediate send + toast) is gated by throttle/cap/busy/delivery-DEDUP.
    //   This affects ONLY the immediate upload, NOT the capture above. The captured file will
    //   always be delivered: either by this immediate upload (will delete EXACTLY its own file on success),
    //   or by drain during idle / resend on next startup.
    var do_send = true;
    var skip_reason = "";
    try {
        var gate = __fastlogs_autosend_allowed(sig);
        do_send     = gate.allowed;
        skip_reason = gate.reason;
    } catch (_eg2) {
        do_send = true;   // could not evaluate gate - do not block send
    }

    if (do_send) {
        // Attempt immediate send (best-effort; may not complete before game closes).
        //   FILE BINDING: pass pending_path of the just-captured file so a successful
        //   upload deletes EXACTLY that file (no deleting someone else's/stale file; no orphaned file left).
        //   If capture did not happen (dedup/disk) and pending_path is empty - normal body send as-is.
        try {
            if (is_string(crash_body) && string_length(crash_body) > 0
                && script_exists(asset_get_index("fastlogs_pending_send"))) {
                // fastlogs_pending_send will raise a status toast itself; single-flight inside.
                fastlogs_pending_send(crash_body, pending_path);
            } else {
                // Fallback: body not built / no pending layer - normal send.
                fastlogs_send(crash_opts);
            }
        } catch (_e3) { /* swallow */ }
    } else {
        // Delivery blocked by guard, but CRASH IS ALREADY CAPTURED to disk (if not capture-deduped) -
        //   it will be delivered by drain/on startup. Notify the tester that it was not lost.
        var note = captured ? "Краш записан (" + skip_reason + ", отправим позже)"
                            : "Краш записан (" + skip_reason + ")";
        show_debug_message("[FastLogs] autosend on crash deferred: " + skip_reason
            + (captured ? " (captured to outbox: " + pending_path + ")" : ""));
        try {
            if (script_exists(asset_get_index("fastlogs_status_toast"))) {
                fastlogs_status_toast("info", note);
            }
        } catch (_e4) { /* swallow */ }
    }

    // Nothing useful to return - the game will close (if the crash is fatal).
}

// =====================================================================================
// flog(message, [level]) - primary logging entry point (+ alias fastlogs_log below).
// Always writes to memory (ring) when FASTLOGS_ENABLED; to disk only if recording is on
//   (the recorder does this in fastlogs_recorder_on_record). Increments the session level counter.
// =====================================================================================
function flog(message, level = FASTLOGS_LEVEL_LOG) {
    if (!FASTLOGS_ENABLED) return;

    var st = __fastlogs_state();

    var lvl = is_real(level) ? clamp(floor(level), FASTLOGS_LEVEL_LOG, FASTLOGS_LEVEL_ERROR)
                             : FASTLOGS_LEVEL_LOG;
    var txt = string(message);   // coerce any type to string
    var t   = date_current_datetime();

    // Session counters.
    switch (lvl) {
        case FASTLOGS_LEVEL_ERROR: st.cnt_error++; break;
        case FASTLOGS_LEVEL_WARN:  st.cnt_warn++;  break;
        default:                   st.cnt_log++;   break;
    }

    // Write to ring. PERF (D): REUSE the struct in the slot if it already exists (mutate
    //   fields instead of allocating a new struct for each log entry). Allocation only happens during
    //   the first fill of the ring; afterwards - in-place overwrite. This is safe: the recorder
    //   synchronously consumes rec right here, and the old rec in the slot was already formatted/flushed
    //   on the previous rotation (snapshot/flush hold references only during synchronous consumption).
    var rec = st.ring[st.head];
    if (is_struct(rec)) {
        rec.time  = t;
        rec.level = lvl;
        rec.text  = txt;
    } else {
        rec = { time: t, level: lvl, text: txt };
        st.ring[st.head] = rec;
    }
    st.head = (st.head + 1) mod st.ring_size;
    if (st.count < st.ring_size) st.count++;

    // Persist to disk - only when recording is active. Delegate to recorder (it gates itself).
    fastlogs_recorder_on_record(rec);
}

// Convenience wrappers with a fixed level (PUBLIC-API contract).
function fastlogs_log(message)   { flog(message, FASTLOGS_LEVEL_LOG);   }
function fastlogs_warn(message)  { flog(message, FASTLOGS_LEVEL_WARN);  }
function fastlogs_error(message) { flog(message, FASTLOGS_LEVEL_ERROR); }

// =====================================================================================
// fastlogs_clear() - clear the in-memory ring and session counters.
// Does NOT touch the persist file on disk (cross-session history is preserved).
// =====================================================================================
function fastlogs_clear() {
    if (!FASTLOGS_ENABLED) return;
    var st = __fastlogs_state();
    for (var i = 0; i < st.ring_size; i++) st.ring[i] = undefined;
    st.head      = 0;
    st.count     = 0;
    st.cnt_error = 0;
    st.cnt_warn  = 0;
    st.cnt_log   = 0;
}

// =====================================================================================
// fastlogs_get_counts() -> { error, warn, log } - PER-SESSION counters (same as payload counts).
// When !FASTLOGS_ENABLED -> zeros.
// =====================================================================================
function fastlogs_get_counts() {
    if (!FASTLOGS_ENABLED) return { error: 0, warn: 0, log: 0 };
    var st = __fastlogs_state();
    return { error: st.cnt_error, warn: st.cnt_warn, log: st.cnt_log };
}

// =====================================================================================
// fastlogs_set_screenshot(enabled) - toggle screenshot inclusion in the next fastlogs_send.
// Actual frame capture is done by payload/http via util (screen_save -> buffer_load ->
//   buffer_base64_encode), see GM-NOTES 2.2.
// =====================================================================================
function fastlogs_set_screenshot(enabled) {
    if (!FASTLOGS_ENABLED) return;
    var st = __fastlogs_state();
    st.screenshot = bool(enabled);
}

// =====================================================================================
// Internal state getters for other modules (recorder/payload/http/overlay).
// Return a snapshot of the ring as an array of entries in CHRONOLOGICAL order (oldest -> newest).
// =====================================================================================
function fastlogs_ring_snapshot() {
    var st = __fastlogs_state();
    var out = [];
    if (st.count <= 0) return out;
    // Oldest element: if ring is full - it is head; otherwise - 0.
    var start = (st.count >= st.ring_size) ? st.head : 0;
    for (var i = 0; i < st.count; i++) {
        var idx = (start + i) mod st.ring_size;
        var rec = st.ring[idx];
        if (!is_undefined(rec)) array_push(out, rec);
    }
    return out;
}
