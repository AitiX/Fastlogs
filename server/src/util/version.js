'use strict';

// version - a self-contained, TOTAL ordering for app version strings, used by
// the crash-grouping "first seen / regression" detection. Never throws on any
// input (strings, '', null-ish coerced); pure, no dependencies.
//
// Ordering rules, in priority order:
//   1. Both parse as SemVer (major.minor.patch, optional leading 'v', optional
//      -prerelease, build '+meta' ignored): numeric major>minor>patch; a
//      prerelease (1.2.0-rc1) sorts BEFORE its release (1.2.0); prerelease
//      identifiers compare numerically when both numeric, lexicographically
//      otherwise, with numeric < alphanumeric and a shorter prefix lower.
//   2. Else both "loose numeric-dotted" (every dot-part starts with a digit,
//      e.g. '1.0', Unity '2024.3.10f1'): compare part-by-part as integers,
//      missing parts = 0.
//   3. Else compare by created_at when both timestamps are valid and differ
//      (date ordering for opaque labels like 'nightly', git SHAs, 'qa-build-42').
//   4. Final tiebreaker: case-sensitive lexicographic compare of the raw strings.
// created_at is also the tiebreaker within rules 1/2 when the versions are equal.

function sign(n) {
  return n < 0 ? -1 : n > 0 ? 1 : 0;
}

function dateMs(x) {
  if (x == null || x === '') return null;
  const t = Date.parse(x);
  return Number.isNaN(t) ? null : t;
}

// Parse a SemVer string into { major, minor, patch, pre } or null. `pre` is the
// prerelease string ('' when none). Build metadata ('+...') is stripped.
function parseSemver(s) {
  if (s == null) return null;
  let str = String(s).trim();
  if (!str) return null;
  if (str[0] === 'v' || str[0] === 'V') str = str.slice(1);
  const plus = str.indexOf('+');
  if (plus >= 0) str = str.slice(0, plus);
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(str);
  if (!m) return null;
  return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] || '' };
}

// True when every dot-separated part begins with a digit (loose numeric-dotted).
function isLooseNumeric(s) {
  if (!s) return false;
  return String(s).split('.').every((p) => /^\d/.test(p));
}

// Compare SemVer prerelease strings. '' (no prerelease) ranks ABOVE any
// prerelease. Identifier-by-identifier per the SemVer spec.
function comparePre(a, b) {
  if (a === b) return 0;
  if (!a) return 1;
  if (!b) return -1;
  const as = a.split('.');
  const bs = b.split('.');
  const n = Math.max(as.length, bs.length);
  for (let i = 0; i < n; i++) {
    const x = as[i];
    const y = bs[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) {
      const d = parseInt(x, 10) - parseInt(y, 10);
      if (d !== 0) return sign(d);
    } else if (xn) {
      return -1;
    } else if (yn) {
      return 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

// Compare loose numeric-dotted strings as integer arrays (missing part = 0).
function compareLoose(a, b) {
  const pa = String(a).split('.');
  const pb = String(b).split('.');
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const x = parseInt(pa[i], 10);
    const y = parseInt(pb[i], 10);
    const xv = Number.isFinite(x) ? x : 0;
    const yv = Number.isFinite(y) ? y : 0;
    if (xv !== yv) return sign(xv - yv);
  }
  return 0;
}

// created_at tiebreaker for two versions that compare semantically equal. When
// the timestamps do not disambiguate, the versions ARE equal (0) - we do NOT
// fall to raw-string compare here, so 'v1.2.3' and '1.2.3' stay equal. The
// raw-string lexicographic last resort lives in compareVersions' rule 4, used
// only for versions that parse as neither semver nor loose-numeric.
function tieBreak(ca, cb) {
  const da = dateMs(ca);
  const db = dateMs(cb);
  if (da !== null && db !== null && da !== db) return sign(da - db);
  return 0;
}

// Compare two version strings. Optional createdAt args are the tiebreaker.
function compareVersions(a, b, createdAtA, createdAtB) {
  const sa = a == null ? '' : String(a);
  const sb = b == null ? '' : String(b);

  const pa = parseSemver(sa);
  const pb = parseSemver(sb);
  if (pa && pb) {
    const c = pa.major - pb.major || pa.minor - pb.minor || pa.patch - pb.patch;
    if (c !== 0) return sign(c);
    const cp = comparePre(pa.pre, pb.pre);
    if (cp !== 0) return cp;
    return tieBreak(createdAtA, createdAtB);
  }

  // Only treat both as loose numeric-dotted when NEITHER parsed as semver, so a
  // prerelease like '1.2.0-rc1' (whose part '0-rc1' starts with a digit) is not
  // misread as the integer triple [1,2,0] - which would break the total order.
  if (!pa && !pb && isLooseNumeric(sa) && isLooseNumeric(sb)) {
    const c = compareLoose(sa, sb);
    if (c !== 0) return c;
    return tieBreak(createdAtA, createdAtB);
  }

  const da = dateMs(createdAtA);
  const db = dateMs(createdAtB);
  if (da !== null && db !== null && da !== db) return sign(da - db);

  if (sa < sb) return -1;
  if (sa > sb) return 1;
  return 0;
}

module.exports = { compareVersions, parseSemver };
