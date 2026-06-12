'use strict';

// CLI: run the retention sweeper once.
//
// Deletes expired (non-pinned) logs and their blobs. Intended to be run from a
// cron job / systemd timer. Loops in batches until nothing expired remains (or a
// safety cap is hit), so a single invocation fully drains the backlog.
//
// Usage:
//   node scripts/sweep.js [--batch N] [--now ISO] [--once]
//   npm run sweep
//
// Flags:
//   --batch N   batch size per pass (default 500)
//   --now ISO   override the cutoff timestamp (default: current UTC time)
//   --once      run a single pass instead of looping until drained

const { sweep } = require('../src/sweeper');
const { nowUtcIso } = require('../src/util/http');

// Minimal argv parser for the few flags we support.
function parseArgs(argv) {
  const out = { batch: 500, now: nowUtcIso(), once: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--once') out.once = true;
    else if (a === '--batch') out.batch = Number.parseInt(argv[++i], 10) || out.batch;
    else if (a === '--now') out.now = argv[++i] || out.now;
    else {
      console.error(`Unknown argument: ${a}`);
      process.exitCode = 2;
    }
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  // Safety cap on the number of passes to avoid an unbounded loop.
  const maxPasses = args.once ? 1 : 1000;

  const totals = { scanned: 0, blobsRemoved: 0, rowsDeleted: 0, errors: 0 };

  for (let pass = 0; pass < maxPasses; pass++) {
    const r = await sweep(args.now, args.batch);
    totals.scanned += r.scanned;
    totals.blobsRemoved += r.blobsRemoved;
    totals.rowsDeleted += r.rowsDeleted;
    totals.errors += r.errors.length;

    for (const e of r.errors) console.error(`  failed ${e.id}: ${e.error}`);

    // Stop when a pass found fewer than a full batch (backlog drained), or when
    // running a single pass was requested.
    if (args.once || r.scanned < args.batch) break;
  }

  console.log(
    `Sweep done: scanned=${totals.scanned} rowsDeleted=${totals.rowsDeleted} ` +
      `blobsRemoved=${totals.blobsRemoved} errors=${totals.errors} (cutoff=${args.now})`,
  );
  return totals.errors === 0 ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error('Sweep crashed:', (err && err.message) || err);
    process.exit(1);
  });
