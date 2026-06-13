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

  // ---- Counts bar ----

  var counts = data.counts || {};
  document.getElementById('cnt-error').textContent = counts.error || 0;
  document.getElementById('cnt-warn').textContent = counts.warn || 0;
  document.getElementById('cnt-log').textContent = counts.log || 0;

  var metaParts = [];
  if (data.platform) metaParts.push(data.platform);
  if (data.appVersion) metaParts.push(data.appVersion);
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

  // Detect stack trace continuation lines (indented or starting with "at ").
  function isTraceLine(line) {
    return /^(\s+at\s|\s{2,}UnityEngine\.|  \[0x)/.test(line);
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
