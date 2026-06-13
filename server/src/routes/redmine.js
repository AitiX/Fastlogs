'use strict';

// POST /api/logs/:id/redmine - create a Redmine issue from a log and link it.
//
// - Disabled (503) when REDMINE_URL / REDMINE_API_KEY are unset (checked first,
//   before any auth/db work, so the disabled state is cheap and unambiguous).
// - Viewer-gated (token via Authorization: Bearer or ?token=), like /browse.
// - Idempotent: once a log is linked, a second call returns the existing issue
//   (created:false) without creating a duplicate.
//
// Optional JSON body { subject?, projectId?, trackerId? } overrides defaults.

const auth = require('../auth');
const db = require('../db');
const config = require('../config');
const { readBuffer, sendJson, sendError } = require('../util/http');
const { getLiveLog, notFoundJson, linksFor } = require('./shared');
const redmine = require('../redmine');

// Viewer tier: token from Authorization header or ?token= (admin satisfies it).
function authorizeViewer(req, query) {
  const headerToken = auth.parseBearer(req.headers['authorization']);
  if (headerToken && auth.isViewer(headerToken)) return true;
  const queryToken = query ? query.get('token') : null;
  if (queryToken && auth.isViewer(queryToken)) return true;
  return false;
}

async function createRedmineIssue(req, res, params, query) {
  if (!config.redmine.enabled) {
    return sendError(res, 503, 'redmine_disabled', 'Redmine integration is not configured');
  }
  if (!authorizeViewer(req, query)) {
    return sendError(res, 401, 'unauthorized', 'Viewer token required');
  }

  const row = getLiveLog(params.id);
  if (!row) return notFoundJson(res);

  // Idempotency: already linked -> return the existing issue, do not re-create.
  if (row.redmine_issue_id) {
    return sendJson(res, 200, {
      issueId: row.redmine_issue_id,
      issueUrl: row.redmine_issue_url || null,
      created: false,
    });
  }

  // Optional override body (fully optional: an empty body means "no overrides").
  let body = {};
  try {
    const buf = await readBuffer(req, 4096);
    if (buf.length > 0) body = JSON.parse(buf.toString('utf8'));
  } catch (err) {
    if (err && err.code === 'PAYLOAD_TOO_LARGE') {
      return sendError(res, 413, 'payload_too_large', 'Body too large');
    }
    return sendError(res, 400, 'bad_request', 'Invalid JSON body');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) body = {};

  const publicUrl = linksFor(row.id, row.has_shot === 1).self;
  const { subject, description } = redmine.buildIssueContent(row, publicUrl, {
    subject: typeof body.subject === 'string' ? body.subject : undefined,
  });
  const projectId = body.projectId != null && body.projectId !== '' ? body.projectId : config.redmine.projectId;
  const trackerId = body.trackerId != null && body.trackerId !== '' ? body.trackerId : config.redmine.trackerId;

  if (!projectId) {
    return sendError(res, 502, 'redmine_error', 'REDMINE_PROJECT_ID not set');
  }

  const result = await redmine.createIssue({
    url: config.redmine.url,
    apiKey: config.redmine.apiKey,
    projectId,
    trackerId,
    subject,
    description,
    timeoutMs: config.redmine.timeoutMs,
  });

  if (result.ok) {
    const issueUrl = config.redmine.url + '/issues/' + result.issueId;
    db.setRedmine(row.id, result.issueId, issueUrl);
    return sendJson(res, 200, { issueId: result.issueId, issueUrl, created: true });
  }
  if (result.kind === 'network') {
    return sendError(res, 504, 'redmine_unreachable', 'Could not reach Redmine: ' + (result.detail || ''));
  }
  return sendError(res, 502, 'redmine_error', 'Redmine rejected the issue: ' + (result.detail || ('HTTP ' + (result.status || '?'))));
}

module.exports = { createRedmineIssue };
