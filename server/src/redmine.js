'use strict';

// Redmine REST client + issue-content builders, kept out of the route for
// testability. No new dependencies: Node's global fetch + AbortController.
//
// Confirmed Redmine REST API (redmine.org wiki, current 2024-2026): create an
// issue with POST {REDMINE_URL}/issues.json, header X-Redmine-API-Key,
// Content-Type application/json, body { issue: { project_id, tracker_id?,
// subject, description } }. Success is 201 Created with { issue: { id } }; a
// 422 returns { errors: [...] } on validation; 401/403 on a bad API key.

const { parseDevice } = require('./routes/shared');

function clamp(s, n) {
  const str = String(s == null ? '' : s);
  return str.length > n ? str.slice(0, n) : str;
}

// Build the Redmine issue subject + description from a log row. `publicUrl` is
// the browser-facing FastLogs link; `overrides.subject` wins when provided.
function buildIssueContent(row, publicUrl, overrides) {
  overrides = overrides || {};
  const title = row.title || (row.platform ? row.platform + ' log' : 'log');
  const subject = clamp(overrides.subject || `[${row.app_id} ${row.app_version}] ${title}`, 255);

  const lines = [];
  lines.push('FastLogs report: ' + publicUrl);
  lines.push('');
  lines.push('Project: ' + row.app_id);
  lines.push('Version: ' + row.app_version);
  lines.push('Platform: ' + (row.platform || ''));
  lines.push('Time: ' + (row.ts_utc || ''));
  lines.push('Errors: ' + row.cnt_error + '  Warnings: ' + row.cnt_warn + '  Logs: ' + row.cnt_log);
  if (row.tester) lines.push('Tester: ' + row.tester);

  const device = parseDevice(row);
  const devLines = [];
  for (const groupName of ['system', 'application', 'graphics']) {
    const g = device[groupName];
    if (!g || typeof g !== 'object') continue;
    for (const k of Object.keys(g)) {
      const v = g[k];
      if (v === null || v === undefined || typeof v === 'object') continue;
      devLines.push('  ' + k + ': ' + String(v));
      if (devLines.length >= 16) break;
    }
    if (devLines.length >= 16) break;
  }
  if (devLines.length) {
    lines.push('');
    lines.push('Device:');
    lines.push(...devLines);
  }

  if (row.comment) {
    lines.push('');
    lines.push('Comment:');
    lines.push(String(row.comment));
  }

  return { subject, description: lines.join('\n') };
}

// POST a new issue to Redmine. Never throws: returns { ok:true, issueId, raw }
// on 201, or { ok:false, kind, status?, detail } otherwise (kind is one of
// 'validation' | 'auth' | 'http' | 'network').
async function createIssue(opts) {
  const { url, apiKey, projectId, trackerId, subject, description, timeoutMs } = opts;

  const issue = { project_id: projectId, subject, description };
  if (trackerId) {
    const n = Number(trackerId);
    issue.tracker_id = Number.isFinite(n) ? n : trackerId;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs > 0 ? timeoutMs : 10000);
  try {
    const resp = await fetch(String(url).replace(/\/+$/, '') + '/issues.json', {
      method: 'POST',
      headers: {
        'X-Redmine-API-Key': apiKey,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ issue }),
      signal: controller.signal,
    });

    if (resp.status === 201) {
      let data = null;
      try { data = await resp.json(); } catch { /* tolerate non-JSON success */ }
      const issueId = data && data.issue ? data.issue.id : null;
      return { ok: true, issueId, raw: data };
    }
    if (resp.status === 401 || resp.status === 403) {
      return { ok: false, kind: 'auth', status: resp.status, detail: 'authentication failed' };
    }
    if (resp.status === 422) {
      let detail = 'validation error';
      try {
        const j = await resp.json();
        if (j && Array.isArray(j.errors) && j.errors.length) detail = String(j.errors[0]);
      } catch { /* keep default detail */ }
      return { ok: false, kind: 'validation', status: 422, detail: clamp(detail, 200) };
    }
    return { ok: false, kind: 'http', status: resp.status, detail: 'HTTP ' + resp.status };
  } catch (err) {
    return { ok: false, kind: 'network', detail: (err && err.message) || 'network error' };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { buildIssueContent, createIssue };
