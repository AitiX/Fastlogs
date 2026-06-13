'use strict';

// Redmine integration DISABLED (no REDMINE_* config): the endpoint returns 503
// and meta reports redmineEnabled:false. Own child process so env is clean.

delete process.env.REDMINE_URL;
delete process.env.REDMINE_API_KEY;

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { setup, makeIngestBody, req } = require('./helpers');

const ctx = setup();
const VIEWER = 'viewer-test-token';

let id;
before(async () => {
  await ctx.ready;
  ctx.addApp({ appId: 'testapp', name: 'Test App' });
  const ing = await req(ctx.baseUrl, '/api/logs', { method: 'POST', body: makeIngestBody({}) });
  assert.equal(ing.status, 201);
  id = ing.body.id;
});
after(() => ctx.close());

test('redmine endpoint returns 503 when not configured (even with a token)', async () => {
  const r = await req(ctx.baseUrl, '/api/logs/' + id + '/redmine', {
    method: 'POST', body: {}, headers: { authorization: 'Bearer ' + VIEWER },
  });
  assert.equal(r.status, 503);
  assert.equal(r.body.error, 'redmine_disabled');
});

test('meta reports redmineEnabled:false and no linked issue', async () => {
  const r = await req(ctx.baseUrl, '/api/logs/' + id);
  assert.equal(r.body.redmineEnabled, false);
  assert.equal(r.body.redmineIssue, null);
});
