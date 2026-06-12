'use strict';

// Discord sink (Incoming Webhook).
//
// Posts an embed to a Discord channel webhook URL. Discord webhooks accept a
// JSON body with `content` and/or `embeds`. We send a single rich embed with the
// project, version, platform, counts and a clickable title linking to the log.
//
// Sink config fields:
//   - type: "discord"             (required)
//   - url:  "https://discord.com/api/webhooks/..."  (required)
//   - username, avatarUrl         (optional cosmetic overrides)
//   - mentionOnError: "@here"     (optional content prefix when counts.error > 0)
//   - retries, timeoutMs          (optional)

const { deliver } = require('./deliver');

// Pick an embed colour by severity (Discord uses a decimal RGB int).
function colorFor(error, warn) {
  if (error > 0) return 0xe01e5a; // red-ish
  if (warn > 0) return 0xecb22e; // amber
  return 0x2eb67d; // green
}

// Build the Discord webhook JSON body.
function buildBody(payload, sink) {
  const c = payload.counts || {};
  const error = Number(c.error) || 0;
  const warn = Number(c.warn) || 0;
  const log = Number(c.log) || 0;

  const name = payload.projectName || payload.project || 'unknown';
  const embed = {
    title: payload.title || `${name} ${payload.version || ''}`.trim(),
    url: payload.url || undefined,
    color: colorFor(error, warn),
    fields: [
      { name: 'Project', value: String(name), inline: true },
      { name: 'Version', value: String(payload.version || '-'), inline: true },
      { name: 'Platform', value: String(payload.platform || '-'), inline: true },
      { name: 'Errors', value: String(error), inline: true },
      { name: 'Warnings', value: String(warn), inline: true },
      { name: 'Logs', value: String(log), inline: true },
    ],
  };
  if (payload.time) embed.timestamp = payload.time;

  const body = { embeds: [embed] };
  if (sink.username) body.username = sink.username;
  if (sink.avatarUrl) body.avatar_url = sink.avatarUrl;
  if (error > 0 && sink.mentionOnError) body.content = String(sink.mentionOnError);

  return body;
}

// Send the payload to a Discord webhook. Returns a deliver() result.
async function send(sink, payload) {
  if (!sink.url) return { ok: false, attempts: 0, error: 'discord sink missing url' };

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
