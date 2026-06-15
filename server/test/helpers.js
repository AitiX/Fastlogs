'use strict';

// Test helpers: spin up the server on a random port with isolated tmp dirs.
//
// IMPORTANT: This file must be required BEFORE any server src modules are
// required in the test file. It sets process.env overrides; since CommonJS
// modules are cached globally, config.js reads env only once, so the env must
// be set before the first require of any server module.
//
// Each *.test.js should call setup() once to get { baseUrl, addApp, close }.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

// Build a minimal valid ingest body for tests.
function makeIngestBody(overrides = {}) {
  return Object.assign({
    appId: 'testapp',
    platform: 'WebGL',
    appVersion: '1.0.0',
    timestampUtc: new Date().toISOString(),
    counts: { error: 0, warn: 0, log: 1 },
    logText: 'test log line',
    logEncoding: 'plain',
    device: { system: { os: 'Windows' } },
  }, overrides);
}

// Perform an HTTP request. Returns { status, headers, body }.
// body is parsed JSON when Content-Type is application/json, otherwise string.
function req(baseUrl, urlPath, opts = {}) {
  const full = baseUrl + urlPath;
  return new Promise((resolve, reject) => {
    const method = opts.method || 'GET';
    let bodyStr;
    if (opts.body !== undefined) {
      bodyStr = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);
    }
    const headers = Object.assign({}, opts.headers);
    if (bodyStr !== undefined && !headers['content-type']) {
      headers['content-type'] = 'application/json';
    }
    if (bodyStr !== undefined) {
      headers['content-length'] = Buffer.byteLength(bodyStr);
    }

    const u = new URL(full);
    const options = {
      hostname: u.hostname,
      port: Number(u.port),
      path: u.pathname + u.search,
      method,
      headers,
    };

    const r = http.request(options, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let body;
        const ct = (res.headers['content-type'] || '');
        if (ct.includes('application/json')) {
          try { body = JSON.parse(raw); } catch { body = raw; }
        } else {
          body = raw;
        }
        resolve({ status: res.statusCode, headers: res.headers, body });
      });
    });
    r.on('error', reject);
    if (bodyStr !== undefined) r.write(bodyStr);
    r.end();
  });
}

// Set up isolated environment and start the server.
// Call ONCE at the beginning of a test file; call close() in after().
function setup() {
  const suffix = crypto.randomBytes(6).toString('hex');
  const tmpBase = path.join(os.tmpdir(), `fastlogs-test-${suffix}`);
  const dataDir = path.join(tmpBase, 'data');
  const blobDir = path.join(tmpBase, 'blobs');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(blobDir, { recursive: true });

  // Set env overrides BEFORE requiring any server module.
  process.env.DATA_DIR = dataDir;
  process.env.BLOB_DIR = blobDir;
  process.env.PORT = '0'; // OS-assigned free port.
  process.env.ADMIN_TOKEN = 'admin-test-token';
  process.env.VIEWER_TOKEN = 'viewer-test-token';
  process.env.BASE_URL = 'http://testhost';
  process.env.CORS_ALLOW_ORIGIN = '*';
  process.env.IP_SALT = 'test-salt';
  // Disable the disk-usage monitor in tests: with the default cadence its
  // startup pass would statfs the volume, walk blobs/, and could POST to a
  // webhook. 0 makes diskMonitor.start() a no-op, keeping tests hermetic.
  process.env.DISK_MONITOR_INTERVAL_SEC = '0';

  // Require server modules (they read config once from env).
  const { server, start } = require('../src/index');
  const db = require('../src/db');
  const { sha256 } = require('../src/auth');
  const { nowUtcIso } = require('../src/util/http');

  // Start the server and resolve once it is listening.
  const ready = start();

  // Compute baseUrl after listening (need the port).
  let baseUrl;
  const afterStart = ready.then((srv) => {
    const addr = srv.address();
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  // addApp: register a test app. Call AFTER awaiting ctx.ready.
  function addApp({ appId = 'testapp', name = 'Test App', token = null, enabled = 1,
                    retentionDays = 30, maxRetentionDays = 365 } = {}) {
    db.upsertApp({
      app_id: appId,
      name,
      token_hash: token ? sha256(token) : null,
      retention_days: retentionDays,
      max_retention_days: maxRetentionDays,
      sinks_json: null,
      enabled,
      created_at: nowUtcIso(),
    });
  }

  function close() {
    return new Promise((resolve) => {
      server.close(() => {
        try { fs.rmSync(tmpBase, { recursive: true, force: true }); } catch {}
        resolve();
      });
    });
  }

  // Proxy baseUrl access through a getter so tests read it after start.
  const ctx = {
    ready: afterStart,
    get baseUrl() { return baseUrl; },
    db,
    addApp,
    close,
  };
  return ctx;
}

module.exports = { setup, makeIngestBody, req };
