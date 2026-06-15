'use strict';

// CLI: backfill the full-text search (FTS5) index for logs that predate the
// search feature (or were stored while FTS was unavailable). Reads each
// not-yet-indexed log's body from disk and indexes its catalog text + body.
//
// The search route ALSO lazily backfills a bounded batch per query
// (SEARCH_BACKFILL_BATCH), so this script is for draining a large backlog up
// front rather than spreading it over many first queries. Idempotent: a log
// already indexed (fts_indexed = 1) is skipped, and re-running is safe.
//
// Usage:
//   node scripts/backfill-fts.js [--batch N] [--app <appId>]
//   npm run backfill-fts
//
// Flags:
//   --batch N      logs per pass (default 500)
//   --app <appId>  restrict to one app (default: all registered apps)

const db = require('../src/db');
const storage = require('../src/storage');

function parseArgs(argv) {
  const out = { batch: 500, app: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--batch') out.batch = Number.parseInt(argv[++i], 10) || out.batch;
    else if (a === '--app') out.app = argv[++i] || null;
    else {
      console.error(`Unknown argument: ${a}`);
      process.exitCode = 2;
    }
  }
  return out;
}

// Drain one app's not-yet-indexed logs in batches. Returns { indexed, errors }.
async function backfillApp(appId, batch) {
  let indexed = 0;
  let errors = 0;
  // Safety cap so a stuck row (perpetual read failure) cannot loop forever:
  // each pass either indexes rows (advancing fts_indexed) or, on failure,
  // leaves them, so we stop once a pass makes no progress.
  for (;;) {
    const missing = db.listLogsMissingFts(appId, batch);
    if (missing.length === 0) break;
    let progressed = 0;
    for (const m of missing) {
      let body = '';
      try {
        body = (await storage.readLogGz(m.id)) || '';
      } catch (err) {
        errors += 1;
        console.error(`  read failed ${m.id}: ${(err && err.message) || err}`);
        continue;
      }
      try {
        db.indexLog(m, body);
        indexed += 1;
        progressed += 1;
      } catch (err) {
        errors += 1;
        console.error(`  index failed ${m.id}: ${(err && err.message) || err}`);
      }
    }
    // No row advanced this pass: the remaining rows all fail; stop looping.
    if (progressed === 0) break;
  }
  return { indexed, errors };
}

async function main() {
  if (!db.searchAvailable()) {
    console.error('FTS5 is unavailable on this server build; nothing to backfill.');
    return 1;
  }
  const args = parseArgs(process.argv.slice(2));
  const appIds = args.app ? [args.app] : db.listApps().map((a) => a.app_id);

  let totalIndexed = 0;
  let totalErrors = 0;
  for (const appId of appIds) {
    const r = await backfillApp(appId, args.batch);
    if (r.indexed || r.errors) {
      console.log(`  ${appId}: indexed=${r.indexed} errors=${r.errors}`);
    }
    totalIndexed += r.indexed;
    totalErrors += r.errors;
  }

  console.log(`Backfill done: indexed=${totalIndexed} errors=${totalErrors} (apps=${appIds.length})`);
  return totalErrors === 0 ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error('Backfill crashed:', (err && err.message) || err);
    process.exit(1);
  });
