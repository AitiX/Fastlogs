'use strict';

// HTTP helpers shared across routes.
//
// Provides small response helpers (sendJson/sendText/sendError) and a request
// body reader (readJsonBody) that enforces a byte limit and transparently
// decompresses gzip bodies (Content-Encoding: gzip). Error responses follow the
// CONTRACT shape: { "error": "<code>", "message": "<text>" }.

const zlib = require('node:zlib');
const { promisify } = require('node:util');

const gunzip = promisify(zlib.gunzip);

// Current time as an ISO-8601 UTC string (e.g. "2026-06-12T09:30:00.000Z").
function nowUtcIso() {
  return new Date().toISOString();
}

// Send a JSON response with the given status code.
function sendJson(res, status, obj, extraHeaders) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Length', String(body.length));
  if (extraHeaders) {
    for (const [k, v] of Object.entries(extraHeaders)) res.setHeader(k, v);
  }
  res.end(body);
}

// Send a plain-text response with the given status code.
function sendText(res, status, text, extraHeaders) {
  const body = Buffer.isBuffer(text) ? text : Buffer.from(String(text), 'utf8');
  res.statusCode = status;
  if (!res.getHeader('Content-Type')) {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  }
  res.setHeader('Content-Length', String(body.length));
  if (extraHeaders) {
    for (const [k, v] of Object.entries(extraHeaders)) res.setHeader(k, v);
  }
  res.end(body);
}

// Send a CONTRACT-shaped error: { error, message }. `code` is the short error
// token (e.g. "bad_request"), `message` a human-readable detail.
function sendError(res, status, code, message, extraHeaders) {
  return sendJson(res, status, { error: code, message: message || code }, extraHeaders);
}

// Read the full request body into a Buffer, enforcing a byte limit.
// Rejects with an Error carrying .code === 'PAYLOAD_TOO_LARGE' when the body
// exceeds maxBytes (the caller maps this to HTTP 413).
function readBuffer(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let done = false;

    function fail(err) {
      if (done) return;
      done = true;
      req.removeAllListeners('data');
      req.removeAllListeners('end');
      reject(err);
    }

    req.on('data', (chunk) => {
      if (done) return;
      total += chunk.length;
      if (total > maxBytes) {
        const err = new Error('Payload too large');
        err.code = 'PAYLOAD_TOO_LARGE';
        // Stop consuming further data.
        req.destroy();
        fail(err);
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (done) return;
      done = true;
      resolve(Buffer.concat(chunks, total));
    });

    req.on('error', (err) => fail(err));
  });
}

// Read and parse a JSON request body, honoring Content-Encoding: gzip.
//
// Returns the parsed object. Throws Errors with a `.code`:
//   - 'PAYLOAD_TOO_LARGE'  body (compressed or, after inflate, decompressed)
//                          exceeds maxBytes -> HTTP 413;
//   - 'BAD_JSON'           body is not valid JSON                -> HTTP 400;
//   - 'BAD_ENCODING'       gzip body could not be decompressed   -> HTTP 400.
//
// The same maxBytes limit is applied both to the raw incoming bytes and to the
// decompressed size, so a gzip bomb cannot blow past the configured ceiling.
async function readJsonBody(req, maxBytes) {
  const raw = await readBuffer(req, maxBytes);

  const encoding = String(req.headers['content-encoding'] || '').toLowerCase();
  let jsonBuf = raw;

  if (encoding.includes('gzip')) {
    try {
      // maxOutputLength guards against decompression bombs.
      jsonBuf = await gunzip(raw, { maxOutputLength: maxBytes });
    } catch (err) {
      if (err && err.code === 'ERR_BUFFER_TOO_LARGE') {
        const e = new Error('Decompressed payload too large');
        e.code = 'PAYLOAD_TOO_LARGE';
        throw e;
      }
      const e = new Error('Invalid gzip body');
      e.code = 'BAD_ENCODING';
      throw e;
    }
  }

  if (jsonBuf.length === 0) {
    const e = new Error('Empty body');
    e.code = 'BAD_JSON';
    throw e;
  }

  try {
    return JSON.parse(jsonBuf.toString('utf8'));
  } catch {
    const e = new Error('Invalid JSON body');
    e.code = 'BAD_JSON';
    throw e;
  }
}

module.exports = {
  nowUtcIso,
  sendJson,
  sendText,
  sendError,
  readBuffer,
  readJsonBody,
};
