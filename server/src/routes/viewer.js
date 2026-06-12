'use strict';

// GET /:id -> the HTML viewer shell with an inline JSON data island.
//
// The viewer is a static HTML page (public/viewer.html) that loads /viewer.css
// and /viewer.js and contains a sentinel for inline data:
//
//     <script>var __LD = /*__FASTLOGS_DATA__*/ null;</script>
//
// We replace the sentinel (the comment plus the trailing `null`) with a JSON
// object literal so that `__LD` becomes that object. Serving the data inline
// avoids a second round-trip and lets the page render immediately.
//
// Data island shape (consumed by viewer.js):
//   { id, appId, appVersion, platform, title, timestampUtc, createdAt,
//     expiresAt, pinned, counts:{error,warn,log}, logBytes, hasScreenshot,
//     device:{...grouped...}, logText: string }
//
// Missing/expired/invalid ids return the uniform 404 (anti-enumeration), and we
// always set X-Robots-Tag: noindex so logs never end up in search engines.

const storage = require('../storage');
const { sendText } = require('../util/http');
const {
  getLiveLog,
  notFound,
  getViewerShell,
  VIEWER_PLACEHOLDER,
  publicLogObject,
} = require('./shared');

// Matches the data sentinel: `/*__FASTLOGS_DATA__*/` optionally followed by a
// `null` literal (the shell's default value). Whitespace-tolerant so small
// formatting changes in the HTML do not break injection.
const SENTINEL_RE = new RegExp(
  '/\\*' + VIEWER_PLACEHOLDER + '\\*/\\s*(?:null)?'
);

// Characters to escape so the JSON is safe inside a <script> element. The map
// is built from code points (constructed via String.fromCharCode for U+2028 /
// U+2029) so this source file stays plain ASCII and never embeds the raw line
// separators, which are illegal in JS string literals.
const LS = String.fromCharCode(0x2028); // U+2028 line separator
const PS = String.fromCharCode(0x2029); // U+2029 paragraph separator
const SCRIPT_UNSAFE = new RegExp('[<>&' + LS + PS + ']', 'g');
const SCRIPT_ESCAPES = {
  '<': '\\u003c',
  '>': '\\u003e',
  '&': '\\u0026',
  [LS]: '\\u2028',
  [PS]: '\\u2029',
};

// Serialize a value to JSON safe to embed inside a <script> element.
function safeJsonForScript(value) {
  return JSON.stringify(value).replace(SCRIPT_UNSAFE, (ch) => SCRIPT_ESCAPES[ch]);
}

async function viewer(req, res, params) {
  const row = getLiveLog(params.id);
  if (!row) return notFound(res);

  // Pull the decompressed log text so the page can render without a fetch.
  const logText = (await storage.readLogGz(row.id)) || '';

  // Build the island object. publicLogObject carries the metadata + links; the
  // viewer front-end only needs the metadata and logText, but keeping links is
  // harmless and useful for debugging.
  const data = publicLogObject(row);
  data.logText = logText;

  const json = safeJsonForScript(data);
  const shell = getViewerShell();

  // Replace the sentinel with the JSON object literal. If for some reason the
  // sentinel is absent (shell changed), fall back to a global replace of the
  // bare token so we still inject rather than serving a dead page.
  let html;
  if (SENTINEL_RE.test(shell)) {
    html = shell.replace(SENTINEL_RE, () => json);
  } else {
    html = shell.split(VIEWER_PLACEHOLDER).join(json);
  }

  sendText(res, 200, html, {
    'Content-Type': 'text/html; charset=utf-8',
    'X-Robots-Tag': 'noindex, nofollow',
    'Cache-Control': 'no-store',
  });
}

module.exports = { viewer };
