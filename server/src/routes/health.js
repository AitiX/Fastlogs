'use strict';

// Health check. GET /api/health -> 200 { ok: true }.
// Used by nginx/uptime probes; intentionally trivial and unauthenticated.

const { sendJson } = require('../util/http');

function health(req, res) {
  sendJson(res, 200, { ok: true });
}

module.exports = { health };
