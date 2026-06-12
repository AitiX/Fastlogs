'use strict';

// CORS handling.
//
// The allowed origin comes from config.corsAllowOrigin (default "*"). When the
// configured value is "*", we never set Access-Control-Allow-Credentials, since
// the wildcard origin and credentials are mutually exclusive per the Fetch
// spec. When a concrete origin is configured, we echo it and mark Vary: Origin.

const config = require('./config');

const ALLOW_METHODS = 'GET, POST, OPTIONS';
const ALLOW_HEADERS = 'Authorization, Content-Type';
const MAX_AGE_SECONDS = 86400; // 24h preflight cache.

// Apply CORS response headers to `res` based on the request and configuration.
// Safe to call on every request (including non-CORS ones).
function applyCors(req, res) {
  const allow = config.corsAllowOrigin || '*';

  if (allow === '*') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    // No Allow-Credentials with a wildcard origin.
  } else {
    // Concrete allowed origin: echo it and vary so caches stay correct.
    res.setHeader('Access-Control-Allow-Origin', allow);
    res.setHeader('Vary', 'Origin');
  }

  res.setHeader('Access-Control-Allow-Methods', ALLOW_METHODS);
  res.setHeader('Access-Control-Allow-Headers', ALLOW_HEADERS);
  res.setHeader('Access-Control-Max-Age', String(MAX_AGE_SECONDS));
}

// Handle a CORS preflight. If the request method is OPTIONS, write the CORS
// headers, respond with 204 No Content, and return true (request handled).
// Otherwise returns false so the caller continues normal routing.
function handlePreflight(req, res) {
  if (req.method !== 'OPTIONS') return false;
  applyCors(req, res);
  res.statusCode = 204;
  res.setHeader('Content-Length', '0');
  res.end();
  return true;
}

module.exports = {
  applyCors,
  handlePreflight,
  ALLOW_METHODS,
  ALLOW_HEADERS,
  MAX_AGE_SECONDS,
};
