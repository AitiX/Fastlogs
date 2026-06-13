'use strict';

// crashsig - derive a stable "crash signature" from a FastLogs log body so the
// catalog can group logs that represent the SAME crash/error.
//
// Pure module (only node:crypto), unit-testable without a server. Used at ingest
// (src/routes/ingest.js) to fill logs.crash_sig, and by the lazy recompute in
// the crashes route for logs ingested before the column existed.
//
// FastLogs line format (see unity Runtime/Capture/LogFormat.cs):
//   [E] +12.345 message text         <- one entry; level tag is L | W | E
//       stack frame line 1           <- raw Unity stack trace (may be empty)
//       stack frame line 2
//   (x3)                             <- only when the entry coalesced duplicates
//
// We anchor crash detection on ERROR-level ([E]) entries ONLY. Unity attaches a
// script stack trace to EVERY log (even info), so keying off "lines that look
// like a stack frame" alone would make almost every log a "crash". An [E] entry
// is a real error/exception, so its message + stack is the crash. Logs with no
// [E] entry yield null (not a crash).
//
// The signature is sha1(key + topK normalized frames), truncated. Normalization
// strips everything build/run/OS specific (hex addresses, IL2CPP offsets, line
// numbers, file paths, <assembly> tokens, generic arity, argument lists) so the
// same crash from different builds/devices collapses to one signature.

const crypto = require('node:crypto');

const TOP_K = 8;     // top stack frames folded into the signature
const SIG_LEN = 12;  // sha1 hex truncated to this many chars

// Matches the start of a formatted entry: "[E] +12.345 message". Captures the
// level char (L|W|E) and the message (the rest of the line, tag and time gone).
const ENTRY_RE = /^\[([LWE])\]\s+\+\d+(?:\.\d+)?\s?(.*)$/;
// Session marker written by the recorder between runs (not part of any entry).
const SESSION_RE = /^==== FastLogs session /;
// Coalesced-duplicate marker that trails an entry's stack.
const REPEAT_RE = /^\(x\d+\)\s*$/;

// Is this line a stack-trace frame? Patterns copied verbatim from
// public/viewer.js isTraceLine() so the server's notion of a "frame" matches
// exactly what the viewer folds under the trace toggle.
function isFrameLine(line) {
  if (!line) return false;
  if (/^\s+at\s/.test(line)) return true;
  if (/\[0x[0-9a-fA-F]+\]\s+in\s/.test(line)) return true;
  if (/\(at\s.+:\d+\)\s*$/.test(line)) return true;
  if (/^[A-Za-z_][\w.+<>\[\]`]*:[A-Za-z_<.][\w.<>\[\]`]*\s*\(.*\)\s*$/.test(line)) return true;
  if (/^\(wrapper\s/.test(line)) return true;
  if (/^Rethrow as\s/.test(line)) return true;
  if (/^---\s*End of\s/.test(line)) return true;
  return false;
}

// Split the log body into entries: { level, message, body[] }. Lines that are
// not an entry header (stack frames, etc.) attach to the current entry's body;
// session markers and repeat markers are boundaries, not body.
function parseEntries(text) {
  const lines = String(text).split('\n');
  const entries = [];
  let cur = null;
  for (const raw of lines) {
    const line = raw == null ? '' : String(raw);
    const m = ENTRY_RE.exec(line);
    if (m) {
      cur = { level: m[1], message: m[2] || '', body: [] };
      entries.push(cur);
      continue;
    }
    if (SESSION_RE.test(line)) { cur = null; continue; }
    if (REPEAT_RE.test(line)) { cur = null; continue; }
    if (cur) cur.body.push(line);
  }
  return entries;
}

// Extract the exception type from an error message: "Ns.FooException: msg" ->
// "Ns.FooException". The trailing ":" is required so plain English errors like
// "Error loading scene" (no colon) do not masquerade as a type named "Error".
function exceptionType(message) {
  if (!message) return '';
  const m = /^([A-Za-z_][\w.+<>`]*(?:Exception|Error)):/.exec(String(message).trim());
  return m ? m[1].replace(/`\d+/g, '') : '';
}

// When an error has no exception type (e.g. Debug.LogError("free text")), build
// a grouping key from the message with the volatile parts removed (hex, GUIDs,
// paths, numbers) so "Failed to load asset 12" and "...asset 99" group together.
function normalizeMessage(message) {
  if (!message) return '';
  let s = String(message);
  s = s.replace(/0x[0-9a-fA-F]+/g, '');
  s = s.replace(/\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/gi, '');
  s = s.replace(/(?:[A-Za-z]:)?[\\/][^\s:]*[\\/]/g, '');
  s = s.replace(/\d+/g, '');
  s = s.replace(/\s+/g, ' ').trim().toLowerCase();
  return s.slice(0, 160);
}

// Make one stack frame stable across runs/builds/OSes. Strips line numbers, hex
// addresses, IL2CPP offsets, file paths, <assembly>/source tokens, generic
// arity markers, and collapses argument lists to "()" so overloads group.
function normalizeFrame(line) {
  if (!line) return '';
  let s = String(line);
  if (/^\s*\(wrapper\s/i.test(s)) return 'wrapper';
  if (/^\s*Rethrow as\b/i.test(s)) return 'rethrow as';
  if (/^\s*---\s*End of\b/i.test(s)) return 'end of';
  s = s.replace(/^\s*at\s+/, '').trim();
  s = s.replace(/\s*\(at\s[^)]*:\d+\)\s*$/, '');           // "(at File.cs:42)" suffix
  s = s.replace(/\s+in\s+<[^>]*>\s*:?\d*/g, '');           // " in <assembly>:0"
  s = s.replace(/\[0x[0-9a-fA-F]+\]/g, '');                // IL2CPP offset block
  s = s.replace(/0x[0-9a-fA-F]+/g, '');                    // bare hex address
  s = s.replace(/<[^>]*>/g, '');                           // angle-bracket tokens
  s = s.replace(/(?:[A-Za-z]:)?[\\/][^\s():]*[\\/]/g, ''); // drive/unix paths
  s = s.replace(/:\d+\b/g, '');                            // line numbers
  s = s.replace(/@\d+/g, '');                              // memory offsets
  s = s.replace(/`\d+/g, '');                              // generic arity
  s = s.replace(/\([^)]*\)/g, '()');                       // collapse args
  s = s.replace(/\s+\(/g, '(');                            // drop space before ()
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

// Pick the representative error entry: the LAST [E] entry that carries a stack
// (the most recent crash, the usual auto-send trigger); fall back to the last
// [E] entry with no stack. Returns { message, frames } or null when no error.
function pickError(entries) {
  const errors = entries.filter((e) => e.level === 'E');
  if (errors.length === 0) return null;
  let chosen = null;
  for (const e of errors) {
    const frames = e.body.filter(isFrameLine);
    if (frames.length > 0) chosen = { message: e.message, frames };
  }
  if (!chosen) {
    const last = errors[errors.length - 1];
    chosen = { message: last.message, frames: [] };
  }
  return chosen;
}

// Compute the crash signature for a decompressed log body. Returns a SIG_LEN
// hex string, or null when the log is not a crash (no [E] entry, or no usable
// key/frames). null tells the caller to store the '' sentinel ("computed, not a
// crash") so the lazy recompute never re-scans the same non-crash log.
function computeSignature(logText, opts) {
  if (!logText || typeof logText !== 'string') return null;
  const topK = opts && Number.isFinite(opts.topK) && opts.topK > 0 ? opts.topK : TOP_K;

  const err = pickError(parseEntries(logText));
  if (!err) return null;

  const key = exceptionType(err.message) || normalizeMessage(err.message);

  const frames = [];
  let prev = null;
  for (const raw of err.frames) {
    const nf = normalizeFrame(raw);
    if (!nf || nf === prev) continue;
    frames.push(nf);
    prev = nf;
    if (frames.length >= topK) break;
  }

  if (!key && frames.length === 0) return null;

  const canonical = [key].concat(frames).join('\n');
  return crypto.createHash('sha1').update(canonical, 'utf8').digest('hex').slice(0, SIG_LEN);
}

module.exports = {
  computeSignature,
  parseEntries,
  pickError,
  exceptionType,
  normalizeMessage,
  normalizeFrame,
  isFrameLine,
  TOP_K,
  SIG_LEN,
};
