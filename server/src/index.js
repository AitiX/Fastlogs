'use strict';

// FastLogs HTTP server.
//
// A dependency-light Node http server with a tiny method+path router. It wires
// every route, applies CORS to all responses, answers OPTIONS preflight, and
// shuts down gracefully. It listens on 127.0.0.1:<port> (nginx terminates TLS
// and proxies to us), so the app never faces the public network directly.
//
// Route ordering matters: specific paths are registered before the viewer
// catch-all ("/:id") so the catch-all cannot shadow "/browse", "/api/...", or
// the static assets. The router matches the first route that fits both method
// and segment shape.

const http = require('node:http');
const { URL } = require('node:url');

const config = require('./config');
const { Router } = require('./router');
const { applyCors, handlePreflight } = require('./cors');
const { sendError, sendText } = require('./util/http');

// Route handlers.
const { health } = require('./routes/health');
const { handleIngest } = require('./routes/ingest');
const { meta } = require('./routes/meta');
const { raw } = require('./routes/raw');
const { screenshot } = require('./routes/screenshot');
const { viewer } = require('./routes/viewer');
const { pin } = require('./routes/pin');
const { browseRoot, browseApp, browseVersion } = require('./routes/browse');
const staticRoutes = require('./routes/static');

// ---------------------------------------------------------------------------
// Router wiring. Specific-before-catch-all order is load-bearing.
// ---------------------------------------------------------------------------

const router = new Router();

// API surface.
router.get('/api/health', health);
router.post('/api/logs', handleIngest);
router.post('/api/logs/:id/pin', pin);
router.get('/api/logs/:id', meta);

// Catalog (viewer-token gated).
router.get('/browse', browseRoot);
router.get('/browse/:appId', browseApp);
router.get('/browse/:appId/:version', browseVersion);

// Static viewer + catalog assets (explicit allowlist; handled by the static
// module). These single-segment paths are registered BEFORE the "/:id"
// catch-all so the viewer route cannot shadow them.
router.get('/viewer.css', (req, res) => staticRoutes.serveAsset(req, res, '/viewer.css'));
router.get('/viewer.js', (req, res) => staticRoutes.serveAsset(req, res, '/viewer.js'));
router.get('/browse.css', (req, res) => staticRoutes.serveAsset(req, res, '/browse.css'));
router.get('/browse.js', (req, res) => staticRoutes.serveAsset(req, res, '/browse.js'));

// Public per-id surface. These 2-segment routes are anchored by a literal last
// segment ("raw"/"screenshot"), so they never collide with "/browse/:appId".
router.get('/:id/raw', raw);
router.get('/:id/screenshot', screenshot);

// Viewer catch-all (must be last among GET routes).
router.get('/:id', viewer);

// ---------------------------------------------------------------------------
// Request dispatch.
// ---------------------------------------------------------------------------

// Parse the request URL into a pathname and a query (URLSearchParams). We use a
// dummy origin because Node's URL needs an absolute URL; only path + query are
// used downstream.
function parseUrl(req) {
  const u = new URL(req.url, 'http://localhost');
  return { pathname: u.pathname, query: u.searchParams };
}

async function dispatch(req, res) {
  // CORS on every response.
  applyCors(req, res);

  // Preflight short-circuits before routing.
  if (handlePreflight(req, res)) return;

  const { pathname, query } = parseUrl(req);

  // Root path: nothing to show. A bare 200 keeps health probes/humans happy.
  if (pathname === '/' || pathname === '') {
    return sendText(res, 200, 'FastLogs', {
      'Content-Type': 'text/plain; charset=utf-8',
    });
  }

  const matched = router.match(req.method, pathname);

  if (!matched) {
    // Nothing matched: uniform 404 (text for the public surface).
    return sendText(res, 404, 'Not found', { 'X-Robots-Tag': 'noindex, nofollow' });
  }
  if (matched.methodMismatch) {
    return sendError(res, 405, 'method_not_allowed', 'Method not allowed');
  }

  // Hand off to the route. Handlers may be sync or async; we await either way
  // and convert any thrown error into a 500.
  await matched.handler(req, res, matched.params, query);
}

// Wrap dispatch so any unexpected error becomes a clean 500 (and is logged)
// without crashing the process or leaking a stack trace to clients.
function onRequest(req, res) {
  Promise.resolve()
    .then(() => dispatch(req, res))
    .catch((err) => {
      console.error('[server] unhandled error:', err);
      if (!res.headersSent) {
        sendError(res, 500, 'internal_error', 'Internal server error');
      } else {
        // Headers already flushed; just end the response.
        try { res.end(); } catch { /* ignore */ }
      }
    });
}

// ---------------------------------------------------------------------------
// Server lifecycle.
// ---------------------------------------------------------------------------

const server = http.createServer(onRequest);

// Bind address. Default 127.0.0.1 so a bare-metal deploy is private behind
// nginx. Inside a container set HOST=0.0.0.0: Docker maps only host 127.0.0.1
// to the container, so the service stays private while remaining reachable
// through the container network interface (binding container-loopback would
// make it unreachable via the published port).
function start() {
  return new Promise((resolve) => {
    server.listen(config.port, config.host, () => {
      console.log(`[server] FastLogs listening on http://${config.host}:${config.port}`);
      resolve(server);
    });
  });
}

// Graceful shutdown: stop accepting connections, let in-flight finish, then
// exit. A hard timeout guards against stuck sockets.
let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[server] ${signal} received, shutting down...`);

  const forceTimer = setTimeout(() => {
    console.error('[server] forced shutdown (timeout)');
    process.exit(1);
  }, 10000);
  forceTimer.unref();

  server.close((err) => {
    if (err) {
      console.error('[server] error during close:', err);
      process.exit(1);
    }
    console.log('[server] closed cleanly');
    process.exit(0);
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// Start immediately when run as the entry point. When required (e.g. by tests),
// export the pieces and let the caller start.
if (require.main === module) {
  start();
}

module.exports = { server, start, router, dispatch };
