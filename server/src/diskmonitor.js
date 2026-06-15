'use strict';

// Disk-usage monitor.
//
// A small, off-the-hot-path watchdog that periodically measures how full the
// filesystem backing BLOB_DIR is, and how large the blobs/ tree has grown. When
// a configured threshold is crossed it raises an alert: always a server-log
// warning, plus an optional POST to a webhook (DISK_ALERT_WEBHOOK). The webhook
// body carries both `text` (Slack) and `content` (Discord) so the same URL
// works for a Slack incoming webhook, a Discord channel webhook, or any generic
// receiver - mirroring how the sinks layer talks to those services, but without
// the ingest-shaped payload (this is a SYSTEM notification, not a log forward).
//
// Design notes:
//   - The check runs on an unref'd interval so it never keeps the process alive
//     or blocks shutdown; the listening server owns the lifecycle.
//   - Filesystem fullness uses fs.promises.statfs (Node 18.15+). If it is not
//     available we log once and fall back to the absolute-size check only, so
//     an old runtime degrades gracefully instead of crashing.
//   - blobs/ size is computed by walking the tree (like `du`). This is bounded
//     by the on-disk file count and runs at most once per interval, off the
//     request path, so the cost is acceptable for a housekeeping pass.
//   - Alerts are level-triggered with hysteresis: one notification per rising
//     edge (not every interval while over the line), and a recovery note when
//     usage drops back below the threshold. This keeps a full disk from
//     flooding the channel.
//   - All errors are contained: a failed measurement or a failed webhook is
//     logged and never thrown, so the monitor can never take the server down.

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const config = require('./config');
const { deliver } = require('./sinks/deliver');

// statfs landed in Node 18.15. Capture once; if absent the percentage check is
// skipped (logged a single time) and only the absolute-size check applies.
const hasStatfs = typeof fsp.statfs === 'function';
let warnedNoStatfs = false;

// Module-level alert state so we only notify on the rising edge and recovery.
// One flag per trigger kind keeps the two thresholds independent.
const alerted = { pct: false, bytes: false };

let timer = null;

// Format a byte count as a short human string (for log lines / messages).
function humanBytes(n) {
  if (!Number.isFinite(n) || n < 0) return String(n);
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${i === 0 ? v : v.toFixed(1)} ${units[i]}`;
}

// Recursively sum the on-disk size of every regular file under `dir`. Symlinks
// are not followed (lstat) so we never double-count or escape the tree. Missing
// entries (raced with the sweeper) are ignored. Returns total bytes.
async function dirSize(dir) {
  let total = 0;
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return 0;
    throw err;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    try {
      if (entry.isDirectory()) {
        total += await dirSize(full);
      } else if (entry.isFile()) {
        const st = await fsp.lstat(full);
        total += st.size;
      }
    } catch (err) {
      // A file removed mid-walk (sweeper) is fine; anything else is reported up.
      if (err.code !== 'ENOENT') throw err;
    }
  }
  return total;
}

// Read filesystem fullness for the volume backing BLOB_DIR. Returns
// { usedPct, totalBytes, freeBytes } or null when statfs is unavailable.
async function fsUsage(dir) {
  if (!hasStatfs) {
    if (!warnedNoStatfs) {
      warnedNoStatfs = true;
      console.warn('[diskmonitor] fs.statfs unavailable (Node < 18.15); percentage check disabled');
    }
    return null;
  }
  const s = await fsp.statfs(dir);
  // bsize = fragment/block size; blocks = total, bavail = free to unprivileged.
  const blockSize = s.bsize || s.frsize || 4096;
  const totalBytes = s.blocks * blockSize;
  const freeBytes = s.bavail * blockSize;
  const usedBytes = totalBytes - freeBytes;
  const usedPct = totalBytes > 0 ? (usedBytes / totalBytes) * 100 : 0;
  return { usedPct, totalBytes, freeBytes };
}

// Send the alert message: always a log line, plus a webhook when configured.
// `level` is 'warn' for a raised alert, 'info' for a recovery. Never throws.
async function notify(level, message) {
  if (level === 'warn') console.warn(`[diskmonitor] ${message}`);
  else console.log(`[diskmonitor] ${message}`);

  const url = config.diskMonitor.webhook;
  if (!url) return;

  // One body shape covers the common destinations: Slack reads `text`, Discord
  // reads `content`, a generic receiver gets the whole JSON. Routed through the
  // shared sink deliver() helper for the same timeout/retry/backoff behaviour.
  const body = JSON.stringify({ text: message, content: message });
  try {
    const res = await deliver(
      {
        url,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      },
      { retries: 2, timeoutMs: 10000 },
    );
    if (!res.ok) {
      console.error(`[diskmonitor] webhook failed: ${res.error || 'unknown error'}`);
    }
  } catch (err) {
    console.error(`[diskmonitor] webhook threw: ${(err && err.message) || err}`);
  }
}

// One measurement pass: evaluate both thresholds and fire/clear alerts.
// Exported so tests and tools can run a pass on demand. Returns the measured
// snapshot { usedPct, totalBytes, freeBytes, blobBytes } (usedPct/totals null
// when statfs is unavailable). Never throws.
async function checkOnce() {
  const cfg = config.diskMonitor;

  let usage = null;
  let blobBytes = null;
  try {
    usage = await fsUsage(config.blobDir);
  } catch (err) {
    console.error(`[diskmonitor] statfs error: ${(err && err.message) || err}`);
  }
  try {
    blobBytes = await dirSize(config.blobDir);
  } catch (err) {
    console.error(`[diskmonitor] blobs size error: ${(err && err.message) || err}`);
  }

  // Percentage trigger (filesystem fullness).
  if (usage && cfg.alertPct > 0) {
    const pct = usage.usedPct;
    if (pct >= cfg.alertPct && !alerted.pct) {
      alerted.pct = true;
      await notify(
        'warn',
        `disk at ${pct.toFixed(1)}% on the BLOB_DIR volume (>= ${cfg.alertPct}% threshold), `
          + `${humanBytes(usage.freeBytes)} free of ${humanBytes(usage.totalBytes)}`,
      );
    } else if (pct < cfg.alertPct && alerted.pct) {
      alerted.pct = false;
      await notify(
        'info',
        `disk recovered to ${pct.toFixed(1)}% on the BLOB_DIR volume (below ${cfg.alertPct}% threshold)`,
      );
    }
  }

  // Absolute-size trigger (blobs/ growth).
  if (blobBytes !== null && cfg.alertBytes > 0) {
    if (blobBytes >= cfg.alertBytes && !alerted.bytes) {
      alerted.bytes = true;
      await notify(
        'warn',
        `blobs/ is ${humanBytes(blobBytes)} (>= ${humanBytes(cfg.alertBytes)} threshold)`,
      );
    } else if (blobBytes < cfg.alertBytes && alerted.bytes) {
      alerted.bytes = false;
      await notify(
        'info',
        `blobs/ shrank to ${humanBytes(blobBytes)} (below ${humanBytes(cfg.alertBytes)} threshold)`,
      );
    }
  }

  return {
    usedPct: usage ? usage.usedPct : null,
    totalBytes: usage ? usage.totalBytes : null,
    freeBytes: usage ? usage.freeBytes : null,
    blobBytes,
  };
}

// Start the periodic monitor. Runs one pass at startup, then every
// DISK_MONITOR_INTERVAL_SEC. Returns the timer (or null when disabled). The
// timer is unref'd so it never blocks shutdown. Idempotent: a second start is
// a no-op while a timer is live.
function start() {
  const cfg = config.diskMonitor;
  if (timer) return timer;
  if (!cfg.intervalSec || cfg.intervalSec <= 0) return null;
  if (cfg.alertPct <= 0 && cfg.alertBytes <= 0) return null; // Nothing to watch.

  // Degenerate config: the only trigger is the percentage one, but statfs is
  // unavailable (Node < 18.15), so it can never fire and blobs/ is unwatched.
  // The monitor would run yet alert nothing - warn once so the operator can set
  // DISK_ALERT_BYTES instead of silently believing the disk is being watched.
  if (!hasStatfs && cfg.alertPct > 0 && cfg.alertBytes <= 0) {
    console.warn('[diskmonitor] fs.statfs unavailable (Node < 18.15) and DISK_ALERT_BYTES=0: '
      + 'nothing is being watched. Set DISK_ALERT_BYTES to enable the absolute-size check.');
  }

  const run = () => {
    checkOnce().catch((e) => console.error(`[diskmonitor] pass error: ${(e && e.message) || e}`));
  };
  run();
  timer = setInterval(run, cfg.intervalSec * 1000);
  if (timer.unref) timer.unref();
  return timer;
}

// Stop the monitor (used by graceful shutdown / tests).
function stop() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

module.exports = {
  start,
  stop,
  checkOnce,
  dirSize,
  fsUsage,
  humanBytes,
};
