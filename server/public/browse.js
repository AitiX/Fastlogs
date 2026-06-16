'use strict';

// FastLogs - catalog (browse) page.
//
// Single page served (as the HTML shell) at all three catalog routes; it reads
// window.location.pathname to decide which view to render:
//
//   /browse                     - list all projects
//   /browse/:appId              - list versions of one project
//   /browse/:appId/crashes      - crash groups for one project (by signature)
//   /browse/:appId/pinned       - pinned logs of one project (across versions)
//   /browse/:appId/:version     - list logs of one app+version
//
// It fetches the JSON form of the SAME endpoints (with ?format=json so the
// server returns JSON instead of this HTML shell):
//
//   GET /browse?format=json                    -> { projects: [{ appId, name, enabled, engine, totalBytes, logCount, pinnedCount }], totals }
//   GET /browse/:appId?format=json             -> { appId, name, versions: [{ version, count, logCount, totalBytes, pinnedCount, lastAt }], totals, largestLogs }
//   GET /browse/:appId/crashes?format=json     -> { appId, name, latestVersion, crashes: [{ sig, signature, title, platform, count, testers, versions, firstSeenVersion, lastSeenVersion, isNew, kind, sampleLogId }] }
//   GET /browse/:appId/pinned?format=json      -> { appId, name, logs: [{ id, title, time, createdAt, platform, counts:{error,warn,log}, logBytes, hasScreenshot, pinned, status, tags, engine, version, expiresAt }] }
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
  // The pinned view is the special path [appId, 'pinned'] (exactly two parts):
  // all pinned logs of the app across every version, in one place.
  var isPinned = parts.length === 2 && parts[1] === 'pinned';
  // Version may itself contain encoded slashes; join the remaining parts.
  // (Never treated as a version when this is the crashes or pinned view.)
  var version = (!isCrashes && !isPinned && parts.length > 1) ? decodeURIComponent(parts.slice(1).join('/')) : null;

  // Preserve the query string for auth token forwarding (e.g. "?token=xyz").
  var qs = window.location.search;

  // App-level query modifiers (only meaningful on /browse/:appId): a full-text
  // search query (?q=) and a session filter (?session=). These pick a special
  // view of one app without a new path segment.
  var searchParams = new URLSearchParams(window.location.search);
  var searchQuery = (appId && !version && !isCrashes && !isPinned) ? (searchParams.get('q') || '') : '';
  var sessionId = (appId && !version && !isCrashes && !isPinned) ? (searchParams.get('session') || '') : '';

  // Persist the viewer token. The catalog is server-gated, so this page always
  // arrives with ?token=...; storing it lets a later token-less log link (the
  // viewer reads the same fallback) still reach the team-gated catalog via the
  // FastLogs logo. localStorage may be unavailable (private mode) - tolerate.
  try {
    var __catalogToken = searchParams.get('token');
    if (__catalogToken) localStorage.setItem('fastlogs_token', __catalogToken);
  } catch (e) { /* storage blocked - no persistence */ }

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

  // Build a /api/search URL: explicit appId + q, carrying over the token.
  function searchApiUrl(appId, q) {
    var sp = new URLSearchParams();
    var t = searchParams.get('token');
    if (t) sp.set('token', t);
    sp.set('appId', appId);
    sp.set('q', q);
    return '/api/search?' + sp.toString();
  }

  // POST a folder move for a selection of logs. Carries the viewer token as
  // ?token= (same auth path the catalog already uses) and sends the appId, the
  // selected ids and the target folder ('' = root). Resolves with the server's
  // { appId, folder, moved } response, rejects with an Error on a non-2xx.
  function moveLogsToFolder(appId, ids, folder) {
    var sp = new URLSearchParams();
    var t = searchParams.get('token');
    if (t) sp.set('token', t);
    var url = '/api/folders/move' + (sp.toString() ? '?' + sp.toString() : '');
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({ appId: appId, ids: ids, folder: folder }),
    }).then(function (r) {
      if (r.status === 401 || r.status === 403) throw new Error('auth required');
      return r.json().then(function (data) {
        if (!r.ok) throw new Error((data && data.message) || ('HTTP ' + r.status));
        return data;
      }, function () {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return {};
      });
    });
  }

  // ---- Utility: fetch JSON with error handling ----

  function fetchJson(path) {
    return fetchJsonRaw(apiUrl(path));
  }

  // Fetch JSON from an already-built URL (used for /api/search, which carries
  // its own appId/q/token rather than the page query string).
  function fetchJsonRaw(url) {
    return fetch(url, { headers: { 'Accept': 'application/json' } }).then(function (r) {
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

  // A token-only query string ("?token=xyz" or ""), for links that must NOT
  // carry over ?q= / ?session= (e.g. the breadcrumb back to the app home).
  function tokenQs() {
    var t = searchParams.get('token');
    return t ? '?token=' + encodeURIComponent(t) : '';
  }

  // Link to one app's version list (drops any q/session, keeps the token).
  function appHomeHref(appId) {
    return '/browse/' + encodeURIComponent(appId) + tokenQs();
  }

  // ---- Breadcrumbs ----

  function renderBreadcrumbs(appId, version, isCrashes, isPinned) {
    var bc = document.getElementById('breadcrumbs');
    var catalog = '<span class="crumb"><a href="' + withQs('/browse') + '">Catalog</a></span>';
    var sep = '<span class="crumb-sep">/</span>';
    var html = '';
    if (!appId) {
      html = '<span class="crumb">Catalog</span>';
    } else if (isCrashes) {
      html = catalog + sep +
        '<span class="crumb"><a href="' + appHomeHref(appId) + '">' + esc(appId) + '</a></span>' +
        sep + '<span class="crumb">Crashes</span>';
    } else if (isPinned) {
      html = catalog + sep +
        '<span class="crumb"><a href="' + appHomeHref(appId) + '">' + esc(appId) + '</a></span>' +
        sep + '<span class="crumb">Pinned</span>';
    } else if (searchQuery) {
      html = catalog + sep +
        '<span class="crumb"><a href="' + appHomeHref(appId) + '">' + esc(appId) + '</a></span>' +
        sep + '<span class="crumb">Search</span>';
    } else if (sessionId) {
      html = catalog + sep +
        '<span class="crumb"><a href="' + appHomeHref(appId) + '">' + esc(appId) + '</a></span>' +
        sep + '<span class="crumb">Session</span>';
    } else if (!version) {
      html = catalog + sep + '<span class="crumb">' + esc(appId) + '</span>';
    } else {
      html = catalog + sep +
        '<span class="crumb"><a href="' + appHomeHref(appId) + '">' + esc(appId) + '</a></span>' +
        sep + '<span class="crumb">' + esc(version) + '</span>';
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

    // Full-text search box: navigates to /browse/:appId?q=... (server search
    // across this app's logs). Submitting an empty box goes back to versions.
    var searchForm = document.createElement('form');
    searchForm.className = 'search-form';
    searchForm.innerHTML =
      '<input class="search-box" type="search" placeholder="Search all logs of ' + esc(appId) + ' (title, comment, tester, context, body)...">' +
      '<button class="search-go" type="submit">Search</button>';
    var searchBox = searchForm.querySelector('.search-box');
    searchForm.addEventListener('submit', function (e) {
      e.preventDefault();
      var q = searchBox.value.trim();
      var dest = '/browse/' + encodeURIComponent(appId) + tokenQs();
      if (q) dest += (tokenQs() ? '&' : '?') + 'q=' + encodeURIComponent(q);
      window.location.href = dest;
    });
    contentEl.appendChild(searchForm);

    // One link to the grouped crashes view for this app.
    var crashesLink = document.createElement('a');
    crashesLink.className = 'crashes-link';
    crashesLink.href = withQs('/browse/' + encodeURIComponent(appId) + '/crashes');
    crashesLink.textContent = 'View crashes (grouped)';
    contentEl.appendChild(crashesLink);

    // One link to the pinned view for this app: all pinned logs (auto-pinned by a
    // Redmine task + any manually pinned) gathered across versions. The count is
    // the app-level pinned total (totals.pinnedCount), so the link advertises how
    // many there are before the click. Carries the token like every catalog link.
    var pinnedTotal = (totals && totals.pinnedCount) || 0;
    var pinnedLink = document.createElement('a');
    pinnedLink.className = 'crashes-link';
    pinnedLink.href = withQs('/browse/' + encodeURIComponent(appId) + '/pinned');
    pinnedLink.textContent = 'Pinned (' + pinnedTotal + ')';
    contentEl.appendChild(pinnedLink);

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
    var folderSelect = document.getElementById('folder-select');
    var errorsOnlyLabel = document.getElementById('errors-only-label');
    var errorsOnlyCb = document.getElementById('errors-only-cb');

    // Reset the new controls to defaults on entry (the shell is shared across
    // views, so a value could linger from a back/forward).
    statusSelect.value = '';
    sortSelect.value = 'newest';
    errorsOnlyCb.checked = false;
    folderSelect.innerHTML = '<option value="">All folders</option>';
    folderSelect.value = '';

    if (!logs || logs.length === 0) {
      showEmpty('No logs found.');
      return;
    }

    // Reveal the filter/sort controls only when there is something to act on.
    platformSelect.style.display = '';
    levelSelect.style.display = '';
    statusSelect.style.display = '';
    sortSelect.style.display = '';
    folderSelect.style.display = '';
    errorsOnlyLabel.style.display = '';

    // Build the folder filter from the folders present in the loaded logs:
    // "All folders" (default), "(root)" for the unfiled logs, then each distinct
    // path. The dropdown only filters the current view client-side.
    var folderSet = {};
    var hasRoot = false;
    logs.forEach(function (log) {
      if (log.folder) folderSet[log.folder] = true; else hasRoot = true;
    });
    if (hasRoot) {
      var rootOpt = document.createElement('option');
      rootOpt.value = ' root'; rootOpt.textContent = '(root)';
      folderSelect.appendChild(rootOpt);
    }
    Object.keys(folderSet).sort().forEach(function (f) {
      var opt = document.createElement('option');
      opt.value = f; opt.textContent = f;
      folderSelect.appendChild(opt);
    });

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
      '<th class="th-select"><input type="checkbox" id="select-all-cb" title="Select all visible"></th>' +
      '<th>ID</th>' +
      '<th>Title</th>' +
      '<th>Platform</th>' +
      '<th>E / W / L</th>' +
      '<th>Size</th>' +
      '<th>Folder</th>' +
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

      var folder = log.folder || '';

      var tr = document.createElement('tr');
      tr.dataset.platform = log.platform || '';
      tr.dataset.error = cntE;
      tr.dataset.warn = cntW;
      tr.dataset.title = (log.title || '').toLowerCase();
      tr.dataset.status = status;
      tr.dataset.timeMs = timeMs;
      tr.dataset.logBytes = bytes;
      tr.dataset.id = id;
      tr.dataset.folder = folder;

      var folderHtml = folder ? '<span class="folder-tag">' + esc(folder) + '</span>' : '';

      tr.innerHTML =
        '<td class="td-select"><input type="checkbox" class="row-select-cb"></td>' +
        '<td class="td-id"><a href="' + withQs('/' + encodeURIComponent(id)) + '" target="_blank">' + esc(id) + '</a></td>' +
        '<td class="td-title"><span class="td-title-text" title="' + esc(log.title || '') + '">' + esc(log.title || '(no title)') + '</span></td>' +
        '<td class="td-platform">' + esc(log.platform || '') + engineHtml + '</td>' +
        '<td class="td-counts"><span class="count-e">' + cntE + '</span> / <span class="count-w">' + cntW + '</span> / <span class="count-l">' + cntL + '</span></td>' +
        '<td class="td-size">' + esc(fmtBytes(log.logBytes)) + '</td>' +
        '<td class="td-folder">' + folderHtml + '</td>' +
        '<td class="td-status">' + statusBadge(status) + '</td>' +
        '<td class="td-time">' + esc(fmtDate(log.time || log.createdAt)) + '</td>' +
        '<td class="td-pin">' + (log.pinned ? '<span class="badge-pin">pinned</span>' : '') + '</td>';

      tr.addEventListener('click', function (e) {
        // Don't intercept clicks on links or the row-select checkbox.
        if (e.target.tagName === 'A') return;
        if (e.target.classList && e.target.classList.contains('row-select-cb')) return;
        if (e.target.closest && e.target.closest('.td-select')) return;
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
      var fd = folderSelect.value;
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
        // Folder filter: '' = all; ' root' (sentinel) = unfiled logs; else exact.
        var fdOk = true;
        if (fd === ' root') fdOk = !tr.dataset.folder;
        else if (fd) fdOk = tr.dataset.folder === fd;
        tr.classList.toggle('hidden', !(titleOk && pfOk && lvOk && errOnlyOk && stOk && fdOk));
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

    // After a filter pass, drop the selection on now-hidden rows (a hidden row
    // must not be silently moved) and refresh the selection toolbar.
    function applyFiltersAndSync() {
      applyFilters();
      tbody.querySelectorAll('tr.hidden .row-select-cb').forEach(function (cb) { cb.checked = false; });
      syncSelection();
    }

    filterInput.addEventListener('input', applyFiltersAndSync);
    platformSelect.addEventListener('change', applyFiltersAndSync);
    levelSelect.addEventListener('change', applyFiltersAndSync);
    statusSelect.addEventListener('change', applyFiltersAndSync);
    sortSelect.addEventListener('change', applyFiltersAndSync);
    folderSelect.addEventListener('change', applyFiltersAndSync);
    errorsOnlyCb.addEventListener('change', applyFiltersAndSync);

    // ---- Selection + Move-to-folder ----

    var folderBar = document.getElementById('folder-bar');
    var folderBarCount = document.getElementById('folder-bar-count');
    var folderMoveInput = document.getElementById('folder-move-input');
    var folderMoveBtn = document.getElementById('folder-move-btn');
    var folderBarMsg = document.getElementById('folder-bar-msg');
    var selectAllCb = document.getElementById('select-all-cb');
    var folderDatalist = document.getElementById('folder-datalist');

    // Offer the app's existing folders as datalist suggestions in the move box.
    folderDatalist.innerHTML = '';
    Object.keys(folderSet).sort().forEach(function (f) {
      var opt = document.createElement('option');
      opt.value = f;
      folderDatalist.appendChild(opt);
    });

    // The visible, currently-checked rows.
    function selectedRows() {
      return Array.prototype.slice.call(tbody.querySelectorAll('tr'))
        .filter(function (tr) {
          var cb = tr.querySelector('.row-select-cb');
          return cb && cb.checked && !tr.classList.contains('hidden');
        });
    }

    // Reflect the current selection in the toolbar (count, button state) and
    // show/hide the bar. Clears any stale status message.
    function syncSelection() {
      var n = selectedRows().length;
      folderBarCount.textContent = n + ' selected';
      folderMoveBtn.disabled = n === 0;
      folderBar.style.display = n > 0 ? '' : 'none';
      if (n === 0) { folderBarMsg.textContent = ''; folderBarMsg.className = 'folder-bar-msg'; }
    }

    selectAllCb.addEventListener('change', function () {
      tbody.querySelectorAll('tr').forEach(function (tr) {
        if (tr.classList.contains('hidden')) return;
        var cb = tr.querySelector('.row-select-cb');
        if (cb) cb.checked = selectAllCb.checked;
      });
      syncSelection();
    });

    tbody.addEventListener('change', function (e) {
      if (e.target && e.target.classList && e.target.classList.contains('row-select-cb')) {
        syncSelection();
      }
    });

    folderMoveBtn.addEventListener('click', function () {
      var rows = selectedRows();
      if (rows.length === 0) return;
      var ids = rows.map(function (tr) { return tr.dataset.id; });
      var target = folderMoveInput.value;

      folderMoveBtn.disabled = true;
      folderBarMsg.textContent = 'Moving...';
      folderBarMsg.className = 'folder-bar-msg';

      moveLogsToFolder(appId, ids, target)
        .then(function (data) {
          folderBarMsg.textContent = 'Moved ' + data.moved + ' log' + (data.moved !== 1 ? 's' : '') +
            (data.folder ? ' to ' + data.folder : ' to root');
          folderBarMsg.className = 'folder-bar-msg ok';
          // Reflect the new folder on each moved row in place (no full reload).
          var newFolder = data.folder || '';
          rows.forEach(function (tr) {
            tr.dataset.folder = newFolder;
            var cell = tr.querySelector('.td-folder');
            if (cell) cell.innerHTML = newFolder ? '<span class="folder-tag">' + esc(newFolder) + '</span>' : '';
            var cb = tr.querySelector('.row-select-cb');
            if (cb) cb.checked = false;
          });
          if (selectAllCb) selectAllCb.checked = false;
          // A brand-new folder should appear in the filter + datalist.
          if (newFolder && !folderSet[newFolder]) {
            folderSet[newFolder] = true;
            var opt = document.createElement('option');
            opt.value = newFolder; opt.textContent = newFolder;
            folderSelect.appendChild(opt);
            var dopt = document.createElement('option');
            dopt.value = newFolder;
            folderDatalist.appendChild(dopt);
          }
          syncSelection();
        })
        .catch(function (err) {
          folderBarMsg.textContent = 'Move failed: ' + err.message;
          folderBarMsg.className = 'folder-bar-msg err';
          folderMoveBtn.disabled = false;
        });
    });

    syncSelection();
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

  // ---- View: Pinned logs (GET /browse/:appId/pinned) ----

  // All pinned logs of one app across every version, newest first: the auto-
  // pinned (a log that spawned a Redmine task is pinned) plus any manually
  // pinned logs, gathered into one place. Mirrors the version-view log rows
  // (renderLogs): the same id/title/platform/counts/size/status/time/pin cells,
  // each opening the log in a new tab, with the same title/platform/level/status
  // filters + sort. Cross-version, so it shows a Version column in place of the
  // version view's Folder column and drops the folder Move toolbar (no folder
  // context here).
  function renderPinned(appId, logs) {
    var filterInput = document.getElementById('filter-input');
    filterInput.placeholder = 'Search by title...';

    var platformSelect = document.getElementById('platform-select');
    var levelSelect = document.getElementById('level-select');
    var statusSelect = document.getElementById('status-select');
    var sortSelect = document.getElementById('sort-select');

    // Reset the shared controls to defaults on entry (the shell is shared across
    // views, so a value could linger from a back/forward).
    statusSelect.value = '';
    sortSelect.value = 'newest';

    if (!logs || logs.length === 0) {
      showEmpty('No pinned logs for ' + appId + '.');
      return;
    }

    // Reveal the filter/sort controls only when there is something to act on.
    platformSelect.style.display = '';
    levelSelect.style.display = '';
    statusSelect.style.display = '';
    sortSelect.style.display = '';

    // Collect unique platforms.
    var platforms = {};
    logs.forEach(function (log) { if (log.platform) platforms[log.platform] = true; });
    Object.keys(platforms).sort().forEach(function (p) {
      var opt = document.createElement('option');
      opt.value = p; opt.textContent = p;
      platformSelect.appendChild(opt);
    });

    var wrap = document.createElement('div');
    wrap.className = 'logs-table-wrap';

    var table = document.createElement('table');
    table.className = 'logs-table';
    table.innerHTML =
      '<thead><tr>' +
      '<th>ID</th>' +
      '<th>Title</th>' +
      '<th>Version</th>' +
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

      var engineHtml = log.engine ? ' <span class="engine-badge">' + esc(log.engine) + '</span>' : '';

      var tr = document.createElement('tr');
      tr.dataset.platform = log.platform || '';
      tr.dataset.error = cntE;
      tr.dataset.warn = cntW;
      tr.dataset.title = (log.title || '').toLowerCase();
      tr.dataset.status = status;
      tr.dataset.timeMs = timeMs;
      tr.dataset.logBytes = bytes;
      tr.dataset.id = id;

      tr.innerHTML =
        '<td class="td-id"><a href="' + withQs('/' + encodeURIComponent(id)) + '" target="_blank">' + esc(id) + '</a></td>' +
        '<td class="td-title"><span class="td-title-text" title="' + esc(log.title || '') + '">' + esc(log.title || '(no title)') + '</span></td>' +
        '<td class="td-platform">' + esc(log.version || '') + '</td>' +
        '<td class="td-platform">' + esc(log.platform || '') + engineHtml + '</td>' +
        '<td class="td-counts"><span class="count-e">' + cntE + '</span> / <span class="count-w">' + cntW + '</span> / <span class="count-l">' + cntL + '</span></td>' +
        '<td class="td-size">' + esc(fmtBytes(log.logBytes)) + '</td>' +
        '<td class="td-status">' + statusBadge(status) + '</td>' +
        '<td class="td-time">' + esc(fmtDate(log.time || log.createdAt)) + '</td>' +
        '<td class="td-pin">' + (log.pinned ? '<span class="badge-pin">pinned</span>' : '') + '</td>';

      tr.addEventListener('click', function (e) {
        if (e.target.tagName === 'A') return;
        window.open(withQs('/' + encodeURIComponent(id)), '_blank');
      });

      tbody.appendChild(tr);
    });

    table.appendChild(tbody);
    wrap.appendChild(table);
    contentEl.innerHTML = '';
    contentEl.appendChild(wrap);

    // One merged filter + sort pass (mirrors renderLogs, minus the folder filter
    // and the selection sync, neither of which applies to the pinned overview).
    function applyFilters() {
      var q = filterInput.value.toLowerCase();
      var pf = platformSelect.value;
      var lv = levelSelect.value;
      var st = statusSelect.value;
      var sortBy = sortSelect.value;

      var rows = Array.prototype.slice.call(tbody.querySelectorAll('tr'));

      rows.forEach(function (tr) {
        var errCount = parseInt(tr.dataset.error, 10) || 0;
        var titleOk = !q || tr.dataset.title.indexOf(q) !== -1;
        var pfOk = !pf || tr.dataset.platform === pf;
        var lvOk = true;
        if (lv === 'error') lvOk = errCount > 0;
        else if (lv === 'warn') lvOk = (parseInt(tr.dataset.warn, 10) || 0) > 0;
        var stOk = !st || tr.dataset.status === st;
        tr.classList.toggle('hidden', !(titleOk && pfOk && lvOk && stOk));
      });

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
  }

  // ---- Shared: a catalog log-record table for the search + session views ----

  // Build a "link to all logs of this session" anchor for a row, or '' when the
  // log has no session. Carries the token so the catalog stays authorized.
  function sessionLink(appId, sid) {
    if (!sid) return '';
    var href = '/browse/' + encodeURIComponent(appId) + tokenQs() +
      (tokenQs() ? '&' : '?') + 'session=' + encodeURIComponent(sid);
    return '<a class="session-link" href="' + esc(href) + '" title="All logs of this session">session</a>';
  }

  // Render a list of catalog log records (id, title, time, platform, counts,
  // version, sessionId, optional snippet) as a table. `opts.showSnippet` adds a
  // snippet column (search results); `opts.showVersion` adds a version column.
  // Each row opens the log in a new tab; the session cell links to that
  // session's logs. A client-side substring filter (the shared filter input)
  // narrows by title/snippet.
  function renderResultLogs(appId, logs, opts) {
    opts = opts || {};
    var filterInput = document.getElementById('filter-input');
    filterInput.placeholder = 'Filter results...';

    if (!logs || logs.length === 0) {
      showEmpty(opts.emptyMsg || 'No logs found.');
      return;
    }

    var wrap = document.createElement('div');
    wrap.className = 'logs-table-wrap';
    var table = document.createElement('table');
    table.className = 'logs-table';
    table.innerHTML =
      '<thead><tr>' +
      '<th>ID</th>' +
      '<th>Title</th>' +
      (opts.showVersion ? '<th>Version</th>' : '') +
      '<th>Platform</th>' +
      '<th>E / W / L</th>' +
      (opts.showSnippet ? '<th>Match</th>' : '') +
      '<th>Session</th>' +
      '<th>Time</th>' +
      '</tr></thead>';

    var tbody = document.createElement('tbody');
    logs.forEach(function (log) {
      var id = log.id || '';
      var counts = log.counts || {};
      var cntE = counts.error != null ? counts.error : 0;
      var cntW = counts.warn != null ? counts.warn : 0;
      var cntL = counts.log != null ? counts.log : 0;
      var engineHtml = log.engine ? ' <span class="engine-badge">' + esc(log.engine) + '</span>' : '';

      var tr = document.createElement('tr');
      tr.dataset.title = ((log.title || '') + ' ' + (log.snippet || '')).toLowerCase();

      tr.innerHTML =
        '<td class="td-id"><a href="' + withQs('/' + encodeURIComponent(id)) + '" target="_blank">' + esc(id) + '</a></td>' +
        '<td class="td-title"><span class="td-title-text" title="' + esc(log.title || '') + '">' + esc(log.title || '(no title)') + '</span></td>' +
        (opts.showVersion ? '<td class="td-platform">' + esc(log.version || '') + '</td>' : '') +
        '<td class="td-platform">' + esc(log.platform || '') + engineHtml + '</td>' +
        '<td class="td-counts"><span class="count-e">' + cntE + '</span> / <span class="count-w">' + cntW + '</span> / <span class="count-l">' + cntL + '</span></td>' +
        (opts.showSnippet ? '<td class="td-snippet">' + esc(log.snippet || '') + '</td>' : '') +
        '<td class="td-session">' + sessionLink(appId, log.sessionId) + '</td>' +
        '<td class="td-time">' + esc(fmtDate(log.time || log.createdAt)) + '</td>';

      tr.addEventListener('click', function (e) {
        if (e.target.tagName === 'A') return;
        window.open(withQs('/' + encodeURIComponent(id)), '_blank');
      });
      tbody.appendChild(tr);
    });

    table.appendChild(tbody);
    wrap.appendChild(table);
    contentEl.innerHTML = '';
    contentEl.appendChild(wrap);

    filterInput.addEventListener('input', function () {
      var q = filterInput.value.toLowerCase();
      tbody.querySelectorAll('tr').forEach(function (tr) {
        tr.classList.toggle('hidden', !(!q || tr.dataset.title.indexOf(q) !== -1));
      });
    });
  }

  // ---- View: full-text search results (GET /api/search) ----

  function renderSearch(appId, query, results) {
    document.title = 'FastLogs - ' + appId + ' / Search';
    // renderResultLogs writes the table into #content; prepend a header line
    // echoing the query + result count above it.
    renderResultLogs(appId, results, {
      showSnippet: true,
      showVersion: true,
      emptyMsg: 'No logs match "' + query + '".',
    });
    var head = document.createElement('div');
    head.className = 'search-head';
    head.innerHTML = '<span class="search-head-q">Results for <strong>' + esc(query) + '</strong></span>' +
      '<span class="search-head-count">' + results.length + ' match' + (results.length !== 1 ? 'es' : '') + '</span>';
    contentEl.insertBefore(head, contentEl.firstChild);
  }

  // ---- View: one session's logs (GET /browse/:appId?session=) ----

  function renderSession(appId, sid, logs) {
    document.title = 'FastLogs - ' + appId + ' / Session';
    renderResultLogs(appId, logs, {
      showVersion: true,
      emptyMsg: 'No logs for this session.',
    });
    var head = document.createElement('div');
    head.className = 'search-head';
    head.innerHTML = '<span class="search-head-q">Session <strong>' + esc(sid) + '</strong></span>' +
      '<span class="search-head-count">' + logs.length + ' log' + (logs.length !== 1 ? 's' : '') + '</span>';
    contentEl.insertBefore(head, contentEl.firstChild);
  }

  // ---- Main: route and fetch ----

  renderBreadcrumbs(appId, version, isCrashes, isPinned);

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

  } else if (isPinned) {
    // Pinned logs for one app (across all versions).
    document.title = 'FastLogs - ' + appId + ' / Pinned';
    fetchJson('/browse/' + encodeURIComponent(appId) + '/pinned')
      .then(function (data) { renderPinned(appId, (data && data.logs) || []); })
      .catch(function (err) {
        if (err.message === 'auth_required') showError('Authentication required. Pass ?token= in the URL.');
        else showError('Failed to load pinned logs: ' + err.message);
      });

  } else if (searchQuery) {
    // Full-text search results for one app.
    document.title = 'FastLogs - ' + appId + ' / Search';
    fetchJsonRaw(searchApiUrl(appId, searchQuery))
      .then(function (data) { renderSearch(appId, searchQuery, (data && data.results) || []); })
      .catch(function (err) {
        if (err.message === 'auth_required') showError('Authentication required. Pass ?token= in the URL.');
        else showError('Search failed: ' + err.message);
      });

  } else if (sessionId) {
    // All logs of one session.
    document.title = 'FastLogs - ' + appId + ' / Session';
    fetchJson('/browse/' + encodeURIComponent(appId))
      .then(function (data) { renderSession(appId, sessionId, (data && data.logs) || []); })
      .catch(function (err) {
        if (err.message === 'auth_required') showError('Authentication required. Pass ?token= in the URL.');
        else showError('Failed to load session: ' + err.message);
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
