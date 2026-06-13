'use strict';

// Unit tests for src/util/version.js. Pure module: require directly.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { compareVersions, parseSemver } = require('../src/util/version');

const lt = (a, b, ca, cb) => assert.ok(compareVersions(a, b, ca, cb) < 0, `${a} < ${b}`);
const gt = (a, b, ca, cb) => assert.ok(compareVersions(a, b, ca, cb) > 0, `${a} > ${b}`);
const eq = (a, b, ca, cb) => assert.equal(compareVersions(a, b, ca, cb), 0, `${a} == ${b}`);

test('semver numeric ordering', () => {
  lt('1.0.0', '1.0.1');
  lt('1.0.1', '1.1.0');
  lt('1.1.0', '2.0.0');
  gt('2.0.0', '1.9.9');
});

test('prerelease sorts before release; identifiers compare', () => {
  lt('1.2.0-rc1', '1.2.0');
  lt('1.2.0-alpha', '1.2.0-beta');
  lt('1.2.0-beta', '1.2.0-rc1');
  lt('1.2.0-1', '1.2.0-2');
  lt('1.2.0-2', '1.2.0-10');
  lt('1.2.0-1', '1.2.0-alpha');
});

test('leading v tolerated; build metadata ignored', () => {
  eq('v1.2.3', '1.2.3');
  eq('1.2.3+abc', '1.2.3');
  eq('1.2.3+abc', '1.2.3+def');
});

test('loose numeric-dotted fallback', () => {
  lt('1.0', '1.0.1');
  lt('2024.3.10f1', '2024.3.11f1');
  gt('2025.1.0f1', '2024.3.11f1');
});

test('total order holds for a prerelease semver mixed with a 2-part loose version', () => {
  // Regression: '1.2.0-rc1' must not be misread as the loose triple [1,2,0].
  lt('1.2.0-rc1', '1.2.0');
  gt('1.2.0', '1.2');
  gt('1.2.0-rc1', '1.2');   // order is 1.2 < 1.2.0-rc1 < 1.2.0 (transitive, no ties)
});

test('opaque labels fall back to created_at then lexicographic', () => {
  lt('nightly', 'qa', '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z');
  gt('nightly', 'qa', '2026-01-03T00:00:00.000Z', '2026-01-02T00:00:00.000Z');
  lt('aaa', 'bbb');
  gt('zzz', 'aaa');
});

test('createdAt tiebreaks equal versions', () => {
  lt('1.2.3', '1.2.3', '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z');
  gt('1.2.3', '1.2.3', '2026-01-02T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
  eq('1.2.3', '1.2.3');
});

test('mixed semver / non-semver is deterministic and never throws', () => {
  const r = compareVersions('1.2.3', 'nightly');
  assert.equal(typeof r, 'number');
  assert.equal(compareVersions('1.2.3', 'nightly'), compareVersions('1.2.3', 'nightly'));
});

test('total order on empty / null-ish input, no exceptions', () => {
  assert.equal(compareVersions('', ''), 0);
  assert.equal(typeof compareVersions(null, undefined), 'number');
  assert.doesNotThrow(() => compareVersions(null, '1.2.3'));
  assert.ok(compareVersions('', '1.2.3') < 0);
});

test('parseSemver', () => {
  assert.deepEqual(parseSemver('1.2.3'), { major: 1, minor: 2, patch: 3, pre: '' });
  assert.deepEqual(parseSemver('v1.2.3-rc1'), { major: 1, minor: 2, patch: 3, pre: 'rc1' });
  assert.equal(parseSemver('1.2'), null);
  assert.equal(parseSemver('nightly'), null);
  assert.equal(parseSemver(''), null);
  assert.equal(parseSemver(null), null);
});
