'use strict';

// Self-hosted web fonts (ФИЧА 4): the viewer and catalog link /fonts.css, which
// requests the woff2 files under /fonts/<name>.woff2. These are served by the
// static module through an explicit allowlist (src/routes/static.js, wired in
// src/index.js). This suite locks:
//   - /fonts.css is served as text/css and declares the expected @font-face's;
//   - each allowlisted woff2 is served as font/woff2 with valid woff2 bytes;
//   - unknown font names and traversal attempts get the uniform 404 (no escape
//     out of public/fonts/).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { setup } = require('./helpers');

const ctx = setup();

// Raw GET that preserves the response body as a Buffer (the shared req() helper
// stringifies bodies, which would corrupt binary woff2 bytes). Returns
// { status, headers, buf }.
function getRaw(baseUrl, urlPath) {
  const u = new URL(baseUrl + urlPath);
  return new Promise((resolve, reject) => {
    const r = http.request(
      { hostname: u.hostname, port: Number(u.port), path: u.pathname + u.search, method: 'GET' },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({
          status: res.statusCode,
          headers: res.headers,
          buf: Buffer.concat(chunks),
        }));
      },
    );
    r.on('error', reject);
    r.end();
  });
}

// woff2 files begin with the signature "wOF2" (0x77 0x4F 0x46 0x32).
function isWoff2(buf) {
  return buf.length > 4 && buf.toString('latin1', 0, 4) === 'wOF2';
}

const FONT_FILES = [
  'atkinson-hyperlegible-regular.woff2',
  'atkinson-hyperlegible-bold.woff2',
  'jetbrains-mono-regular.woff2',
  'jetbrains-mono-bold.woff2',
];

before(async () => {
  await ctx.ready;
});
after(() => ctx.close());

test('GET /fonts.css is served as text/css and declares the font families', async () => {
  const r = await getRaw(ctx.baseUrl, '/fonts.css');
  assert.equal(r.status, 200);
  assert.match(String(r.headers['content-type'] || ''), /text\/css/);
  const css = r.buf.toString('utf8');
  assert.match(css, /@font-face/);
  assert.match(css, /Atkinson Hyperlegible/);
  assert.match(css, /JetBrains Mono/);
  // Every @font-face url must point at an allowlisted woff2 under /fonts/.
  for (const f of FONT_FILES) {
    assert.ok(css.includes('/fonts/' + f), `fonts.css must reference /fonts/${f}`);
  }
});

test('each allowlisted woff2 is served as font/woff2 with valid bytes', async () => {
  for (const f of FONT_FILES) {
    const r = await getRaw(ctx.baseUrl, '/fonts/' + f);
    assert.equal(r.status, 200, `${f} should be 200`);
    assert.equal(String(r.headers['content-type'] || ''), 'font/woff2', `${f} content-type`);
    assert.ok(isWoff2(r.buf), `${f} must be a real woff2 (wOF2 signature)`);
    assert.ok(r.buf.length > 1000, `${f} should be a plausible font size, got ${r.buf.length}`);
  }
});

test('unknown font name returns the uniform 404', async () => {
  const r = await getRaw(ctx.baseUrl, '/fonts/does-not-exist.woff2');
  assert.equal(r.status, 404);
});

test('traversal attempts cannot escape public/fonts/', async () => {
  // Encoded "../viewer.js" and similar must not resolve to a real file: the
  // closed filename whitelist rejects anything not literally in the font set.
  const attempts = [
    '/fonts/..%2fviewer.js',
    '/fonts/%2e%2e%2f%2e%2e%2fpackage.json',
    '/fonts/atkinson-hyperlegible-regular.woff2.bak',
  ];
  for (const p of attempts) {
    const r = await getRaw(ctx.baseUrl, p);
    assert.equal(r.status, 404, `${p} must 404`);
  }
});
