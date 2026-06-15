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
//   breadcrumbs:  [ { t?: string, m: string, lvl?: 'info'|'warn'|'error' } ], // empty [] when none
//   sceneContext: string | null,   // opaque JSON string (parsed + rendered here)
//   correlationCode: string | null,// short debug/await code
//   sessionId:    string | null,   // per-launch id; links to "all logs of this session"
//   attachments:  [ { id, name, size, kind, mime, downloadUrl } ] // standalone files (empty [] when none)
// }
//
// sceneContext JSON shape (when parsed):
//   { truncated: bool, stats: { scenes, objects, components },
//     scenes: [ { name, ddol, roots: [GO] } ] }
//   GO   = { n: name, a: active, tag, layer, comp: [COMP], kids: [GO] }
//   COMP = { t: typeName, en: bool|null, f: { fieldName: valueString } }
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
      // Once linked (or mid-request) the element is a real anchor to Redmine -
      // let the browser navigate; only suppress the no-op click in button mode.
      if (redmineBtn.classList.contains('redmine-linked') || redmineBtn.classList.contains('busy')) return;
      e.preventDefault();
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
  // Debug/await correlation code (small label) when the client sent one.
  if (data.correlationCode) metaParts.push('code: ' + data.correlationCode);
  document.getElementById('counts-meta').textContent = metaParts.join(' - ');

  // "All logs of this session" link (catalog, viewer-gated) when the client
  // sent a sessionId. Appended after the meta text so it is clickable. The
  // token (when this page carries one) is forwarded so the catalog stays
  // authorized; without a token the link still works for token-less viewer
  // setups and otherwise lands on the catalog auth prompt.
  if (data.sessionId && data.appId) {
    var sToken = new URLSearchParams(window.location.search).get('token');
    var sHref = '/browse/' + encodeURIComponent(data.appId) +
      (sToken ? '?token=' + encodeURIComponent(sToken) + '&' : '?') +
      'session=' + encodeURIComponent(data.sessionId);
    var sLink = document.createElement('a');
    sLink.className = 'session-link';
    sLink.href = sHref;
    sLink.textContent = 'session logs';
    sLink.title = 'All logs of this session';
    var metaEl = document.getElementById('counts-meta');
    metaEl.appendChild(document.createTextNode(metaParts.length ? ' - ' : ''));
    metaEl.appendChild(sLink);
  }

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

  // ---- Scene Context (collapsible object tree) ----

  // Build a small badge span (e.g. an "active" / tag / layer marker).
  function sceneBadge(text, extraClass) {
    var b = document.createElement('span');
    b.className = 'scene-badge' + (extraClass ? ' ' + extraClass : '');
    b.textContent = text;
    return b;
  }

  // A collapsible node: an arrow + label row over an indented child container
  // (built lazily on first expand to keep a large tree cheap). `openByDefault`
  // controls the initial state; deep nodes stay collapsed so the tree stays
  // readable. `buildChildren(container)` populates the body when first opened.
  function sceneNode(labelEl, buildChildren, openByDefault) {
    var node = document.createElement('div');
    node.className = 'scene-node';

    var toggle = document.createElement('div');
    toggle.className = 'scene-toggle';
    var arrow = document.createElement('span');
    arrow.className = 'scene-arrow';
    arrow.textContent = '►';
    toggle.appendChild(arrow);
    toggle.appendChild(labelEl);

    var children = document.createElement('div');
    children.className = 'scene-children';

    var built = false;
    function ensureBuilt() {
      if (built) return;
      built = true;
      buildChildren(children);
    }

    toggle.addEventListener('click', function () {
      var willOpen = !node.classList.contains('open');
      if (willOpen) ensureBuilt();
      node.classList.toggle('open', willOpen);
    });

    node.appendChild(toggle);
    node.appendChild(children);

    if (openByDefault) {
      ensureBuilt();
      node.classList.add('open');
    }
    return node;
  }

  // A leaf row "key: value" used for component fields.
  function sceneField(key, value) {
    var row = document.createElement('div');
    row.className = 'scene-field';
    var k = document.createElement('span');
    k.className = 'scene-fkey';
    k.textContent = key + ':';
    var v = document.createElement('span');
    v.className = 'scene-fval';
    v.textContent = (value === null || value === undefined) ? 'null'
      : (typeof value === 'object' ? JSON.stringify(value) : String(value));
    row.appendChild(k);
    row.appendChild(v);
    return row;
  }

  // Render one component (t + enabled badge) -> expandable field list.
  function renderComp(comp) {
    var label = document.createElement('span');
    label.className = 'scene-name scene-comp';
    label.textContent = (comp && comp.t != null) ? String(comp.t) : '(component)';

    var hasFields = comp && comp.f && typeof comp.f === 'object' && Object.keys(comp.f).length > 0;

    function labelRow() {
      var wrap = document.createElement('span');
      wrap.appendChild(label);
      if (comp && comp.en === false) wrap.appendChild(sceneBadge('disabled', 'scene-off'));
      else if (comp && comp.en === true) wrap.appendChild(sceneBadge('enabled', 'scene-on'));
      return wrap;
    }

    if (!hasFields) {
      var leaf = document.createElement('div');
      leaf.className = 'scene-leaf';
      leaf.appendChild(labelRow());
      return leaf;
    }
    return sceneNode(labelRow(), function (container) {
      Object.keys(comp.f).forEach(function (fk) {
        container.appendChild(sceneField(fk, comp.f[fk]));
      });
    }, false);
  }

  // Render one GameObject (n + active/tag/layer badges) -> components + kids.
  // Always collapsed by default (the tree can be deep/large).
  function renderGO(go) {
    var label = document.createElement('span');
    var nameEl = document.createElement('span');
    nameEl.className = 'scene-name';
    nameEl.textContent = (go && go.n != null) ? String(go.n) : '(object)';
    label.appendChild(nameEl);
    if (go && go.a === false) label.appendChild(sceneBadge('inactive', 'scene-off'));
    if (go && go.tag != null && go.tag !== '' && go.tag !== 'Untagged') label.appendChild(sceneBadge(String(go.tag)));
    if (go && go.layer != null) label.appendChild(sceneBadge('L' + go.layer));

    var comps = (go && Array.isArray(go.comp)) ? go.comp : [];
    var kids = (go && Array.isArray(go.kids)) ? go.kids : [];

    if (comps.length === 0 && kids.length === 0) {
      var leaf = document.createElement('div');
      leaf.className = 'scene-leaf';
      leaf.appendChild(label);
      return leaf;
    }
    return sceneNode(label, function (container) {
      comps.forEach(function (c) { container.appendChild(renderComp(c)); });
      kids.forEach(function (k) { container.appendChild(renderGO(k)); });
    }, false);
  }

  // Render one scene (name + ddol badge) -> its root GameObjects.
  function renderScene(scene, openByDefault) {
    var label = document.createElement('span');
    var nameEl = document.createElement('span');
    nameEl.className = 'scene-name';
    nameEl.textContent = (scene && scene.name != null) ? String(scene.name) : '(scene)';
    label.appendChild(nameEl);
    if (scene && scene.ddol) label.appendChild(sceneBadge('DontDestroyOnLoad', 'scene-ddol'));

    var roots = (scene && Array.isArray(scene.roots)) ? scene.roots : [];
    return sceneNode(label, function (container) {
      if (roots.length === 0) {
        var empty = document.createElement('div');
        empty.className = 'scene-leaf scene-stats';
        empty.textContent = '(no root objects)';
        container.appendChild(empty);
        return;
      }
      roots.forEach(function (r) { container.appendChild(renderGO(r)); });
    }, openByDefault);
  }

  var scenePanel = document.getElementById('scene-panel');
  if (data.sceneContext) {
    scenePanel.style.display = '';
    var sceneHeader = document.getElementById('scene-panel-header');
    var sceneBody = document.getElementById('scene-body');
    sceneHeader.addEventListener('click', function () {
      scenePanel.classList.toggle('open');
    });

    var parsed = null;
    try {
      parsed = JSON.parse(data.sceneContext);
    } catch (e) {
      parsed = null;
    }

    if (!parsed || typeof parsed !== 'object') {
      // Malformed / unexpected: fall back to showing the raw string verbatim.
      var raw = document.createElement('div');
      raw.className = 'scene-raw';
      raw.textContent = data.sceneContext;
      sceneBody.appendChild(raw);
    } else {
      var scenes = Array.isArray(parsed.scenes) ? parsed.scenes : [];
      document.getElementById('scene-count').textContent = '(' + scenes.length + ')';

      // Stats line (scenes / objects / components) + a truncated note.
      var stats = parsed.stats || {};
      var statParts = [];
      if (stats.scenes != null) statParts.push(stats.scenes + ' scenes');
      if (stats.objects != null) statParts.push(stats.objects + ' objects');
      if (stats.components != null) statParts.push(stats.components + ' components');
      if (parsed.truncated) statParts.push('truncated');
      if (statParts.length > 0) {
        var statsEl = document.createElement('div');
        statsEl.className = 'scene-stats';
        statsEl.textContent = statParts.join(' · ');
        sceneBody.appendChild(statsEl);
      }

      // Open the first scene by default; the rest collapse to keep it light.
      scenes.forEach(function (scene, idx) {
        sceneBody.appendChild(renderScene(scene, idx === 0));
      });
    }
  }

  // ---- Screenshot ----

  var screenshotWrap = document.getElementById('screenshot-wrap');
  // Build relative screenshot URLs from the count (robust against a baseUrl that
  // differs from the host serving the viewer). Index 0 is /<id>/screenshot.
  var shotCount = data.screenshotCount || (data.hasScreenshot ? 1 : 0);
  if (shotCount > 0) {
    screenshotWrap.style.display = '';

    var label = document.getElementById('screenshot-label');
    if (label) label.textContent = shotCount > 1 ? 'Screenshots (' + shotCount + ')' : 'Screenshot';

    var body = document.getElementById('screenshot-body');
    body.textContent = '';
    for (var si = 0; si < shotCount; si++) {
      var img = document.createElement('img');
      img.src = si === 0 ? '/' + data.id + '/screenshot' : '/' + data.id + '/screenshot/' + si;
      img.alt = 'Screenshot ' + (si + 1);
      img.loading = 'lazy';
      body.appendChild(img);
    }

    var screenshotHeader = document.getElementById('screenshot-header');
    var screenshotArrow = document.getElementById('screenshot-arrow');
    screenshotHeader.addEventListener('click', function () {
      screenshotWrap.classList.toggle('open');
      screenshotArrow.textContent = screenshotWrap.classList.contains('open') ? '▼' : '►';
    });
  }

  // ---- Attachments (standalone files attached to this log) ----

  var attachments = Array.isArray(data.attachments) ? data.attachments : [];
  var attachmentsPanel = document.getElementById('attachments-panel');
  if (attachments.length > 0) {
    attachmentsPanel.style.display = '';
    var attHeader = document.getElementById('attachments-panel-header');
    var attBody = document.getElementById('attachments-body');
    document.getElementById('attachments-count').textContent = '(' + attachments.length + ')';

    attachments.forEach(function (att) {
      if (!att || !att.downloadUrl) return;
      var row = document.createElement('div');
      row.className = 'att-row';

      var info = document.createElement('div');
      info.className = 'att-info';

      var nameEl = document.createElement('span');
      nameEl.className = 'att-name';
      nameEl.textContent = att.name || att.id;
      info.appendChild(nameEl);

      var metaParts = [];
      if (att.size !== null && att.size !== undefined && !isNaN(att.size)) metaParts.push(fmtBytes(att.size));
      if (att.kind) metaParts.push(att.kind);
      if (metaParts.length > 0) {
        var metaEl = document.createElement('span');
        metaEl.className = 'att-meta';
        metaEl.textContent = metaParts.join(' · ');
        info.appendChild(metaEl);
      }

      // Relative download URL: works regardless of the host serving the page.
      var dl = document.createElement('a');
      dl.className = 'btn btn-ghost att-download';
      dl.href = att.downloadUrl;
      dl.setAttribute('download', '');
      dl.textContent = 'Download';

      row.appendChild(info);
      row.appendChild(dl);
      attBody.appendChild(row);
    });

    attHeader.addEventListener('click', function () {
      attachmentsPanel.classList.toggle('open');
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

  // Parse an entry-header line per the fixed line-format contract:
  //   [L|W|E] +<sec.mmm>[ f<frame>] <message>
  // The level marker (L/W/E) and the relative timestamp are always present in
  // the new format; the frame group (f<n>) is OPTIONAL - the client does not
  // emit it yet, and old logs predate it. Returns null for lines that do not
  // match the header shape (free-form / legacy lines), so callers fall back to
  // the heuristic detectLevel() and skip the rich metadata.
  //   -> { level: 'error'|'warn'|'log', relSec: number, frame: number|null, message: string }
  var HEADER_RE = /^\[([LWE])\]\s+\+([0-9.]+)(?:\s+f(\d+))?\s+(.*)$/;
  var HEADER_LEVEL = { L: 'log', W: 'warn', E: 'error' };
  function parseHeader(line) {
    if (!line) return null;
    var m = HEADER_RE.exec(line);
    if (!m) return null;
    var rel = parseFloat(m[2]);
    if (isNaN(rel)) return null;
    return {
      level: HEADER_LEVEL[m[1]] || 'log',
      relSec: rel,
      frame: (m[3] !== undefined) ? parseInt(m[3], 10) : null,
      message: m[4]
    };
  }

  // Recognise a session marker emitted at the start of each launch:
  //   ==== FastLogs session <guid> | <UTC> | ...
  // The second pipe-delimited field is the launch wall-clock in UTC. We track
  // the nearest preceding marker so each entry's relSec can be turned into an
  // absolute time. Returns the parsed Date (or null when the field is missing
  // or unparseable - then entries keep only their relative "+sec" time).
  var SESSION_RE = /^=+\s*FastLogs session\b/;
  function parseSessionStart(line) {
    if (!line || !SESSION_RE.test(line)) return undefined; // not a marker
    var parts = line.split('|');
    if (parts.length < 2) return null;
    var d = new Date(parts[1].trim());
    return isNaN(d.getTime()) ? null : d;
  }

  // Format a relative offset (seconds since session start) as "+M:SS.mmm" for
  // longer runs, or "+S.mmms" for short ones - compact but still precise.
  function fmtRel(sec) {
    if (sec === null || sec === undefined || isNaN(sec)) return '';
    if (sec < 60) return '+' + sec.toFixed(3) + 's';
    var m = Math.floor(sec / 60);
    var s = sec - m * 60;
    return '+' + m + ':' + (s < 10 ? '0' : '') + s.toFixed(3);
  }

  // Wall-clock for an entry: session-start UTC + relSec, shown in local time.
  // Returns '' when there is no preceding session marker.
  function fmtWall(sessionStart, relSec) {
    if (!sessionStart || relSec === null || relSec === undefined || isNaN(relSec)) return '';
    var t = new Date(sessionStart.getTime() + relSec * 1000);
    try { return t.toLocaleString(); } catch (e) { return t.toISOString(); }
  }

  // Build pretty rendered lines.
  var logPrettyEl = document.getElementById('log-pretty');
  var logRawEl = document.getElementById('log-raw');

  // Store metadata per DOM line for filtering.
  var lineNodes = []; // { el, level, text }

  // Append a key/value row to a detail panel (used by the expand block).
  function detailRow(panel, key, value) {
    var row = document.createElement('div');
    row.className = 'log-detail-kv';
    var k = document.createElement('span');
    k.className = 'log-detail-key';
    k.textContent = key;
    var v = document.createElement('span');
    v.className = 'log-detail-val';
    v.textContent = value;
    row.appendChild(k);
    row.appendChild(v);
    panel.appendChild(row);
  }

  // Walk the lines once, grouping each entry-header with the trace frames that
  // follow it (isTraceLine), collapsing consecutive identical entries into a
  // single "xN" row, and tracking the nearest session marker for wall-clock.
  //
  // Each entry that carries metadata (a parsed [L|W|E] header) or stack frames
  // gets a compact gutter toggle (>/v) by its line number. Clicking it expands
  // ONE unified detail block below the row: a key/value panel (Level, Frame,
  // Time, repeats) plus the full stack trace. Plain legacy lines with neither
  // header nor frames render as a bare row (no toggle), keeping the view light.
  //
  // The toggle has NO per-element listener - a single delegated listener on the
  // container (installed after this loop) drives every expand, so it survives
  // any later re-render/filter that touches the DOM.
  var expandSeq = 0;        // unique id pairing a toggle with its detail block
  var sessionStart = null;  // Date of the nearest preceding session marker
  var i = 0;
  var lineNum = 1;
  while (i < logLines.length) {
    var line = logLines[i];

    // Session marker: remember its UTC for wall-clock, render it as a plain row.
    var maybeSession = parseSessionStart(line);
    if (maybeSession !== undefined) sessionStart = maybeSession; // null = unparseable

    var header = parseHeader(line);
    var level = header ? header.level : detectLevel(line);

    // Collapse consecutive identical raw lines into one entry (repeats xN).
    var repeats = 1;
    while (i + repeats < logLines.length && logLines[i + repeats] === line) {
      repeats++;
    }

    // Trace continuation lines belong to the LAST occurrence of the entry.
    var traceLines = [];
    var j = i + repeats;
    while (j < logLines.length && isTraceLine(logLines[j])) {
      traceLines.push(logLines[j]);
      j++;
    }

    var entrySessionStart = sessionStart;
    var relSec = header ? header.relSec : null;
    var frame = header ? header.frame : null;
    var wall = fmtWall(entrySessionStart, relSec);
    var rel = fmtRel(relSec);

    // Expandable when there is something extra to show below the line.
    var expandable = (traceLines.length > 0) || (header !== null);

    // Main entry row: line number, gutter toggle (or spacer), text.
    var row = document.createElement('div');
    row.className = 'log-line ' + level;

    var numEl = document.createElement('span');
    numEl.className = 'log-line-num';
    numEl.textContent = lineNum;
    row.appendChild(numEl);

    var detailId = '';
    if (expandable) {
      detailId = 'x' + (++expandSeq);
      var toggle = document.createElement('span');
      toggle.className = 'log-trace-toggle';
      toggle.dataset.expand = detailId;
      toggle.textContent = '▸'; // > (collapsed); flips to v when open
      var frameNote = (traceLines.length > 0)
        ? (traceLines.length + ' frame' + (traceLines.length !== 1 ? 's' : ''))
        : 'details';
      toggle.title = 'Expand ' + frameNote;
      row.appendChild(toggle);
    } else {
      var spacer = document.createElement('span');
      spacer.className = 'log-trace-spacer';
      row.appendChild(spacer);
    }

    var textEl = document.createElement('span');
    textEl.className = 'log-line-text log-level-' + (level === 'log' ? 'l' : level === 'warn' ? 'w' : 'e');
    // Show the header message when parsed (drops the redundant [L]/+time/f
    // prefix), else the raw line for legacy formats.
    textEl.textContent = header ? header.message : line;
    row.appendChild(textEl);

    if (repeats > 1) {
      var repeatEl = document.createElement('span');
      repeatEl.className = 'log-repeat';
      repeatEl.textContent = 'x' + repeats;
      repeatEl.title = repeats + ' identical lines collapsed';
      row.appendChild(repeatEl);
    }

    // Hover tooltip on the row: Frame (only if present) + Time.
    var tipParts = [];
    if (frame !== null) tipParts.push('Frame ' + frame);
    if (rel) tipParts.push('Time ' + rel + (wall ? ' (' + wall + ')' : ''));
    if (tipParts.length) row.title = tipParts.join('  |  ');

    logPrettyEl.appendChild(row);
    var rowNode = { el: row, level: level, text: line };
    lineNodes.push(rowNode);
    lineNum++;

    // Unified detail block: key/value panel + (optional) stack frames.
    if (expandable) {
      var detail = document.createElement('div');
      detail.className = 'log-entry-detail';
      detail.dataset.expandFor = detailId;
      // Pair the row with its detail block so a filter that hides the row also
      // hides the (possibly expanded) detail beneath it.
      rowNode.detailEl = detail;

      var kv = document.createElement('div');
      kv.className = 'log-detail-kv-list';
      detailRow(kv, 'Level', level.charAt(0).toUpperCase() + level.slice(1));
      detailRow(kv, 'Frame', frame !== null ? String(frame) : '-');
      var timeStr = rel ? (rel + (wall ? ' (' + wall + ')' : '')) : '-';
      detailRow(kv, 'Time', timeStr);
      if (repeats > 1) detailRow(kv, 'Repeats', 'x' + repeats);
      detail.appendChild(kv);

      if (traceLines.length > 0) {
        var stackHead = document.createElement('div');
        stackHead.className = 'log-detail-stack-head';
        stackHead.textContent = 'Stack trace (' + traceLines.length + ')';
        detail.appendChild(stackHead);

        var stack = document.createElement('div');
        stack.className = 'log-detail-stack';
        traceLines.forEach(function (tl) {
          var tr = document.createElement('div');
          tr.className = 'log-line log-level-l log-trace-frame';
          var tn = document.createElement('span');
          tn.className = 'log-line-num';
          tn.textContent = lineNum;
          var tt = document.createElement('span');
          tt.className = 'log-line-text';
          tt.textContent = tl;
          tr.appendChild(tn);
          tr.appendChild(tt);
          stack.appendChild(tr);
          // traceEl points at the detail block so filtering skips folded frames.
          lineNodes.push({ el: tr, level: level, text: tl, traceEl: detail });
          lineNum++;
        });
        detail.appendChild(stack);
      }

      logPrettyEl.appendChild(detail);
    }

    i = j; // advance past the repeats and the trace block
  }

  if (logLines.length === 0) {
    logPrettyEl.innerHTML = '<div class="log-no-results">Log is empty.</div>';
  }

  // Single delegated click handler for every gutter toggle. Robust against any
  // later DOM rebuild/filter: it resolves target + detail block at click time
  // instead of holding per-element listeners (the previous per-toggle approach
  // lost its handlers whenever the list was re-rendered).
  logPrettyEl.addEventListener('click', function (e) {
    var toggle = e.target.closest('.log-trace-toggle');
    if (!toggle || !logPrettyEl.contains(toggle)) return;
    var id = toggle.dataset.expand;
    if (!id) return;
    var detail = logPrettyEl.querySelector('.log-entry-detail[data-expand-for="' + id + '"]');
    if (!detail) return;
    var open = detail.classList.toggle('open');
    toggle.classList.toggle('open', open);
    toggle.textContent = open ? '▾' : '▸'; // v / >
    toggle.title = (open ? 'Collapse' : 'Expand') + ' details';
  });

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
      // Keep an entry's detail block in lockstep with its row.
      if (item.detailEl) item.detailEl.classList.toggle('hidden', !visible);
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
