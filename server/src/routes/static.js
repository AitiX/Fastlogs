'use strict';

// Static asset serving for the viewer front-end (CSS/JS).
//
// The viewer HTML shell (public/viewer.html) references external assets
// (/viewer.css, /viewer.js). We serve those from the public/ directory. Only
// an explicit allowlist of files is served - there is no directory traversal
// and no arbitrary file access - so a crafted id can never read outside the
// allowlist.

const fs = require('node:fs');
const path = require('node:path');
const config = require('../config');
const { sendText } = require('../util/http');
const { notFound } = require('./shared');

const PUBLIC_DIR = path.join(config.serverRoot, 'public');

// Allowlisted static assets: request path -> { file, contentType }.
const ASSETS = {
  '/viewer.css': { file: 'viewer.css', type: 'text/css; charset=utf-8' },
  '/viewer.js': { file: 'viewer.js', type: 'text/javascript; charset=utf-8' },
  '/browse.css': { file: 'browse.css', type: 'text/css; charset=utf-8' },
  '/browse.js': { file: 'browse.js', type: 'text/javascript; charset=utf-8' },
};

// Is this pathname a known static asset? (used by the router wiring)
function isAsset(pathname) {
  return Object.prototype.hasOwnProperty.call(ASSETS, pathname);
}

// Serve an allowlisted static asset. Reads from disk on each request; these
// files are tiny and the OS cache makes repeat reads cheap. A missing file
// yields the uniform 404.
function serveAsset(req, res, pathname) {
  const entry = ASSETS[pathname];
  if (!entry) return notFound(res);

  let body;
  try {
    body = fs.readFileSync(path.join(PUBLIC_DIR, entry.file));
  } catch {
    return notFound(res);
  }
  sendText(res, 200, body, {
    'Content-Type': entry.type,
    'Cache-Control': 'public, max-age=3600',
  });
}

module.exports = { isAsset, serveAsset, ASSETS };
