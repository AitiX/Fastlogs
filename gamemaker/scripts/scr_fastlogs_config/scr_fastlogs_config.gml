/// @description scr_fastlogs_config
// FastLogs GameMaker client - CONFIGURATION (default macros).
// NEUTRAL defaults: no playjoystudios, no secrets. Integrator overrides
// these values in their own project (e.g. in a separate config script on top).
// Check GML API against GM-NOTES.md. Request body contract: ../../CONTRACT.md.

// =====================================================================================
// CONSOLE SAFETY / GATING (per-config)
// -------------------------------------------------------------------------------------
// FASTLOGS_ENABLED is set PER BUILD CONFIG. Config names must match the .yyp:
//   Default - release config (client OFF, controller not created, no http/screen_save).
//   debug   - debug config (client ON).
// Pattern like __INPUT_DEBUG_STEAM_INPUT / __SCRIBBLE_DEBUG.
// Retail console builds use Default -> forbidden network/screenshot calls are never executed.
#macro Default:FASTLOGS_ENABLED false
#macro debug:FASTLOGS_ENABLED true

// =====================================================================================
// SERVER / INGEST (same server as the Unity client)
// -------------------------------------------------------------------------------------
// Endpoint - full ingest URL per contract: <BASE_URL>/api/logs
// Default is empty -> integrator MUST set it (otherwise fastlogs_send is a no-op + warning).
#macro FASTLOGS_ENDPOINT      ""        // e.g. "http://localhost:8787/api/logs"
#macro FASTLOGS_APP_ID        ""        // [a-z0-9_-]{2,32}, = Project in the catalog
#macro FASTLOGS_TOKEN         ""        // ingest token (Authorization: Bearer ...); "" = no header
#macro FASTLOGS_APP_VERSION   ""        // "" -> use GM_version / set manually

// Retention (per-request override; server clamp(1, app.maxRetentionDays)). -1 = do not send the field.
#macro FASTLOGS_RETENTION_DAYS -1

// Tester name - goes into the "tester" field of EVERY report (contract: <=120 characters).
// Empty string -> field is not sent (contract: omit empty fields). Integrator sets
// their own value in the project (or via runtime-override fastlogs_init({ tester: "..." })).
#macro FASTLOGS_TESTER        ""

// Auto-copy of the short link (url) to the device clipboard after a SUCCESSFUL send.
// ON by default. On WebGL copying requires a user gesture - it may not work there
// (we don't crash; the overlay still shows a "Copy" button as a click fallback).
#macro FASTLOGS_COPY_ON_SEND  true

// HTTP connection timeout, ms. // TODO verify applicability of http_set_connect_timeout.
#macro FASTLOGS_HTTP_TIMEOUT_MS 15000

// RETRY-UNTIL-SUCCESS (deferred resend on a timer, RETRY feature).
// -------------------------------------------------------------------------------------
// If sending a report FAILED even after immediate uploader retries
//   (FASTLOGS_HTTP_MAX_RETRIES in scr_fastlogs_http, instant), the report is queued for
//   DEFERRED retry every N seconds and retried UNTIL it succeeds (or until
//   it hits the attempt limit below). Implementation uses the controller's alarm timer
//   (Alarm[0]), NOT polling every frame: the alarm ticks once per second to update
//   the "Retry in Ns..." status and trigger the retry at zero (no per-frame allocations).
// Interval between deferred retries, seconds. 0 -> deferred retry OFF
//   (old behavior: on failure show an error toast with a manual "Retry" button).
#macro FASTLOGS_RETRY_INTERVAL_SEC 30
// Hard limit on the number of DEFERRED retries. 0 -> no limit (retry while the app is alive
//   or until the send succeeds). >0 -> after this many failed deferred retries
//   we give up and show an error toast with a manual "Retry" button.
#macro FASTLOGS_RETRY_MAX 0

// =====================================================================================
// LOG RECORDING (ring buffer + persist)
// -------------------------------------------------------------------------------------
// Ring buffer size in memory (number of log entry strings).
#macro FASTLOGS_RING_SIZE     2000

// Auto-start recording. OFF BY DEFAULT - recording is enabled via fastlogs_record_start()/set(true).
#macro FASTLOGS_AUTO_START_RECORDING false

// Persist to disk: save the log between sessions (rolling file with a size limit, session marker).
#macro FASTLOGS_PERSIST_ENABLED   true
// Relative path of the log file inside game_save_id.
#macro FASTLOGS_PERSIST_DIR       "fastlogs"
#macro FASTLOGS_PERSIST_FILE      "session.log"
// Maximum size of the persist file on disk (bytes) before rotation.
#macro FASTLOGS_PERSIST_MAX_BYTES 1048576   // 1 MB

// PERF (D): persist to disk via BATCHING, not on every line. Lines accumulate in memory and
//   are flushed to disk in bulk on a timer (below) or forcibly before send/on crash.
//   This removes full-file IO on EVERY flog (previously each line loaded the whole file into a buffer).
// Auto-flush interval for the batch to disk, seconds. 0 -> write immediately (old behavior, no batch).
#macro FASTLOGS_PERSIST_FLUSH_SECONDS 2
// Hard limit on the in-memory batch size (bytes) - if exceeded we flush before the timer fires,
//   so peak memory usage / data loss on crash is bounded even under heavy logging.
#macro FASTLOGS_PERSIST_FLUSH_MAX_BYTES 65536   // 64 KB

// logText truncation in the payload (unpacked log), bytes. Contract: truncate with a marker.
#macro FASTLOGS_MAX_LOG_BYTES     2000000   // ~2 MB (server MAX_LOG_BYTES ~20 MB - headroom)

// Log encoding in the payload. On WebGL plain is required; we use plain everywhere for simplicity.
#macro FASTLOGS_LOG_ENCODING      "plain"

// =====================================================================================
// SCREENSHOT
// -------------------------------------------------------------------------------------
// Whether to include a screenshot in the payload by default (toggle; runtime - fastlogs_set_screenshot).
#macro FASTLOGS_SCREENSHOT_DEFAULT false
// Temporary PNG filename inside game_save_id for the screen_save -> buffer_load -> base64 path.
#macro FASTLOGS_SCREENSHOT_TMP     "fastlogs_shot_tmp.png"

// =====================================================================================
// AUTO-SEND ON CRASH (AUTO-SEND feature, C)
// -------------------------------------------------------------------------------------
// Automatically send on an unhandled exception (best-effort + persist to disk).
//   Default: ON in the dev config (handler is registered only when FASTLOGS_ENABLED, i.e. in debug).
#macro FASTLOGS_AUTOSEND_ON_EXCEPTION true

// DEDUP + THROTTLING of auto-send DELIVERIES (so a repeated exception doesn't spam the server).
//   - DELIVERY dedup (FIX-3, parity with Unity): the same stack is suppressed within a window of minGap*2
//     (FASTLOGS_AUTOSEND_THROTTLE_SECONDS*2), NOT forever for the session. If the crash recurs
//     after the window - we deliver again (old "once per session" silenced it until restart).
//   - Throttle: no more than one AUTO-send per N seconds (any stack).
//   - Session limit: at most K auto-DELIVERIES total per launch (Unity canon = 10).
// These limits apply ONLY to auto-send (DELIVERY) on crash; manual fastlogs_send/quick-send
//   are not throttled. IMPORTANT: this is DELIVERY dedup; CAPTURE dedup (minGap window, see core
//   __fastlogs_capture_allowed) does NOT depend on these values and is NOT changed.
#macro FASTLOGS_AUTOSEND_THROTTLE_SECONDS 30
// FIX-3: Unity canon - session limit for auto-DELIVERIES = 10 (was 5).
#macro FASTLOGS_AUTOSEND_SESSION_LIMIT    10
// DELIVERY dedup for identical stacks (true -> a repeated stack is suppressed within the minGap*2 window,
//   not forever; see FASTLOGS_AUTOSEND_SUPPRESS_WINDOW_SECONDS).
#macro FASTLOGS_AUTOSEND_DEDUP            true
// FIX-3: DELIVERY dedup suppression WINDOW (Unity canon = minGap*2). The same stack delivered
//   less than SUPPRESS_WINDOW seconds ago is suppressed; after the window it is delivered again.
//   Derived from the throttle (minGap): window = throttle*2. Interval/window taken from existing
//   throttle macros (no new config knob), so parity with Unity is maintained automatically.
#macro FASTLOGS_AUTOSEND_SUPPRESS_WINDOW_SECONDS (FASTLOGS_AUTOSEND_THROTTLE_SECONDS * 2)

// =====================================================================================
// CRASH REPORT PERSIST + RESEND ON START (feature #1, PENDING-QUEUE)
// -------------------------------------------------------------------------------------
// On auto-send triggered by a crash (unhandled exception) we FIRST synchronously write the report
//   (the ready-made JSON payload body) to the pending disk queue, THEN attempt to send;
//   on success the file is removed from the queue. On startup (fastlogs_init) the queue is scanned and
//   unsent reports are resent - so a hard crash that killed the process before HTTP completed
//   will still be delivered on the next launch. The report already carries its timestampUtc/
//   logText/counts/comment/tester/context/breadcrumbs (no screenshot - too heavy for a crash).
//
// Pending directory inside game_save_id: FASTLOGS_PERSIST_DIR + "/" + FASTLOGS_PENDING_DIR.
#macro FASTLOGS_PENDING_DIR        "pending"
// Cap on the number of files in the queue (old files beyond the limit are discarded to avoid infinite accumulation).
#macro FASTLOGS_PENDING_MAX        5
// How many pending reports to resend PER START (to avoid blocking the main thread for too long).
//   The rest will be picked up on subsequent launches. <=0 -> same as FASTLOGS_PENDING_MAX.
#macro FASTLOGS_PENDING_RESEND_PER_START 5

// =====================================================================================
// PRIVACY / PII SCRUBBING (feature #3). PRIVATE BY DEFAULT.
// -------------------------------------------------------------------------------------
// FASTLOGS_SCRUB_PII = true: before sending, logText, context values and breadcrumb texts
//   are run through redaction (email / IPv4 / IPv6 / Bearer tokens / long digit sequences
//   -> "[redacted]"). Toggle is available in the overlay (persist ini) and via
//   runtime-override fastlogs_init({ scrubPii: false }). Patterns are extensible (see scr_fastlogs_util:
//   fastlogs_redact_default_rules / fastlogs_redact_rules_set).
#macro FASTLOGS_SCRUB_PII          true
// Replacement string for a detected PII fragment.
#macro FASTLOGS_REDACT_PLACEHOLDER "[redacted]"
// Threshold for "long digit sequence" (consecutive digits) for redaction
//   (card numbers / phone numbers / long IDs). Short numbers (versions, counters) are NOT touched.
//   UNIFIED with the Unity client (\d{9,}) -> 9, so redaction matches on both engines.
#macro FASTLOGS_REDACT_MIN_DIGITS  9

// WHETHER TO INCLUDE SENSITIVE device/URL/identifier FIELDS (feature #3). OFF BY DEFAULT.
//   In the current client the device script does NOT collect obviously sensitive identifiers anyway,
//   so this is an explicit intent flag (for the future / for Unity client compatibility). The tester's IP
//   is never sent by the client at all (the server hashes salt+sha256). Enable deliberately as an integrator.
#macro FASTLOGS_INCLUDE_SENSITIVE  false

// =====================================================================================
// CONTEXT + BREADCRUMBS (feature #2)
// -------------------------------------------------------------------------------------
// Cap on the rolling breadcrumb buffer (last N). Old entries are evicted (ring buffer).
#macro FASTLOGS_BREADCRUMB_MAX     100
// Limits on context key/value (soft client-side guard; server also caps ~4KB total,
//   key<=64, value<=512). Too-long values are truncated on the client to avoid sending obvious garbage.
#macro FASTLOGS_CONTEXT_KEY_MAX    64
#macro FASTLOGS_CONTEXT_VAL_MAX    512
// Character limit for a single breadcrumb text (server caps ~16KB total for 100 entries).
#macro FASTLOGS_BREADCRUMB_MSG_MAX 512

// =====================================================================================
// CONTROLS / HOTKEYS
// -------------------------------------------------------------------------------------
// Overlay toggle key (on platforms with a keyboard). vk_* constant.
#macro FASTLOGS_HOTKEY_TOGGLE  vk_f8
// Gamepad combo for consoles. // TODO verify gp_* constants for target platforms.
#macro FASTLOGS_GP_TOGGLE      gp_select

// QUICK SEND (QUICK-SEND feature, A): a SEPARATE hotkey/gesture that immediately sends the current
//   recording via fastlogs_send() WITHOUT opening the overlay. Must differ from the overlay toggle.
//   On platforms with a keyboard - a vk_* constant. Default F9 (next to the F8 toggle).
#macro FASTLOGS_HOTKEY_QUICK_SEND vk_f9
// Gamepad button for quick send on consoles. Different from FASTLOGS_GP_TOGGLE.
//   // TODO verify gp_* constants for target platforms. Default gp_start (Start != Select toggle).
#macro FASTLOGS_GP_QUICK_SEND     gp_start

// =====================================================================================
// OVERLAY (colors/layout; drawn with PRIMITIVES, no sprites)
// -------------------------------------------------------------------------------------
#macro FASTLOGS_COL_BG        $000000     // panel background (BGR in GM make_colour_rgb hex notation - see below)
#macro FASTLOGS_COL_PANEL     $1A1A1A
#macro FASTLOGS_COL_TEXT      $E6E6E6
#macro FASTLOGS_COL_ERROR     $4040FF     // red (GM hex = $BBGGRR)
#macro FASTLOGS_COL_WARN      $20C0FF     // yellow-orange
#macro FASTLOGS_COL_LOG       $C0C0C0     // grey
#macro FASTLOGS_COL_BTN       $303030
#macro FASTLOGS_COL_BTN_HOVER $4A4A4A
#macro FASTLOGS_COL_ACCENT    $50C878     // accent (green)

#macro FASTLOGS_BG_ALPHA      0.85        // background panel opacity
#macro FASTLOGS_BTN_MIN_SIZE  64          // min tap-zone size (px), large buttons for touch

// =====================================================================================
// STATUS TOAST (STATUS feature, B) - lightweight notification over the game even without the overlay
// -------------------------------------------------------------------------------------
// Show the send status to the player as a toast (Sending / Done+link / Error) over the game,
//   even when the overlay is closed. The toast is drawn ONLY when there is something to show (zero work otherwise).
#macro FASTLOGS_TOAST_ENABLED          true
// Duration for short toasts (success/info), seconds. "Sending..." stays until the send finishes.
#macro FASTLOGS_TOAST_SECONDS          3
// Duration for the error toast (give the user time to read the reason + retry hint), seconds.
#macro FASTLOGS_TOAST_ERROR_SECONDS    6
