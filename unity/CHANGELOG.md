# Changelog

All notable changes to the FastLogs Unity package are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.0] - 2026-06-13

### Added

- **Context** facade: `FastLogs.SetContext(key, value)` and
  `FastLogs.ClearContext()`. The accumulated key->value map travels with every
  report (`context` contract field) and is shown in the viewer.
- **Breadcrumbs** facade: `FastLogs.Breadcrumb(message, level = FastLogLevel.Log)`,
  backed by `Capture/FastLogsCrumbStore.cs` - a bounded rolling trail of the last
  events (cap 100). Sent as the `breadcrumbs` contract array and shown in the
  viewer timeline.
- `Net/PiiScrubber.cs`: best-effort PII redaction run once at send/crash time over
  the log text, every context value and every breadcrumb message. Default patterns
  redact emails, IPv4, IPv6, Bearer/Authorization tokens and long digit runs
  (>= 9 digits) to `[redacted]`. The pattern set is extensible via
  `PiiScrubber.AddPattern(...)`. Privacy-by-default: `DiagnosticsSection.ScrubPii`
  is `true` and `DiagnosticsSection.IncludeSensitive` is `false` out of the box;
  both are toggleable from the in-game settings panel.
- `Net/PendingCrashQueue.cs`: a durable, crash-safe outbox. On an unhandled
  exception the runtime FIRST persists the (already PII-scrubbed) report to disk
  (`persistentDataPath/FastLogs/pending/<id>.json`) - ahead of every throttle /
  per-session cap / busy / dedup gate - so a crash is never lost, then attempts
  the normal upload. Leftovers are re-sent on idle and on the next app start, so a
  report whose process died mid-upload still arrives.

### Changed

- Unhandled-exception capture now always runs before any delivery guard, with a
  capture-side dedup kept separate from the send-side dedup so a tight crash loop
  cannot flood the outbox while every distinct crash is still captured. The 30s
  throttle and per-session cap (10) limit only the immediate-upload tempo, not
  capture.

### Fixed

- A pending crash report permanently rejected by the server (non-transient 4xx:
  400/401/403/413/415) is dropped from the outbox (poison-pill) instead of being
  retried forever; unparseable/half-written outbox files are also dropped.

## [0.2.0] - 2026-06-13

### Added

- Default services factory and an `Init` fallback so FastLogs works out of the box
  (overlay anchored top-right) without a hand-wired `IFastLogsServices`.
- `FastLogs.Send()` quick-send (no UI) and an auto-send-on-crash path, plus a
  status toast that reports send success and auto-copies the result link.
- Tester-name setting and a per-report comment input, both forwarded to the server.
- Retry-until-success for transient upload errors (unscaled timer), and a guard
  that blocks starting a new send while a send or retry is already in progress.

### Changed

- Hardened the logging hot path: no per-frame allocation and an incremental
  recorder.

## [0.1.0] - 2026-06-12

### Added

- Initial core scaffold of the FastLogs UPM package (`com.playjoy.fastlogs`).
- Static `FastLogs` facade (always compiles): `Init`, `Shutdown`, `IsInitialized`,
  `ShowOverlay`/`HideOverlay`/`ToggleOverlay`, `Log`/`Warn`/`Error`,
  `StartRecording`/`StopRecording`/`SetRecording`/`ClearRecording`, `IsRecording`,
  `RecordScope`, `Counts`, `SendAsync`, `OnUploaded`.
- `FastLogsConfig` ScriptableObject with neutral, empty defaults (no hardcoded
  endpoints) and `FastLogsConfigLoader` (loads `Resources/FastLogsConfig`,
  otherwise an in-memory default).
- Build/console safety: capture, networking, overlay, screenshot and hooks are
  gated behind `UNITY_EDITOR || DEVELOPMENT_BUILD` (optional `LOGSHARE_FORCE_ENABLED`
  for mobile/standalone, hard-guarded off on PS4/PS5/GameCore/Switch).
  Void facade methods are `[Conditional]` so calls strip in retail builds;
  value-returning methods stay as safe no-ops.
- Dependency-free model layer: grouped `DeviceInfoDto`, `LogReportDto`,
  `CountsDto`, `UploadResultDto`, and a `MiniJson` writer/reader (omits empty/null
  fields per contract, parses `{id,url,...}` responses).
- `DiagnosticsCollector`: full device snapshot mapped to the wire contract
  (system / graphics / display / application / runtime / memory / network / build / web),
  with a sensitive-data gate.
- Soft SRDebugger integration via `versionDefines` (`SRDEBUGGER` define, no hard reference).
- `Editor/FastLogsConfigEditor.cs`: custom Inspector for `FastLogsConfig` with
  foldout sections, validation messages (empty endpoint, iOS + http warning, empty
  appId), and quick-action buttons (Ping, Open README, Build Defines Helper).
- `Editor/FastLogsMenu.cs`: `Tools > PlayJoy > FastLogs` menu with Create Config
  Asset, Select Config Asset, Open README, and Build Defines Helper entries.
- `Editor/FastLogsBuildDefines.cs`: utility EditorWindow that lists the
  build-gating model and lets developers add/remove `LOGSHARE_FORCE_ENABLED` per
  platform (Android, iOS, Standalone, WebGL). Console platforms are intentionally
  excluded from the UI.
- `Samples~/BasicUsage/FastLogsBasicUsage.cs`: MonoBehaviour sample that covers
  `Init`, `StartRecording`, `RecordScope`, `SendAsync` with `await`, and the
  `OnUploaded` event.
- `Samples~/BasicUsage/README.md`: step-by-step sample documentation.
- `README.md`: full user documentation covering installation (git URL + embedded),
  config asset creation, all configuration fields, usage patterns (recording,
  logging, sending, overlay), gating/console safety, privacy notes, and samples.

### Notes

- This is a scaffold release. Concrete log sources, trigger sources, uploader,
  screenshot capturer, clipboard and overlay implementations are provided by
  separate builders against the interfaces documented in `ARCHITECTURE.md`.
- `.meta` files are not included in the package source (no Unity available during
  authoring). Unity generates them on first import. Cross-assembly references in
  asmdef files use names rather than GUIDs and resolve automatically.
