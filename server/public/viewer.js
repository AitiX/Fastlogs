'use strict';
/* global __LD */

// FastLogs - viewer page logic.
//
// Data contract (__LD, injected inline by the server route):
// {
//   id:           string,          // short id
//   appId:        string,
//   appVersion:   string,
//   platform:     string,
//   title:        string | null,
//   timestampUtc: string,          // ISO-8601 UTC
//   pinned:       boolean,
//   counts:       { error, warn, log },
//   status:       string,          // new | triaged | in_progress | fixed | wontfix
//   tags:         string[],        // possibly empty
//   engine:       string | null,   // "Unity", "GameMaker", or null
//   crashSig:     string | null,
//   redmineEnabled: boolean,
//   redmineIssue: { id, url } | null,
//   hasScreenshot: boolean,
//   logText:      string,          // decompressed, may be large
//   device: {
//     system?:      { ... },
//     graphics?:    { ... },
//     display?:     { ... },
//     application?: { ... },
//     runtime?:     { ... },
//     memory?:      { ... },
//     network?:     { ... },
//     build?:       { ... },
//     web?:         { ... },
//   },
//   context:      { [key: string]: string },   // empty {} when none
//   breadcrumbs:  [ { t?: string, m: string, lvl?: 'info'|'warn'|'error' } ] // empty [] when none
// }
//
// Known device group order shown first, extras appended after.

(function () {
  // ---- Toast ----

  var toastTimer = null;
  function toast(msg, durationMs) {
    var el = document.getElementById('toast');
    el.textContent = msg;
    el.classList.add('show');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove('show'); }, durationMs || 2000);
  }

  // ---- Mutation URL builder ----

  // Build an /api/logs/:id/<action> URL, forwarding a ?token= from the current
  // location when present. The token is harmless on the open-by-link endpoints
  // (status/tags) and required by the viewer-gated one (redmine).
  function apiUrl(id, action) {
    var url = '/api/logs/' + encodeURIComponent(id) + '/' + action;
    var token = new URLSearchParams(window.location.search).get('token');
    if (token) url += '?token=' + encodeURIComponent(token);
    return url;
  }

  // ---- Format byte size ----

  function fmtBytes(n) {
    if (n === null || n === undefined || isNaN(n) || n < 0) return '';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / (1024 * 1024)).toFixed(1) + ' MB';
  }

  // ---- Data ----

  var data = (typeof __LD !== 'undefined') ? __LD : null;
  if (!data || !data.id) {
    document.getElementById('page-title').textContent = 'Log not found';
    document.getElementById('log-pretty').innerHTML =
      '<div class="log-no-results">No data available for this log entry.</div>';
    return;
  }

  // ---- Header / title ----

  var titleText = data.title || (data.appId + ' ' + data.platform);
  document.title = 'FastLogs - ' + titleText;
  document.getElementById('page-title').textContent = titleText;

  // ---- Comment (tester's free-text issue description) ----
  if (data.comment) {
    document.getElementById('comment-text').textContent = data.comment;
    document.getElementById('comment-box').style.display = '';
  }

  // Raw link
  var rawLink = document.getElementById('raw-link');
  rawLink.href = '/' + data.id + '/raw';

  // FastLogs logo -> projects home (catalog). Carry the token when the page has
  // one so the catalog stays authorized; a bare /browse would 401.
  var logoEl = document.getElementById('topbar-logo');
  if (logoEl) {
    var logoToken = new URLSearchParams(window.location.search).get('token');
    logoEl.href = '/browse' + (logoToken ? '?token=' + encodeURIComponent(logoToken) : '');
  }

  // Copy link button
  document.getElementById('copy-link-btn').addEventListener('click', function () {
    var url = window.location.origin + '/' + data.id;
    if (navigator.clipboard) {
      navigator.clipboard.writeText(url).then(function () { toast('Link copied'); }).catch(function () { toast('Copy failed'); });
    } else {
      toast('Clipboard not available');
    }
  });

  // ---- Pin button ----

  var pinBtn = document.getElementById('pin-btn');
  if (data.pinned) {
    pinBtn.textContent = 'Pinned';
    pinBtn.classList.add('pinned');
  }

  pinBtn.addEventListener('click', function () {
    var currentlyPinned = pinBtn.classList.contains('pinned');
    var newPin = !currentlyPinned;
    var url = '/api/logs/' + encodeURIComponent(data.id) + '/pin';
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin: newPin })
    }).then(function (r) {
      if (!r.ok) {
        return r.json().then(function (e) { toast('Error: ' + (e.message || r.status)); });
      }
      return r.json().then(function (res) {
        var pinned = res.pinned === true;
        pinBtn.textContent = pinned ? 'Pinned' : 'Pin';
        pinBtn.classList.toggle('pinned', pinned);
        data.pinned = pinned;
        toast(pinned ? 'Log pinned' : 'Log unpinned');
      });
    }).catch(function (err) { toast('Network error'); });
  });

  // ---- Status dropdown ----

  // Triage status as a select. Mirrors the pin fetch: POST -> JSON -> toast.
  // A per-status data attribute drives the dot/badge colour in CSS.
  var statusSelect = document.getElementById('status-select');
  var currentStatus = data.status || 'new';

  function reflectStatus(status) {
    currentStatus = status;
    statusSelect.value = status;
    statusSelect.dataset.status = status;
  }
  reflectStatus(currentStatus);

  statusSelect.addEventListener('change', function () {
    var next = statusSelect.value;
    var prev = currentStatus;
    fetch(apiUrl(data.id, 'status'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: next })
    }).then(function (r) {
      if (!r.ok) {
        // Roll back the select to the last confirmed status on failure.
        reflectStatus(prev);
        return r.json().then(function (e) { toast('Error: ' + (e.message || r.status)); });
      }
      return r.json().then(function (res) {
        reflectStatus(res.status || next);
        data.status = currentStatus;
        toast('Status updated');
      });
    }).catch(function (err) { reflectStatus(prev); toast('Network error'); });
  });

  // ---- Tags ----

  // Tags render as chips (createElement + textContent, never innerHTML). Each
  // chip carries a small "x" that removes it; Enter in the input adds one. Both
  // paths POST the FULL array and re-render from the server's normalized list.
  var tagsList = document.getElementById('tags-list');
  var tagsInput = document.getElementById('tags-input');
  var currentTags = Array.isArray(data.tags) ? data.tags.slice() : [];

  function renderTags(tags) {
    currentTags = Array.isArray(tags) ? tags.slice() : [];
    data.tags = currentTags.slice();
    tagsList.textContent = '';
    currentTags.forEach(function (tag) {
      var chip = document.createElement('span');
      chip.className = 'tag-chip';

      var label = document.createElement('span');
      label.className = 'tag-chip-label';
      label.textContent = tag;

      var x = document.createElement('span');
      x.className = 'tag-chip-x';
      x.textContent = '×';
      x.title = 'Remove tag';
      x.addEventListener('click', function () {
        var next = currentTags.filter(function (t) { return t !== tag; });
        postTags(next);
      });

      chip.appendChild(label);
      chip.appendChild(x);
      tagsList.appendChild(chip);
    });
  }

  // POST the full tags array; re-render from the server's normalized response.
  function postTags(tags) {
    fetch(apiUrl(data.id, 'tags'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tags: tags })
    }).then(function (r) {
      if (!r.ok) {
        return r.json().then(function (e) { toast('Error: ' + (e.message || r.status)); });
      }
      return r.json().then(function (res) {
        renderTags(Array.isArray(res.tags) ? res.tags : []);
      });
    }).catch(function (err) { toast('Network error'); });
  }

  renderTags(currentTags);

  tagsInput.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    var typed = tagsInput.value.trim();
    if (!typed) return;
    tagsInput.value = '';
    // Add locally then POST the full array; server normalizes (trim/dedupe/cap).
    var next = currentTags.slice();
    next.push(typed);
    postTags(next);
  });

  // ---- Redmine button / link ----

  // One <a> element doubles as the create button and the resulting issue link.
  // - existing issue -> render as a link to data.redmineIssue.url, shown.
  // - else enabled    -> show the "+ Redmine issue" create button.
  // - else            -> stay hidden (default display:none in the markup).
  var redmineBtn = document.getElementById('redmine-btn');

  // Render the linked-issue state: an "Issue #<id>" anchor opening in a new tab.
  function renderRedmineIssue(id, url) {
    redmineBtn.textContent = 'Issue #' + id;
    redmineBtn.classList.add('redmine-linked');
    if (url) {
      redmineBtn.href = url;
      redmineBtn.target = '_blank';
      redmineBtn.rel = 'noopener noreferrer';
    } else {
      redmineBtn.removeAttribute('href');
    }
    redmineBtn.style.display = '';
  }

  function createRedmineIssue() {
    redmineBtn.classList.add('busy');
    fetch(apiUrl(data.id, 'redmine'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    }).then(function (r) {
      if (!r.ok) {
        if (r.status === 401) { toast('Redmine requires a team token'); return; }
        return r.json().then(function (e) { toast('Error: ' + (e.message || r.status)); });
      }
      return r.json().then(function (res) {
        data.redmineIssue = { id: res.issueId, url: res.issueUrl };
        renderRedmineIssue(res.issueId, res.issueUrl);
        toast('Redmine issue created');
      });
    }).catch(function (err) {
      toast('Network error');
    }).then(function () {
      redmineBtn.classList.remove('busy');
    });
  }

  if (data.redmineIssue && data.redmineIssue.id) {
    renderRedmineIssue(data.redmineIssue.id, data.redmineIssue.url);
  } else if (data.redmineEnabled) {
    redmineBtn.textContent = '+ Redmine issue';
    redmineBtn.style.display = '';
    redmineBtn.addEventListener('click', function (e) {
      e.preventDefault();
      if (redmineBtn.classList.contains('redmine-linked') || redmineBtn.classList.contains('busy')) return;
      createRedmineIssue();
    });
  }

  // ---- Counts bar ----

  var counts = data.counts || {};
  document.getElementById('cnt-error').textContent = counts.error || 0;
  document.getElementById('cnt-warn').textContent = counts.warn || 0;
  document.getElementById('cnt-log').textContent = counts.log || 0;

  var metaParts = [];
  if (data.platform) metaParts.push(data.platform);
  if (data.appVersion) metaParts.push(data.appVersion);
  // Engine (Unity / GameMaker / ...) only when known; at-a-glance line.
  if (data.engine) metaParts.push(data.engine);
  if (data.logBytes !== null && data.logBytes !== undefined && !isNaN(data.logBytes)) metaParts.push(fmtBytes(data.logBytes));
  if (data.timestampUtc) {
    try { metaParts.push(new Date(data.timestampUtc).toLocaleString()); } catch (e) { metaParts.push(data.timestampUtc); }
  }
  if (data.tester) metaParts.unshift('by ' + data.tester);
  document.getElementById('counts-meta').textContent = metaParts.join(' - ');

  // ---- Device info ----

  var DEVICE_GROUP_ORDER = ['system', 'graphics', 'display', 'application', 'runtime', 'memory', 'network', 'build', 'web'];

  var device = data.device || {};
  var groupKeys = DEVICE_GROUP_ORDER.filter(function (k) { return device[k] && Object.keys(device[k]).length > 0; });
  // Append any extra groups not in the standard list.
  Object.keys(device).forEach(function (k) {
    if (groupKeys.indexOf(k) === -1 && device[k] && Object.keys(device[k]).length > 0) {
      groupKeys.push(k);
    }
  });

  var devicePanel = document.getElementById('device-panel');
  var deviceHeader = document.getElementById('device-panel-header');
  var deviceGroupsEl = document.getElementById('device-groups');

  if (groupKeys.length === 0) {
    devicePanel.style.display = 'none';
  } else {
    deviceHeader.addEventListener('click', function () {
      devicePanel.classList.toggle('open');
    });

    groupKeys.forEach(function (groupName) {
      var groupData = device[groupName];
      var groupEl = document.createElement('div');
      groupEl.className = 'device-group';

      var toggle = document.createElement('div');
      toggle.className = 'device-group-toggle';
      var titleEl = document.createElement('div');
      titleEl.className = 'device-group-title';
      titleEl.textContent = groupName;
      var arrowEl = document.createElement('span');
      arrowEl.className = 'device-group-arrow';
      arrowEl.textContent = '►';
      toggle.appendChild(arrowEl);
      toggle.appendChild(titleEl);

      var body = document.createElement('div');
      body.className = 'device-group-body';

      Object.keys(groupData).forEach(function (k) {
        var val = groupData[k];
        if (val === null || val === undefined) return;

        var row = document.createElement('div');
        row.className = 'device-kv';

        var keyEl = document.createElement('span');
        keyEl.className = 'device-key';
        keyEl.textContent = k;

        var valEl = document.createElement('span');
        valEl.className = 'device-val';
        if (typeof val === 'object') {
          valEl.textContent = JSON.stringify(val);
        } else {
          valEl.textContent = String(val);
        }

        row.appendChild(keyEl);
        row.appendChild(valEl);
        body.appendChild(row);
      });

      toggle.addEventListener('click', function () {
        groupEl.classList.toggle('open');
      });

      groupEl.appendChild(toggle);
      groupEl.appendChild(body);
      deviceGroupsEl.appendChild(groupEl);
    });
  }

  // ---- Context (key->value map) ----

  var context = data.context || {};
  var contextKeys = Object.keys(context);
  var contextPanel = document.getElementById('context-panel');
  if (contextKeys.length > 0) {
    contextPanel.style.display = '';
    var contextHeader = document.getElementById('context-panel-header');
    var contextBody = document.getElementById('context-body');

    contextKeys.forEach(function (k) {
      var row = document.createElement('div');
      row.className = 'ctx-kv';

      var keyEl = document.createElement('span');
      keyEl.className = 'ctx-key';
      keyEl.textContent = k;

      var valEl = document.createElement('span');
      valEl.className = 'ctx-val';
      var v = context[k];
      valEl.textContent = (typeof v === 'object') ? JSON.stringify(v) : String(v);

      row.appendChild(keyEl);
      row.appendChild(valEl);
      contextBody.appendChild(row);
    });

    contextHeader.addEventListener('click', function () {
      contextPanel.classList.toggle('open');
    });
  }

  // ---- Breadcrumbs (event timeline) ----

  var breadcrumbs = data.breadcrumbs || [];
  var breadcrumbsPanel = document.getElementById('breadcrumbs-panel');
  if (breadcrumbs.length > 0) {
    breadcrumbsPanel.style.display = '';
    var bcHeader = document.getElementById('breadcrumbs-panel-header');
    var bcBody = document.getElementById('breadcrumbs-body');
    document.getElementById('breadcrumbs-count').textContent =
      '(' + breadcrumbs.length + ')';

    breadcrumbs.forEach(function (crumb) {
      if (!crumb || typeof crumb !== 'object') return;
      var lvl = crumb.lvl === 'warn' || crumb.lvl === 'error' ? crumb.lvl : 'info';

      var row = document.createElement('div');
      row.className = 'bc-item bc-' + lvl;

      var timeEl = document.createElement('span');
      timeEl.className = 'bc-time';
      if (crumb.t) {
        var label = crumb.t;
        try { label = new Date(crumb.t).toLocaleTimeString(); } catch (e) { label = crumb.t; }
        timeEl.textContent = label;
        timeEl.title = crumb.t;
      } else {
        timeEl.textContent = '';
      }

      var dotEl = document.createElement('span');
      dotEl.className = 'bc-dot bc-dot-' + lvl;

      var msgEl = document.createElement('span');
      msgEl.className = 'bc-msg';
      msgEl.textContent = crumb.m != null ? String(crumb.m) : '';

      row.appendChild(timeEl);
      row.appendChild(dotEl);
      row.appendChild(msgEl);
      bcBody.appendChild(row);
    });

    bcHeader.addEventListener('click', function () {
      breadcrumbsPanel.classList.toggle('open');
    });
  }

  // ---- Screenshot ----

  var screenshotWrap = document.getElementById('screenshot-wrap');
  if (data.hasScreenshot) {
    screenshotWrap.style.display = '';
    document.getElementById('screenshot-img').src = '/' + data.id + '/screenshot';

    var screenshotHeader = document.getElementById('screenshot-header');
    var screenshotArrow = document.getElementById('screenshot-arrow');
    screenshotHeader.addEventListener('click', function () {
      screenshotWrap.classList.toggle('open');
      screenshotArrow.textContent = screenshotWrap.classList.contains('open') ? '▼' : '►';
    });
  }

  // ---- Log rendering ----

  var logText = data.logText || '';
  var logLines = logText ? logText.split('\n') : [];

  // Remove trailing empty line from split if text ends with \n.
  if (logLines.length > 0 && logLines[logLines.length - 1] === '') {
    logLines.pop();
  }

  document.getElementById('log-line-count').textContent = logLines.length + ' lines';

  // Detect level for a log line. Returns 'error', 'warn', or 'log'.
  function detectLevel(line) {
    var low = line.toLowerCase();
    // Unity-style prefixes and common patterns.
    if (/\b(error|exception|critical|fatal)\b/.test(low)) return 'error';
    if (/\b(warning|warn)\b/.test(low)) return 'warn';
    return 'log';
  }

  // Detect stack trace continuation lines so they can be folded under the log
  // entry that produced them. Covers Unity's real formats: IL2CPP/Mono managed
  // frames "Ns.Class:Method(args)" (no space after the colon - the hallmark
  // that separates a frame from a "Tag: message" log line), the editor's
  // "Class.Method (args) (at File.cs:line)" form, .NET "  at ..." frames,
  // IL2CPP "[0x0001] in <...>" offsets, and wrapper/rethrow markers.
  function isTraceLine(line) {
    if (!line) return false;
    if (/^\s+at\s/.test(line)) return true;
    if (/\[0x[0-9a-fA-F]+\]\s+in\s/.test(line)) return true;
    if (/\(at\s.+:\d+\)\s*$/.test(line)) return true;
    if (/^[A-Za-z_][\w.+<>\[\]`]*:[A-Za-z_<.][\w.<>\[\]`]*\s*\(.*\)\s*$/.test(line)) return true;
    if (/^\(wrapper\s/.test(line)) return true;
    if (/^Rethrow as\s/.test(line)) return true;
    if (/^---\s*End of\s/.test(line)) return true;
    return false;
  }

  // Build pretty rendered lines.
  var logPrettyEl = document.getElementById('log-pretty');
  var logRawEl = document.getElementById('log-raw');

  // Store metadata per DOM line for filtering.
  var lineNodes = []; // { el, level, text }

  // Group consecutive trace lines after an error/warn for collapsing.
  var i = 0;
  var lineNum = 1;
  while (i < logLines.length) {
    var line = logLines[i];
    var level = detectLevel(line);

    // Check if next lines are trace continuation.
    var traceLines = [];
    var j = i + 1;
    while (j < logLines.length && isTraceLine(logLines[j])) {
      traceLines.push(logLines[j]);
      j++;
    }

    // Main log line row.
    var row = document.createElement('div');
    row.className = 'log-line ' + level;

    var numEl = document.createElement('span');
    numEl.className = 'log-line-num';
    numEl.textContent = lineNum;

    var textEl = document.createElement('span');
    textEl.className = 'log-line-text log-level-' + (level === 'log' ? 'l' : level === 'warn' ? 'w' : 'e');
    textEl.textContent = line;

    row.appendChild(numEl);
    row.appendChild(textEl);
    logPrettyEl.appendChild(row);

    lineNodes.push({ el: row, level: level, text: line });
    lineNum++;
    i++;

    // Attach trace block if present.
    if (traceLines.length > 0) {
      var traceToggle = document.createElement('div');
      traceToggle.className = 'log-line log-trace-toggle';
      var numEl2 = document.createElement('span');
      numEl2.className = 'log-line-num';
      numEl2.textContent = '';
      var traceLabel = document.createElement('span');
      traceLabel.className = 'log-line-text';
      traceLabel.textContent = '  [+ ' + traceLines.length + ' stack frame' + (traceLines.length !== 1 ? 's' : '') + ' - click to expand]';
      traceToggle.appendChild(numEl2);
      traceToggle.appendChild(traceLabel);

      var traceBody = document.createElement('div');
      traceBody.className = 'log-trace-body';

      traceLines.forEach(function (tl) {
        var tr = document.createElement('div');
        tr.className = 'log-line log-level-l';
        var tn = document.createElement('span');
        tn.className = 'log-line-num';
        tn.textContent = lineNum;
        var tt = document.createElement('span');
        tt.className = 'log-line-text';
        tt.style.color = 'var(--text-dim)';
        tt.textContent = tl;
        tr.appendChild(tn);
        tr.appendChild(tt);
        traceBody.appendChild(tr);
        lineNodes.push({ el: tr, level: level, text: tl, traceEl: traceBody });
        lineNum++;
      });

      traceToggle.addEventListener('click', function () {
        traceBody.classList.toggle('open');
        var open = traceBody.classList.contains('open');
        traceLabel.textContent = open
          ? '  [- collapse stack frames]'
          : '  [+ ' + traceLines.length + ' stack frame' + (traceLines.length !== 1 ? 's' : '') + ' - click to expand]';
      });

      logPrettyEl.appendChild(traceToggle);
      logPrettyEl.appendChild(traceBody);

      i = j;
    }
  }

  if (logLines.length === 0) {
    logPrettyEl.innerHTML = '<div class="log-no-results">Log is empty.</div>';
  }

  // Raw view
  logRawEl.textContent = logText;

  // ---- Filtering ----

  var currentLevel = 'all';
  var currentSearch = '';

  function applyFilter() {
    var q = currentSearch.toLowerCase();
    var matchCount = 0;
    var total = 0;

    lineNodes.forEach(function (item) {
      // Skip lines inside collapsed trace blocks from the count perspective.
      if (item.traceEl) return;

      total++;
      var levelOk = (currentLevel === 'all') || (item.level === currentLevel);
      var textOk = !q || item.text.toLowerCase().indexOf(q) !== -1;
      var visible = levelOk && textOk;
      item.el.classList.toggle('hidden', !visible);
      if (visible) matchCount++;
    });

    var visEl = document.getElementById('log-visible-count');
    if (q || currentLevel !== 'all') {
      visEl.textContent = '(' + matchCount + ' of ' + total + ' shown)';
    } else {
      visEl.textContent = '';
    }

    // Show "no results" message if all hidden.
    var existingNoResults = logPrettyEl.querySelector('.log-no-results');
    if (matchCount === 0 && total > 0) {
      if (!existingNoResults) {
        var msg = document.createElement('div');
        msg.className = 'log-no-results';
        msg.textContent = 'No lines match the current filter.';
        logPrettyEl.appendChild(msg);
      }
    } else if (existingNoResults) {
      existingNoResults.remove();
    }
  }

  // Search input
  document.getElementById('search-input').addEventListener('input', function (e) {
    currentSearch = e.target.value;
    applyFilter();
  });

  // Level buttons
  document.querySelectorAll('.level-btn').forEach(function (btn) {
    btn.addEventListener('click', function () {
      document.querySelectorAll('.level-btn').forEach(function (b) { b.classList.remove('active'); });
      btn.classList.add('active');
      currentLevel = btn.dataset.level;
      applyFilter();
    });
  });

  // View toggle (pretty / raw)
  document.querySelectorAll('.view-btn').forEach(function (btn) {
    btn.addEventListener('click', function () {
      document.querySelectorAll('.view-btn').forEach(function (b) { b.classList.remove('active'); });
      btn.classList.add('active');
      var view = btn.dataset.view;
      logPrettyEl.classList.toggle('active', view === 'pretty');
      logRawEl.classList.toggle('active', view === 'raw');
    });
  });

  // Copy log button
  document.getElementById('log-copy-btn').addEventListener('click', function () {
    if (navigator.clipboard) {
      navigator.clipboard.writeText(logText).then(function () { toast('Log copied'); }).catch(function () { toast('Copy failed'); });
    } else {
      toast('Clipboard not available');
    }
  });

})();
