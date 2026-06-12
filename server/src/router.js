'use strict';

// Tiny method+path router.
//
// Routes are registered with a method and a path pattern. Patterns use
// ":name" segments for parameters, e.g. "/api/logs/:id/pin". A literal "*"
// is not supported on purpose: every dynamic part is a named parameter so
// handlers stay explicit.
//
// Matching is ordered: the first registered route that matches wins. This
// matters because the viewer catch-all ("/:id") would otherwise shadow more
// specific routes like "/browse" or "/api/health". Callers must therefore
// register specific routes before the catch-all ones (the index does this).
//
// A matched handler is invoked as handler(req, res, params), where params is a
// plain object of decoded path parameters.

// Split a path into clean segments (no empty parts from leading/trailing "/").
function segments(pathname) {
  const out = [];
  for (const part of pathname.split('/')) {
    if (part !== '') out.push(part);
  }
  return out;
}

// Compile a pattern string into its segment list once at registration time.
function compile(pattern) {
  return segments(pattern).map((seg) => {
    if (seg.startsWith(':')) {
      return { param: true, name: seg.slice(1) };
    }
    return { param: false, value: seg };
  });
}

class Router {
  constructor() {
    this.routes = [];
  }

  // Register a route. `method` is upper-case (GET/POST/...); `pattern` is a
  // path template; `handler` is the route function.
  add(method, pattern, handler) {
    this.routes.push({
      method: method.toUpperCase(),
      parts: compile(pattern),
      pattern,
      handler,
    });
    return this;
  }

  // Convenience helpers for the common verbs.
  get(pattern, handler) {
    return this.add('GET', pattern, handler);
  }
  post(pattern, handler) {
    return this.add('POST', pattern, handler);
  }

  // Find the first route matching method + pathname.
  //
  // Returns { handler, params } on a match. If the path matches one or more
  // routes but only under a different method, returns { methodMismatch: true }
  // so the caller can answer 405 instead of 404. Returns null if nothing
  // matched at all.
  match(method, pathname) {
    const reqSegs = segments(pathname);
    let methodMismatch = false;

    for (const route of this.routes) {
      if (route.parts.length !== reqSegs.length) continue;

      const params = {};
      let ok = true;
      for (let i = 0; i < route.parts.length; i++) {
        const part = route.parts[i];
        const seg = reqSegs[i];
        if (part.param) {
          // Decode percent-encoding in path parameters; reject malformed input.
          let value;
          try {
            value = decodeURIComponent(seg);
          } catch {
            ok = false;
            break;
          }
          params[part.name] = value;
        } else if (part.value !== seg) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;

      if (route.method !== method.toUpperCase()) {
        methodMismatch = true;
        continue;
      }
      return { handler: route.handler, params };
    }

    if (methodMismatch) return { methodMismatch: true };
    return null;
  }
}

module.exports = { Router };
