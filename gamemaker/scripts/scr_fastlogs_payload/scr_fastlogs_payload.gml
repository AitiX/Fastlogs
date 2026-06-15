/// @description scr_fastlogs_payload
// FastLogs GameMaker client - PAYLOAD (builds the JSON request body per CONTRACT.md).
// Purpose: assemble the request body struct strictly per contract, omit empty fields,
//   truncate logText to the byte limit, optionally embed screenshotPng (base64 without data:),
//   and serialize via json_stringify.
// Gating: when !FASTLOGS_ENABLED returns "" / {} (no-op).
//
// DEPENDENCIES (actual names from neighbouring FastLogs scripts - verified against code):
//   scr_fastlogs_core:
//     - fastlogs_get_counts()                 -> { error, warn, log } for the session
//   scr_fastlogs_recorder:
//     - fastlogs_recorder_get_logtext()       -> string of accumulated log (persist+ring)
//     - __fastlogs_utc_iso()                  -> string "YYYY-MM-DDThh:mm:ssZ" (UTC) [private but
//                                                stable; DRY - do not duplicate date logic]
//   scr_fastlogs_device (same builder):
//     - fastlogs_collect_device([extra])      -> struct device{}
//     - fastlogs_platform_string()            -> string platform
//   scr_fastlogs_screenshot:
//     - fastlogs_screenshot_base64()          -> string ready base64 PNG ("" if none)
//   Local compact/truncation helpers are implemented BELOW (payload responsibility per
//   PUBLIC-API: "truncate logText, omit empty fields").

// =====================================================================================
// fastlogs_build_payload([opts]) -> struct
// Assembles the request body struct per CONTRACT.md. Empty device fields are removed.
// opts (opt., struct): title(string<=120), retentionDays(int), screenshot(bool override),
//   extraDevice(struct).
// NOTE on screenshot: the actual frame capture is asynchronous (Draw GUI End) and is initiated
//   in the http layer BEFORE build_payload is called; here we only READ the already-ready base64.
// =====================================================================================
function fastlogs_build_payload(opts = undefined) {
    if (!FASTLOGS_ENABLED) { return {}; }
    if (!is_struct(opts)) { opts = {}; }

    // --- appVersion: from config or GM_version ---
    var app_version = FASTLOGS_APP_VERSION;
    if (!is_string(app_version) || string_length(app_version) == 0) {
        app_version = string(GM_version);                 // fallback to project version
    }

    // --- counts (for the session) ---
    var counts = fastlogs_get_counts();                   // core: { error, warn, log }
    if (!is_struct(counts)) { counts = { error: 0, warn: 0, log: 0 }; }

    // --- logText + truncation to limit ---
    var raw_log = fastlogs_recorder_get_logtext();        // recorder: accumulated text
    if (!is_string(raw_log)) { raw_log = ""; }
    var cut = fastlogs_truncate_log(raw_log, FASTLOGS_MAX_LOG_BYTES); // { text, truncated }
    var log_text = cut.text;
    if (cut.truncated) {
        // Truncation marker (contract: truncated at MAX_LOG_BYTES with marker).
        log_text += "\n...[FastLogs] logText truncated at " + string(FASTLOGS_MAX_LOG_BYTES) + " bytes...";
    }
    // PII (#3): scrub logText AFTER truncation (less text to scan) and before sending.
    //   fastlogs_redact gates itself via FASTLOGS_SCRUB_PII/override (disabled -> returns as-is).
    if (script_exists(asset_get_index("fastlogs_redact"))) {
        log_text = fastlogs_redact(log_text);
    }

    // --- device ---
    var extra_device = variable_struct_exists(opts, "extraDevice") ? opts.extraDevice : undefined;
    var device = fastlogs_collect_device(extra_device);   // device script

    // --- assemble root struct STRICTLY per contract ---
    var body = {};
    body.appId        = FASTLOGS_APP_ID;                  // REQUIRED
    body.platform     = fastlogs_platform_string();       // REQUIRED (device script)
    body.appVersion   = app_version;                      // REQUIRED
    body.timestampUtc = __fastlogs_utc_iso();             // REQUIRED UTC ISO-8601 (recorder)
    body.counts       = {
        error: is_real(counts.error) ? counts.error : 0,
        warn:  is_real(counts.warn)  ? counts.warn  : 0,
        log:   is_real(counts.log)   ? counts.log   : 0,
    };
    body.logText      = log_text;                         // REQUIRED
    body.logEncoding  = FASTLOGS_LOG_ENCODING;            // REQUIRED "plain"
    body.device       = fastlogs_struct_compact(device);  // REQUIRED (empty fields omitted)

    // --- screenshotPng (OPT.): raw base64 PNG without data: ---
    // Capture was already initiated by the http layer; here we read the result. If not ready/failed - omit.
    //   opts.screenshot==false (explicit) -> do NOT include screenshot even if a previous one is in cache
    //   (important for crash report #1: screenshot:false -> clean report without heavy PNG).
    var allow_shot = !(variable_struct_exists(opts, "screenshot") && opts.screenshot == false);
    if (allow_shot) {
        var b64 = fastlogs_screenshot_base64();           // screenshot script ("" if none)
        if (is_string(b64) && string_length(b64) > 0) {
            body.screenshotPng = b64;
        }
    }

    // --- retentionDays (OPT.) ---
    var ret = FASTLOGS_RETENTION_DAYS;
    if (variable_struct_exists(opts, "retentionDays")) { ret = opts.retentionDays; }
    if (is_real(ret) && ret >= 1) { body.retentionDays = floor(ret); } // -1 = do not send

    // --- title (OPT., <=120) ---
    if (variable_struct_exists(opts, "title")) {
        var t = opts.title;
        if (is_string(t) && string_length(t) > 0) {
            if (string_length(t) > 120) { t = string_copy(t, 1, 120); }
            body.title = t;
        }
    }

    // --- comment (OPT., <=4000): free-form issue description by tester, from send opts ---
    // Contract: omit empty fields (do not send null/""). Therefore include only non-empty.
    if (variable_struct_exists(opts, "comment")) {
        var cm = opts.comment;
        if (is_string(cm) && string_length(cm) > 0) {
            if (string_length(cm) > 4000) { cm = string_copy(cm, 1, 4000); }
            body.comment = cm;
        }
    }

    // --- tester (OPT., <=120): tester name from config; sent with EVERY report ---
    // Source: runtime-override fastlogs_init({ tester }) -> otherwise macro FASTLOGS_TESTER.
    // Empty value is not sent (contract: omit empty fields).
    var tester = __fastlogs_cfg("tester", FASTLOGS_TESTER);
    if (is_string(tester) && string_length(tester) > 0) {
        if (string_length(tester) > 120) { tester = string_copy(tester, 1, 120); }
        body.tester = tester;
    }

    // --- context (OPT., object string->string; feature #2): sent with EVERY report ---
    // Contract: omit empty. Scrub values via redaction (#3). Server caps at ~4KB total.
    if (script_exists(asset_get_index("fastlogs_context_snapshot"))) {
        var ctx = fastlogs_context_snapshot();            // NEW struct copy (mutable)
        if (is_struct(ctx) && variable_struct_names_count(ctx) > 0) {
            var do_scrub = script_exists(asset_get_index("fastlogs_redact"));
            var cnames = variable_struct_get_names(ctx);
            for (var ci = 0; ci < array_length(cnames); ci++) {
                var ck = cnames[ci];
                var cv = variable_struct_get(ctx, ck);
                cv = is_string(cv) ? cv : string(cv);
                if (do_scrub) { cv = fastlogs_redact(cv); }   // scrub context VALUES
                variable_struct_set(ctx, ck, cv);
            }
            // Compact will remove empty values (contract: do not send empty).
            var ctx_c = fastlogs_struct_compact(ctx);
            if (is_struct(ctx_c) && variable_struct_names_count(ctx_c) > 0) {
                body.context = ctx_c;
            }
        }
    }

    // --- breadcrumbs (OPT., array {t,m,lvl}; feature #2): rolling buffer of last N ---
    // Contract: omit empty; lvl in info|warn|error (opt.). Scrub m texts via redaction (#3).
    //   Server caps at 100 items and ~16KB (client already enforces FASTLOGS_BREADCRUMB_MAX cap).
    if (script_exists(asset_get_index("fastlogs_breadcrumbs_snapshot"))) {
        var crumbs = fastlogs_breadcrumbs_snapshot();     // array of NEW copies (mutable)
        if (is_array(crumbs) && array_length(crumbs) > 0) {
            var do_scrub2 = script_exists(asset_get_index("fastlogs_redact"));
            var out_crumbs = [];
            for (var bi = 0; bi < array_length(crumbs); bi++) {
                var cr = crumbs[bi];
                if (!is_struct(cr)) continue;
                var item = {};
                var ct = variable_struct_exists(cr, "t")   ? cr.t   : "";
                var cm = variable_struct_exists(cr, "m")   ? cr.m   : "";
                var cl = variable_struct_exists(cr, "lvl") ? cr.lvl : "";
                if (do_scrub2) { cm = fastlogs_redact(string(cm)); }
                // Contract: m is required per element; t and lvl are optional. Without m skip the crumb.
                if (!is_string(cm) || string_length(cm) == 0) continue;
                if (is_string(ct) && string_length(ct) > 0) item.t = ct;   // order: t, m, lvl
                item.m = cm;
                if (is_string(cl) && string_length(cl) > 0) item.lvl = cl;
                array_push(out_crumbs, item);
            }
            if (array_length(out_crumbs) > 0) {
                body.breadcrumbs = out_crumbs;
            }
        }
    }

    return body;
}

// =====================================================================================
// fastlogs_build_payload_json([opts]) -> string
// Ready JSON string of the request body for http_request. "" when !FASTLOGS_ENABLED.
// =====================================================================================
function fastlogs_build_payload_json(opts = undefined) {
    if (!FASTLOGS_ENABLED) { return ""; }
    var body = fastlogs_build_payload(opts);
    // json_stringify: struct/array -> string. Struct functions are not serialized (none here).
    //   prettify not needed (minimise body size).
    return json_stringify(body);
}

// =====================================================================================
// fastlogs_truncate_log(text, max_bytes) -> { text, truncated }
// Truncates text to <= max_bytes (UTF-8 bytes), preserving line integrity on \n where possible.
// Contract: counts - for the session; logText truncated at MAX_LOG_BYTES with marker (marker
//   is added by the caller). We truncate from the END, not leaving a broken multibyte symbol.
// =====================================================================================
function fastlogs_truncate_log(text, max_bytes) {
    var res = { text: text, truncated: false };
    if (!is_string(text)) { res.text = ""; return res; }
    var blen = string_byte_length(text);                  // UTF-8 bytes (GM stores strings in UTF-8)
    if (blen <= max_bytes) { return res; }

    res.truncated = true;
    // Keep the TAIL of the log (recent entries matter more than old ones) up to ~max_bytes.
    // Walk from the end, cutting old lines from the beginning until within the limit.
    var tail = text;
    // Rough fast cut: while too many bytes - remove up to the first \n from the start.
    // (string_delete operates on CHARACTERS; safe for UTF-8 - does not split a symbol.)
    var guard = 0;
    while (string_byte_length(tail) > max_bytes && guard < 100000) {
        var nl = string_pos("\n", tail);
        if (nl <= 0) {
            // No \n - cut by characters from start by the approximate overshoot.
            var over_chars = string_length(tail) - max_bytes; // upper estimate (1 byte ~ 1 char)
            tail = string_delete(tail, 1, max(1, over_chars));
            break;
        }
        tail = string_delete(tail, 1, nl);                // delete up to and including first \n
        guard++;
    }
    res.text = tail;
    return res;
}

// =====================================================================================
// fastlogs_struct_compact(value) -> value
// RECURSIVELY removes "empty" fields from struct/array per contract invariant 3:
//   omit "" (empty strings), undefined, empty struct {} and empty array [].
// NOTE: ZERO (0) and false are NOT removed - these are valid values (battery 0.0, genuine false).
//   (Contract says "empty/unavailable" - the device script already does not put knowingly
//    unavailable zeros, so remaining numbers are meaningful.)
// =====================================================================================
function fastlogs_struct_compact(value) {
    if (is_struct(value)) {
        var out = {};
        var names = variable_struct_get_names(value);
        for (var i = 0; i < array_length(names); i++) {
            var k = names[i];
            var v = fastlogs_struct_compact(variable_struct_get(value, k));
            if (fastlogs_is_empty_value(v)) { continue; }
            out[$ k] = v;
        }
        return out;
    }
    if (is_array(value)) {
        var arr = [];
        for (var j = 0; j < array_length(value); j++) {
            var av = fastlogs_struct_compact(value[j]);
            if (fastlogs_is_empty_value(av)) { continue; }
            array_push(arr, av);
        }
        return arr;
    }
    return value;
}

// "Empty" value for compact: undefined, "" (empty string), empty struct/array.
//   Numbers (including 0) and bool - NOT empty.
function fastlogs_is_empty_value(v) {
    if (is_undefined(v)) { return true; }
    if (is_string(v))  { return (string_length(v) == 0); }
    if (is_struct(v))  { return (variable_struct_names_count(v) == 0); }
    if (is_array(v))   { return (array_length(v) == 0); }
    return false;
}
