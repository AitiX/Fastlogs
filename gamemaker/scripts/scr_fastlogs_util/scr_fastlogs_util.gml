/// @description scr_fastlogs_util
// FastLogs GameMaker client - UTILITIES + PII SCRUBBING (redaction, feature #3).
// Purpose: redaction of sensitive data (PII) in text before sending:
//   email / IPv4 / IPv6 / Bearer (Authorization) tokens / long digit sequences
//   -> "[redacted]". Applied to logText, context values and breadcrumb texts.
//
// NOTE ON REGEX (verified via WebSearch, June 2026): GameMaker has NO native runtime regex.
//   The manual only provides string_replace / string_replace_all for LITERALS (not patterns).
//   External extensions (RegexGM etc.) break the zero-dependency drop-in client, so
//   patterns are implemented as MANUAL GML string scanners (ord/string_char_at/string_pos),
//   equivalent to the required regexes. Each rule is annotated with its regex equivalent.
//   The rule set is EXTENSIBLE: fastlogs_redact_rules_set([...]) / default fastlogs_redact_default_rules().
//
// VERIFY AGAINST MANUAL when importing into IDE (manual returns 403 on direct fetch; below are standard,
//   but marked as requiring final verification):
//   - ord(string) -> code of the first character (Unicode codepoint).    // TODO verify
//   - string_char_at(str, pos) -> character at position pos (1-based).   // TODO verify
//   - string_length / string_byte_length / string_pos / string_copy /
//     string_delete / string_insert / string_replace_all / string_lower. // standard
//   GML string positions are 1-based (confirmed by project usage: string_copy(s,1,n)).
//
// All PUBLIC entry points: early return when !FASTLOGS_ENABLED.
// Verify GML API against GM-NOTES.md. Mark uncertain items with // TODO verify.

// =====================================================================================
// Effective PII scrubbing flag: runtime-override (fastlogs_init({scrubPii})) -> macro.
//   __fastlogs_cfg is available from core; if core is not yet connected - fall back to macro.
// =====================================================================================
function fastlogs_scrub_pii_enabled() {
    if (!FASTLOGS_ENABLED) return false;
    var def = FASTLOGS_SCRUB_PII;
    if (script_exists(asset_get_index("__fastlogs_cfg"))) {
        return bool(__fastlogs_cfg("scrubPii", def));
    }
    return bool(def);
}

// =====================================================================================
// Low-level per-character predicates (character codes). ord() returns codepoint.
//   We operate on codepoints - all character classes we care about (digits, hex, ASCII symbols)
//   are in the ASCII range, so per-character parsing via string_char_at is safe.
// =====================================================================================
function fastlogs_char_is_digit(ch) {
    var c = ord(ch);
    return (c >= 48 && c <= 57);                 // '0'..'9'
}
function fastlogs_char_is_hex(ch) {
    var c = ord(ch);
    if (c >= 48 && c <= 57)  return true;        // 0-9
    if (c >= 65 && c <= 70)  return true;        // A-F
    if (c >= 97 && c <= 102) return true;        // a-f
    return false;
}
// "Atom" of the email local part / domain: letters, digits and the set of characters allowed in email.
function fastlogs_char_is_email_atom(ch) {
    var c = ord(ch);
    if (c >= 48 && c <= 57)  return true;        // 0-9
    if (c >= 65 && c <= 90)  return true;        // A-Z
    if (c >= 97 && c <= 122) return true;        // a-z
    // allowed characters in local part / domain: . _ % + - (no brackets/quotes)
    switch (c) {
        case 46:  // .
        case 95:  // _
        case 37:  // %
        case 43:  // +
        case 45:  // -
            return true;
    }
    return false;
}
// Email domain character: letters/digits/dot/hyphen (for the part after '@').
function fastlogs_char_is_domain(ch) {
    var c = ord(ch);
    if (c >= 48 && c <= 57)  return true;
    if (c >= 65 && c <= 90)  return true;
    if (c >= 97 && c <= 122) return true;
    return (c == 46 || c == 45);                 // . -
}

// =====================================================================================
// Internal: generic scanner "replace matcher-predicate matches with placeholder".
//   matcher(str, pos) -> match length IN CHARACTERS starting at pos (>0), or 0 if no match.
//   Iterates left to right; on a match inserts placeholder and skips past it.
//   PERF: single O(n) pass; called ONCE during payload/crash assembly, not per frame.
//   Returns the string with replacements applied.
// =====================================================================================
function fastlogs_redact_scan(str, matcher, placeholder) {
    if (!is_string(str) || string_length(str) == 0) return str;
    var n   = string_length(str);
    var out = "";
    var i   = 1;                                  // 1-based
    while (i <= n) {
        var mlen = matcher(str, i);
        if (mlen > 0) {
            out += placeholder;
            i   += mlen;                          // skip past the match
        } else {
            out += string_char_at(str, i);
            i   += 1;
        }
    }
    return out;
}

// =====================================================================================
// MATCHERS (regex equivalents). Each: (str, pos) -> match length in characters, or 0.
// =====================================================================================

// EMAIL. regex equivalent: [A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}
//   We "anchor" the match on '@': the matcher is called at EVERY position, so we catch '@' and
//   backtrack left through the local part... but the scanner only moves forward. To avoid
//   backtracking, implement as "local part -> @ -> domain" starting at pos: if pos is a
//   valid email start and '@' with a valid domain follows - match the whole block.
function fastlogs_match_email(str, pos) {
    var n = string_length(str);
    // 1) local part: >=1 email atom
    var i = pos;
    var local_len = 0;
    while (i <= n && fastlogs_char_is_email_atom(string_char_at(str, i))) { i += 1; local_len += 1; }
    if (local_len == 0) return 0;
    // 2) '@'
    if (i > n || string_char_at(str, i) != "@") return 0;
    i += 1;
    // 3) domain: labels [A-Za-z0-9-] separated by '.', at least one dot and TLD >=2 letters
    var dom_start = i;
    var last_dot  = -1;
    while (i <= n && fastlogs_char_is_domain(string_char_at(str, i))) {
        if (string_char_at(str, i) == ".") last_dot = i;
        i += 1;
    }
    if (i == dom_start) return 0;                 // no domain
    if (last_dot < 0)   return 0;                 // no dot -> not an email
    // TLD after the last dot: >=2 letters
    var tld_len = 0;
    var k = last_dot + 1;
    while (k <= n) {
        var c = ord(string_char_at(str, k));
        if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122)) { tld_len += 1; k += 1; }
        else break;
    }
    if (tld_len < 2) return 0;
    // Match length = up to end of TLD (trailing dots/hyphens of the domain are not included).
    var _end = last_dot + tld_len;                // position of the last TLD character
    return (_end - pos + 1);
}

// IPv4. regex equivalent: \b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b (with octet range check 0..255).
function fastlogs_match_ipv4(str, pos) {
    var n = string_length(str);
    var i = pos;
    var octets = 0;
    while (octets < 4) {
        // 1..3 digits
        var dstart = i;
        var val = 0;
        var dcount = 0;
        while (i <= n && dcount < 3 && fastlogs_char_is_digit(string_char_at(str, i))) {
            val = val * 10 + (ord(string_char_at(str, i)) - 48);
            i += 1; dcount += 1;
        }
        if (dcount == 0) return 0;                // no digit -> not an octet
        if (val > 255) return 0;                  // outside octet range
        octets += 1;
        if (octets < 4) {
            if (i > n || string_char_at(str, i) != ".") return 0;  // separator
            i += 1;
        }
    }
    // Do not match if immediately followed by another digit or dot (part of a longer number/version).
    if (i <= n) {
        var nc = string_char_at(str, i);
        if (fastlogs_char_is_digit(nc) || nc == ".") return 0;
    }
    return (i - pos);
}

// IPv6. regex equivalent (simplified, catches common forms): hex groups (1..4 chars)
//   separated by ':' with optional "::" (zero compression). Require at least 2 colons to avoid
//   confusion with "time 12:30" or MAC addresses. Matcher is conservative: hex groups + ':' + optional "::".
function fastlogs_match_ipv6(str, pos) {
    var n = string_length(str);
    var i = pos;
    var colons = 0;
    var groups = 0;
    var saw_double = false;
    var started = false;
    while (i <= n) {
        var ch = string_char_at(str, i);
        if (fastlogs_char_is_hex(ch)) {
            // hex group 1..4 characters
            var glen = 0;
            while (i <= n && glen < 4 && fastlogs_char_is_hex(string_char_at(str, i))) { i += 1; glen += 1; }
            groups += 1; started = true;
        } else if (ch == ":") {
            colons += 1; started = true;
            i += 1;
            if (i <= n && string_char_at(str, i) == ":") { saw_double = true; colons += 1; i += 1; }
        } else {
            break;
        }
    }
    if (!started) return 0;
    // Conservative threshold: >=2 colons and >=2 hex groups (or "::" is present).
    if (colons < 2) return 0;
    if (!saw_double && groups < 2) return 0;
    return (i - pos);
}

// BEARER / AUTHORIZATION token. regex equivalent (case-insensitive):
//   (Bearer|Authorization:?\s*Bearer)\s+[A-Za-z0-9._\-+/=]+
//   Match keyword Bearer (after optional "Authorization:" / "Authorization ") + the token itself.
function fastlogs_match_bearer(str, pos) {
    var n = string_length(str);
    var i = pos;
    // Optional prefix "authorization" + optional ':' + spaces.
    var lowered = string_lower(string_copy(str, pos, min(20, n - pos + 1)));
    if (string_pos("authorization", lowered) == 1) {
        i = pos + 13;                             // length of "authorization"
        if (i <= n && string_char_at(str, i) == ":") i += 1;
        while (i <= n && fastlogs_char_is_space(string_char_at(str, i))) i += 1;
    }
    // Keyword "bearer" (case-insensitive).
    var kw = string_lower(string_copy(str, i, min(6, n - i + 1)));
    if (kw != "bearer") return 0;
    i += 6;
    // Whitespace between Bearer and the token (at least one).
    var sp = 0;
    while (i <= n && fastlogs_char_is_space(string_char_at(str, i))) { i += 1; sp += 1; }
    if (sp == 0) return 0;
    // The token itself: set of base64url/jwt characters.
    var tstart = i;
    while (i <= n && fastlogs_char_is_token(string_char_at(str, i))) i += 1;
    if (i == tstart) return 0;                    // "Bearer" with no token -> do not redact
    return (i - pos);
}
function fastlogs_char_is_space(ch) {
    var c = ord(ch);
    return (c == 32 || c == 9);                   // space, tab
}
function fastlogs_char_is_token(ch) {
    var c = ord(ch);
    if (c >= 48 && c <= 57)  return true;
    if (c >= 65 && c <= 90)  return true;
    if (c >= 97 && c <= 122) return true;
    switch (c) {
        case 46:  // .
        case 95:  // _
        case 45:  // -
        case 43:  // +
        case 47:  // /
        case 61:  // =
            return true;
    }
    return false;
}

// LONG DIGIT SEQUENCE. regex equivalent: \d{N,} (N=FASTLOGS_REDACT_MIN_DIGITS).
//   Card numbers/phone numbers/long ids. Short numbers (versions, counters, coordinates) are left alone.
function fastlogs_match_long_digits(str, pos) {
    var n = string_length(str);
    var i = pos;
    var cnt = 0;
    while (i <= n && fastlogs_char_is_digit(string_char_at(str, i))) { i += 1; cnt += 1; }
    var mind = max(2, FASTLOGS_REDACT_MIN_DIGITS);
    if (cnt >= mind) return cnt;
    return 0;
}

// =====================================================================================
// RULE SET (EXTENSIBLE). Each rule: { name, matcher }. Applied in order.
//   Order matters: structural rules first (email/bearer/ip), then "long digits" (otherwise
//   digits inside IPv4 could be consumed first; but the IPv4 matcher captures the whole block, and
//   long-digits only fires on >=N consecutive digits without dots, so there is no conflict).
//   Customization: fastlogs_redact_rules_set([{name,matcher}, ...]).
// =====================================================================================
function fastlogs_redact_default_rules() {
    return [
        { name: "bearer",     matcher: fastlogs_match_bearer      },
        { name: "email",      matcher: fastlogs_match_email       },
        { name: "ipv6",       matcher: fastlogs_match_ipv6        },
        { name: "ipv4",       matcher: fastlogs_match_ipv4        },
        { name: "longdigits", matcher: fastlogs_match_long_digits },
    ];
}

// Lazily return the active rule set from state (or default). Stored in core-state.
function __fastlogs_redact_rules() {
    if (script_exists(asset_get_index("__fastlogs_state"))) {
        var st = __fastlogs_state();
        if (!variable_struct_exists(st, "redact_rules") || !is_array(st.redact_rules)) {
            st.redact_rules = fastlogs_redact_default_rules();
        }
        return st.redact_rules;
    }
    return fastlogs_redact_default_rules();
}

/// Replace the active redaction rule set (extensibility). no-op when !FASTLOGS_ENABLED.
/// @param {array} rules array of { name:string, matcher:function(str,pos)->len }
function fastlogs_redact_rules_set(rules) {
    if (!FASTLOGS_ENABLED) return;
    if (!is_array(rules)) return;
    if (script_exists(asset_get_index("__fastlogs_state"))) {
        __fastlogs_state().redact_rules = rules;
    }
}

// =====================================================================================
// fastlogs_redact(text) -> string
//   Runs text through ALL active redaction rules in order. If scrubbing is disabled
//   (FASTLOGS_SCRUB_PII=false / runtime-override) - returns text as-is.
//   Safe against non-strings ("" / coercion). ONE-SHOT operation (during payload/crash assembly).
// =====================================================================================
function fastlogs_redact(text) {
    if (!FASTLOGS_ENABLED) return is_string(text) ? text : "";
    if (!is_string(text) || string_length(text) == 0) return is_string(text) ? text : "";
    if (!fastlogs_scrub_pii_enabled()) return text;

    var placeholder = FASTLOGS_REDACT_PLACEHOLDER;
    var rules = __fastlogs_redact_rules();
    var out = text;
    for (var r = 0; r < array_length(rules); r++) {
        var rule = rules[r];
        if (!is_struct(rule) || !variable_struct_exists(rule, "matcher")) continue;
        out = fastlogs_redact_scan(out, rule.matcher, placeholder);
    }
    return out;
}
