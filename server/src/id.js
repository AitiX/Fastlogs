'use strict';

// Short, URL-safe, unguessable log identifiers.
//
// IDs are base62 (0-9, A-Z, a-z). Default length is 6 characters which yields
// 62^6 ~ 56.8 billion combinations - plenty for short links while staying hard
// to brute-force. On collision the generator grows the length by one and tries
// again, so we never fail to produce a unique id.

const crypto = require('node:crypto');

const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const BASE = ALPHABET.length; // 62
const DEFAULT_LENGTH = 6;
const MAX_ATTEMPTS_PER_LENGTH = 8; // After this many collisions, grow length.

// Generate one random base62 string of the given length.
// We draw bytes with rejection sampling so the distribution stays uniform
// (256 is not a multiple of 62, so naive modulo would bias low values).
function randomBase62(length) {
  const out = new Array(length);
  let filled = 0;
  // 62 * 4 = 248 is the largest multiple of 62 that is <= 256; bytes >= 248
  // are rejected to avoid modulo bias.
  const limit = 248;
  while (filled < length) {
    const bytes = crypto.randomBytes(length - filled);
    for (let i = 0; i < bytes.length && filled < length; i++) {
      const b = bytes[i];
      if (b >= limit) continue; // Reject biased values.
      out[filled++] = ALPHABET[b % BASE];
    }
  }
  return out.join('');
}

// Produce a new id that does not already exist.
//
// `existsFn(id)` must return a truthy value if the id is already taken.
// `startLength` (optional) sets the initial id length (defaults to 6). The
// length grows by one whenever too many collisions happen at the current
// length, guaranteeing termination even in pathological cases.
function newId(existsFn, startLength = DEFAULT_LENGTH) {
  if (typeof existsFn !== 'function') {
    throw new TypeError('newId requires an existsFn(id) callback');
  }
  let length = startLength;
  for (;;) {
    for (let attempt = 0; attempt < MAX_ATTEMPTS_PER_LENGTH; attempt++) {
      const id = randomBase62(length);
      if (!existsFn(id)) return id;
    }
    length += 1; // Widen the keyspace and retry.
  }
}

module.exports = {
  newId,
  randomBase62,
  ALPHABET,
  DEFAULT_LENGTH,
};
