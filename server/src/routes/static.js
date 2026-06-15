'use strict';

// Static asset serving for the viewer front-end (CSS/JS/fonts).
//
// The viewer HTML shell (public/viewer.html) references external assets
// (/viewer.css, /viewer.js) and the catalog references (/browse.css,
// /browse.js). Both pages also link /fonts.css, which in turn requests the
// self-hosted web fonts under /fonts/<name>.woff2. We serve all of these from
// the public/ directory. Only an explicit allowlist of files is served - there
// is no directory traversal and no arbitrary file access - so a crafted id (or
// a "../" in a font name) can never read outside the allowlist.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const config = require('../config');
const { sendText } = require('../util/http');
const { notFound } = require('./shared');

const PUBLIC_DIR = path.join(config.serverRoot, 'public');
const FONTS_DIR = path.join(PUBLIC_DIR, 'fonts');

// Allowlisted static assets: request path -> { file, contentType }.
const ASSETS = {
  '/viewer.css': { file: 'viewer.css', type: 'text/css; charset=utf-8' },
  '/viewer.js': { file: 'viewer.js', type: 'text/javascript; charset=utf-8' },
  '/browse.css': { file: 'browse.css', type: 'text/css; charset=utf-8' },
  '/browse.js': { file: 'browse.js', type: 'text/javascript; charset=utf-8' },
  '/fonts.css': { file: 'fonts.css', type: 'text/css; charset=utf-8' },
};

// Allowlisted web fonts served under /fonts/<name>. The set is a closed
// whitelist of exact basenames (no extension juggling, no path separators), so
// a request name is either one of these literals or a 404 - traversal like
// "../viewer.js" or "..%2f..%2fetc" can never match. Each maps to its file in
// public/fonts/. Keep this in sync with public/fonts.css @font-face urls.
const FONTS = {
  'atkinson-hyperlegible-regular.woff2': 'atkinson-hyperlegible-regular.woff2',
  'atkinson-hyperlegible-bold.woff2': 'atkinson-hyperlegible-bold.woff2',
  'jetbrains-mono-regular.woff2': 'jetbrains-mono-regular.woff2',
  'jetbrains-mono-bold.woff2': 'jetbrains-mono-bold.woff2',
};

// Is this pathname a known static asset? (used by the router wiring)
function isAsset(pathname) {
  return Object.prototype.hasOwnProperty.call(ASSETS, pathname);
}

// Serve an allowlisted static asset. Reads from disk on each request; these
// files are tiny and the OS cache makes repeat reads cheap. A missing file
// yields the uniform 404.
//
// Caching: viewer.js/viewer.css/browse.js/browse.css/fonts.css change on every
// deploy, so a time-based cache (max-age) would hide a viewer/catalog update
// from testers for up to that window - exactly the kind of "I see the old UI"
// confusion we must avoid. We use 'no-cache' (revalidate on every load) plus a
// content ETag, so the browser always checks but the server answers 304 (no
// body) when nothing changed, keeping revalidation cheap. The fonts themselves
// are immutable (served by serveFont) and keep their long cache.
function serveAsset(req, res, pathname) {
  const entry = ASSETS[pathname];
  if (!entry) return notFound(res);

  let body;
  try {
    body = fs.readFileSync(path.join(PUBLIC_DIR, entry.file));
  } catch {
    return notFound(res);
  }

  const etag = '"' + crypto.createHash('sha1').update(body).digest('base64').slice(0, 27) + '"';
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, { 'Cache-Control': 'no-cache', ETag: etag });
    return res.end();
  }
  sendText(res, 200, body, {
    'Content-Type': entry.type,
    'Cache-Control': 'no-cache',
    ETag: etag,
  });
}

// Serve a self-hosted web font (woff2). The name is matched against the closed
// FONTS whitelist; anything not in it (including any traversal attempt) is a
// 404. Fonts are immutable content, so they get a long, immutable cache.
function serveFont(req, res, name) {
  const file = Object.prototype.hasOwnProperty.call(FONTS, name) ? FONTS[name] : null;
  if (!file) return notFound(res);

  let body;
  try {
    body = fs.readFileSync(path.join(FONTS_DIR, file));
  } catch {
    return notFound(res);
  }
  sendText(res, 200, body, {
    'Content-Type': 'font/woff2',
    'Cache-Control': 'public, max-age=31536000, immutable',
  });
}

module.exports = { isAsset, serveAsset, serveFont, ASSETS, FONTS };
