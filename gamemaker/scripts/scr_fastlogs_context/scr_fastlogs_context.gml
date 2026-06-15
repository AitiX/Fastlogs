/// @description scr_fastlogs_context
// FastLogs GameMaker client - CONTEXT + BREADCRUMBS (feature #2).
// Public API for game code:
//   fastlogs_set_context(key, value)   - set a context key-value pair (sent with EVERY report)
//   fastlogs_clear_context()           - clear all context
//   fastlogs_breadcrumb(msg, [level])  - add a breadcrumb (rolling buffer of the last N entries)
// Internal snapshots for payload:
//   fastlogs_context_snapshot()        -> struct string->string (optionally empty)
//   fastlogs_breadcrumbs_snapshot()    -> array { t, m, lvl } in chronological order
//
// Storage is in global.__fastlogs (core-state) so the API can be called from any context without
//   with/instance_find (like the rest of the client state):
//   - context     : struct (key->string value)
//   - bc_ring     : array of FASTLOGS_BREADCRUMB_MAX capacity (ring), bc_head/bc_count
// PERF: context is a dictionary (O(1) writes); breadcrumb is a ring write O(1), NO per-frame
//   allocations (struct slot is reused on ring wrap, same as core ring). Redaction/serialization
//   happen ONCE during payload assembly, not on the hot path.
//
// All PUBLIC entry points: early exit when !FASTLOGS_ENABLED (getters -> safe defaults).
// Breadcrumb level in info|warn|error (contract; otherwise normalized to "info").

// =====================================================================================
// Internal: lazily create and return the context sub-state inside global.__fastlogs.
//   Depends on __fastlogs_state() (core). If core is not yet connected - returns undefined,
//   and public functions degrade to no-op (safe with respect to call order).
// =====================================================================================
function __fastlogs_ctx_state() {
    if (!script_exists(asset_get_index("__fastlogs_state"))) return undefined;
    var st = __fastlogs_state();
    if (!variable_struct_exists(st, "context") || !is_struct(st.context)) {
        st.context = {};
    }
    if (!variable_struct_exists(st, "bc_ring") || !is_array(st.bc_ring)) {
        var cap = max(1, FASTLOGS_BREADCRUMB_MAX);
        st.bc_ring  = array_create(cap, undefined);
        st.bc_cap   = cap;
        st.bc_head  = 0;   // next write position
        st.bc_count = 0;   // number of valid entries (<= cap)
    }
    return st;
}

// =====================================================================================
// fastlogs_set_context(key, value) - set a context key-value pair.
//   key/value are coerced to string; truncated to FASTLOGS_CONTEXT_KEY/VAL_MAX (soft guard,
//   the server also caps). Empty key is ignored. Value is stored raw; redaction of
//   values happens during payload assembly (not here - to avoid editing twice/too early).
// =====================================================================================
function fastlogs_set_context(key, value) {
    if (!FASTLOGS_ENABLED) return;
    var st = __fastlogs_ctx_state();
    if (is_undefined(st)) return;

    var k = string(key);
    if (string_length(k) == 0) return;
    if (string_length(k) > FASTLOGS_CONTEXT_KEY_MAX) k = string_copy(k, 1, FASTLOGS_CONTEXT_KEY_MAX);

    var v = string(value);
    if (string_length(v) > FASTLOGS_CONTEXT_VAL_MAX) v = string_copy(v, 1, FASTLOGS_CONTEXT_VAL_MAX);

    // variable_struct_set is safe for arbitrary string keys (including those with spaces).
    variable_struct_set(st.context, k, v);
}

// =====================================================================================
// fastlogs_remove_context(key) - remove a single context pair (if present). Useful for targeted removal.
// =====================================================================================
function fastlogs_remove_context(key) {
    if (!FASTLOGS_ENABLED) return;
    var st = __fastlogs_ctx_state();
    if (is_undefined(st)) return;
    var k = string(key);
    if (variable_struct_exists(st.context, k)) {
        variable_struct_remove(st.context, k);
    }
}

// =====================================================================================
// fastlogs_clear_context() - clear all context.
// =====================================================================================
function fastlogs_clear_context() {
    if (!FASTLOGS_ENABLED) return;
    var st = __fastlogs_ctx_state();
    if (is_undefined(st)) return;
    st.context = {};
}

// =====================================================================================
// Internal: normalize a breadcrumb level to info|warn|error. Accepts a string or
//   FASTLOGS_LEVEL_* (real). Otherwise -> "info".
// =====================================================================================
function __fastlogs_bc_level_norm(level) {
    if (is_string(level)) {
        var l = string_lower(level);
        if (l == "warn" || l == "warning") return "warn";
        if (l == "error" || l == "err")    return "error";
        if (l == "info")                   return "info";
        return "info";
    }
    if (is_real(level)) {
        switch (floor(level)) {
            case FASTLOGS_LEVEL_ERROR: return "error";
            case FASTLOGS_LEVEL_WARN:  return "warn";
            default:                   return "info";
        }
    }
    return "info";
}

// =====================================================================================
// fastlogs_breadcrumb(msg, [level]) - add a breadcrumb to the rolling buffer.
//   level (opt.): "info"|"warn"|"error" or FASTLOGS_LEVEL_* (default "info").
//   t (timestamp) is captured immediately as UTC ISO-8601 (via __fastlogs_utc_iso from recorder,
//   if available) - so the breadcrumb carries the moment IT occurred, not the send time.
//   PERF: ring write O(1), struct slot is reused on wrap (no allocation per breadcrumb).
// =====================================================================================
function fastlogs_breadcrumb(msg, level = "info") {
    if (!FASTLOGS_ENABLED) return;
    var st = __fastlogs_ctx_state();
    if (is_undefined(st)) return;

    var m = string(msg);
    if (string_length(m) > FASTLOGS_BREADCRUMB_MSG_MAX) m = string_copy(m, 1, FASTLOGS_BREADCRUMB_MSG_MAX);
    var lvl = __fastlogs_bc_level_norm(level);

    // Breadcrumb timestamp (UTC ISO-8601). If recorder is not connected - leave "" (payload will omit t).
    var t = "";
    if (script_exists(asset_get_index("__fastlogs_utc_iso"))) {
        t = __fastlogs_utc_iso();
    }

    // Ring write: reuse existing struct slot, otherwise create one.
    var slot = st.bc_ring[st.bc_head];
    if (is_struct(slot)) {
        slot.t   = t;
        slot.m   = m;
        slot.lvl = lvl;
    } else {
        slot = { t: t, m: m, lvl: lvl };
        st.bc_ring[st.bc_head] = slot;
    }
    st.bc_head = (st.bc_head + 1) mod st.bc_cap;
    if (st.bc_count < st.bc_cap) st.bc_count += 1;
}

// =====================================================================================
// fastlogs_clear_breadcrumbs() - clear the breadcrumb buffer.
// =====================================================================================
function fastlogs_clear_breadcrumbs() {
    if (!FASTLOGS_ENABLED) return;
    var st = __fastlogs_ctx_state();
    if (is_undefined(st)) return;
    for (var i = 0; i < st.bc_cap; i++) st.bc_ring[i] = undefined;
    st.bc_head  = 0;
    st.bc_count = 0;
}

// =====================================================================================
// fastlogs_context_snapshot() -> struct (COPY of context key->string).
//   Returns a NEW struct so the payload can apply redaction and compact it
//   without touching the live state. Empty context -> {} (payload will omit it).
// =====================================================================================
function fastlogs_context_snapshot() {
    if (!FASTLOGS_ENABLED) return {};
    var st = __fastlogs_ctx_state();
    if (is_undefined(st)) return {};
    var out = {};
    var keys = variable_struct_get_names(st.context);
    for (var i = 0; i < array_length(keys); i++) {
        var k = keys[i];
        var v = variable_struct_get(st.context, k);
        out[$ k] = is_string(v) ? v : string(v);
    }
    return out;
}

// =====================================================================================
// fastlogs_breadcrumbs_snapshot() -> array { t, m, lvl } in CHRONOLOGICAL order.
//   Returns an array of NEW struct copies (payload applies redaction to m and compacts).
//   Empty buffer -> [] (payload will omit it).
// =====================================================================================
function fastlogs_breadcrumbs_snapshot() {
    if (!FASTLOGS_ENABLED) return [];
    var st = __fastlogs_ctx_state();
    if (is_undefined(st)) return [];
    var out = [];
    if (st.bc_count <= 0) return out;
    // Oldest entry: when ring is full - bc_head; otherwise - 0.
    var start = (st.bc_count >= st.bc_cap) ? st.bc_head : 0;
    for (var i = 0; i < st.bc_count; i++) {
        var idx = (start + i) mod st.bc_cap;
        var rec = st.bc_ring[idx];
        if (is_struct(rec)) {
            array_push(out, {
                t:   variable_struct_exists(rec, "t")   ? rec.t   : "",
                m:   variable_struct_exists(rec, "m")   ? rec.m   : "",
                lvl: variable_struct_exists(rec, "lvl") ? rec.lvl : "info",
            });
        }
    }
    return out;
}
