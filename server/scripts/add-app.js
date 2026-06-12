'use strict';

// CLI: register (or update) an app and mint its ingest token.
//
// Generates a strong random ingest token, prints it ONCE (it is never
// recoverable later - only its sha256 hash is stored), and writes the app row.
//
// Usage:
//   node scripts/add-app.js <appId> "<name>" [retentionDays] [options]
//   npm run add-app -- <appId> "<name>" [retentionDays]
//
// Arguments:
//   appId          required, [a-z0-9_-]{2,32} (= Project in the catalog)
//   name           required, human-readable display name
//   retentionDays  optional, default = config.defaultRetentionDays (clamped to maxRetentionDays)
//
// Options:
//   --max-retention N   per-app retention ceiling (default = config.maxRetentionDays)
//   --no-token          open ingest for this app (no token required)
//   --keep-token        when updating an existing app, keep its current token
//   --disabled          register the app as disabled (enabled=0)
//   --token <value>     use a specific token instead of a generated one (still hashed)
//
// Re-running for an existing appId UPDATES it. By default a new token is minted
// (the old one stops working); pass --keep-token to preserve the existing hash.

const db = require('../src/db');
const config = require('../src/config');
const { sha256 } = require('../src/auth');
const { randomBase62 } = require('../src/id');
const { nowUtcIso } = require('../src/util/http');

const APP_ID_RE = /^[a-z0-9_-]{2,32}$/;
const TOKEN_LENGTH = 40; // base62, ~238 bits of entropy.

// Parse positional args + flags. Returns a structured options object or exits.
function parseArgs(argv) {
  const positionals = [];
  const opts = {
    maxRetention: null,
    noToken: false,
    keepToken: false,
    disabled: false,
    token: null,
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--no-token': opts.noToken = true; break;
      case '--keep-token': opts.keepToken = true; break;
      case '--disabled': opts.disabled = true; break;
      case '--max-retention': opts.maxRetention = Number.parseInt(argv[++i], 10); break;
      case '--token': opts.token = argv[++i]; break;
      default:
        if (a.startsWith('--')) fail(`Unknown option: ${a}`);
        positionals.push(a);
    }
  }

  opts.appId = positionals[0];
  opts.name = positionals[1];
  opts.retentionDays = positionals[2] !== undefined ? Number.parseInt(positionals[2], 10) : null;
  return opts;
}

// Print an error + usage hint and exit non-zero.
function fail(msg) {
  console.error(`Error: ${msg}`);
  console.error('Usage: node scripts/add-app.js <appId> "<name>" [retentionDays] [--no-token|--keep-token|--disabled|--max-retention N|--token V]');
  process.exit(2);
}

// Clamp a retention value into [1, max].
function clampRetention(days, max) {
  return Math.min(Math.max(1, days), max);
}

function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (!opts.appId) fail('appId is required');
  if (!APP_ID_RE.test(opts.appId)) fail(`appId "${opts.appId}" must match [a-z0-9_-]{2,32}`);
  if (!opts.name || !opts.name.trim()) fail('name is required');

  const existing = db.getApp(opts.appId);

  // Resolve max retention: explicit flag > existing value > config default.
  const maxRetention =
    Number.isFinite(opts.maxRetention) && opts.maxRetention > 0
      ? opts.maxRetention
      : existing
        ? existing.max_retention_days
        : config.maxRetentionDays;

  // Resolve retention: explicit arg > existing value > config default, clamped.
  let retentionDays =
    Number.isFinite(opts.retentionDays) && opts.retentionDays !== null
      ? opts.retentionDays
      : existing
        ? existing.retention_days
        : config.defaultRetentionDays;
  retentionDays = clampRetention(retentionDays, maxRetention);

  // Decide the token / token_hash.
  let plainToken = null; // printed only when we mint or are given one
  let tokenHash;
  if (opts.noToken) {
    tokenHash = null; // open ingest
  } else if (opts.keepToken && existing) {
    tokenHash = existing.token_hash; // preserve
  } else {
    plainToken = opts.token && opts.token.trim() ? opts.token.trim() : randomBase62(TOKEN_LENGTH);
    tokenHash = sha256(plainToken);
  }

  const row = {
    app_id: opts.appId,
    name: opts.name.trim(),
    token_hash: tokenHash,
    retention_days: retentionDays,
    max_retention_days: maxRetention,
    // Preserve existing per-app sinks on update; null for a fresh app.
    sinks_json: existing ? existing.sinks_json : null,
    enabled: opts.disabled ? 0 : existing ? existing.enabled : 1,
    created_at: existing ? existing.created_at : nowUtcIso(),
  };

  db.upsertApp(row);

  // Report.
  const action = existing ? 'updated' : 'registered';
  console.log(`App ${action}: ${row.app_id} ("${row.name}")`);
  console.log(`  retentionDays   : ${row.retention_days}`);
  console.log(`  maxRetentionDays: ${row.max_retention_days}`);
  console.log(`  enabled         : ${row.enabled === 1}`);

  if (opts.noToken) {
    console.log('  ingest token    : (none - open ingest for this app)');
  } else if (plainToken) {
    console.log('');
    console.log('  INGEST TOKEN (shown once, store it now - only its hash is kept):');
    console.log(`    ${plainToken}`);
    console.log('');
    console.log('  Clients send it as:  Authorization: Bearer <token>');
  } else {
    console.log('  ingest token    : (unchanged)');
  }
}

try {
  main();
  process.exit(0);
} catch (err) {
  console.error('add-app failed:', (err && err.message) || err);
  process.exit(1);
}
