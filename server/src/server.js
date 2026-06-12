'use strict';

// Entry point referenced by package.json ("main"/"start": node src/server.js).
//
// The HTTP server, router, and full route wiring live in ./index (which binds
// to loopback for nginx, serves the static viewer assets, and installs the
// SIGINT/SIGTERM graceful-shutdown handlers). This file is a thin wrapper so
// the package's stable entry point starts that server. Implementation stays in
// index.js to avoid two diverging copies of the wiring.

const { start } = require('./index');

start().catch((err) => {
  console.error('[server] failed to start:', err);
  process.exit(1);
});

module.exports = require('./index').server; // Exported for tests.
