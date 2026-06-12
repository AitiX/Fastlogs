'use strict';

// GET /api/logs/:id -> JSON metadata for the viewer (and external tooling).
//
// This is the machine-readable counterpart of the HTML viewer. It returns the
// log metadata plus public links, but NOT the log text (fetch that from /raw)
// to keep the payload small. CORS is intentionally permissive (the core CORS
// layer already sets Allow-Origin), since this endpoint is read-only public
// data keyed by an unguessable id.

const { sendJson } = require('../util/http');
const { getLiveLog, notFoundJson, publicLogObject } = require('./shared');

function meta(req, res, params) {
  const row = getLiveLog(params.id);
  if (!row) return notFoundJson(res);
  sendJson(res, 200, publicLogObject(row));
}

module.exports = { meta };
