'use strict';

// Google Sheet sink (Apps Script Web App webhook).
//
// The simplest reliable way to append rows to a Google Sheet without OAuth in
// the server is a Google Apps Script "Web App": you deploy a doPost(e) that
// parses the JSON and appends a row to the sheet, then publish it with access
// "Anyone". The server just POSTs the payload to that web app URL.
//
// A reference Apps Script (paste into Extensions -> Apps Script, deploy as Web
// App, execute as you, access "Anyone"):
//
//   function doPost(e) {
//     var data = JSON.parse(e.postData.contents);
//     var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Logs')
//                 || SpreadsheetApp.getActiveSpreadsheet().getSheets()[0];
//     sheet.appendRow([
//       data.time, data.project, data.projectName, data.version, data.platform,
//       data.counts.error, data.counts.warn, data.counts.log, data.title, data.url
//     ]);
//     return ContentService.createTextOutput(JSON.stringify({ ok: true }))
//                          .setMimeType(ContentService.MimeType.JSON);
//   }
//
// Sink config fields:
//   - type: "googlesheet"         (required)
//   - url:  "https://script.google.com/macros/s/.../exec"  (required)
//   - secret: "..."               (optional; added as `secret` in the body so the
//                                  Apps Script can reject unknown callers)
//   - retries, timeoutMs          (optional)
//
// Note: Apps Script web apps answer the POST with a 302 redirect to
// script.googleusercontent.com; deliver() follows redirects, so a 2xx after the
// redirect is treated as success.

const { deliver } = require('./deliver');

// Build a flat row-oriented body that the Apps Script can append directly.
function buildBody(payload, sink) {
  const c = payload.counts || {};
  const body = {
    time: payload.time || '',
    project: payload.project || '',
    projectName: payload.projectName || '',
    version: payload.version || '',
    platform: payload.platform || '',
    counts: {
      error: Number(c.error) || 0,
      warn: Number(c.warn) || 0,
      log: Number(c.log) || 0,
    },
    title: payload.title || '',
    url: payload.url || '',
  };
  if (sink.secret) body.secret = String(sink.secret);
  return body;
}

// Send the payload to the Apps Script web app. Returns a deliver() result.
async function send(sink, payload) {
  if (!sink.url) return { ok: false, attempts: 0, error: 'googlesheet sink missing url' };

  return deliver(
    {
      url: sink.url,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildBody(payload, sink)),
    },
    { retries: sink.retries, timeoutMs: sink.timeoutMs },
  );
}

module.exports = {
  send,
  buildBody,
};
