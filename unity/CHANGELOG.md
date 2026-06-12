# Changelog

All notable changes to the FastLogs Unity package are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
