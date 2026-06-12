'use strict';

// Sink dispatcher: forward successful ingests to configured destinations.
//
// On a successful ingest the route layer calls dispatch(app, logMeta). We:
//   1. collect the effective sink list = global sinks (config/sinks.json) plus
//      the app's own sinks (apps.sinks_json), with per-app sinks appended;
//   2. build the forwarding payload (CONTRACT section 5);
//   3. for each enabled sink whose filter matches, send asynchronously with
//      retries; errors are logged, never thrown, and never block the ingest
//      response (dispatch returns immediately, work continues in the background).
//
// The global config file is read once and cached; reloadSinksConfig() clears the
// cache (used by tools/tests).

const fs = require('node:fs');
const path = require('node:path');
const config = require('../config');
const { passesFilter } = require('./filter');

// Sink type registry: type string -> module with send(sink, payload).
const handlers = {
  webhook: require('./webhook'),
  slack: require('./slack'),
  discord: require('./discord'),
  confluence: require('./confluence'),
  googlesheet: require('./googlesheet'),
};

// Absolute path to the global sinks config (overridable via SINKS_CONFIG env).
const GLOBAL_SINKS_PATH = process.env.SINKS_CONFIG
  ? path.resolve(process.env.SINKS_CONFIG)
  : path.join(config.serverRoot, 'config', 'sinks.json');

let globalSinksCache = null; // null = not loaded yet; array once loaded.

// Default logger: a small wrapper around console with a stable prefix so sink
// activity is easy to grep in server logs. Callers may inject their own.
const defaultLogger = {
  info: (...a) => console.log('[sinks]', ...a),
  warn: (...a) => console.warn('[sinks]', ...a),
  error: (...a) => console.error('[sinks]', ...a),
};

// Read and parse a sinks JSON file. Returns an array (empty on missing/invalid),
// logging a warning on malformed content so misconfiguration is visible.
function readSinksFile(filePath, logger) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return []; // No global config is fine.
    logger.warn(`cannot read sinks config ${filePath}: ${err.message}`);
    return [];
  }
  return parseSinksJson(raw, filePath, logger);
}

// Parse a JSON string into a sink array. Accepts either a bare array or an
// object with a `sinks` array (so the file can carry comments/metadata fields).
function parseSinksJson(raw, label, logger) {
  if (!raw || !raw.trim()) return [];
  let data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    logger.warn(`invalid sinks JSON in ${label}: ${err.message}`);
    return [];
  }
  const list = Array.isArray(data) ? data : Array.isArray(data && data.sinks) ? data.sinks : null;
  if (!list) {
    logger.warn(`sinks config ${label} is neither an array nor { sinks: [...] }`);
    return [];
  }
  return list.filter((s) => s && typeof s === 'object');
}

// Load (and cache) the global sinks list.
function loadGlobalSinks(logger) {
  if (globalSinksCache === null) {
    globalSinksCache = readSinksFile(GLOBAL_SINKS_PATH, logger);
  }
  return globalSinksCache;
}

// Clear the cached global config (tools/tests call this after edits).
function reloadSinksConfig() {
  globalSinksCache = null;
}

// Parse an app's per-app sinks from its sinks_json column.
function loadAppSinks(app, logger) {
  if (!app || !app.sinks_json) return [];
  return parseSinksJson(app.sinks_json, `app:${app.app_id}.sinks_json`, logger);
}

// Build the CONTRACT section 5 forwarding payload from app row + log metadata.
//
// logMeta keys (from the ingest route):
//   { id, url?, version, platform, title?, counts:{error,warn,log}, time }
// `url` is derived from config.baseUrl + id when not supplied.
function buildPayload(app, logMeta) {
  const counts = logMeta.counts || {};
  const url = logMeta.url || `${config.baseUrl}/${logMeta.id}`;
  return {
    project: app ? app.app_id : logMeta.project || '',
    projectName: app ? app.name : logMeta.projectName || '',
    version: logMeta.version || '',
    platform: logMeta.platform || '',
    url,
    title: logMeta.title || '',
    counts: {
      error: Number(counts.error) || 0,
      warn: Number(counts.warn) || 0,
      log: Number(counts.log) || 0,
    },
    time: logMeta.time || '',
  };
}

// True if a sink is enabled (default true when the field is absent).
function isEnabled(sink) {
  return sink.enabled !== false && sink.enabled !== 0;
}

// A short, human-friendly label for a sink (for log lines).
function sinkLabel(sink, idx) {
  return sink.name ? `${sink.type}:${sink.name}` : `${sink.type}#${idx}`;
}

// Send to a single sink with filtering and error capture. Resolves to a small
// result record; never rejects.
async function sendToSink(sink, payload, logger, idx) {
  const label = sinkLabel(sink, idx);

  const handler = handlers[sink.type];
  if (!handler) {
    logger.warn(`unknown sink type "${sink.type}" (${label}), skipping`);
    return { label, ok: false, skipped: true, error: 'unknown sink type' };
  }

  if (!isEnabled(sink)) {
    return { label, ok: false, skipped: true, error: 'disabled' };
  }

  if (!passesFilter(sink.filter, payload)) {
    return { label, ok: false, skipped: true, error: 'filtered out' };
  }

  try {
    const res = await handler.send(sink, payload);
    if (res && res.ok) {
      logger.info(`${label} -> ok (${res.attempts} attempt(s))`);
    } else {
      const detail = (res && res.error) || 'unknown error';
      logger.error(`${label} -> failed: ${detail}`);
    }
    return { label, ...(res || { ok: false, error: 'no result' }) };
  } catch (err) {
    // Defensive: a handler should never throw, but if it does, swallow it.
    logger.error(`${label} -> threw: ${(err && err.message) || err}`);
    return { label, ok: false, error: (err && err.message) || String(err) };
  }
}

// Dispatch forwarding for one successful ingest.
//
// Fire-and-forget by default: returns a Promise (so tests/tools can await), but
// the route layer is expected NOT to await it so the ingest response is not
// delayed. All errors are contained.
//
// opts.logger may override the default logger.
function dispatch(app, logMeta, opts = {}) {
  const logger = opts.logger || defaultLogger;

  let sinks;
  try {
    const global = loadGlobalSinks(logger);
    const appSinks = loadAppSinks(app, logger);
    sinks = [...global, ...appSinks];
  } catch (err) {
    logger.error(`failed to assemble sink list: ${(err && err.message) || err}`);
    return Promise.resolve([]);
  }

  if (sinks.length === 0) return Promise.resolve([]);

  let payload;
  try {
    payload = buildPayload(app, logMeta);
  } catch (err) {
    logger.error(`failed to build payload: ${(err && err.message) || err}`);
    return Promise.resolve([]);
  }

  // Launch every sink concurrently; each contains its own errors.
  const jobs = sinks.map((sink, idx) => sendToSink(sink, payload, logger, idx));
  return Promise.allSettled(jobs).then((settled) =>
    settled.map((s) => (s.status === 'fulfilled' ? s.value : { ok: false, error: 'settled rejected' })),
  );
}

module.exports = {
  dispatch,
  buildPayload,
  reloadSinksConfig,
  loadGlobalSinks,
  loadAppSinks,
  handlers,
  GLOBAL_SINKS_PATH,
};
