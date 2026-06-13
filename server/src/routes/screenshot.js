'use strict';

// GET /:id/screenshot       -> image/png (the first screenshot, index 0).
// GET /:id/screenshot/:n    -> image/png (the Nth screenshot, 0-based).
//
// Serves a PNG screenshot blob for a log. Returns the uniform 404 when the id
// is missing/expired or when the requested index is out of range. shot_count is
// the source of truth (with a has_shot fallback for pre-feature rows).

const storage = require('../storage');
const { sendText } = require('../util/http');
const { getLiveLog, notFound } = require('./shared');

async function screenshot(req, res, params) {
  const row = getLiveLog(params.id);
  if (!row) return notFound(res);

  let index = 0;
  if (params.n != null) {
    index = Number.parseInt(params.n, 10);
    if (!Number.isInteger(index) || index < 0) return notFound(res);
  }
  const count = row.shot_count > 0 ? row.shot_count : (row.has_shot === 1 ? 1 : 0);
  if (index >= count) return notFound(res);

  const png = await storage.readShot(row.id, index);
  if (!png) return notFound(res);

  // Immutable: the blob never changes for a given id. Cache for a day.
  sendText(res, 200, png, {
    'Content-Type': 'image/png',
    'Cache-Control': 'public, max-age=86400',
    'X-Robots-Tag': 'noindex, nofollow',
  });
}

module.exports = { screenshot };
