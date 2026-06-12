'use strict';

// Generic webhook sink.
//
// Performs a configurable HTTP request to an arbitrary endpoint. The body and
// headers may be templated against the forwarding payload (CONTRACT section 5)
// using {{path}} placeholders (see template.js).
//
// Sink config fields:
//   - type: "webhook"                       (required)
//   - url:  "https://..."                   (required)
//   - method: "POST" | "PUT" | ...          (default "POST")
//   - headers: { "X-Token": "{{project}}" } (optional, values templated)
//   - bodyTemplate: object | array | string (optional)
//       * object/array  -> sent as JSON (Content-Type set unless overridden),
//                          placeholders resolved structurally (numbers stay numbers);
//       * string        -> sent verbatim after string templating;
//       * omitted       -> the raw payload is sent as JSON.
//   - retries, timeoutMs                    (optional, passed to deliver)

const { deliver } = require('./deliver');
const { renderString, renderJson } = require('./template');

// Build the outbound request (url, method, headers, body) from sink + payload.
function buildRequest(sink, payload) {
  const method = (sink.method || 'POST').toUpperCase();

  // Template header values (keys are taken as-is).
  const headers = {};
  if (sink.headers && typeof sink.headers === 'object') {
    for (const [k, v] of Object.entries(sink.headers)) {
      headers[k] = renderString(String(v), payload);
    }
  }

  let body;
  if (sink.bodyTemplate === undefined) {
    // Default: forward the raw payload as JSON.
    body = JSON.stringify(payload);
    if (!hasHeader(headers, 'content-type')) headers['Content-Type'] = 'application/json';
  } else if (typeof sink.bodyTemplate === 'string') {
    // Verbatim string body after templating; caller controls Content-Type.
    body = renderString(sink.bodyTemplate, payload);
  } else {
    // Structured JSON body with placeholder substitution.
    body = JSON.stringify(renderJson(sink.bodyTemplate, payload));
    if (!hasHeader(headers, 'content-type')) headers['Content-Type'] = 'application/json';
  }

  return { url: sink.url, method, headers, body };
}

// Case-insensitive header presence check.
function hasHeader(headers, name) {
  const target = name.toLowerCase();
  return Object.keys(headers).some((k) => k.toLowerCase() === target);
}

// Send the payload to a generic webhook. Returns a deliver() result.
async function send(sink, payload) {
  if (!sink.url) return { ok: false, attempts: 0, error: 'webhook sink missing url' };
  const request = buildRequest(sink, payload);
  return deliver(request, { retries: sink.retries, timeoutMs: sink.timeoutMs });
}

module.exports = {
  send,
  buildRequest,
};
