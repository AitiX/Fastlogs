'use strict';

// CLI: rename a project (appId / slug) and/or its display name, keeping the OLD
// appId working as an alias.
//
// Renaming re-keys the app row + ALL its logs and standalone files from the old
// id to the new id, records the old id as an alias of the new one, and repoints
// any pre-existing aliases onto the new id. NOTHING is lost:
//   - log ids are unchanged, so every /<id> link keeps resolving;
//   - blobs on disk are untouched (keyed by log id, not appId);
//   - the FTS index is keyed by log id, so it needs no rewrite;
//   - ingest / browse / search under the OLD appId resolve to the new one
//     (db.resolveAppId checks apps first, then app_aliases).
// The whole rename runs in one transaction, so a failure leaves the project
// exactly as it was.
//
// Usage:
//   node scripts/rename-app.js <oldAppId> <newAppId> ["New Display Name"]
//   npm run rename-app -- <oldAppId> <newAppId> ["New Display Name"]
//
// Arguments:
//   oldAppId   required, the current appId (or an existing alias of it)
//   newAppId   required, [a-z0-9_-]{2,32}, the new canonical appId
//   newName    optional, new human-readable display name (apps.name)
//
// Idempotent:
//   - re-running with the SAME old and new id only updates the name (if given);
//   - if <newAppId> equals <oldAppId>, only the name is changed (no aliasing);
//   - if the project was already renamed, pass its CURRENT id (or any old alias)
//     as <oldAppId> - resolveAppId finds the canonical row either way.

const db = require('../src/db');

const APP_ID_RE = /^[a-z0-9_-]{2,32}$/;

// Print an error + usage hint and exit non-zero.
function fail(msg) {
  console.error(`Error: ${msg}`);
  console.error('Usage: node scripts/rename-app.js <oldAppId> <newAppId> ["New Display Name"]');
  process.exit(2);
}

function main() {
  const argv = process.argv.slice(2);
  const oldArg = argv[0];
  const newAppId = argv[1];
  const newName = argv[2] !== undefined ? String(argv[2]).trim() : null;

  if (!oldArg) fail('oldAppId is required');
  if (!newAppId) fail('newAppId is required');
  if (!APP_ID_RE.test(newAppId)) fail(`newAppId "${newAppId}" must match [a-z0-9_-]{2,32}`);
  if (newName !== null && newName.length === 0) fail('newName, when given, must not be empty');

  // Resolve the OLD argument to the canonical app row, so renaming works whether
  // the caller passes the current id or one of its historical aliases.
  const canonicalOld = db.resolveAppId(oldArg);
  if (!canonicalOld) fail(`unknown appId or alias: "${oldArg}"`);
  const oldApp = db.getApp(canonicalOld);
  if (!oldApp) fail(`unknown appId: "${canonicalOld}"`);

  // Guard: refuse to clobber a DIFFERENT existing project. Renaming onto an id
  // that is already a live, distinct app would merge two projects - not what a
  // rename means - so we stop. (Renaming onto an OLD alias of THIS app is fine;
  // resolveAppId would point it back here, and the transaction drops that alias.)
  if (newAppId !== canonicalOld) {
    const collide = db.getApp(newAppId);
    if (collide) fail(`newAppId "${newAppId}" is already a registered project; choose another id`);
  }

  const stats = db.statsForApp(canonicalOld) || { logCount: 0 };

  db.renameApp(canonicalOld, newAppId, newName);

  // Report.
  if (newAppId === canonicalOld) {
    console.log(`App "${canonicalOld}" kept its id`);
  } else {
    console.log(`App renamed: ${canonicalOld} -> ${newAppId}`);
    console.log(`  old id "${canonicalOld}" now resolves as an alias of "${newAppId}"`);
    console.log(`  ${stats.logCount} log(s) re-keyed; ids and links unchanged`);
  }
  const finalApp = db.getApp(newAppId);
  console.log(`  display name    : "${finalApp ? finalApp.name : ''}"`);
}

try {
  main();
  process.exit(0);
} catch (err) {
  console.error('rename-app failed:', (err && err.message) || err);
  process.exit(1);
}
