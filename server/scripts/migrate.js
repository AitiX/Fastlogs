'use strict';

// CLI: run database migrations.
//
// Importing src/db already runs migrate() on load, but this script makes the
// intent explicit (e.g. for first-time setup or CI) and prints a confirmation.
// Migrations are idempotent, so re-running is safe.
//
// Usage:
//   node scripts/migrate.js
//   npm run migrate

const db = require('../src/db');

function main() {
  db.migrate();
  const apps = db.listApps().length;
  console.log('Migrations applied (schema is up to date).');
  console.log(`Registered apps: ${apps}`);
}

try {
  main();
  process.exit(0);
} catch (err) {
  console.error('Migration failed:', (err && err.message) || err);
  process.exit(1);
}
