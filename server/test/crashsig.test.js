'use strict';

// Unit tests for src/crashsig.js. Pure module, no server: require it directly.
// FastLogs log format is "[E] +time message" + raw stack frames (see
// unity Runtime/Capture/LogFormat.cs).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crashsig = require('../src/crashsig');

// A crash log: one [E] entry (NullReferenceException) with two IL2CPP frames,
// preceded by ordinary info logs that ALSO carry script stacks (the false-
// positive trap this module must avoid).
const CRASH_A = [
  '[L] +1.000 [Loading] Begin: PlayerProfile.Load',
  'Terraf.TerrafApp:LoadingStep(String)',
  'InitialLoadingScene:Update()',
  '[E] +12.345 NullReferenceException: Object reference not set to an instance of an object',
  'Game.Player:TakeDamage (System.Int32 amount) [0x00012] in <a1b2c3>:0',
  'Game.Combat:Resolve () [0x0007f] in <a1b2c3>:0',
].join('\n');

// The SAME crash from a different build/run: different hex offsets, different
// <assembly> token, different line numbers. Must hash identically to CRASH_A.
const CRASH_A_REBUILD = [
  '[L] +0.500 [Boot] starting',
  '[E] +88.001 NullReferenceException: Object reference not set to an instance of an object',
  'Game.Player:TakeDamage (System.Int32 amount) [0x000ff] in <z9y8x7>:42',
  'Game.Combat:Resolve () [0x00abc] in <z9y8x7>:88',
].join('\n');

// The SAME crash as CRASH_A, but the entry headers now carry a frame token
// ("[E] +12.345 f5821 ...") as emitted once the client captures Time.frameCount.
// crashsig must skip the optional f<frame> token so this hashes identically to
// CRASH_A (otherwise crash grouping would fragment across the format boundary).
const CRASH_A_WITHFRAME = [
  '[L] +1.000 f10 [Loading] Begin: PlayerProfile.Load',
  'Terraf.TerrafApp:LoadingStep(String)',
  'InitialLoadingScene:Update()',
  '[E] +12.345 f5821 NullReferenceException: Object reference not set to an instance of an object',
  'Game.Player:TakeDamage (System.Int32 amount) [0x00012] in <a1b2c3>:0',
  'Game.Combat:Resolve () [0x0007f] in <a1b2c3>:0',
].join('\n');

// A DIFFERENT crash: different exception type, different frames.
const CRASH_B = [
  '[E] +3.100 IndexOutOfRangeException: Index was outside the bounds of the array.',
  'Game.Inventory:Get (System.Int32 slot) [0x00001] in <a1b2c3>:0',
].join('\n');

// Not a crash: only info/warning entries (each with its own script stack).
const NON_CRASH = [
  '[L] +1.000 [Loading] Begin: PlayerProfile.Load',
  'Terraf.TerrafApp:LoadingStep(String)',
  'InitialLoadingScene:Update()',
  '[W] +2.000 Texture import settings overridden',
  'UnityEngine.Debug:LogWarning(Object)',
].join('\n');

test('crash log yields a 12-char lowercase hex signature', () => {
  const sig = crashsig.computeSignature(CRASH_A);
  assert.equal(typeof sig, 'string');
  assert.match(sig, /^[0-9a-f]{12}$/);
});

test('STABILITY: same crash across builds (offsets/lines/assembly differ) -> same signature', () => {
  assert.equal(crashsig.computeSignature(CRASH_A), crashsig.computeSignature(CRASH_A_REBUILD));
});

test('STABILITY: frame token in the header (new format) -> same signature as the frame-less format', () => {
  assert.equal(crashsig.computeSignature(CRASH_A_WITHFRAME), crashsig.computeSignature(CRASH_A));
});

test('DISTINCTNESS: different exception type / frames -> different signature', () => {
  assert.notEqual(crashsig.computeSignature(CRASH_A), crashsig.computeSignature(CRASH_B));
});

test('non-crash (no [E] entry) -> null even though info logs carry stacks', () => {
  assert.equal(crashsig.computeSignature(NON_CRASH), null);
});

test('empty / null / non-string input -> null', () => {
  assert.equal(crashsig.computeSignature(''), null);
  assert.equal(crashsig.computeSignature(null), null);
  assert.equal(crashsig.computeSignature(undefined), null);
  assert.equal(crashsig.computeSignature(12345), null);
});

test('exceptionType extracts the type, ignores plain "Error " words', () => {
  assert.equal(crashsig.exceptionType('NullReferenceException: foo'), 'NullReferenceException');
  assert.equal(crashsig.exceptionType('System.IO.IOException: disk full'), 'System.IO.IOException');
  assert.equal(crashsig.exceptionType('Error loading scene MainMenu'), '');
  assert.equal(crashsig.exceptionType('[Loading] Begin: PlayerProfile.Load'), '');
});

test('normalizeFrame strips offsets/lines/paths/generics, collapses args', () => {
  assert.equal(
    crashsig.normalizeFrame('Game.Player:TakeDamage (System.Int32 amount) [0x00012] in <a1b2c3>:0'),
    'Game.Player:TakeDamage()'
  );
  assert.equal(
    crashsig.normalizeFrame('  at Game.Combat:Resolve () [0x0007f] in <z9>:42'),
    'Game.Combat:Resolve()'
  );
  assert.equal(
    crashsig.normalizeFrame('Player.TakeDamage (Int32 amount) (at Assets/Scripts/Player.cs:42)'),
    'Player.TakeDamage()'
  );
  assert.equal(
    crashsig.normalizeFrame('System.Collections.Generic.List`1:Add (T item)'),
    'System.Collections.Generic.List:Add()'
  );
});

test('frame path/offset/line differences do not change the frame token', () => {
  const a = crashsig.normalizeFrame('Player.TakeDamage (Int32 a) (at C:/proj/Assets/Player.cs:42)');
  const b = crashsig.normalizeFrame('Player.TakeDamage (Int32 a) (at /home/ci/Assets/Player.cs:88)');
  assert.equal(a, b);
});

test('error without a type/stack groups by normalized message (volatile parts stripped)', () => {
  const m1 = '[E] +5.000 Failed to load asset bundle 12345 at 0xABCD';
  const m2 = '[E] +9.000 Failed to load asset bundle 67890 at 0x1234';
  const s1 = crashsig.computeSignature(m1);
  const s2 = crashsig.computeSignature(m2);
  assert.match(s1, /^[0-9a-f]{12}$/);
  assert.equal(s1, s2);
});

test('SIG_LEN / TOP_K exported constants', () => {
  assert.equal(crashsig.SIG_LEN, 12);
  assert.equal(crashsig.TOP_K, 8);
});
