'use strict';

// Router-ordering invariant: the standalone file routes (/files/:id and
// /files/:id/download) must be matched by the files handlers, NOT swallowed by
// the viewer catch-all "/:id" (or "/:id/raw"). This locks /files/... being
// registered before /:id, mirroring crashes-route-order.test.js.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { setup, req } = require('./helpers');

const ctx = setup();

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');

before(async () => {
  await ctx.ready;
  ctx.addApp({ appId: 'routeapp', name: 'Route App' });
});
after(() => ctx.close());

test('GET /files/:id hits the standalone file viewer, not the log viewer', async () => {
  const up = await req(ctx.baseUrl, '/api/files', {
    method: 'POST',
    body: {
      appId: 'routeapp', platform: 'Windows', appVersion: '1.0.0',
      name: 'route.bin', mime: 'text/plain', fileBase64: b64('route-bytes'),
    },
  });
  assert.equal(up.status, 201, JSON.stringify(up.body));
  const id = up.body.id;

  const v = await req(ctx.baseUrl, '/files/' + id);
  assert.equal(v.status, 200);
  assert.match(String(v.headers['content-type'] || ''), /text\/html/);
  // The file viewer shows the file name + a Download link; the log viewer would
  // inject the __FASTLOGS_DATA__ island instead.
  assert.match(v.body, /route\.bin/);
  assert.match(v.body, /\/files\/.+\/download/);
  assert.ok(!/__FASTLOGS_DATA__/.test(v.body), 'must NOT be the log viewer shell');

  const dl = await req(ctx.baseUrl, '/files/' + id + '/download');
  assert.equal(dl.status, 200);
  assert.equal(dl.body, 'route-bytes');
});

test('GET /files/<unknown-id> returns the uniform 404', async () => {
  const v = await req(ctx.baseUrl, '/files/Zzz999');
  assert.equal(v.status, 404);
});
