'use strict';

// Tests for the optional "sent from code" provenance ingest fields:
// `sentViaCode`, `callerFile`, `callerLine`.
//
// Covers:
//   - round-trip: POST /api/logs with sentViaCode=true + callerFile/line -> 201,
//     then GET /api/logs/:id reflects them (sentViaCode true, caller file:line);
//   - absent fields: sentViaCode is false and the caller fields are null
//     (the "overlay send" default, stable shape);
//   - sentViaCode=false explicitly behaves like absent (false, no caller badge);
//   - callerFile is trimmed and clamped to 260 chars;
//   - a non-boolean sentViaCode collapses to false (no 400);
//   - a non-integer / negative callerLine collapses to null (no 400).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { setup, makeIngestBody, req } = require('./helpers');

const ctx = setup();

before(async () => {
  await ctx.ready;
  ctx.addApp({ appId: 'testapp', name: 'Test App' });
});

after(() => ctx.close());

// Ingest a body, assert 201, fetch its meta, and return the meta body.
async function ingestAndGetMeta(overrides) {
  const ingestRes = await req(ctx.baseUrl, '/api/logs', {
    method: 'POST',
    body: makeIngestBody(overrides),
  });
  assert.equal(ingestRes.status, 201,
    `expected 201, got ${ingestRes.status}: ${JSON.stringify(ingestRes.body)}`);
  const { id } = ingestRes.body;

  const metaRes = await req(ctx.baseUrl, `/api/logs/${id}`);
  assert.equal(metaRes.status, 200,
    `meta expected 200, got ${metaRes.status}: ${JSON.stringify(metaRes.body)}`);
  return metaRes.body;
}

// -------------------------------------------------------------------------
// 1. Round-trip: a code send with caller file:line surfaces in the meta.
// -------------------------------------------------------------------------
test('POST /api/logs round-trips sentViaCode=true and callerFile/callerLine', async () => {
  const meta = await ingestAndGetMeta({
    sentViaCode: true,
    callerFile: 'Assets/Scripts/Boss/BossFight.cs',
    callerLine: 142,
  });

  assert.equal(meta.sentViaCode, true, 'sentViaCode must be true for a code send');
  assert.equal(meta.callerFile, 'Assets/Scripts/Boss/BossFight.cs', 'callerFile round-trips');
  assert.equal(meta.callerLine, 142, 'callerLine round-trips');
});

// -------------------------------------------------------------------------
// 2. Absent fields -> overlay-send default (false + null caller fields).
// -------------------------------------------------------------------------
test('POST /api/logs without the via-code fields returns sentViaCode=false and null caller', async () => {
  const meta = await ingestAndGetMeta({});
  assert.equal(meta.sentViaCode, false, 'absent sentViaCode defaults to false');
  assert.equal(meta.callerFile, null, 'absent callerFile surfaces as null');
  assert.equal(meta.callerLine, null, 'absent callerLine surfaces as null');
});

// -------------------------------------------------------------------------
// 3. sentViaCode=false explicitly behaves like absent (no caller badge).
// -------------------------------------------------------------------------
test('POST /api/logs with sentViaCode=false is treated as an overlay send', async () => {
  const meta = await ingestAndGetMeta({ sentViaCode: false });
  assert.equal(meta.sentViaCode, false, 'explicit false stays false');
  assert.equal(meta.callerFile, null, 'no caller file for an overlay send');
  assert.equal(meta.callerLine, null, 'no caller line for an overlay send');
});

// -------------------------------------------------------------------------
// 4. callerFile is trimmed and clamped to 260 chars.
// -------------------------------------------------------------------------
test('POST /api/logs trims and clamps callerFile to 260 chars', async () => {
  const long = '  ' + 'f'.repeat(400) + '  ';
  const meta = await ingestAndGetMeta({ sentViaCode: true, callerFile: long });
  assert.equal(meta.callerFile.length, 260, 'callerFile clamped to 260 chars');
  assert.equal(meta.callerFile, 'f'.repeat(260), 'trimmed then clamped');
});

// -------------------------------------------------------------------------
// 5. A non-boolean sentViaCode collapses to false (no 400).
// -------------------------------------------------------------------------
test('POST /api/logs coerces a non-boolean sentViaCode to false', async () => {
  // Only a literal JSON true counts as a code send; a truthy non-boolean (e.g.
  // the string "true" or 1) must NOT flip the flag, so the column stays clean.
  const meta = await ingestAndGetMeta({ sentViaCode: 'true' });
  assert.equal(meta.sentViaCode, false, 'a non-boolean sentViaCode collapses to false');
});

// -------------------------------------------------------------------------
// 6. A non-integer / negative callerLine collapses to null (no 400).
// -------------------------------------------------------------------------
test('POST /api/logs drops a non-integer or negative callerLine to null', async () => {
  const bad = await ingestAndGetMeta({ sentViaCode: true, callerLine: 'NaN' });
  assert.equal(bad.callerLine, null, 'a non-numeric callerLine collapses to null');

  const negative = await ingestAndGetMeta({ sentViaCode: true, callerLine: -5 });
  assert.equal(negative.callerLine, null, 'a negative callerLine collapses to null');

  // A floating-point line number is floored to an integer.
  const floored = await ingestAndGetMeta({ sentViaCode: true, callerLine: 99.9 });
  assert.equal(floored.callerLine, 99, 'a fractional callerLine is floored');
});
