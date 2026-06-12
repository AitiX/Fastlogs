'use strict';

// Slack sink (Incoming Webhook).
//
// Posts a compact message to a Slack incoming webhook URL. Slack expects a JSON
// body with a `text` field (and optionally Block Kit `blocks`); we build a
// readable one-line summary plus a context line and let Slack unfurl the link.
//
// Sink config fields:
//   - type: "slack"               (required)
//   - url:  "https://hooks.slack.com/services/..."  (required)
//   - username, iconEmoji         (optional cosmetic overrides)
//   - mentionOnError: "<!here>"   (optional; prepended when counts.error > 0)
//   - retries, timeoutMs          (optional)

const { deliver } = require('./deliver');

// Compose the Slack message text from the forwarding payload.
function buildText(payload, sink) {
  const c = payload.counts || {};
  const error = Number(c.error) || 0;
  const warn = Number(c.warn) || 0;
  const log = Number(c.log) || 0;

  const name = payload.projectName || payload.project || 'unknown';
  const title = payload.title ? `: ${payload.title}` : '';
  const counts = `E:${error} W:${warn} L:${log}`;

  let prefix = '';
  if (error > 0 && sink.mentionOnError) prefix = `${sink.mentionOnError} `;

  // <url|label> is Slack's link syntax.
  const link = payload.url ? `<${payload.url}|open log>` : '';
  return `${prefix}*${name}* ${payload.version || ''} [${payload.platform || '?'}] ${counts}${title} ${link}`.trim();
}

// Send the payload to a Slack incoming webhook. Returns a deliver() result.
async function send(sink, payload) {
  if (!sink.url) return { ok: false, attempts: 0, error: 'slack sink missing url' };

  const body = { text: buildText(payload, sink) };
  if (sink.username) body.username = sink.username;
  if (sink.iconEmoji) body.icon_emoji = sink.iconEmoji;

  return deliver(
    {
      url: sink.url,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
    { retries: sink.retries, timeoutMs: sink.timeoutMs },
  );
}

module.exports = {
  send,
  buildText,
};
