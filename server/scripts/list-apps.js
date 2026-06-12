'use strict';

// CLI: list registered apps.
//
// Prints a table of apps with their key attributes. Never prints token values
// (only whether a token is set, since we store the hash). Add --json for
// machine-readable output.
//
// Usage:
//   node scripts/list-apps.js [--json]
//   npm run list-apps

const db = require('../src/db');

// Truncate/pad a value to a fixed column width for the text table.
function col(value, width) {
  const s = value === null || value === undefined ? '' : String(value);
  if (s.length >= width) return s.slice(0, width - 1) + ' ';
  return s + ' '.repeat(width - s.length);
}

function main() {
  const asJson = process.argv.includes('--json');
  const apps = db.listApps();

  if (asJson) {
    // Map to a safe view: include `hasToken`, never the hash itself.
    const view = apps.map((a) => ({
      appId: a.app_id,
      name: a.name,
      hasToken: !!a.token_hash,
      retentionDays: a.retention_days,
      maxRetentionDays: a.max_retention_days,
      enabled: a.enabled === 1,
      hasSinks: !!a.sinks_json,
      createdAt: a.created_at,
    }));
    console.log(JSON.stringify(view, null, 2));
    return;
  }

  if (apps.length === 0) {
    console.log('No apps registered. Add one with: npm run add-app -- <appId> "<name>" [retentionDays]');
    return;
  }

  console.log(
    col('APP_ID', 18) + col('NAME', 28) + col('TOKEN', 7) + col('RET', 6) + col('MAXRET', 8) + col('ON', 4) + col('SINKS', 7) + 'CREATED',
  );
  console.log('-'.repeat(96));
  for (const a of apps) {
    console.log(
      col(a.app_id, 18) +
        col(a.name, 28) +
        col(a.token_hash ? 'yes' : 'no', 7) +
        col(a.retention_days, 6) +
        col(a.max_retention_days, 8) +
        col(a.enabled === 1 ? 'on' : 'off', 4) +
        col(a.sinks_json ? 'yes' : 'no', 7) +
        (a.created_at || ''),
    );
  }
  console.log(`\n${apps.length} app(s).`);
}

try {
  main();
  process.exit(0);
} catch (err) {
  console.error('list-apps failed:', (err && err.message) || err);
  process.exit(1);
}
