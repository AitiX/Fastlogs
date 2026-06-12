'use strict';

// Confluence sink (basic).
//
// Two modes are supported:
//
//   1) "webhook" mode (default, fully working): POST the forwarding payload (or a
//      templated body) to an arbitrary URL - e.g. an Atlassian Automation
//      "Incoming webhook" trigger that appends a row to a Confluence table or
//      creates/updates a page. This needs no API token in the server and is the
//      recommended path for now.
//
//   2) "rest" mode (basic stub, see TODO): talk to the Confluence Cloud REST API
//      directly to append content to a page. Appending to an existing page
//      requires read-modify-write of the page body and a version bump, which is
//      more involved; the skeleton and the exact REST calls are outlined below
//      so it can be finished without rediscovery.
//
// Sink config fields:
//   - type: "confluence"          (required)
//   - mode: "webhook" | "rest"    (default "webhook")
//
//   webhook mode:
//     - url:  "https://..."       (required) Atlassian Automation webhook URL
//     - headers: { ... }          (optional, values templated)
//     - bodyTemplate: ...         (optional; default forwards the raw payload)
//
//   rest mode (TODO):
//     - baseUrl: "https://<site>.atlassian.net/wiki"  (required)
//     - email, apiToken           (required; HTTP Basic for Cloud REST)
//     - pageId or spaceKey+title  (target page)

const { deliver } = require('./deliver');
const webhook = require('./webhook');

// Webhook mode: reuse the generic webhook builder so templating/headers behave
// identically to a `webhook` sink, but keep the preset type for clarity.
async function sendWebhook(sink, payload) {
  if (!sink.url) return { ok: false, attempts: 0, error: 'confluence(webhook) sink missing url' };
  // Delegate to the generic webhook implementation (same request shape).
  return webhook.send(sink, payload);
}

// REST mode: append a summary line to a Confluence page via the Cloud REST API.
//
// TODO (Confluence Cloud v2 / v1 REST):
//   1. Authenticate with HTTP Basic: header
//        Authorization: Basic base64("<email>:<apiToken>")
//   2. GET the current page to obtain its body + version number:
//        GET {baseUrl}/api/v2/pages/{pageId}?body-format=storage
//      (v1 equivalent: GET {baseUrl}/rest/api/content/{pageId}?expand=body.storage,version)
//   3. Append our summary (storage-format HTML, e.g. a <p> or a new <tr> in a
//      table) to the existing body.
//   4. PUT the updated page with version.number incremented by 1:
//        PUT {baseUrl}/api/v2/pages/{pageId}
//        body: { id, status:"current", title, body:{representation:"storage",value:<merged>},
//                version:{ number:<old+1>, message:"FastLogs append" } }
//   5. Handle 409 (version conflict) by re-reading and retrying.
//
// Until implemented, return a clear non-fatal error so the dispatcher logs it
// without affecting ingest.
async function sendRest(sink, payload) {
  void payload; // unused until the REST flow is implemented
  if (!sink.baseUrl || !sink.email || !sink.apiToken) {
    return { ok: false, attempts: 0, error: 'confluence(rest) requires baseUrl, email, apiToken' };
  }
  return {
    ok: false,
    attempts: 0,
    error: 'confluence(rest) not implemented yet - use mode:"webhook" (see TODO in confluence.js)',
  };
}

// Send the payload to Confluence. Returns a deliver()-shaped result.
async function send(sink, payload) {
  const mode = sink.mode || 'webhook';
  if (mode === 'rest') return sendRest(sink, payload);
  return sendWebhook(sink, payload);
}

module.exports = {
  send,
  sendWebhook,
  sendRest,
  // Re-exported for callers/tests that want the underlying deliver primitive.
  deliver,
};
