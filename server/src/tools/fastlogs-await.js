'use strict';

// CLI: poll the FastLogs await endpoint for the most recent log carrying a
// given debug/await code, writing the current state to a JSON file each poll so
// another process can watch it. Exits 0 when found, 2 on timeout, 1 on error.
//
// No external dependencies: uses the built-in http/https + fs modules only.
//
// Usage:
//   node src/tools/fastlogs-await.js --app <id> --code <code> --token <viewerToken> \
//       --base <baseUrl> [--out <path>] [--interval <sec>] [--timeout <sec>]
//
// Arguments:
//   --app <id>          required, the appId to wait on
//   --code <code>       required, the debug/await code to look for (1..64 chars)
//   --token <token>     required, a viewer (or admin) token for /api/await
//   --base <baseUrl>    required, the FastLogs base URL (e.g. https://logs.example.com)
//   --out <path>        output state file (default: await-state.json)
//   --interval <sec>    poll interval in seconds (default: 3)
//   --timeout <sec>     overall timeout in seconds (default: 600)
//
// Output file shape (rewritten every poll):
//   { status: "waiting"|"found"|"timeout"|"error", code, app,
//     id, url, rawUrl, checkedAt(ISO), foundAt(ISO|null), error }

const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const { URL } = require('node:url');

// Parse the supported flags. Returns an options object or exits with usage.
function parseArgs(argv) {
  const opts = {
    app: null, code: null, token: null, base: null,
    out: 'await-state.json', interval: 3, timeout: 600,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--app': opts.app = argv[++i]; break;
      case '--code': opts.code = argv[++i]; break;
      case '--token': opts.token = argv[++i]; break;
      case '--base': opts.base = argv[++i]; break;
      case '--out': opts.out = argv[++i]; break;
      case '--interval': opts.interval = Number.parseFloat(argv[++i]); break;
      case '--timeout': opts.timeout = Number.parseFloat(argv[++i]); break;
      default:
        fail(`Unknown argument: ${a}`);
    }
  }
  if (!opts.app) fail('--app is required');
  if (!opts.code) fail('--code is required');
  if (!opts.token) fail('--token is required');
  if (!opts.base) fail('--base is required');
  if (!Number.isFinite(opts.interval) || opts.interval <= 0) opts.interval = 3;
  if (!Number.isFinite(opts.timeout) || opts.timeout <= 0) opts.timeout = 600;
  return opts;
}

function fail(msg) {
  console.error(`Error: ${msg}`);
  console.error('Usage: node src/tools/fastlogs-await.js --app <id> --code <code> --token <viewerToken> --base <baseUrl> [--out <path>] [--interval <sec>] [--timeout <sec>]');
  process.exit(1);
}

const nowIso = () => new Date().toISOString();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// One GET to the await endpoint. Resolves with the parsed JSON body, or rejects
// on a transport / non-2xx / parse error so the caller can record it.
function pollOnce(base, app, code, token) {
  const url = new URL(base.replace(/\/+$/, '') + '/api/await/' + encodeURIComponent(app));
  url.searchParams.set('code', code);
  url.searchParams.set('token', token);
  const client = url.protocol === 'https:' ? https : http;

  return new Promise((resolve, reject) => {
    const r = client.get(url, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error(`HTTP ${res.statusCode}: ${raw.slice(0, 200)}`));
        }
        try {
          resolve(JSON.parse(raw));
        } catch {
          reject(new Error('Invalid JSON response'));
        }
      });
    });
    r.on('error', reject);
  });
}

// Atomically write the state file (write temp + rename) so a watcher never
// reads a half-written file.
function writeState(outPath, state) {
  const tmp = outPath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, outPath);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const deadline = Date.now() + opts.timeout * 1000;

  // Base state, reused/updated each poll.
  const state = {
    status: 'waiting',
    code: opts.code,
    app: opts.app,
    id: null,
    url: null,
    rawUrl: null,
    checkedAt: null,
    foundAt: null,
    error: null,
  };

  console.log(`[await] app=${opts.app} code=${opts.code} interval=${opts.interval}s timeout=${opts.timeout}s -> ${opts.out}`);

  for (;;) {
    state.checkedAt = nowIso();
    let res;
    try {
      res = await pollOnce(opts.base, opts.app, opts.code, opts.token);
      state.error = null;
    } catch (err) {
      state.status = 'error';
      state.error = (err && err.message) || String(err);
      writeState(opts.out, state);
      console.error(`[await] error: ${state.error}`);
      return 1;
    }

    if (res && res.found) {
      state.status = 'found';
      state.id = res.id || null;
      state.url = res.url || null;
      state.rawUrl = res.rawUrl || null;
      state.foundAt = nowIso();
      writeState(opts.out, state);
      console.log(`[await] found id=${state.id} url=${state.url}`);
      return 0;
    }

    state.status = 'waiting';
    writeState(opts.out, state);
    console.log(`[await] waiting... (checked ${state.checkedAt})`);

    if (Date.now() + opts.interval * 1000 >= deadline) {
      state.status = 'timeout';
      state.checkedAt = nowIso();
      writeState(opts.out, state);
      console.error(`[await] timeout after ${opts.timeout}s (no log with code=${opts.code})`);
      return 2;
    }
    await sleep(opts.interval * 1000);
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error('fastlogs-await crashed:', (err && err.message) || err);
    process.exit(1);
  });
