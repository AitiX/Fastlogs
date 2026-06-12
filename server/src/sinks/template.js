'use strict';

// Tiny placeholder templating for the generic webhook sink.
//
// Templates use {{path}} placeholders resolved against the forwarding payload
// (CONTRACT section 5) plus a few derived helpers. Example:
//
//   "{{projectName}} [{{platform}}] {{counts.error}} errors -> {{url}}"
//
// Supported placeholders are the payload fields by dotted path
// (e.g. {{counts.error}}), plus:
//   - {{json}}            the whole payload as compact JSON
//   - {{counts.summary}}  "E:3 W:12 L:540"
//
// Missing paths resolve to an empty string. Values are inserted verbatim for
// string templates; use buildJsonBody for a structured JSON body instead.

// Resolve a dotted path (e.g. "counts.error") against an object. Returns
// undefined when any segment is missing.
function getPath(obj, dotted) {
  const parts = String(dotted).split('.');
  let cur = obj;
  for (const p of parts) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[p];
  }
  return cur;
}

// Build the set of derived values available to templates.
function deriveExtras(payload) {
  const c = (payload && payload.counts) || {};
  return {
    json: JSON.stringify(payload),
    'counts.summary': `E:${Number(c.error) || 0} W:${Number(c.warn) || 0} L:${Number(c.log) || 0}`,
  };
}

// Coerce a resolved value to a string for insertion into a string template.
function toStr(value) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

// Render a string template by replacing {{path}} occurrences.
function renderString(tpl, payload) {
  if (typeof tpl !== 'string') return tpl;
  const extras = deriveExtras(payload);
  return tpl.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key) => {
    if (key in extras) return toStr(extras[key]);
    return toStr(getPath(payload, key));
  });
}

// Recursively render a JSON-like template (object/array/string), substituting
// placeholders inside string leaves. A string leaf that is exactly a single
// "{{path}}" resolves to the raw value (preserving numbers/objects), so a body
// template like { "errors": "{{counts.error}}" } yields a real number.
function renderJson(tpl, payload) {
  if (Array.isArray(tpl)) return tpl.map((item) => renderJson(item, payload));
  if (tpl && typeof tpl === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(tpl)) out[k] = renderJson(v, payload);
    return out;
  }
  if (typeof tpl === 'string') {
    const exact = /^\{\{\s*([\w.]+)\s*\}\}$/.exec(tpl);
    if (exact) {
      const key = exact[1];
      const extras = deriveExtras(payload);
      if (key in extras) return extras[key];
      const v = getPath(payload, key);
      return v === undefined ? null : v;
    }
    return renderString(tpl, payload);
  }
  return tpl;
}

module.exports = {
  renderString,
  renderJson,
  getPath,
};
