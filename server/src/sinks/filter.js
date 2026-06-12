'use strict';

// Sink filtering.
//
// Each sink may declare a `filter` object that decides whether a given log
// event should be forwarded to that sink. Filters operate on the forwarding
// payload (CONTRACT section 5): project, version, platform, counts, title, etc.
//
// Supported filter keys (all optional, combined with AND):
//   - minError / minWarn / minLog   numeric thresholds on counts.{error,warn,log}
//   - errorOnly: true               shorthand for minError: 1
//   - platforms: ["WebGL", ...]     allow-list of platforms (case-insensitive)
//   - apps / projects: ["lfa", ...] allow-list of project ids
//   - excludePlatforms: [...]       deny-list of platforms
//
// A sink without a filter (or with an empty filter) matches everything.

// Read a non-negative integer from a filter value, or null if not specified.
function asThreshold(v) {
  if (v === undefined || v === null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// Normalise a string list to lowercase for case-insensitive comparison.
function lowerList(list) {
  if (!Array.isArray(list)) return null;
  return list.map((s) => String(s).toLowerCase());
}

// Decide whether `payload` passes the given `filter`.
// `payload` is the CONTRACT section 5 object. Returns true when the event should
// be forwarded. Unknown filter keys are ignored (forward-compatible).
function passesFilter(filter, payload) {
  if (!filter || typeof filter !== 'object') return true;

  const counts = (payload && payload.counts) || {};
  const error = Number(counts.error) || 0;
  const warn = Number(counts.warn) || 0;
  const log = Number(counts.log) || 0;
  const platform = String((payload && payload.platform) || '').toLowerCase();
  const project = String((payload && payload.project) || '').toLowerCase();

  // errorOnly is a shorthand for "at least one error".
  if (filter.errorOnly === true && error < 1) return false;

  const minError = asThreshold(filter.minError);
  if (minError !== null && error < minError) return false;

  const minWarn = asThreshold(filter.minWarn);
  if (minWarn !== null && warn < minWarn) return false;

  const minLog = asThreshold(filter.minLog);
  if (minLog !== null && log < minLog) return false;

  const platforms = lowerList(filter.platforms);
  if (platforms && !platforms.includes(platform)) return false;

  const excludePlatforms = lowerList(filter.excludePlatforms);
  if (excludePlatforms && excludePlatforms.includes(platform)) return false;

  // Either `apps` or `projects` may be used to gate by project id.
  const projectAllow = lowerList(filter.apps) || lowerList(filter.projects);
  if (projectAllow && !projectAllow.includes(project)) return false;

  return true;
}

module.exports = {
  passesFilter,
};
