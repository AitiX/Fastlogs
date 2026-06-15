/// @description FastLogs controller - Async HTTP (eventType 7 / eventNum 62)
// Parse ingest response. Match async_load[? "id"] against the http state (request_id);
//   when status<=0 (final) read http_status: 2xx (contract - 201) = success -> json_parse(result)
//   -> {id,url} -> populate last_url, copy link. Errors -> retry (network/5xx) or Error.
// HTTP state is in global.__fastlogs.http (see scr_fastlogs_http: fastlogs_http_get_state()).
// Verified (GM-NOTES 2.1 + WebSearch June 2026):
//   async_load["status"]: 1 = downloading, 0 = done, <0 = error;
//   async_load["id"], ["http_status"], ["result"](string), ["response_headers"](ds_map).
if (!FASTLOGS_ENABLED) { exit; }

var hs = fastlogs_http_get_state();   // http sub-state

// This event fires for ALL http requests in the game. We only react to our own.
var ev_id = async_load[? "id"];
if (is_undefined(ev_id)) { exit; }
if (ev_id != hs.request_id) { exit; }       // not our request

var status      = async_load[? "status"];
var http_status = async_load[? "http_status"];
var result      = async_load[? "result"];

// status == 1 -> data still downloading (progress). Wait for final (0) or error (<0).
if (is_real(status) && status == 1) { exit; }

// --- REQUEST FINAL (status <= 0) ---
hs.is_sending  = false;
hs.request_id  = -1;
hs.last_status = is_real(http_status) ? http_status : 0;

// Successful ingest per contract -> 201 Created (we accept any 2xx).
var ok       = is_real(http_status) && (http_status >= 200 && http_status < 300);
// status < 0 -> network error/drop (http_status may be 0).
var net_error = is_real(status) && (status < 0);

if (ok && !net_error) {
    // RETRY-UNTIL-SUCCESS (feature RETRY): success - final. Cancel any pending deferred retry
    //   and its alarm (this success may have come from a deferred attempt). The existing
    //   success toast below will notify the tester of the final success.
    if (script_exists(asset_get_index("fastlogs_retry_cancel"))) {
        fastlogs_retry_cancel();
    }

    // CRASH-REPORT PERSIST (feature #1): if this successful report came from the disk queue
    //   pending - delete its file (delivered). Path is bound to the request in hs.pending_file.
    //   Remember the path of the just-delivered file so the drain chain below does not
    //   try to resend it (and to know it was a pending/drain send).
    var just_sent_file = is_string(hs.pending_file) ? hs.pending_file : "";
    if (string_length(just_sent_file) > 0) {
        if (script_exists(asset_get_index("fastlogs_pending_delete"))) {
            fastlogs_pending_delete(just_sent_file);
        }
        hs.pending_file = "";
    }

    // Response body: { "id", "url", "rawUrl", "expiresAt" }.
    var url = "";
    var log_id = "";
    if (is_string(result) && string_length(result) > 0) {
        // json_parse in struct mode (option_legacy_json_parsing=false).
        var parsed = undefined;
        try {
            parsed = json_parse(result);
        } catch (_e) {
            parsed = undefined;                 // body is not JSON -> degrade gracefully
        }
        if (is_struct(parsed)) {
            if (variable_struct_exists(parsed, "url") && is_string(parsed.url)) { url = parsed.url; }
            if (variable_struct_exists(parsed, "id")  && is_string(parsed.id))  { log_id = parsed.id; }
        }
    }

    hs.state = "ok";
    if (string_length(url) > 0) {
        hs.last_url = url;
        show_debug_message("[FastLogs] ingest OK (" + string(http_status) + ") id=" + log_id + " url=" + url);

        // COPY-ON-SEND: when the flag is enabled, auto-copy the short link to the device clipboard.
        //   best-effort; the clipboard script gates the platform itself (consoles -> no-op).
        //   On WebGL copying requires a user-gesture and may not work here - do NOT crash
        //   (swallow the exception), the "Copy" button in the overlay remains as a fallback.
        var copied = false;
        if (FASTLOGS_COPY_ON_SEND && script_exists(asset_get_index("fastlogs_copy_url"))) {
            try {
                copied = fastlogs_copy_url();
            } catch (_ce) {
                copied = false;                 // WebGL without gesture / platform refusal - do not crash
            }
        }
        // STATUS (B): "Done" toast + link over the game, even without the overlay open.
        //   Link already auto-copied (copied) - the toast shows it + click to copy again.
        if (script_exists(asset_get_index("fastlogs_status_toast"))) {
            var ok_text = copied ? "Готово (ссылка скопирована)" : "Готово";
            fastlogs_status_toast("ok", ok_text, { url: url });
        }
        // Comment went with the report -> clear the field so it does not get sent again (feature COMMENT).
        if (script_exists(asset_get_index("fastlogs_comment_clear"))) {
            fastlogs_comment_clear();
        }
    } else {
        show_debug_message("[FastLogs] ingest OK (" + string(http_status) + ") but no url in response: " + string(result));
        // Success, but the server did not return a url - still "Done" (no link).
        if (script_exists(asset_get_index("fastlogs_status_toast"))) {
            fastlogs_status_toast("ok", "Готово");
        }
    }

    // OUTBOX DRAIN "AT FIRST OPPORTUNITY" (feature #1): send completed successfully and the client
    //   is now idle (is_sending already cleared above). If files remain in outbox (crashes
    //   captured during busy/throttle/over delivery cap) - send the NEXT one by one,
    //   gracefully. This is the chain: each success pulls the next file until the queue is empty
    //   (previously resend_all hit single-flight and sent only one per session). Do not duplicate
    //   the just-sent file (pass just_sent_file as exclude).
    //
    //   FIX-1 (idle drain must not stall): PER_START limit (FASTLOGS_PENDING_RESEND_PER_START)
    //   applied ONLY to the START chain (init_chain_active, launched by fastlogs_pending_resend_all
    //   at init) - so the start does not hammer the entire outbox at once. LIVE idle drain (after a normal
    //   send/immediate crash or AFTER the start chain completes) is NOT gated by this limit:
    //   pull the next pending while outbox is non-empty. Previously the single session-cumulative drain_count
    //   against PER_START(=5) was NEVER reset and shared with start -> after 5 resends per session the
    //   idle chain stalled until restart (weakening "at first opportunity"). Volume is still
    //   capped by FASTLOGS_PENDING_MAX/enforce_cap, so the idle chain cannot run indefinitely.
    var retry_pending = script_exists(asset_get_index("fastlogs_retry_is_pending"))
                      && fastlogs_retry_is_pending();
    if (!retry_pending) {   // do not interfere if a deferred retry is scheduled
        if (script_exists(asset_get_index("fastlogs_pending_drain_next"))) {
            if (hs.init_chain_active) {
                // START chain: honor PER_START. 0/negative -> no limit (then start = idle).
                var per = FASTLOGS_PENDING_RESEND_PER_START;
                var unlimited = (!is_real(per) || per <= 0);
                if (unlimited || hs.init_drain_count < per) {
                    if (fastlogs_pending_drain_next(just_sent_file)) {
                        hs.init_drain_count += 1;   // one more start-backstop file
                    } else {
                        // Outbox empty or layer busy -> start chain complete. Clear the flag,
                        //   further successes will go as live idle drain (no PER_START).
                        hs.init_chain_active = false;
                    }
                } else {
                    // PER_START exhausted for this start -> end the START chain (backstop). Remaining
                    //   outbox will arrive via live idle drain (not gated) or on the next start.
                    hs.init_chain_active = false;
                }
            } else {
                // LIVE idle drain: pull the next pending WITHOUT a limit while outbox is non-empty.
                //   single-flight inside fastlogs_pending_send: if busy - returns false (we will pick it up later).
                fastlogs_pending_drain_next(just_sent_file);
            }
        }
    }
} else {
    // Error: 4xx/5xx or network drop.
    show_debug_message("[FastLogs] ingest FAILED status=" + string(status) + " http_status=" + string(http_status) + " result=" + string(result));

    // Retry only network errors and 5xx (4xx - problem in the body, retry will not help
    //   immediately or deferred -> these get an immediate terminal error toast).
    //   Considered transient: network/drop (net_error||status<=0) OR http_status>=500.
    var retryable = net_error || (is_real(http_status) && http_status >= 500) || (is_real(status) && status <= 0);

    // POISON-PILL (feature #1): if this was a send of a pending file from the disk outbox
    //   (hs.pending_file is set) and the error is PERMANENT non-transient (4xx: 400/401/403/413/415,
    //   i.e. !retryable) - retrying the file forever is pointless: DELETE it from outbox (+log) so
    //   it does not block draining indefinitely. For TRANSIENT errors (network/0/5xx) KEEP the file -
    //   it will arrive on the next start/during idle. Do this BEFORE retries/scheduler because for
    //   4xx no retries are scheduled (retryable=false) and this is terminal for this file.
    if (!retryable && is_string(hs.pending_file) && string_length(hs.pending_file) > 0) {
        show_debug_message("[FastLogs] poison-pill: dropping pending file (permanent HTTP "
            + string(http_status) + "): " + hs.pending_file);
        if (script_exists(asset_get_index("fastlogs_pending_delete"))) {
            fastlogs_pending_delete(hs.pending_file);
        }
        hs.pending_file = "";   // unlinked: file no longer exists
    }

    // 1) First - IMMEDIATE uploader retries (instant, up to FASTLOGS_HTTP_MAX_RETRIES).
    var retried = false;
    if (retryable) {
        retried = fastlogs_http_retry();        // starts a new request, re-sets is_sending
    }

    if (retried) {
        // Auto-retry (immediate) started - keep status "Sending..." (retry N/2).
        if (script_exists(asset_get_index("fastlogs_status_toast"))) {
            fastlogs_status_toast("sending", "Отправка... (повтор)");
        }
    } else {
        // 2) Immediate retries exhausted/not applicable. RETRY-UNTIL-SUCCESS (feature RETRY):
        //   for transient errors (network/5xx) schedule a DEFERRED retry on a timer, until
        //   it succeeds (or until FASTLOGS_RETRY_MAX is reached). One
        //   pending at a time is guaranteed by the scheduler itself (replaces body/countdown).
        //   4xx does not reach here (retryable=false) -> immediate terminal error toast.
        var scheduled = false;
        if (retryable && script_exists(asset_get_index("fastlogs_retry_schedule"))) {
            // Deferred retry limit: 0 = no limit; >0 = give up after that many.
            var under_limit = (!is_real(FASTLOGS_RETRY_MAX) || FASTLOGS_RETRY_MAX <= 0)
                            || (hs.dretry_count < FASTLOGS_RETRY_MAX);
            if (under_limit) {
                scheduled = fastlogs_retry_schedule(hs.pending_body);
            }
        }

        if (scheduled) {
            // Deferred retry scheduled - NOT an error for the tester: show countdown
            //   "Retry in Ns..." (raised by fastlogs_retry_schedule itself).
            //   Further countdown is driven by Alarm[0] (fastlogs_retry_tick), no per-frame work.
        } else {
            // Deferred retry disabled/not applicable/limit exhausted - terminal error.
            //   Cancel any residual pending so the state is clean.
            if (script_exists(asset_get_index("fastlogs_retry_cancel"))) {
                fastlogs_retry_cancel();
            }
            hs.state = "error";
            // STATUS (B): "Error: <reason>" toast + clickable "Retry" zone over the game.
            if (script_exists(asset_get_index("fastlogs_status_toast"))) {
                var reason;
                if (net_error)                                  reason = "сеть недоступна";
                else if (is_real(http_status) && http_status > 0) reason = "HTTP " + string(http_status);
                else                                            reason = "неизвестно";
                fastlogs_status_toast("error", "Ошибка: " + reason, { retry: true });
            }
        }
    }
}
