'use strict';

// Multiple screenshots per log: the `screenshotsPng` array (plus the legacy
// single `screenshotPng`), stored + served at /<id>/screenshot[/<n>].

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { setup, makeIngestBody, req } = require('./helpers');

const ctx = setup();
const VIEWER = 'viewer-test-token';

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');

async function ingest(overrides) {
  const r = await req(ctx.baseUrl, '/api/logs', { method: 'POST', body: makeIngestBody(overrides) });
  return r;
}

before(async () => {
  await ctx.ready;
  ctx.addApp({ appId: 'testapp', name: 'Test App' });
});
after(() => ctx.close());

test('array of screenshots is stored and exposed (count + urls + each served)', async () => {
  const ing = await ingest({ screenshotsPng: [b64('shot-A'), b64('shot-B'), b64('shot-C')] });
  assert.equal(ing.status, 201);
  const id = ing.body.id;

  const meta = await req(ctx.baseUrl, '/api/logs/' + id);
  assert.equal(meta.body.hasScreenshot, true);
  assert.equal(meta.body.screenshotCount, 3);
  assert.equal(meta.body.screenshots.length, 3);

  const s0 = await req(ctx.baseUrl, '/' + id + '/screenshot');
  assert.equal(s0.status, 200);
  assert.match(String(s0.headers['content-type'] || ''), /image\/png/);
  assert.equal(s0.body, 'shot-A');

  const s1 = await req(ctx.baseUrl, '/' + id + '/screenshot/1');
  assert.equal(s1.status, 200);
  assert.equal(s1.body, 'shot-B');

  const s2 = await req(ctx.baseUrl, '/' + id + '/screenshot/2');
  assert.equal(s2.status, 200);
  assert.equal(s2.body, 'shot-C');

  const s3 = await req(ctx.baseUrl, '/' + id + '/screenshot/3');
  assert.equal(s3.status, 404);
});

test('legacy single screenshotPng still works (count 1, no index 1)', async () => {
  const ing = await ingest({ screenshotPng: b64('only-one') });
  assert.equal(ing.status, 201);
  const id = ing.body.id;
  const meta = await req(ctx.baseUrl, '/api/logs/' + id);
  assert.equal(meta.body.screenshotCount, 1);
  assert.equal(meta.body.hasScreenshot, true);
  assert.equal((await req(ctx.baseUrl, '/' + id + '/screenshot')).status, 200);
  assert.equal((await req(ctx.baseUrl, '/' + id + '/screenshot/1')).status, 404);
});

test('array + legacy single combine (array first, then the single)', async () => {
  const ing = await ingest({ screenshotsPng: [b64('arr-0'), b64('arr-1')], screenshotPng: b64('single') });
  const id = ing.body.id;
  const meta = await req(ctx.baseUrl, '/api/logs/' + id);
  assert.equal(meta.body.screenshotCount, 3);
  assert.equal((await req(ctx.baseUrl, '/' + id + '/screenshot/2')).body, 'single');
});

test('no screenshots -> count 0, hasScreenshot false, 404 on the blob', async () => {
  const ing = await ingest({});
  const id = ing.body.id;
  const meta = await req(ctx.baseUrl, '/api/logs/' + id);
  assert.equal(meta.body.screenshotCount, 0);
  assert.equal(meta.body.hasScreenshot, false);
  assert.deepEqual(meta.body.screenshots, []);
  assert.equal((await req(ctx.baseUrl, '/' + id + '/screenshot')).status, 404);
});

test('count is capped at MAX_SCREENSHOTS (8)', async () => {
  const many = [];
  for (let i = 0; i < 12; i++) many.push(b64('shot-' + i));
  const ing = await ingest({ screenshotsPng: many });
  const id = ing.body.id;
  const meta = await req(ctx.baseUrl, '/api/logs/' + id);
  assert.equal(meta.body.screenshotCount, 8);
  assert.equal((await req(ctx.baseUrl, '/' + id + '/screenshot/7')).status, 200);
  assert.equal((await req(ctx.baseUrl, '/' + id + '/screenshot/8')).status, 404);
});

test('oversized screenshot -> 413', async () => {
  // 'A'*3MB is valid base64 and decodes to ~2.25 MB, over the 2 MB cap.
  const big = 'A'.repeat(3 * 1024 * 1024);
  const ing = await ingest({ screenshotsPng: [big] });
  assert.equal(ing.status, 413);
});

test('non-string legacy screenshotPng -> 400', async () => {
  const ing = await ingest({ screenshotPng: 123 });
  assert.equal(ing.status, 400);
});
