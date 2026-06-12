'use strict';

// Retention sweeper.
//
// Deletes logs whose retention has elapsed: rows in `logs` that are not pinned
// and whose expires_at is at or before `now`. For each such log we remove its
// on-disk blobs (gzipped body + screenshot) and then delete the database row.
//
// Idempotency: removeBlobs ignores missing files, and deleting an already-gone
// row is a no-op, so re-running the sweep (or crashing mid-batch and retrying)
// is safe. Blobs are removed before the row so that a crash between the two
// leaves an orphan row (still listed as expired) rather than an orphan blob;
// the next sweep finishes the job.
//
// Ordering note: better-sqlite3 transactions must be fully synchronous, so we do
// the async blob deletion outside the transaction and then delete the rows. We
// process in batches to bound memory and keep each pass short.

const db = require('./db');
const storage = require('./storage');
const { nowUtcIso } = require('./util/http');

// Sweep one pass.
//
// Parameters:
//   - now:   ISO-8601 UTC cutoff string (defaults to current time);
//   - batch: max number of logs to process in this call (default 500).
//
// Returns { scanned, blobsRemoved, rowsDeleted, errors } where `errors` is an
// array of { id, error } for logs that could not be fully removed (those rows
// are left in place for the next sweep).
async function sweep(now = nowUtcIso(), batch = 500) {
  const expired = db.listExpired(now, batch);

  const result = {
    scanned: expired.length,
    blobsRemoved: 0,
    rowsDeleted: 0,
    errors: [],
  };

  // Collect ids whose blobs were successfully removed; only those rows get
  // deleted, in a single synchronous transaction at the end.
  const deletable = [];

  for (const row of expired) {
    try {
      const removed = await storage.removeBlobs(row.id);
      result.blobsRemoved += removed;
      deletable.push(row.id);
    } catch (err) {
      // Leave the row for the next sweep; record the failure.
      result.errors.push({ id: row.id, error: (err && err.message) || String(err) });
    }
  }

  if (deletable.length > 0) {
    // Delete all rows whose blobs are gone, atomically.
    const deleteMany = db.db.transaction((ids) => {
      let n = 0;
      for (const id of ids) {
        n += db.deleteLog(id).changes;
      }
      return n;
    });
    result.rowsDeleted = deleteMany(deletable);
  }

  return result;
}

module.exports = {
  sweep,
};
