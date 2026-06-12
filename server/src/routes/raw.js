'use strict';

// GET /:id/raw -> the raw log body as text/plain.
//
// Behaviour (CONTRACT section 2):
//   - Default: decompress the stored .log.gz and send text/plain.
//   - ?download=1: add Content-Disposition: attachment so browsers save it.
//   - Accept-Encoding contains gzip: send the stored .log.gz verbatim with
//     Content-Encoding: gzip (no server-side decompression), letting the client
//     inflate it. This saves CPU and bandwidth for capable clients.

const storage = require('../storage');
const { sendText } = require('../util/http');
const { getLiveLog, notFound } = require('./shared');

// Does the request accept gzip transfer-encoding?
function acceptsGzip(req) {
  const ae = String(req.headers['accept-encoding'] || '').toLowerCase();
  // Match a standalone "gzip" token (avoid matching "x-gzip-foo" etc.).
  return /(^|,|\s)gzip(\s*;|\s*,|$)/.test(ae);
}

async function raw(req, res, params, query) {
  const row = getLiveLog(params.id);
  if (!row) return notFound(res);

  const download = query && query.get('download') === '1';
  const headers = {
    'Content-Type': 'text/plain; charset=utf-8',
    'X-Robots-Tag': 'noindex, nofollow',
    'Cache-Control': 'public, max-age=86400',
  };

  if (acceptsGzip(req)) {
    // Serve the stored gzip blob as-is. For a download we must name the file by
    // its ACTUAL encoding (.log.gz), otherwise a ".log.txt" name would hold raw
    // gzip bytes and be unreadable (CONTRACT section 2).
    const gz = await storage.readLogGz(row.id, { raw: true });
    if (gz === null) return notFound(res);
    headers['Content-Encoding'] = 'gzip';
    headers['Vary'] = 'Accept-Encoding';
    if (download) {
      headers['Content-Disposition'] = `attachment; filename="${row.id}.log.gz"`;
    }
    return sendText(res, 200, gz, headers);
  }

  // Decompress and send plain text. The download name matches the plain body.
  const text = await storage.readLogGz(row.id);
  if (text === null) return notFound(res);
  headers['Vary'] = 'Accept-Encoding';
  if (download) {
    headers['Content-Disposition'] = `attachment; filename="${row.id}.log.txt"`;
  }
  return sendText(res, 200, text, headers);
}

module.exports = { raw };
