'use strict';

// Fixed-window rate limiting backed by the rate_counters table.
//
// We use a fixed window keyed by (key, window index). The window index is
// floor(nowSeconds / windowSec); the stored window_start in the database is
// that index. db.bumpRate atomically increments the counter for the current
// window (resetting when the window rolls over), so we get the post-increment
// count and compare it against the limit. This is a sliding-by-window
// approximation: simple, robust, and good enough for abuse protection.

const db = require('./db');

// Check and consume one unit of quota for `key`.
//
// Parameters:
//   - key:        unique bucket identifier (e.g. "ingest:ip:<hash>");
//   - limit:      max allowed events per window;
//   - windowSec:  window length in seconds.
//
// Returns { allowed, retryAfter, count, limit }:
//   - allowed:    true if this event is within the limit;
//   - retryAfter: seconds until the current window ends (for the Retry-After
//                 header) when blocked, otherwise 0;
//   - count:      current count within the window after this event;
//   - limit:      the limit that was applied.
function check(key, limit, windowSec) {
  const nowSec = Math.floor(Date.now() / 1000);
  const windowIndex = Math.floor(nowSec / windowSec);

  // Atomically bump the counter for this window and read the new count.
  const count = db.bumpRate(key, windowIndex);

  if (count <= limit) {
    return { allowed: true, retryAfter: 0, count, limit };
  }

  // Blocked: compute seconds remaining until the next window boundary.
  const windowEndSec = (windowIndex + 1) * windowSec;
  const retryAfter = Math.max(1, windowEndSec - nowSec);
  return { allowed: false, retryAfter, count, limit };
}

module.exports = {
  check,
};
