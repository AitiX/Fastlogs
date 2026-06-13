'use strict';

// Engine detection: device.application -> engine column, surfaced in the
// catalog (projects + per-log) and meta. Unity is inferred from an engine
// version; an explicit `engine` field (e.g. GameMaker) wins; key casing is
// ignored.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { setup, makeIngestBody, req } = require('./helpers');

const ctx = setup();
const VIEWER = 'viewer-test-token';

async function ingest(overrides) {
  const r = await req(ctx.baseUrl, '/api/logs', { method: 'POST', body: makeIngestBody(overrides) });
  assert.equal(r.status, 201, `ingest failed: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.id;
}

let unityId; let gmId; let bareId; let pascalId;
before(async () => {
  await ctx.ready;
  ctx.addApp({ appId: 'unityapp', name: 'Unity App' });
  ctx.addApp({ appId: 'gmapp', name: 'GameMaker App' });
  ctx.addApp({ appId: 'bareapp', name: 'Bare App' });

  unityId = await ingest({ appId: 'unityapp', platform: 'iOS', device: { application: { engineVersion: '2022.3.62f3' } } });
  gmId = await ingest({ appId: 'gmapp', platform: 'iOS', device: { application: { engine: 'GameMaker', engineVersion: '2024.8' } } });
  bareId = await ingest({ appId: 'bareapp', platform: 'iOS', device: { system: { os: 'iOS 17' } } });
  // Case-insensitive: PascalCase key as the Unity client may serialize it.
  pascalId = await ingest({ appId: 'unityapp', platform: 'Android', device: { application: { EngineVersion: '2022.3.62f3' } } });
});
after(() => ctx.close());

test('engine inferred as Unity from an engine version (any key casing)', async () => {
  assert.equal((await req(ctx.baseUrl, '/api/logs/' + unityId)).body.engine, 'Unity');
  assert.equal((await req(ctx.baseUrl, '/api/logs/' + pascalId)).body.engine, 'Unity');
});

test('explicit engine field wins (GameMaker)', async () => {
  assert.equal((await req(ctx.baseUrl, '/api/logs/' + gmId)).body.engine, 'GameMaker');
});

test('engine is null when no engine info is present', async () => {
  assert.equal((await req(ctx.baseUrl, '/api/logs/' + bareId)).body.engine, null);
});

test('catalog projects expose the latest log engine per project', async () => {
  const r = await req(ctx.baseUrl, '/browse?format=json&token=' + VIEWER);
  const byId = new Map(r.body.projects.map((p) => [p.appId, p]));
  assert.equal(byId.get('unityapp').engine, 'Unity');
  assert.equal(byId.get('gmapp').engine, 'GameMaker');
  assert.equal(byId.get('bareapp').engine, null);
});

test('per-log engine is exposed in the version listing', async () => {
  const r = await req(ctx.baseUrl, '/browse/unityapp/1.0.0?format=json&token=' + VIEWER);
  const log = r.body.logs.find((l) => l.id === unityId);
  assert.equal(log.engine, 'Unity');
});
