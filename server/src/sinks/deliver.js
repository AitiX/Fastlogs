'use strict';

// Shared HTTP delivery helper for sinks.
//
// Every sink ultimately performs an outbound HTTP request (a webhook POST in the
// general case). This module centralises that: timeout, retries with
// exponential backoff plus jitter, and a uniform result shape. Sinks build the
// request (url, method, headers, body) and hand it here; failures are returned,
// never thrown, so the dispatcher can log and move on without affecting ingest.
//
// Uses the global fetch (available in Node 18+). A per-attempt AbortController
// enforces the timeout.

// Sleep helper used between retry attempts.
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Decide whether an HTTP status is worth retrying. 5xx and 429 are transient;
// 408 (request timeout) too. Other 4xx are client errors and will not improve
// on retry, so we give up immediately.
function isRetryableStatus(status) {
  return status === 408 || status === 429 || (status >= 500 && status <= 599);
}

// Perform a single HTTP attempt with a timeout. Returns
// { ok, status, statusText, bodyText } or throws on network/abort errors.
async function attemptOnce(url, { method, headers, body, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      headers,
      body,
      signal: controller.signal,
      redirect: 'follow',
    });
    // Drain the body (bounded) so the connection can be reused and so we can
    // surface a short error snippet from the destination on failure.
    let bodyText = '';
    try {
      const text = await res.text();
      bodyText = text.length > 500 ? text.slice(0, 500) : text;
    } catch {
      // Ignore body read errors; the status is what matters.
    }
    return {
      ok: res.ok,
      status: res.status,
      statusText: res.statusText,
      bodyText,
    };
  } finally {
    clearTimeout(timer);
  }
}

// Deliver an HTTP request with retries and exponential backoff.
//
// request:
//   - url       (string, required)
//   - method    (string, default 'POST')
//   - headers   (object, default {})
//   - body      (string|Buffer, optional)
// opts:
//   - retries     total attempts beyond the first (default 3)
//   - timeoutMs   per-attempt timeout (default 10000)
//   - baseDelayMs base backoff delay, doubled each retry (default 500)
//   - maxDelayMs  cap on a single backoff delay (default 15000)
//
// Always resolves (never rejects) with:
//   { ok, attempts, status?, statusText?, bodyText?, error? }
async function deliver(request, opts = {}) {
  const {
    url,
    method = 'POST',
    headers = {},
    body,
  } = request;

  const retries = Number.isInteger(opts.retries) ? opts.retries : 3;
  const timeoutMs = opts.timeoutMs || 10000;
  const baseDelayMs = opts.baseDelayMs || 500;
  const maxDelayMs = opts.maxDelayMs || 15000;

  if (!url || typeof url !== 'string') {
    return { ok: false, attempts: 0, error: 'missing or invalid url' };
  }

  const totalAttempts = retries + 1;
  let lastResult = null;

  for (let attempt = 1; attempt <= totalAttempts; attempt++) {
    try {
      const res = await attemptOnce(url, { method, headers, body, timeoutMs });
      if (res.ok) {
        return { ok: true, attempts: attempt, status: res.status, statusText: res.statusText };
      }
      lastResult = {
        ok: false,
        attempts: attempt,
        status: res.status,
        statusText: res.statusText,
        bodyText: res.bodyText,
        error: `HTTP ${res.status} ${res.statusText}`,
      };
      // Non-retryable client error: stop now.
      if (!isRetryableStatus(res.status)) return lastResult;
    } catch (err) {
      const reason = err && err.name === 'AbortError' ? `timeout after ${timeoutMs}ms` : (err && err.message) || String(err);
      lastResult = { ok: false, attempts: attempt, error: reason };
    }

    // Back off before the next attempt (skip after the final attempt).
    if (attempt < totalAttempts) {
      const exp = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
      const jitter = Math.floor(Math.random() * (exp / 2));
      await sleep(exp + jitter);
    }
  }

  return lastResult || { ok: false, attempts: totalAttempts, error: 'delivery failed' };
}

module.exports = {
  deliver,
  isRetryableStatus,
  sleep,
};
