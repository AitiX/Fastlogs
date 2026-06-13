'use strict';

// Redmine "create issue from log" integration, ENABLED, against a local mock
// Redmine (never the real network). The mock must be listening and REDMINE_*
// env set BEFORE the server config is required, so we start it and call
// setup() inside before() rather than at module top level.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { setup, makeIngestBody, req } = require('./helpers');

const VIEWER = 'viewer-test-token';

let ctx;
let mock;
let mockCalls = 0;
let lastIssue = null;
let mockMode = 'ok'; // 'ok' | '422' | 'slow'

async function ingest(overrides) {
  const r = await req(ctx.baseUrl, '/api/logs', { method: 'POST', body: makeIngestBody(overrides) });
  assert.equal(r.status, 201, `ingest failed: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.id;
}

before(async () => {
  mock = http.createServer((mreq, mres) => {
    let data = '';
    mreq.on('data', (c) => { data += c; });
    mreq.on('end', () => {
      mockCalls++;
      lastIssue = { headers: mreq.headers, body: data ? JSON.parse(data) : null, url: mreq.url };
      if (mockMode === '422') {
        mres.writeHead(422, { 'content-type': 'application/json' });
        mres.end(JSON.stringify({ errors: ['Subject cannot be blank'] }));
        return;
      }
      if (mockMode === 'slow') {
        setTimeout(() => {
          mres.writeHead(201, { 'content-type': 'application/json' });
          mres.end(JSON.stringify({ issue: { id: 999 } }));
        }, 400);
        return;
      }
      if (mockMode === 'bad-201') {
        // 201 but a non-JSON body (e.g. a proxy/WAF in front of Redmine).
        mres.writeHead(201, { 'content-type': 'text/html' });
        mres.end('<html>created</html>');
        return;
      }
      if (mockMode === 'delayok') {
        // Succeeds, but slowly enough (within the timeout) to overlap a second
        // concurrent request.
        setTimeout(() => {
          mres.writeHead(201, { 'content-type': 'application/json' });
          mres.end(JSON.stringify({ issue: { id: 777 } }));
        }, 40);
        return;
      }
      mres.writeHead(201, { 'content-type': 'application/json' });
      mres.end(JSON.stringify({ issue: { id: 123 } }));
    });
  });
  await new Promise((r) => mock.listen(0, '127.0.0.1', r));
  const port = mock.address().port;

  // Set Redmine env BEFORE setup() requires config.
  process.env.REDMINE_URL = 'http://127.0.0.1:' + port;
  process.env.REDMINE_API_KEY = 'test-key';
  process.env.REDMINE_PROJECT_ID = 'pj';
  process.env.REDMINE_TRACKER_ID = '5';
  process.env.REDMINE_TIMEOUT_MS = '150';

  ctx = setup();
  await ctx.ready;
  ctx.addApp({ appId: 'testapp', name: 'Test App' });
});

after(async () => {
  await ctx.close();
  await new Promise((r) => mock.close(r));
});

test('happy path: creates an issue, links it, sends the right payload', async () => {
  mockMode = 'ok';
  const id = await ingest({ title: 'crash on boot', comment: 'repro: tap play' });
  const before = mockCalls;
  const r = await req(ctx.baseUrl, '/api/logs/' + id + '/redmine', {
    method: 'POST', body: {}, headers: { authorization: 'Bearer ' + VIEWER },
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.created, true);
  assert.match(String(r.body.issueUrl), /\/issues\/123$/);
  assert.equal(mockCalls, before + 1);
  assert.equal(lastIssue.headers['x-redmine-api-key'], 'test-key');
  assert.equal(lastIssue.body.issue.project_id, 'pj');
  assert.equal(lastIssue.body.issue.tracker_id, 5);
  assert.match(lastIssue.body.issue.subject, /crash on boot/);
  assert.match(lastIssue.body.issue.description, /\/[A-Za-z0-9]+$/m); // contains the log link
});

test('idempotent: second call returns the existing issue without re-creating', async () => {
  mockMode = 'ok';
  const id = await ingest({ title: 'dup' });
  const first = await req(ctx.baseUrl, '/api/logs/' + id + '/redmine', { method: 'POST', body: {}, headers: { authorization: 'Bearer ' + VIEWER } });
  assert.equal(first.body.created, true);
  const before = mockCalls;
  const second = await req(ctx.baseUrl, '/api/logs/' + id + '/redmine', { method: 'POST', body: {}, headers: { authorization: 'Bearer ' + VIEWER } });
  assert.equal(second.status, 200);
  assert.equal(second.body.created, false);
  assert.equal(mockCalls, before, 'no second Redmine call');
});

test('auth: no token -> 401, no Redmine call', async () => {
  const id = await ingest({ title: 'noauth' });
  const before = mockCalls;
  const r = await req(ctx.baseUrl, '/api/logs/' + id + '/redmine', { method: 'POST', body: {} });
  assert.equal(r.status, 401);
  assert.equal(mockCalls, before);
});

test('Redmine 422 -> 502 redmine_error, log stays unlinked', async () => {
  mockMode = '422';
  const id = await ingest({ title: 'bad' });
  const r = await req(ctx.baseUrl, '/api/logs/' + id + '/redmine', { method: 'POST', body: {}, headers: { authorization: 'Bearer ' + VIEWER } });
  assert.equal(r.status, 502);
  assert.equal(r.body.error, 'redmine_error');
  const meta = await req(ctx.baseUrl, '/api/logs/' + id);
  assert.equal(meta.body.redmineIssue, null);
  mockMode = 'ok';
});

test('timeout -> 504 redmine_unreachable, log stays unlinked', async () => {
  mockMode = 'slow';
  const id = await ingest({ title: 'slow' });
  const r = await req(ctx.baseUrl, '/api/logs/' + id + '/redmine', { method: 'POST', body: {}, headers: { authorization: 'Bearer ' + VIEWER } });
  assert.equal(r.status, 504);
  assert.equal(r.body.error, 'redmine_unreachable');
  const meta = await req(ctx.baseUrl, '/api/logs/' + id);
  assert.equal(meta.body.redmineIssue, null);
  mockMode = 'ok';
});

test('201 without a parseable issue id -> 502, log stays unlinked', async () => {
  mockMode = 'bad-201';
  const id = await ingest({ title: 'bad201' });
  const r = await req(ctx.baseUrl, '/api/logs/' + id + '/redmine', { method: 'POST', body: {}, headers: { authorization: 'Bearer ' + VIEWER } });
  assert.equal(r.status, 502);
  assert.equal(r.body.error, 'redmine_error');
  const meta = await req(ctx.baseUrl, '/api/logs/' + id);
  assert.equal(meta.body.redmineIssue, null);
  mockMode = 'ok';
});

test('concurrent creates coalesce into a single Redmine issue', async () => {
  mockMode = 'delayok';
  const id = await ingest({ title: 'race' });
  const before = mockCalls;
  const url = '/api/logs/' + id + '/redmine';
  const opts = { method: 'POST', body: {}, headers: { authorization: 'Bearer ' + VIEWER } };
  const [a, b] = await Promise.all([req(ctx.baseUrl, url, opts), req(ctx.baseUrl, url, opts)]);
  assert.equal(mockCalls, before + 1, 'exactly one Redmine call for two concurrent requests');
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  const created = [a.body.created, b.body.created];
  assert.ok(created.includes(true) && created.includes(false), 'one created:true, one coalesced created:false');
  mockMode = 'ok';
});

test('meta exposes redmineEnabled and the linked issue', async () => {
  mockMode = 'ok';
  const id = await ingest({ title: 'meta' });
  await req(ctx.baseUrl, '/api/logs/' + id + '/redmine', { method: 'POST', body: {}, headers: { authorization: 'Bearer ' + VIEWER } });
  const meta = await req(ctx.baseUrl, '/api/logs/' + id);
  assert.equal(meta.body.redmineEnabled, true);
  assert.ok(meta.body.redmineIssue);
  assert.equal(String(meta.body.redmineIssue.id), '123');
  assert.match(String(meta.body.redmineIssue.url), /\/issues\/123$/);
});
