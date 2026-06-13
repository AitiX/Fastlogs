'use strict';

// FastLogs - catalog (browse) page.
//
// Single page served (as the HTML shell) at all three catalog routes; it reads
// window.location.pathname to decide which view to render:
//
//   /browse                     - list all projects
//   /browse/:appId              - list versions of one project
//   /browse/:appId/:version     - list logs of one app+version
//
// It fetches the JSON form of the SAME endpoints (with ?format=json so the
// server returns JSON instead of this HTML shell):
//
//   GET /browse?format=json                    -> { projects: [{ appId, name, enabled }] }
//   GET /browse/:appId?format=json             -> { appId, name, versions: [{ version, count, lastAt }] }
//   GET /browse/:appId/:version?format=json    -> { appId, name, version, logs: [{ id, title, time, createdAt, platform, counts:{error,warn,log}, hasScreenshot, pinned, expiresAt }] }
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
  // Version may itself contain encoded slashes; join the remaining parts.
  var version = parts.length > 1 ? decodeURIComponent(parts.slice(1).join('/')) : null;

  // Preserve the query string for auth token forwarding (e.g. "?token=xyz").
  var qs = window.location.search;

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

  // ---- Breadcrumbs ----

  function renderBreadcrumbs(appId, version) {
    var bc = document.getElementById('breadcrumbs');
    var html = '';
    if (!appId) {
      html = '<span class="crumb">Catalog</span>';
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

  function renderProjects(projects) {
    var filterInput = document.getElementById('filter-input');
    filterInput.placeholder = 'Filter projects...';

    if (!projects || projects.length === 0) {
      showEmpty('No projects found.');
      return;
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
      card.innerHTML =
        '<div class="card-id">' + esc(id) + '</div>' +
        '<div class="card-name">' + esc(name) + '</div>' +
        (p.enabled === false ? '<div class="card-meta">disabled</div>' : '');
      cards.appendChild(card);
    });

    contentEl.innerHTML = '';
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

  function renderVersions(appId, versions) {
    var filterInput = document.getElementById('filter-input');
    filterInput.placeholder = 'Filter versions...';

    if (!versions || versions.length === 0) {
      showEmpty('No versions found for ' + appId + '.');
      return;
    }

    var list = document.createElement('div');
    list.className = 'versions-list';
    list.id = 'versions-wrap';

    versions.forEach(function (v) {
      var ver = v.version || '';
      var row = document.createElement('a');
      row.className = 'version-row';
      row.href = withQs('/browse/' + encodeURIComponent(appId) + '/' + encodeURIComponent(ver));
      var count = v.count || 0;
      row.innerHTML =
        '<span class="version-tag">' + esc(ver) + '</span>' +
        '<span class="version-count">' + count + ' log' + (count !== 1 ? 's' : '') + '</span>' +
        '<span class="version-last">' + esc(fmtDate(v.lastAt)) + '</span>';
      list.appendChild(row);
    });

    contentEl.innerHTML = '';
    contentEl.appendChild(list);

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

    // Show platform and level selects.
    var platformSelect = document.getElementById('platform-select');
    var levelSelect = document.getElementById('level-select');
    platformSelect.style.display = '';
    levelSelect.style.display = '';

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

      var tr = document.createElement('tr');
      tr.dataset.platform = log.platform || '';
      tr.dataset.error = cntE;
      tr.dataset.warn = cntW;
      tr.dataset.title = (log.title || '').toLowerCase();

      tr.innerHTML =
        '<td class="td-id"><a href="' + withQs('/' + encodeURIComponent(id)) + '" target="_blank">' + esc(id) + '</a></td>' +
        '<td class="td-title"><span class="td-title-text" title="' + esc(log.title || '') + '">' + esc(log.title || '(no title)') + '</span></td>' +
        '<td class="td-platform">' + esc(log.platform || '') + '</td>' +
        '<td class="td-counts"><span class="count-e">' + cntE + '</span> / <span class="count-w">' + cntW + '</span> / <span class="count-l">' + cntL + '</span></td>' +
        '<td class="td-size">' + esc(fmtBytes(log.logBytes)) + '</td>' +
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

    // Filter logic.
    function applyFilters() {
      var q = filterInput.value.toLowerCase();
      var pf = platformSelect.value;
      var lv = levelSelect.value;

      tbody.querySelectorAll('tr').forEach(function (tr) {
        var titleOk = !q || tr.dataset.title.indexOf(q) !== -1;
        var pfOk = !pf || tr.dataset.platform === pf;
        var lvOk = true;
        if (lv === 'error') lvOk = parseInt(tr.dataset.error, 10) > 0;
        else if (lv === 'warn') lvOk = parseInt(tr.dataset.warn, 10) > 0;
        tr.classList.toggle('hidden', !(titleOk && pfOk && lvOk));
      });
    }

    filterInput.addEventListener('input', applyFilters);
    platformSelect.addEventListener('change', applyFilters);
    levelSelect.addEventListener('change', applyFilters);
  }

  // ---- Main: route and fetch ----

  renderBreadcrumbs(appId, version);

  if (!appId) {
    // Root: list projects.
    document.title = 'FastLogs - Catalog';
    fetchJson('/browse')
      .then(function (data) { renderProjects((data && data.projects) || []); })
      .catch(function (err) {
        if (err.message === 'auth_required') showError('Authentication required. Pass ?token= in the URL.');
        else showError('Failed to load projects: ' + err.message);
      });

  } else if (!version) {
    // Versions list.
    document.title = 'FastLogs - ' + appId;
    fetchJson('/browse/' + encodeURIComponent(appId))
      .then(function (data) { renderVersions(appId, (data && data.versions) || []); })
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
