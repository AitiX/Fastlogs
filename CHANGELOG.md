# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- MIT `LICENSE` and this `CHANGELOG`.
- `server/Dockerfile` and `server/docker-compose.yml` for one-command deploy.
- Browser-accessible catalog: `GET /browse` (and sub-paths) serve the catalog UI
  on `Accept: text/html`, and `public/browse.css` / `public/browse.js` are
  served via the static allowlist.
- gzip+base64 ingest now validates the gzip magic bytes and trial-decompresses
  with a `MAX_LOG_BYTES` ceiling (rejects corrupt or oversized logs at ingest).

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
