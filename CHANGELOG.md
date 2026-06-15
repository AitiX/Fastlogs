# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **Full-text search** over the catalog: `GET /api/search?appId=&q=[&version=]`
  (viewer-token gated) searches a project's logs by title, tester, comment,
  context values, scene snapshot and the log body via SQLite FTS5 (contentless
  index, so the log body is not duplicated on disk). Results are relevance-ranked
  with a match snippet; a search box appears on the catalog versions page. Raw
  queries are escaped into a safe FTS5 `MATCH` (injection-proof, malformed input
  never 500s). Pre-feature logs are indexed lazily per query
  (`SEARCH_BACKFILL_BATCH`) and/or by `npm run backfill-fts`.
- **Sessions**: ingest gains an optional `sessionId` (per-launch id; `<=128`
  chars). The catalog links all logs of one launch via
  `GET /browse/:appId?session=<id>`, the viewer shows a "session logs" link, and
  `GET /api/logs/:id` returns `sessionId`.

## [0.3.0] - 2026-06-13

### Added
- **Context** (key->value snapshot of what the player was doing / app state):
  the contract gains an optional `context` object (string->string) that travels
  with every report. The server clamps it on ingest (~4KB total, key <= 64 chars,
  value <= 512 chars) and the viewer renders a dedicated **Context** section.
- **Breadcrumbs** (a rolling trail of the last events leading up to a report):
  the contract gains an optional `breadcrumbs` array of `{ t, m, lvl }` items.
  The server clamps it on ingest (100 items / ~16KB total; `lvl` must be one of
  `info` / `warn` / `error`, otherwise dropped; `m` is required and truncated to
  512 chars) and the viewer renders a **Breadcrumbs** event timeline.
- PII scrubbing on the client is privacy-by-default; on the server side the
  ingest no longer stores a raw client IP. The submitting IP is only one-time
  salted and SHA-256 hashed (`config.ipSalt`, first 16 hex chars) for rate
  limiting, so the original address is not retained or reversible.

### Changed
- Ingest persists the new structured fields as `context_json` and
  `breadcrumbs_json`; both are optional and omitted when absent.

## [0.2.0] - 2026-06-13

### Added
- MIT `LICENSE` and this `CHANGELOG`.
- `server/Dockerfile` and `server/docker-compose.yml` for one-command deploy.
- Browser-accessible catalog: `GET /browse` (and sub-paths) serve the catalog UI
  on `Accept: text/html`, and `public/browse.css` / `public/browse.js` are
  served via the static allowlist.
- gzip+base64 ingest now validates the gzip magic bytes and trial-decompresses
  with a `MAX_LOG_BYTES` ceiling (rejects corrupt or oversized logs at ingest).
- Per-report `comment` and `tester` fields, surfaced in the viewer.
- Shared team ingest token (master key) with opt-in auto-register so new games
  can self-onboard.
- In-process retention sweep (periodic, configurable) that keeps disk bounded
  alongside the standalone sweeper.
- Configurable bind `HOST` (default `127.0.0.1`; `0.0.0.0` under Docker), deploy
  guide and team docs.
- Server tests (comment / tester / team-token) and a GitHub Actions CI workflow
  (`npm test`).

### Changed
- Rebranded from "PlayJoy LogShare" to **FastLogs**: package name, service/unit
  names (`fastlogsd`, `fastlogs-sweeper`), data dir (`/var/lib/fastlogs`),
  inline data placeholder (`__FASTLOGS_DATA__`), and UI titles.
- Neutral defaults for reuse: `BASE_URL` defaults to `http://localhost:8787`;
  no hardcoded domain in code defaults.
- `GET /:id/raw?download=1` now names the downloaded file by its actual encoding
  (`.log.gz` when serving gzip, `.log.txt` when serving plain text).
- `deploy/INSTALL.md` is now generic (any VPS/Docker); PlayJoy-specific steps
  moved to `deploy/DEPLOY-playjoy.md`.
- nginx config drops the dead `/assets/` alias; the Node app serves all viewer
  and catalog assets from an explicit allowlist.
- `browse.js` now calls the real catalog endpoints (`/browse...?format=json`)
  and renders the actual JSON shape.

## [0.1.0] - 2026-06-12

### Added
- Initial server: ingest (`POST /api/logs`), web viewer (`GET /:id`), raw log
  (`GET /:id/raw`), screenshot (`GET /:id/screenshot`), JSON metadata
  (`GET /api/logs/:id`), team catalog (`GET /browse`), pin
  (`POST /api/logs/:id/pin`), forwarding sinks, retention sweeper, and
  SQLite storage via `better-sqlite3`.
