'use strict';

// FastLogs - catalog (browse) page.
//
// Single page served (as the HTML shell) at all three catalog routes; it reads
// window.location.pathname to decide which view to render:
//
//   /browse                     - list all projects
//   /browse/:appId              - list versions of one project
//   /browse/:appId/crashes      - crash groups for one project (by signature)
//   /browse/:appId/:version     - list logs of one app+version
//
// It fetches the JSON form of the SAME endpoints (with ?format=json so the
// server returns JSON instead of this HTML shell):
//
//   GET /browse?format=json                    -> { projects: [{ appId, name, enabled, engine, totalBytes, logCount, pinnedCount }], totals }
//   GET /browse/:appId?format=json             -> { appId, name, versions: [{ version, count, logCount, totalBytes, pinnedCount, lastAt }], totals, largestLogs }
//   GET /browse/:appId/crashes?format=json     -> { appId, name, latestVersion, crashes: [{ sig, signature, title, platform, count, testers, versions, firstSeenVersion, lastSeenVersion, isNew, kind, sampleLogId }] }
//   GET /browse/:appId/:version?format=json    -> { appId, name, version, logs: [{ id, title, time, createdAt, platform, counts:{error,warn,log}, logBytes, hasScreenshot, pinned, status, tags, engine, expiresAt }] }
//
// Catalog access is team-gated. The viewer token is supplied as ?token=... in
// the URL; we forward it on every fetch and preserve it across navigation.

(function () {
  // ---- Routing ----

  // Parse the current pathname to determine which view to render.
  // Expected patterns: /browse, /browse/:appId, /browse/:appId/:version
  var pathname = window.location.pathname;
  var parts = pathname.replace(/^\/browse\/?/, '').split('/').filter(Boolean);
  var appId = parts[0] ? decodeURIComponent(parts[0]) : null;
  // The crashes view is the special path [appId, 'crashes'] (exactly two parts).
  var isCrashes = parts.length === 2 && parts[1] === 'crashes';
  // Version may itself contain encoded slashes; join the remaining parts.
  // (Never treated as a version when this is the crashes view.)
  var version = (!isCrashes && parts.length > 1) ? decodeURIComponent(parts.slice(1).join('/')) : null;

  // Preserve the query string for auth token forwarding (e.g. "?token=xyz").
  var qs = window.location.search;

  // The FastLogs logo returns to the projects home, carrying the token so the
  // catalog stays authorized (a bare /browse would 401).
  var logoEl = document.querySelector('.topbar-logo');
  if (logoEl) logoEl.setAttribute('href', '/browse' + qs);

  // Build a JSON-API URL: force ?format=json and carry over ?token=.
  function apiUrl(path) {
    var sp = new URLSearchParams(window.location.search);
    sp.set('format', 'json');
    return path + '?' + sp.toString();
  }

  // ---- Utility: fetch JSON with error handling ----

  function fetchJson(path) {
    return fetch(apiUrl(path), { headers: { 'Accept': 'application/json' } }).then(function (r) {
      if (r.status === 401 || r.status === 403) {
        throw new Error('auth_required');
      }
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    });
  }

  // ---- Utility: format date ----

  function fmtDate(isoStr) {
    if (!isoStr) return '';
    try { return new Date(isoStr).toLocaleString(); } catch (e) { return isoStr; }
  }

  // ---- Utility: format byte size ----

  function fmtBytes(n) {
    if (n === null || n === undefined || isNaN(n) || n < 0) return '';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / (1024 * 1024)).toFixed(1) + ' MB';
  }

  // ---- Utility: escape HTML ----

  function esc(str) {
    if (str === null || str === undefined) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // Build an in-app link that preserves the auth token query string.
  function withQs(path) {
    return path + (qs || '');
  }

  // ---- Utility: status badge ----

  // Map a triage status enum to a display label. Unknown/missing -> 'new'.
  var STATUS_LABELS = {
    'new': 'New',
    'triaged': 'Triaged',
    'in_progress': 'In progress',
    'fixed': 'Fixed',
    'wontfix': "Won't fix",
  };

  // Build the HTML for a status badge. The status is one of the known enum
  // values; anything else falls back to 'new'. The label goes through esc()
  // for safety even though it comes from our own fixed map.
  function statusBadge(status) {
    var s = STATUS_LABELS[status] ? status : 'new';
    return '<span class="badge-status badge-status-' + s + '">' + esc(STATUS_LABELS[s]) + '</span>';
  }

  // ---- Breadcrumbs ----

  function renderBreadcrumbs(appId, version, isCrashes) {
    var bc = document.getElementById('breadcrumbs');
    var html = '';
    if (!appId) {
      html = '<span class="crumb">Catalog</span>';
    } else if (isCrashes) {
      html =
        '<span class="crumb"><a href="' + withQs('/browse') + '">Catalog</a></span>' +
        '<span class="crumb-sep">/</span>' +
        '<span class="crumb"><a href="' + withQs('/browse/' + encodeURIComponent(appId)) + '">' + esc(appId) + '</a></span>' +
        '<span class="crumb-sep">/</span>' +
        '<span class="crumb">Crashes</span>';
    } else if (!version) {
      html =
        '<span class="crumb"><a href="' + withQs('/browse') + '">Catalog</a></span>' +
        '<span class="crumb-sep">/</span>' +
        '<span class="crumb">' + esc(appId) + '</span>';
    } else {
      html =
        '<span class="crumb"><a href="' + withQs('/browse') + '">Catalog</a></span>' +
        '<span class="crumb-sep">/</span>' +
        '<span class="crumb"><a href="' + withQs('/browse/' + encodeURIComponent(appId)) + '">' + esc(appId) + '</a></span>' +
        '<span class="crumb-sep">/</span>' +
        '<span class="crumb">' + esc(version) + '</span>';
    }
    bc.innerHTML = html;
  }

  // ---- Content area ----

  var contentEl = document.getElementById('content');

  function showError(msg) {
    contentEl.innerHTML = '<div class="error-state">' + esc(msg) + '</div>';
  }

  function showEmpty(msg) {
    contentEl.innerHTML = '<div class="empty-state">' + esc(msg) + '</div>';
  }

  // ---- View: Projects list (GET /browse) ----

  function renderProjects(projects, totals) {
    var filterInput = document.getElementById('filter-input');
    filterInput.placeholder = 'Filter projects...';

    if (!projects || projects.length === 0) {
      showEmpty('No projects found.');
      return;
    }

    contentEl.innerHTML = '';

    // Totals rollup line above the cards (storage dashboard).
    if (totals) {
      var summary = document.createElement('div');
      summary.className = 'stats-summary';
      summary.id = 'stats-summary';
      summary.innerHTML =
        '<span><strong>' + esc(fmtBytes(totals.totalBytes) || '0 B') + '</strong> total</span>' +
        '<span><strong>' + (totals.logCount || 0) + '</strong> logs</span>' +
        '<span><strong>' + (totals.pinnedCount || 0) + '</strong> pinned</span>';
      contentEl.appendChild(summary);
    }

    var cards = document.createElement('div');
    cards.className = 'cards';
    cards.id = 'cards-wrap';

    projects.forEach(function (p) {
      var id = p.appId || '';
      var name = p.name || id;
      var card = document.createElement('a');
      card.className = 'card';
      card.href = withQs('/browse/' + encodeURIComponent(id));

      // Per-project meta: size, log count, pinned count, plus an engine badge.
      var size = fmtBytes(p.totalBytes);
      var metaParts = [];
      if (size) metaParts.push(size);
      metaParts.push((p.logCount || 0) + ' log' + ((p.logCount || 0) !== 1 ? 's' : ''));
      if (p.pinnedCount) metaParts.push(p.pinnedCount + ' pinned');
      if (p.enabled === false) metaParts.push('disabled');

      var engineHtml = p.engine ? '<span class="engine-badge">' + esc(p.engine) + '</span>' : '';

      card.innerHTML =
        '<div class="card-id">' + esc(id) + '</div>' +
        '<div class="card-name">' + esc(name) + '</div>' +
        '<div class="card-meta">' + esc(metaParts.join(' · ')) + (engineHtml ? ' ' + engineHtml : '') + '</div>';
      cards.appendChild(card);
    });

    contentEl.appendChild(cards);

    filterInput.addEventListener('input', function () {
      var q = filterInput.value.toLowerCase();
      cards.querySelectorAll('.card').forEach(function (card) {
        var text = card.textContent.toLowerCase();
        card.style.display = !q || text.indexOf(q) !== -1 ? '' : 'none';
      });
    });
  }

  // ---- View: Versions list (GET /browse/:appId) ----

  function renderVersions(appId, versions, totals, largestLogs) {
    var filterInput = document.getElementById('filter-input');
    filterInput.placeholder = 'Filter versions...';

    if (!versions || versions.length === 0) {
      showEmpty('No versions found for ' + appId + '.');
      return;
    }

    contentEl.innerHTML = '';

    // One link to the grouped crashes view for this app.
    var crashesLink = document.createElement('a');
    crashesLink.className = 'crashes-link';
    crashesLink.href = withQs('/browse/' + encodeURIComponent(appId) + '/crashes');
    crashesLink.textContent = 'View crashes (grouped)';
    contentEl.appendChild(crashesLink);

    // App-wide totals rollup.
    if (totals) {
      var summary = document.createElement('div');
      summary.className = 'stats-summary';
      summary.id = 'stats-summary';
      summary.innerHTML =
        '<span><strong>' + esc(fmtBytes(totals.totalBytes) || '0 B') + '</strong> total</span>' +
        '<span><strong>' + (totals.logCount || 0) + '</strong> logs</span>' +
        '<span><strong>' + (totals.pinnedCount || 0) + '</strong> pinned</span>';
      contentEl.appendChild(summary);
    }

    var list = document.createElement('div');
    list.className = 'versions-list';
    list.id = 'versions-wrap';

    versions.forEach(function (v) {
      var ver = v.version || '';
      var row = document.createElement('a');
      row.className = 'version-row';
      row.href = withQs('/browse/' + encodeURIComponent(appId) + '/' + encodeURIComponent(ver));
      var count = (v.count != null ? v.count : v.logCount) || 0;
      var size = fmtBytes(v.totalBytes);
      var metaParts = [];
      if (size) metaParts.push(size);
      if (v.pinnedCount) metaParts.push(v.pinnedCount + ' pinned');
      row.innerHTML =
        '<span class="version-tag">' + esc(ver) + '</span>' +
        '<span class="version-count">' + count + ' log' + (count !== 1 ? 's' : '') + '</span>' +
        (metaParts.length ? '<span class="version-count">' + esc(metaParts.join(' · ')) + '</span>' : '') +
        '<span class="version-last">' + esc(fmtDate(v.lastAt)) + '</span>';
      list.appendChild(row);
    });

    contentEl.appendChild(list);

    // "Largest logs" panel (top-N biggest logs for this app); each links to /:id.
    if (largestLogs && largestLogs.length) {
      var panel = document.createElement('div');
      panel.className = 'largest-logs';
      var titleEl = document.createElement('div');
      titleEl.className = 'largest-logs-title';
      titleEl.textContent = 'Largest logs';
      panel.appendChild(titleEl);

      largestLogs.forEach(function (lg) {
        var lid = lg.id || '';
        var lrow = document.createElement('a');
        lrow.className = 'largest-log-row';
        lrow.href = withQs('/' + encodeURIComponent(lid));
        lrow.target = '_blank';
        lrow.innerHTML =
          '<span class="largest-log-title" title="' + esc(lg.title || '') + '">' + esc(lg.title || '(no title)') + '</span>' +
          '<span class="largest-log-ver">' + esc(lg.version || '') + '</span>' +
          '<span class="largest-log-size">' + esc(fmtBytes(lg.logBytes)) + '</span>';
        panel.appendChild(lrow);
      });
      contentEl.appendChild(panel);
    }

    filterInput.addEventListener('input', function () {
      var q = filterInput.value.toLowerCase();
      list.querySelectorAll('.version-row').forEach(function (row) {
        var text = row.textContent.toLowerCase();
        row.style.display = !q || text.indexOf(q) !== -1 ? '' : 'none';
      });
    });
  }

  // ---- View: Logs list (GET /browse/:appId/:version) ----

  function renderLogs(appId, version, logs) {
    var filterInput = document.getElementById('filter-input');
    filterInput.placeholder = 'Search by title...';

    // Grab every filter/sort control once, up front.
    var platformSelect = document.getElementById('platform-select');
    var levelSelect = document.getElementById('level-select');
    var statusSelect = document.getElementById('status-select');
    var sortSelect = document.getElementById('sort-select');
    var errorsOnlyLabel = document.getElementById('errors-only-label');
    var errorsOnlyCb = document.getElementById('errors-only-cb');

    // Reveal all of them and reset the new controls to defaults on entry (the
    // shell is shared across views, so a value could linger from a back/forward).
    platformSelect.style.display = '';
    levelSelect.style.display = '';
    statusSelect.style.display = '';
    sortSelect.style.display = '';
    errorsOnlyLabel.style.display = '';
    statusSelect.value = '';
    sortSelect.value = 'newest';
    errorsOnlyCb.checked = false;

    if (!logs || logs.length === 0) {
      showEmpty('No logs found.');
      return;
    }

    // Collect unique platforms.
    var platforms = {};
    logs.forEach(function (log) { if (log.platform) platforms[log.platform] = true; });
    Object.keys(platforms).sort().forEach(function (p) {
      var opt = document.createElement('option');
      opt.value = p; opt.textContent = p;
      platformSelect.appendChild(opt);
    });

    // Build table.
    var wrap = document.createElement('div');
    wrap.className = 'logs-table-wrap';

    var table = document.createElement('table');
    table.className = 'logs-table';
    table.innerHTML =
      '<thead><tr>' +
      '<th>ID</th>' +
      '<th>Title</th>' +
      '<th>Platform</th>' +
      '<th>E / W / L</th>' +
      '<th>Size</th>' +
      '<th>Status</th>' +
      '<th>Time</th>' +
      '<th>Pin</th>' +
      '</tr></thead>';

    var tbody = document.createElement('tbody');

    logs.forEach(function (log) {
      var id = log.id || '';
      var counts = log.counts || {};
      var cntE = counts.error != null ? counts.error : 0;
      var cntW = counts.warn != null ? counts.warn : 0;
      var cntL = counts.log != null ? counts.log : 0;
      var status = log.status || 'new';

      // Epoch ms for sorting (newest/oldest). Fall back to 0 if unparseable.
      var timeStr = log.time || log.createdAt;
      var timeMs = timeStr ? Date.parse(timeStr) : NaN;
      if (isNaN(timeMs)) timeMs = 0;
      var bytes = (log.logBytes != null && !isNaN(log.logBytes)) ? log.logBytes : 0;

      // Small engine label next to the platform; blank when null.
      var engineHtml = log.engine ? ' <span class="engine-badge">' + esc(log.engine) + '</span>' : '';

      var tr = document.createElement('tr');
      tr.dataset.platform = log.platform || '';
      tr.dataset.error = cntE;
      tr.dataset.warn = cntW;
      tr.dataset.title = (log.title || '').toLowerCase();
      tr.dataset.status = status;
      tr.dataset.timeMs = timeMs;
      tr.dataset.logBytes = bytes;

      tr.innerHTML =
        '<td class="td-id"><a href="' + withQs('/' + encodeURIComponent(id)) + '" target="_blank">' + esc(id) + '</a></td>' +
        '<td class="td-title"><span class="td-title-text" title="' + esc(log.title || '') + '">' + esc(log.title || '(no title)') + '</span></td>' +
        '<td class="td-platform">' + esc(log.platform || '') + engineHtml + '</td>' +
        '<td class="td-counts"><span class="count-e">' + cntE + '</span> / <span class="count-w">' + cntW + '</span> / <span class="count-l">' + cntL + '</span></td>' +
        '<td class="td-size">' + esc(fmtBytes(log.logBytes)) + '</td>' +
        '<td class="td-status">' + statusBadge(status) + '</td>' +
        '<td class="td-time">' + esc(fmtDate(log.time || log.createdAt)) + '</td>' +
        '<td class="td-pin">' + (log.pinned ? '<span class="badge-pin">pinned</span>' : '') + '</td>';

      tr.addEventListener('click', function (e) {
        // Don't intercept clicks on links inside the row.
        if (e.target.tagName === 'A') return;
        window.open(withQs('/' + encodeURIComponent(id)), '_blank');
      });

      tbody.appendChild(tr);
    });

    table.appendChild(tbody);
    wrap.appendChild(table);
    contentEl.innerHTML = '';
    contentEl.appendChild(wrap);

    // One merged filter + sort pass. Filters by title / platform / level /
    // errors-only / status, hiding non-matching rows, then sorts the still-
    // visible rows and re-appends them so the DOM order reflects the chosen sort.
    function applyFilters() {
      var q = filterInput.value.toLowerCase();
      var pf = platformSelect.value;
      var lv = levelSelect.value;
      var st = statusSelect.value;
      var errorsOnly = errorsOnlyCb.checked;
      var sortBy = sortSelect.value;

      var rows = Array.prototype.slice.call(tbody.querySelectorAll('tr'));

      rows.forEach(function (tr) {
        var errCount = parseInt(tr.dataset.error, 10) || 0;
        var titleOk = !q || tr.dataset.title.indexOf(q) !== -1;
        var pfOk = !pf || tr.dataset.platform === pf;
        var lvOk = true;
        if (lv === 'error') lvOk = errCount > 0;
        else if (lv === 'warn') lvOk = (parseInt(tr.dataset.warn, 10) || 0) > 0;
        var errOnlyOk = !errorsOnly || errCount > 0;
        var stOk = !st || tr.dataset.status === st;
        tr.classList.toggle('hidden', !(titleOk && pfOk && lvOk && errOnlyOk && stOk));
      });

      // Sort the currently-visible rows, then re-append in order. Hidden rows
      // keep their relative position at the end (they are display:none anyway).
      var visible = rows.filter(function (tr) { return !tr.classList.contains('hidden'); });
      visible.sort(function (a, b) {
        if (sortBy === 'oldest') {
          return (parseFloat(a.dataset.timeMs) || 0) - (parseFloat(b.dataset.timeMs) || 0);
        }
        if (sortBy === 'errors') {
          return (parseInt(b.dataset.error, 10) || 0) - (parseInt(a.dataset.error, 10) || 0);
        }
        if (sortBy === 'largest') {
          return (parseFloat(b.dataset.logBytes) || 0) - (parseFloat(a.dataset.logBytes) || 0);
        }
        // Default: newest first.
        return (parseFloat(b.dataset.timeMs) || 0) - (parseFloat(a.dataset.timeMs) || 0);
      });
      visible.forEach(function (tr) { tbody.appendChild(tr); });
    }

    filterInput.addEventListener('input', applyFilters);
    platformSelect.addEventListener('change', applyFilters);
    levelSelect.addEventListener('change', applyFilters);
    statusSelect.addEventListener('change', applyFilters);
    sortSelect.addEventListener('change', applyFilters);
    errorsOnlyCb.addEventListener('change', applyFilters);
  }

  // ---- View: Crash groups (GET /browse/:appId/crashes) ----

  function renderCrashes(appId, crashes) {
    var filterInput = document.getElementById('filter-input');
    filterInput.placeholder = 'Filter crashes...';

    if (!crashes || crashes.length === 0) {
      showEmpty('No crashes found for ' + appId + '.');
      return;
    }

    var wrap = document.createElement('div');
    wrap.className = 'logs-table-wrap';

    var table = document.createElement('table');
    table.className = 'logs-table';
    table.innerHTML =
      '<thead><tr>' +
      '<th>Signature</th>' +
      '<th>Title</th>' +
      '<th>Platform</th>' +
      '<th>Count</th>' +
      '<th>Testers</th>' +
      '<th>Versions</th>' +
      '<th>First seen</th>' +
      '<th>Last seen</th>' +
      '<th>Badge</th>' +
      '</tr></thead>';

    var tbody = document.createElement('tbody');

    crashes.forEach(function (c) {
      var sampleId = c.sampleLogId || '';
      var sig = c.signature || c.sig || '';
      var title = c.title || c.sampleTitle || '';
      var versionsStr = (c.versions || []).join(', ');

      // Badge cell: green NEW pill or red REGRESSION pill for flagged groups.
      var badgeHtml = '';
      if (c.isNew) {
        if (c.kind === 'new') {
          badgeHtml = '<span class="badge-new">NEW in ' + esc(c.firstSeenVersion || '') + '</span>';
        } else if (c.kind === 'regression') {
          badgeHtml = '<span class="badge-regression">REGRESSION in ' + esc(c.lastSeenVersion || '') + '</span>';
        }
      }

      var tr = document.createElement('tr');
      tr.dataset.title = (title + ' ' + sig).toLowerCase();

      tr.innerHTML =
        '<td class="td-sig" title="' + esc(sig) + '">' + esc(sig) + '</td>' +
        '<td class="td-title"><span class="td-title-text" title="' + esc(title) + '">' + esc(title || '(no title)') + '</span></td>' +
        '<td class="td-platform">' + esc(c.platform || '') + '</td>' +
        '<td class="td-counts">' + (c.count != null ? c.count : 0) + '</td>' +
        '<td class="td-counts">' + (c.testers != null ? c.testers : 0) + '</td>' +
        '<td class="td-platform">' + esc(versionsStr) + '</td>' +
        '<td class="td-platform">' + esc(c.firstSeenVersion || '') + '</td>' +
        '<td class="td-platform">' + esc(c.lastSeenVersion || '') + '</td>' +
        '<td class="td-status">' + badgeHtml + '</td>';

      // Open the sample log for this group in a new tab (same per-id pattern).
      if (sampleId) {
        tr.addEventListener('click', function (e) {
          if (e.target.tagName === 'A') return;
          window.open(withQs('/' + encodeURIComponent(sampleId)), '_blank');
        });
      } else {
        tr.style.cursor = 'default';
      }

      tbody.appendChild(tr);
    });

    table.appendChild(tbody);
    wrap.appendChild(table);
    contentEl.innerHTML = '';
    contentEl.appendChild(wrap);

    // Simple title/signature substring filter (reuses the dataset.title field).
    filterInput.addEventListener('input', function () {
      var q = filterInput.value.toLowerCase();
      tbody.querySelectorAll('tr').forEach(function (tr) {
        tr.classList.toggle('hidden', !(!q || tr.dataset.title.indexOf(q) !== -1));
      });
    });
  }

  // ---- Main: route and fetch ----

  renderBreadcrumbs(appId, version, isCrashes);

  if (!appId) {
    // Root: list projects.
    document.title = 'FastLogs - Catalog';
    fetchJson('/browse')
      .then(function (data) { renderProjects((data && data.projects) || [], data && data.totals); })
      .catch(function (err) {
        if (err.message === 'auth_required') showError('Authentication required. Pass ?token= in the URL.');
        else showError('Failed to load projects: ' + err.message);
      });

  } else if (isCrashes) {
    // Crash groups for one app.
    document.title = 'FastLogs - ' + appId + ' / Crashes';
    fetchJson('/browse/' + encodeURIComponent(appId) + '/crashes')
      .then(function (data) { renderCrashes(appId, (data && data.crashes) || []); })
      .catch(function (err) {
        if (err.message === 'auth_required') showError('Authentication required. Pass ?token= in the URL.');
        else showError('Failed to load crashes: ' + err.message);
      });

  } else if (!version) {
    // Versions list.
    document.title = 'FastLogs - ' + appId;
    fetchJson('/browse/' + encodeURIComponent(appId))
      .then(function (data) {
        renderVersions(appId, (data && data.versions) || [], data && data.totals, (data && data.largestLogs) || []);
      })
      .catch(function (err) {
        if (err.message === 'auth_required') showError('Authentication required. Pass ?token= in the URL.');
        else showError('Failed to load versions: ' + err.message);
      });

  } else {
    // Logs list.
    document.title = 'FastLogs - ' + appId + ' / ' + version;
    fetchJson('/browse/' + encodeURIComponent(appId) + '/' + encodeURIComponent(version))
      .then(function (data) { renderLogs(appId, version, (data && data.logs) || []); })
      .catch(function (err) {
        if (err.message === 'auth_required') showError('Authentication required. Pass ?token= in the URL.');
        else showError('Failed to load logs: ' + err.message);
      });
  }

})();
