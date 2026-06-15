/// @description scr_fastlogs_recorder
// FastLogs GameMaker client - PERSISTENT RECORDING.
// Implements: fastlogs_record_start/stop/set/is_recording/clear; log writing to disk
//   (game_save_id, rolling file with FASTLOGS_PERSIST_MAX_BYTES limit, session marker);
//   PERSISTENCE BETWEEN SESSIONS (previous sessions are loaded on startup); delivery of
//   accumulated logText for sending. Recording is OFF by default (enabled via start/set(true) or config).
//
// Persistence model (single rolling file, synchronous append via buffer):
//   - Path: FASTLOGS_PERSIST_DIR + "/" + FASTLOGS_PERSIST_FILE (relative to game_save_id).
//   - On startup the file is fully read into the string accumulator rec_text (previous sessions).
//   - While recording is active each flog is synchronously appended to BOTH rec_text AND the file.
//   - Session marker (guid + UTC + brief device info) is written once on the first activation of
//     recording in a session, so session boundaries are visible in the file.
//   - Rotation: if the file exceeds the limit - trim the OLD beginning (keep a tail of ~half the
//     limit), preserving line integrity on \n boundaries.
//   - The recording flag is persisted in ini (FASTLOGS_PERSIST_DIR/settings.ini) and restored on
//     startup: if recording was enabled in the previous session, continue writing.
//
// Everything is gated on FASTLOGS_ENABLED: when !FASTLOGS_ENABLED all entry points early-exit.
// Local time/file helpers are marked "// REPLACEABLE: util" - once scr_fastlogs_util is ready
//   they can be replaced with the shared fastlogs_util_* functions.
// Verify GML API against GM-NOTES.md / current documentation; mark uncertain items // TODO verify.

// =====================================================================================
// Internal: lazily create and return the recorder sub-state inside global.__fastlogs.
// =====================================================================================
function __fastlogs_rec_state() {
    var st = __fastlogs_state();   // from scr_fastlogs_core
    if (!variable_struct_exists(st, "rec") || !is_struct(st.rec)) {
        st.rec = {
            loaded        : false,   // whether persisted data was loaded on startup
            rec_text      : "",      // accumulated log text (previous + current session)
            // PERF (D): incremental byte size of rec_text. Updated on every append
            //   (+= string_byte_length(piece)) to avoid scanning the entire rec_text
            //   (~1 MB) on every line. The full O(n) scan (__fastlogs_rotate_text) is called
            //   only when the counter exceeds the limit. After rotation the counter is re-synced.
            rec_bytes     : 0,       // byte size of rec_text (amortized O(1) tracking)
            session_mark  : false,   // whether the current session marker has been written
            session_guid  : "",      // guid of the current session (for the marker)
            file_path     : FASTLOGS_PERSIST_DIR + "/" + FASTLOGS_PERSIST_FILE,
            ini_path      : FASTLOGS_PERSIST_DIR + "/settings.ini",
            disk_ok       : true,    // false if file operations failed (fall back to in-memory)
            // PERF (D): BATCH disk writes. Lines accumulate here and are flushed in bulk on
            //   timer/limit/before send/on crash - NOT full-file IO on every line.
            pending       : "",      // lines not yet flushed to disk (already counted in rec_text)
            pending_bytes : 0,       // byte size of the batch (for the FASTLOGS_PERSIST_FLUSH_MAX_BYTES limit)
            last_flush_us : -1,      // get_timer() of the last flush (us); -1 = never flushed
        };
    }
    return st.rec;
}

// =====================================================================================
// REPLACEABLE: util. UTC ISO-8601 timestamp "YYYY-MM-DDThh:mm:ssZ".
// date_current_datetime() returns the moment in the BASE timezone; we set UTC for reading
//   the components, then restore the previous timezone. (date_set_timezone/timezone_utc -
//   CONFIRMED; date_get_* components accept a datetime value.)
// =====================================================================================
function __fastlogs_utc_iso() {
    var prev = date_get_timezone();
    date_set_timezone(timezone_utc);
    var dt = date_current_datetime();
    var _y = date_get_year(dt);
    var mo = date_get_month(dt);
    var d  = date_get_day(dt);
    var h  = date_get_hour(dt);
    var mi = date_get_minute(dt);
    var s  = date_get_second(dt);
    date_set_timezone(prev);

    var p2 = function(n) { return (n < 10 ? "0" : "") + string(n); };
    return string(_y) + "-" + p2(mo) + "-" + p2(d) + "T" + p2(h) + ":" + p2(mi) + ":" + p2(s) + "Z";
}

// REPLACEABLE: util. Timestamp for a single log line "[hh:mm:ss]" (UTC).
function __fastlogs_utc_clock() {
    var prev = date_get_timezone();
    date_set_timezone(timezone_utc);
    var dt = date_current_datetime();
    var h  = date_get_hour(dt);
    var mi = date_get_minute(dt);
    var s  = date_get_second(dt);
    date_set_timezone(prev);
    var p2 = function(n) { return (n < 10 ? "0" : "") + string(n); };
    return p2(h) + ":" + p2(mi) + ":" + p2(s);
}

// REPLACEABLE: util. Text level tag for a log line.
function __fastlogs_level_tag(level) {
    switch (level) {
        case FASTLOGS_LEVEL_ERROR: return "ERROR";
        case FASTLOGS_LEVEL_WARN:  return "WARN";
        default:                   return "LOG";
    }
}

// REPLACEABLE: util. Format a ring entry { time, level, text } into a log line string.
//   Format: "[hh:mm:ss] LEVEL: text". Multi-line text is left as-is.
function __fastlogs_format_record(rec) {
    return "[" + __fastlogs_utc_clock() + "] " + __fastlogs_level_tag(rec.level) + ": " + string(rec.text);
}

// REPLACEABLE: util. Ensure the persist directory exists (relative to game_save_id).
function __fastlogs_ensure_dir() {
    if (!directory_exists(FASTLOGS_PERSIST_DIR)) {
        directory_create(FASTLOGS_PERSIST_DIR);   // path is relative to game_save_id
    }
}

// REPLACEABLE: util. Read an entire text file (UTF-8) via buffer. Returns "" if missing/error.
//   The file is written as raw UTF-8 without a null terminator (buffer_text), so to read it
//   "to the end as a string" we append one \0 to the end of the grow-buffer and read buffer_string from 0.
//   (buffer_string reads UTF-8 up to a null byte - CONFIRMED; buffer_text for fixed-length READ
//    is not documented, so we go through buffer_string.)
function __fastlogs_read_text_file(rel_path) {
    if (!file_exists(rel_path)) return "";
    var buf = buffer_load(rel_path);   // grow-buffer, align 1; path is relative to game_save_id
    if (buf < 0) return "";
    var sz = buffer_get_size(buf);
    if (sz <= 0) { buffer_delete(buf); return ""; }
    buffer_seek(buf, buffer_seek_end, 0);
    buffer_write(buf, buffer_u8, 0);   // null terminator for correct buffer_string read
    var out = buffer_peek(buf, 0, buffer_string);   // read the full string from the start without advancing
    buffer_delete(buf);
    return out;
}

// REPLACEABLE: util. Overwrite a text file entirely with a string (UTF-8, no terminator).
//   buffer_save_ext(buffer, filename, offset, size) - saves the range [offset, offset+size).
//   // TODO verify exact argument order of buffer_save_ext in 2024.x (manual returns 403).
function __fastlogs_write_text_file(rel_path, text) {
    var bytes = string_byte_length(text);
    var buf   = buffer_create(max(1, bytes), buffer_grow, 1);
    if (bytes > 0) buffer_write(buf, buffer_text, text);   // buffer_text: string bytes WITHOUT \0
    buffer_save_ext(buf, rel_path, 0, buffer_tell(buf));   // save only the written bytes
    buffer_delete(buf);
}

// =====================================================================================
// Internal: apply rotation to text (trim old beginning within limit, preserving line integrity on \n).
//   Returns a struct { text, bytes }: the (possibly trimmed) text and its exact byte size.
//   The size is computed HERE (in one pass inside the rare rotation), so the caller can
//   re-sync the incremental rec_bytes counter without a separate O(n) scan.
//   A truncation marker is prepended after trimming. known_bytes (if >=0) is the already-known
//   byte size of text, to avoid re-scanning it on input.
// =====================================================================================
function __fastlogs_rotate_ex(text, known_bytes = -1) {
    var limit = max(1024, FASTLOGS_PERSIST_MAX_BYTES);
    var bytes = (known_bytes >= 0) ? known_bytes : string_byte_length(text);
    if (bytes <= limit) return { text : text, bytes : bytes };

    // Keep a tail of ~half the limit so we don't rotate on every line.
    var keep_bytes = limit div 2;
    // Walk from the beginning, dropping lines until we fit within keep_bytes.
    var tail = text;
    // Simple approach: while byte length is too large, drop the first line at \n.
    while (string_byte_length(tail) > keep_bytes) {
        var nl = string_pos("\n", tail);
        if (nl <= 0) {
            // No newlines - hard-cut by characters.
            var over = string_byte_length(tail) - keep_bytes;
            // trim approximately 'over' characters from the start (estimate: 1 byte ~ 1 char for ASCII)
            tail = string_delete(tail, 1, max(1, over));
            break;
        }
        tail = string_delete(tail, 1, nl);   // remove up to and including the first \n
    }
    var prefix    = "... [fastlogs: старые строки усечены при ротации] ...\n";
    var out_text  = prefix + tail;
    return { text : out_text, bytes : string_byte_length(out_text) };
}

// Wrapper with the old signature (used on the persist-load path where the counter is not needed).
function __fastlogs_rotate_text(text) {
    return __fastlogs_rotate_ex(text, -1).text;
}

// =====================================================================================
// Internal: append one ready-formatted log line to rec_text and to the BATCH (pending).
//   PERF (D): does NOT touch disk on every line. The line accumulates in rs.pending; the actual
//   bulk flush is done by __fastlogs_flush_pending (on timer from tick, on limit, before
//   send/on crash). In-memory rotation of rec_text is still applied; after rotation we mark
//   the batch as "needs full rewrite" (rewrite), because appending a tail after a trim is invalid.
//   immediate=true (crash path) -> flush synchronously right away without waiting for the timer.
// =====================================================================================
function __fastlogs_append_line(line, immediate = false) {
    var rs = __fastlogs_rec_state();
    var piece = line + "\n";

    // PERF (D): append and incremental byte accounting - O(piece), WITHOUT scanning all of rec_text.
    rs.rec_text  += piece;
    var piece_bytes = string_byte_length(piece);
    rs.rec_bytes += piece_bytes;

    // Full O(n) rotation is called ONLY when the incremental counter exceeds the limit
    //   (rare event). Normal line -> cheap branch below without scanning rec_text.
    var rotated = false;
    var limit = max(1024, FASTLOGS_PERSIST_MAX_BYTES);
    if (rs.rec_bytes > limit) {
        var rot = __fastlogs_rotate_ex(rs.rec_text, rs.rec_bytes);   // computes exact size internally
        rotated      = (rot.bytes != rs.rec_bytes);
        rs.rec_text  = rot.text;
        rs.rec_bytes = rot.bytes;   // re-sync counter after rotation (no separate scan)
    }

    if (!FASTLOGS_PERSIST_ENABLED || !rs.disk_ok) return;

    if (rotated) {
        // Rotation: tail-append is invalid (old beginning was trimmed). Flush the batch as a full
        //   file rewrite with the current rec_text. Done immediately (rotation is rare).
        rs.pending       = "";
        rs.pending_bytes = 0;
        rs.last_flush_us = get_timer();
        try {
            __fastlogs_ensure_dir();
            __fastlogs_write_text_file(rs.file_path, rs.rec_text);
        } catch (_e) {
            rs.disk_ok = false;
        }
        return;
    }

    // Normal path: accumulate the line in the batch (NO file IO here).
    rs.pending       += piece;
    rs.pending_bytes += string_byte_length(piece);

    // Flush the batch: immediately (crash) or when the batch size limit is exceeded.
    if (immediate || rs.pending_bytes >= max(1, FASTLOGS_PERSIST_FLUSH_MAX_BYTES)) {
        __fastlogs_flush_pending();
    }
}

// =====================================================================================
// Internal: flush the batch (rs.pending) to disk with a SINGLE append to the end of the file.
//   This is the only per-flush file IO point (instead of per-log). Safe when the batch is empty
//   (no-op). On disk error -> in-memory mode (disk_ok=false); data is still preserved in rec_text.
// =====================================================================================
function __fastlogs_flush_pending() {
    var rs = __fastlogs_rec_state();
    rs.last_flush_us = get_timer();
    if (string_length(rs.pending) == 0) return;
    if (!FASTLOGS_PERSIST_ENABLED || !rs.disk_ok) { rs.pending = ""; rs.pending_bytes = 0; return; }

    var batch = rs.pending;
    rs.pending       = "";
    rs.pending_bytes = 0;
    try {
        __fastlogs_ensure_dir();
        __fastlogs_append_to_file(rs.file_path, batch);   // single bulk append to the end of the file
    } catch (_e) {
        rs.disk_ok = false;   // in-memory mode from here; send will still work (rec_text is intact)
    }
}

// =====================================================================================
// fastlogs_recorder_tick() - call every Step from the controller. PERF (D): cheap timer check;
//   flushes the batch to disk at most once per FASTLOGS_PERSIST_FLUSH_SECONDS. No allocations
//   per frame when the batch is empty (early exit). no-op when !FASTLOGS_ENABLED / persist disabled.
// =====================================================================================
function fastlogs_recorder_tick() {
    if (!FASTLOGS_ENABLED) return;
    if (!FASTLOGS_PERSIST_ENABLED) return;
    // Do not create state if the recorder has not been used yet (tick is cheap and safe).
    var st = __fastlogs_state();
    if (!variable_struct_exists(st, "rec") || !is_struct(st.rec)) return;
    var rs = st.rec;
    if (string_length(rs.pending) == 0) return;   // nothing to flush -> zero work

    var flush_secs = FASTLOGS_PERSIST_FLUSH_SECONDS;
    if (!is_real(flush_secs) || flush_secs <= 0) {
        // 0 -> write immediately (no timer-based batching).
        __fastlogs_flush_pending();
        return;
    }
    var now_us = get_timer();
    if (rs.last_flush_us < 0) { rs.last_flush_us = now_us; }   // first timestamp
    if ((now_us - rs.last_flush_us) >= flush_secs * 1000000) {
        __fastlogs_flush_pending();
    }
}

// =====================================================================================
// fastlogs_recorder_flush() - public forced batch flush to disk (call before sending
//   so that logText/file are up to date). Safe when the batch is empty.
// =====================================================================================
function fastlogs_recorder_flush() {
    if (!FASTLOGS_ENABLED) return;
    var st = __fastlogs_state();
    if (!variable_struct_exists(st, "rec") || !is_struct(st.rec)) return;
    __fastlogs_flush_pending();
}

// REPLACEABLE: util. Append a string to the end of a file (loads the current buffer, seeks to end, appends).
//   GM does not expose an append mode for file buffers directly - load, seek to end, write.
function __fastlogs_append_to_file(rel_path, text) {
    var buf;
    if (file_exists(rel_path)) {
        buf = buffer_load(rel_path);            // grow, align 1
        if (buf < 0) buf = buffer_create(1, buffer_grow, 1);
        buffer_seek(buf, buffer_seek_end, 0);   // seek to end of existing data
    } else {
        buf = buffer_create(1, buffer_grow, 1);
    }
    if (string_byte_length(text) > 0) buffer_write(buf, buffer_text, text);
    buffer_save_ext(buf, rel_path, 0, buffer_tell(buf));   // // TODO verify argument order of buffer_save_ext
    buffer_delete(buf);
}

// REPLACEABLE: util. Simple session guid (no dependencies). Time + randomness.
function __fastlogs_make_guid() {
    var a = string(date_current_datetime());
    var b = string(irandom(999999999));
    var c = string(get_timer());
    return md5_string_utf8(a + "-" + b + "-" + c);   // md5_string_utf8 - built-in
}

// =====================================================================================
// Internal: write the session start marker to the file (once per session, on the first activation
//   of recording). Contains guid + UTC + brief device info so session boundaries are visible.
// =====================================================================================
function __fastlogs_write_session_marker() {
    var rs = __fastlogs_rec_state();
    if (rs.session_mark) return;
    rs.session_mark = true;
    if (rs.session_guid == "") rs.session_guid = __fastlogs_make_guid();

    var dev = "os_type=" + string(os_type) + " ver=" + string(os_version);
    var line = "===== FASTLOGS SESSION " + rs.session_guid
             + " | " + __fastlogs_utc_iso()
             + " | " + dev + " =====";
    __fastlogs_append_line(line);
}

// =====================================================================================
// Internal: load persisted data from previous sessions and restore the recording flag.
//   Called from fastlogs_init (core). Idempotent (loaded flag).
// =====================================================================================
function fastlogs_recorder_load_persisted() {
    if (!FASTLOGS_ENABLED) return;
    var rs = __fastlogs_rec_state();
    if (rs.loaded) return;
    rs.loaded = true;
    rs.session_guid = __fastlogs_make_guid();

    if (!FASTLOGS_PERSIST_ENABLED) return;

    try {
        // Load accumulated log from previous sessions. Using _ex to immediately sync
        //   the incremental rec_bytes counter (one scan here, amortized tracking thereafter).
        var prev_text = __fastlogs_read_text_file(rs.file_path);
        if (prev_text != "") {
            var rot = __fastlogs_rotate_ex(prev_text, -1);
            rs.rec_text  = rot.text;
            rs.rec_bytes = rot.bytes;
        }

        // Restore the recording flag from ini.
        if (file_exists(rs.ini_path)) {
            ini_open(rs.ini_path);
            var was_recording = ini_read_real("recorder", "recording", 0);
            ini_close();
            if (was_recording >= 1) {
                // Continue recording from the previous session (without persisting ini again inside set).
                __fastlogs_state().recording = true;
                __fastlogs_write_session_marker();
            }
        }
    } catch (_e) {
        rs.disk_ok = false;   // disk unavailable - operate in-memory
    }
}

// =====================================================================================
// Internal: persist the recording flag to ini (called from fastlogs_record_set).
// =====================================================================================
function __fastlogs_persist_recording_flag(enabled) {
    if (!FASTLOGS_PERSIST_ENABLED) return;
    var rs = __fastlogs_rec_state();
    if (!rs.disk_ok) return;
    try {
        __fastlogs_ensure_dir();
        ini_open(rs.ini_path);
        ini_write_real("recorder", "recording", enabled ? 1 : 0);
        ini_close();
    } catch (_e) {
        rs.disk_ok = false;
    }
}

// =====================================================================================
// fastlogs_recorder_on_record(rec) - called from flog AFTER writing to the ring.
//   Writes the line to disk ONLY when recording is active. flog persists nothing when disabled.
// =====================================================================================
function fastlogs_recorder_on_record(rec) {
    if (!FASTLOGS_ENABLED) return;
    var st = __fastlogs_state();
    if (!st.recording) return;   // recording disabled -> nothing goes to disk

    var rs = __fastlogs_rec_state();
    if (!rs.session_mark) __fastlogs_write_session_marker();
    __fastlogs_append_line(__fastlogs_format_record(rec));
}

// =====================================================================================
// fastlogs_recorder_flush_crash() - synchronous emergency flush of the ENTIRE ring to disk.
//   Used from the unhandled exception handler: writes even if recording was disabled,
//   so that on a crash the state is saved (to be sent on the next launch).
// =====================================================================================
function fastlogs_recorder_flush_crash() {
    if (!FASTLOGS_ENABLED) return;
    var rs = __fastlogs_rec_state();
    if (!rs.session_mark) {
        // Force-write the session marker (in case recording was disabled).
        rs.session_mark = false;
        __fastlogs_write_session_marker();
    }
    // Dump the entire current ring snapshot (chronologically) into persist.
    var snap = fastlogs_ring_snapshot();   // from core
    for (var i = 0; i < array_length(snap); i++) {
        __fastlogs_append_line(__fastlogs_format_record(snap[i]));
    }
    // Guarantee that everything accumulated (including the normal-write batch) is flushed to disk:
    //   on a crash the game closes after the callback, the timer-based flush will not fire.
    __fastlogs_flush_pending();
}

// =====================================================================================
// PUBLIC RECORDING API (PUBLIC-API contract).
// =====================================================================================

// Enable recording (equivalent to set(true)).
function fastlogs_record_start() {
    if (!FASTLOGS_ENABLED) return;
    fastlogs_record_set(true);
}

// Disable recording (accumulated data on disk is kept).
function fastlogs_record_stop() {
    if (!FASTLOGS_ENABLED) return;
    fastlogs_record_set(false);
}

// Enable/disable recording. Persists the flag (ini) when FASTLOGS_PERSIST_ENABLED.
function fastlogs_record_set(enabled) {
    if (!FASTLOGS_ENABLED) return;
    var st = __fastlogs_state();
    var en = bool(enabled);
    if (st.recording == en) {
        // Idempotent, but still ensure the persist flag is in sync.
        __fastlogs_persist_recording_flag(en);
        return;
    }
    st.recording = en;
    if (en) {
        var rs = __fastlogs_rec_state();
        if (!rs.session_mark) __fastlogs_write_session_marker();   // mark recording start
    }
    __fastlogs_persist_recording_flag(en);
}

// Current recording state. Returns false when !FASTLOGS_ENABLED.
function fastlogs_is_recording() {
    if (!FASTLOGS_ENABLED) return false;
    return __fastlogs_state().recording;
}

// Clear accumulated persist data (memory + file on disk). Unlike fastlogs_clear()
//   (which only clears the ring), this erases the rolling record file.
function fastlogs_record_clear() {
    if (!FASTLOGS_ENABLED) return;
    var rs = __fastlogs_rec_state();
    rs.rec_text     = "";
    rs.rec_bytes    = 0;     // reset the incremental counter in sync with rec_text
    rs.session_mark = false;
    if (FASTLOGS_PERSIST_ENABLED && rs.disk_ok) {
        try {
            if (file_exists(rs.file_path)) file_delete(rs.file_path);
        } catch (_e) { rs.disk_ok = false; }
    }
}

// =====================================================================================
// CRASH REPORT PERSIST + RESEND ON STARTUP (feature #1, PENDING-QUEUE).
// -------------------------------------------------------------------------------------
// Model: on auto-send triggered by a crash, first SYNCHRONOUSLY write the complete JSON
//   payload body to a separate file in the pending directory (inside game_save_id), then
//   attempt to send it. On success delete the file (by the remembered path). On startup
//   scan the directory and resend anything unsent - so a hard crash that killed the process
//   before the HTTP completed will be delivered on the next run.
//   Queue cap: FASTLOGS_PENDING_MAX (oldest entries beyond the limit are discarded).
//   Files are raw UTF-8 JSON (via the same buffer helpers as the log).
// =====================================================================================

// Pending directory relative to game_save_id (same as other recorder paths).
function __fastlogs_pending_dir() {
    return FASTLOGS_PERSIST_DIR + "/" + FASTLOGS_PENDING_DIR;
}

// Ensure the pending directory exists (parent + itself).
function __fastlogs_pending_ensure_dir() {
    __fastlogs_ensure_dir();                       // FASTLOGS_PERSIST_DIR
    var d = __fastlogs_pending_dir();
    if (!directory_exists(d)) directory_create(d);
}

// List of pending files (RELATIVE paths dir+"/"+name), sorted by name.
//   File names start with a zero-padded timestamp -> lexicographic order = chronological order.
function __fastlogs_pending_list() {
    var out = [];
    var d = __fastlogs_pending_dir();
    if (!directory_exists(d)) return out;
    // file_find_first(mask, attr): mask includes path; attr=0 -> regular files only. Returns NAME.
    var fname = file_find_first(d + "/*.json", 0);
    while (fname != "") {
        if (fname != "." && fname != "..") array_push(out, d + "/" + fname);
        fname = file_find_next();
    }
    file_find_close();
    array_sort(out, true);                          // ascending by name (chronologically)
    return out;
}

// Enforce queue cap: delete the oldest files beyond FASTLOGS_PENDING_MAX.
function __fastlogs_pending_enforce_cap() {
    var cap = max(1, FASTLOGS_PENDING_MAX);
    var files = __fastlogs_pending_list();          // sorted: oldest first
    var over = array_length(files) - cap;
    for (var i = 0; i < over; i++) {
        try { if (file_exists(files[i])) file_delete(files[i]); } catch (_e) { /* best-effort */ }
    }
}

// =====================================================================================
// fastlogs_pending_write(body_json) -> string (file path) | ""
//   Synchronously write a ready JSON report body to the pending queue. Returns the relative
//   path of the created file (for later deletion on success) or "" on failure/disabled.
//   Name: crash_<UTC-compact>_<guid8>.json (time-sortable).
// =====================================================================================
function fastlogs_pending_write(body_json) {
    if (!FASTLOGS_ENABLED) return "";
    if (!is_string(body_json) || string_length(body_json) == 0) return "";
    var rs = __fastlogs_rec_state();
    if (!rs.disk_ok) return "";

    var path = "";
    try {
        __fastlogs_pending_ensure_dir();
        // Compact sortable timestamp from UTC ISO (strip non-alphanumeric characters).
        var ts = __fastlogs_utc_iso();
        ts = string_replace_all(ts, "-", "");
        ts = string_replace_all(ts, ":", "");
        ts = string_replace_all(ts, "T", "");
        ts = string_replace_all(ts, "Z", "");
        var guid8 = string_copy(__fastlogs_make_guid(), 1, 8);
        path = __fastlogs_pending_dir() + "/crash_" + ts + "_" + guid8 + ".json";
        __fastlogs_write_text_file(path, body_json);   // raw UTF-8 (same as the log file)
        // After adding, enforce the cap (discard oldest beyond the limit).
        __fastlogs_pending_enforce_cap();
    } catch (_e) {
        rs.disk_ok = false;
        return "";
    }
    return path;
}

// =====================================================================================
// fastlogs_pending_delete(path) -> void
//   Delete one pending file by its remembered path (on successful delivery of that report).
// =====================================================================================
function fastlogs_pending_delete(path) {
    if (!FASTLOGS_ENABLED) return;
    if (!is_string(path) || string_length(path) == 0) return;
    try { if (file_exists(path)) file_delete(path); } catch (_e) { /* best-effort */ }
}

// =====================================================================================
// fastlogs_pending_drain_next([exclude_path]) -> bool (whether a send of ONE file was queued)
//   ONE-AT-A-TIME outbox drain: find the oldest pending file (except exclude_path - the one
//   just sent, to avoid resending it) and queue ONE send for it. Respects single-flight inside
//   fastlogs_pending_send (if busy/waiting for retry - returns false, file stays in queue).
//   Corrupted/empty files are deleted along the way to prevent them from getting stuck.
//   CHAIN: the next file is started by the Async success handler (Other_62) after the previous
//   one finishes - so multiple files are drained per session, not just one (previously resend_all
//   looped through fastlogs_pending_send but single-flight made all iterations except the first a no-op).
//   Returns: true if a request was queued (something to resend and the layer is free); false otherwise.
// =====================================================================================
function fastlogs_pending_drain_next(exclude_path = "") {
    if (!FASTLOGS_ENABLED) return false;
    if (!script_exists(asset_get_index("fastlogs_pending_send"))) return false;

    var files = __fastlogs_pending_list();          // oldest first
    var ex = is_string(exclude_path) ? exclude_path : "";

    for (var i = 0; i < array_length(files); i++) {
        var fp = files[i];
        if (fp == ex) continue;                     // do not resend the one just sent
        var body = __fastlogs_read_text_file(fp);
        if (!is_string(body) || string_length(body) == 0) {
            // Corrupted/empty file - delete it so it doesn't get stuck in the queue, try the next one.
            fastlogs_pending_delete(fp);
            continue;
        }
        // One send (the http layer deletes the file on success using this path). Single-flight inside:
        //   if currently busy/waiting for retry - returns false, we exit (will be picked up later).
        return fastlogs_pending_send(body, fp);
    }
    return false;                                   // queue empty (or only corrupted files remain)
}

// =====================================================================================
// fastlogs_pending_resend_all() -> bool (whether the first send in the chain was started)
//   STARTUP DRAIN (feature #1, backstop). Called from fastlogs_init on startup. Starts ONE
//   first send in the drain chain; SUBSEQUENT files are sent by the Async success handler (Other_62)
//   one at a time as long as the outbox has files (within FASTLOGS_PENDING_RESEND_PER_START per start,
//   see the gate in Other_62). This way multiple files are drained per session, not just one.
//   PREVIOUSLY: there was a loop over fastlogs_pending_send, but single-flight (is_sending) made all
//   iterations except the first a no-op - only one file was actually sent. Now an explicit chain.
//   Each report already carries a complete body (timestampUtc/logText/counts/comment/tester/context/
//   breadcrumbs), so we send it as-is. Depends on fastlogs_pending_send(body, file_path).
// =====================================================================================
function fastlogs_pending_resend_all() {
    if (!FASTLOGS_ENABLED) return false;
    // FIX-1: mark this chain as the STARTUP backstop. The FASTLOGS_PENDING_RESEND_PER_START limit
    //   is applied in Other_62 ONLY while the startup chain is active (init_chain_active);
    //   the live idle drain (after it) is not gated by this limit. Reset the startup counter.
    if (script_exists(asset_get_index("fastlogs_http_get_state"))) {
        var hs = fastlogs_http_get_state();
        hs.init_chain_active = true;
        hs.init_drain_count  = 0;
    }
    // Start the chain: first file. Other_62 (success) will pick up the rest via drain_next.
    var started = fastlogs_pending_drain_next("");
    if (!started) {
        // Nothing to send (outbox empty) or layer busy -> startup chain effectively empty.
        if (script_exists(asset_get_index("fastlogs_http_get_state"))) {
            fastlogs_http_get_state().init_chain_active = false;
        }
    } else {
        // First file of the startup chain queued -> count it in the PER_START counter.
        if (script_exists(asset_get_index("fastlogs_http_get_state"))) {
            fastlogs_http_get_state().init_drain_count += 1;
        }
    }
    return started;
}

// =====================================================================================
// fastlogs_recorder_get_logtext() -> string
//   Returns the log text for the payload logText field. Priority source:
//     1) accumulated persist rec_text (previous + current session), if non-empty -
//        this is the primary source as it contains the cross-session history;
//     2) otherwise - a snapshot of the current in-memory ring (when recording was never enabled).
//   Truncation to FASTLOGS_MAX_LOG_BYTES is done by the payload builder (contract), so we
//   intentionally do NOT truncate here - return the full accumulated text; the payload will
//   truncate with a marker.
//   logEncoding in the payload stays "plain" (FASTLOGS_LOG_ENCODING) - text is not compressed.
// =====================================================================================
function fastlogs_recorder_get_logtext() {
    if (!FASTLOGS_ENABLED) return "";
    var rs = __fastlogs_rec_state();
    if (string_length(rs.rec_text) > 0) {
        return rs.rec_text;
    }
    // Fallback: recording was never active - build from the in-memory ring.
    var snap = fastlogs_ring_snapshot();   // from core
    var out = "";
    for (var i = 0; i < array_length(snap); i++) {
        out += __fastlogs_format_record(snap[i]) + "\n";
    }
    return out;
}
