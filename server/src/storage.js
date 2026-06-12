'use strict';

// Blob storage on the local filesystem.
//
// Log bodies are stored gzipped (.log.gz) and screenshots as PNG (.png). To
// avoid huge flat directories, blobs are sharded into subdirectories named
// after the first two characters of the id. Layout:
//
//   <blobDir>/<shard>/<id>.log.gz
//   <blobDir>/<shard>/<id>.png
//
// All compression/decompression uses node:zlib. Functions are synchronous-ish
// wrappers returning promises so callers can await without blocking the loop
// on large payloads.

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const zlib = require('node:zlib');
const { promisify } = require('node:util');
const config = require('./config');

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

// Compute the shard directory for an id (first two chars, lowercased).
// Short ids (length 1) are padded so the shard is always two characters.
function shardOf(id) {
  const key = (id.length >= 2 ? id.slice(0, 2) : (id + '_')).toLowerCase();
  return key.replace(/[^0-9a-z_-]/g, '_');
}

// Absolute path to the directory holding a given id's blobs.
function shardDir(id) {
  return path.join(config.blobDir, shardOf(id));
}

// Absolute path to the gzipped log body for an id.
function logPath(id) {
  return path.join(shardDir(id), `${id}.log.gz`);
}

// Absolute path to the screenshot for an id.
function shotPath(id) {
  return path.join(shardDir(id), `${id}.png`);
}

// Ensure the shard directory for an id exists.
async function ensureShard(id) {
  await fsp.mkdir(shardDir(id), { recursive: true });
}

// Store a log body. Accepts either raw text/Buffer (gzipped here) or an already
// gzipped Buffer (pass alreadyGzipped=true to store verbatim). Returns the
// number of bytes written on disk (the gzipped size).
async function saveLogGz(id, data, alreadyGzipped = false) {
  await ensureShard(id);
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
  const gz = alreadyGzipped ? buf : await gzip(buf);
  await fsp.writeFile(logPath(id), gz);
  return gz.length;
}

// Read a log body. By default returns the decompressed text as a string.
// Pass { raw: true } to get the raw gzipped Buffer (e.g. to stream .log.gz
// directly when the client accepts gzip). Returns null if the blob is missing.
async function readLogGz(id, { raw = false } = {}) {
  let gz;
  try {
    gz = await fsp.readFile(logPath(id));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  if (raw) return gz;
  const buf = await gunzip(gz);
  return buf.toString('utf8');
}

// Store a screenshot. `data` is a PNG Buffer (or base64 string). Returns the
// number of bytes written.
async function saveShot(id, data) {
  await ensureShard(id);
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data, 'base64');
  await fsp.writeFile(shotPath(id), buf);
  return buf.length;
}

// Read a screenshot as a Buffer, or null if missing.
async function readShot(id) {
  try {
    return await fsp.readFile(shotPath(id));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

// Remove all blobs for an id (log body and screenshot if present). Missing
// files are ignored. Returns the count of files actually removed.
async function removeBlobs(id) {
  let removed = 0;
  for (const p of [logPath(id), shotPath(id)]) {
    try {
      await fsp.unlink(p);
      removed += 1;
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }
  return removed;
}

// Synchronous existence check for a log blob (handy for sweeper diagnostics).
function logExistsSync(id) {
  return fs.existsSync(logPath(id));
}

module.exports = {
  saveLogGz,
  readLogGz,
  saveShot,
  readShot,
  removeBlobs,
  logPath,
  shotPath,
  shardDir,
  shardOf,
  logExistsSync,
};
