'use strict';

// Tests for the optional `comment` and `tester` ingest fields.
//
// Covers:
//   - round-trip: POST /api/logs with comment+tester -> 201, then
//     GET /api/logs/:id returns exactly the same values;
//   - missing/empty comment+tester do not break ingest and surface as null;
//   - overlong comment (>4000) and tester (>120) are accepted and truncated
//     server-side (the documented slice() behaviour) rather than rejected.

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
// 1. Round-trip: comment + tester are stored and returned verbatim.
// -------------------------------------------------------------------------
test('POST /api/logs with comment and tester round-trips via GET /api/logs/:id', async () => {
  const comment = 'Boss fight crashes when picking up the second key.';
  const tester = 'Jane QA';

  const meta = await ingestAndGetMeta({ comment, tester });
  assert.equal(meta.comment, comment, 'comment must round-trip unchanged');
  assert.equal(meta.tester, tester, 'tester must round-trip unchanged');
});

// -------------------------------------------------------------------------
// 2. Missing comment/tester -> ingest still works, fields are null.
// -------------------------------------------------------------------------
test('POST /api/logs without comment/tester returns 201 and null fields', async () => {
  const meta = await ingestAndGetMeta({});
  assert.equal(meta.comment, null, 'absent comment must surface as null');
  assert.equal(meta.tester, null, 'absent tester must surface as null');
});

// -------------------------------------------------------------------------
// 3. Empty-string comment/tester -> not stored, surface as null.
// -------------------------------------------------------------------------
test('POST /api/logs with empty comment/tester returns 201 and null fields', async () => {
  // Empty strings are kept as '' by ingest (slice of ''), but publicLogObject
  // maps falsy values to null via `row.comment || null`. Pin this behaviour.
  const meta = await ingestAndGetMeta({ comment: '', tester: '' });
  assert.equal(meta.comment, null, 'empty comment must surface as null');
  assert.equal(meta.tester, null, 'empty tester must surface as null');
});

// -------------------------------------------------------------------------
// 4. Overlong comment/tester -> accepted (201) and truncated, not rejected.
// -------------------------------------------------------------------------
test('POST /api/logs truncates overlong comment (>4000) and tester (>120)', async () => {
  const longComment = 'c'.repeat(5000); // > 4000 limit
  const longTester = 't'.repeat(200);   // > 120 limit

  const meta = await ingestAndGetMeta({ comment: longComment, tester: longTester });

  // Server accepts and slices: comment to 4000, tester to 120.
  assert.equal(typeof meta.comment, 'string', 'comment must be present');
  assert.equal(meta.comment.length, 4000, 'comment must be truncated to 4000 chars');
  assert.equal(meta.comment, 'c'.repeat(4000), 'truncated comment must be the leading 4000 chars');

  assert.equal(typeof meta.tester, 'string', 'tester must be present');
  assert.equal(meta.tester.length, 120, 'tester must be truncated to 120 chars');
  assert.equal(meta.tester, 't'.repeat(120), 'truncated tester must be the leading 120 chars');
});

// -------------------------------------------------------------------------
// 5. Non-string comment/tester are coerced via String(), not rejected.
// -------------------------------------------------------------------------
test('POST /api/logs coerces non-string comment/tester to string', async () => {
  // ingest uses String(body.comment) / String(body.tester) for any non-null
  // value, so a number is stored as its string form rather than 400-ing.
  const meta = await ingestAndGetMeta({ comment: 12345, tester: 42 });
  assert.equal(meta.comment, '12345', 'numeric comment is stringified');
  assert.equal(meta.tester, '42', 'numeric tester is stringified');
});
