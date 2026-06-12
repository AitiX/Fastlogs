'use strict';

// GET /:id/screenshot -> image/png.
//
// Serves the PNG screenshot blob for a log. Returns the uniform 404 when the
// id is missing/expired or when the log simply has no screenshot. We rely on
// the has_shot flag first (cheap) and then read the blob.

const storage = require('../storage');
const { sendText } = require('../util/http');
const { getLiveLog, notFound } = require('./shared');

async function screenshot(req, res, params) {
  const row = getLiveLog(params.id);
  if (!row || row.has_shot !== 1) return notFound(res);

  const png = await storage.readShot(row.id);
  if (!png) return notFound(res);

  // Immutable: the blob never changes for a given id. Cache for a day.
  sendText(res, 200, png, {
    'Content-Type': 'image/png',
    'Cache-Control': 'public, max-age=86400',
    'X-Robots-Tag': 'noindex, nofollow',
  });
}

module.exports = { screenshot };
