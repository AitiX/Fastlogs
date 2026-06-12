# FastLogs (Unity)

Lightweight in-game log capture and one-tap sharing for Unity.

FastLogs records your console output into a ring buffer, gathers a rich device
snapshot, optionally grabs a screenshot, and uploads everything to a FastLogs
server - returning a short, shareable link your QA / team can open in a browser.

- No hardcoded endpoints or domains. Everything is configured per project.
- No third-party dependencies. JSON and (later) QR are self-contained.
- SRDebugger integration is optional (soft, via reflection / `versionDefines`).
- Console-safe: all capture, networking, overlay and screenshot logic is gated
  to Editor and Development builds and stripped on retail / console targets.
  The public `FastLogs.*` API always compiles, so your game code builds everywhere.

---

## Installation

### Via Git URL (recommended)

Add to `Packages/manifest.json`:

```jsonc
{
  "dependencies": {
    "com.playjoy.fastlogs": "https://github.com/PlayJoy/fastlogs.git?path=/unity#main"
  }
}
```

Replace the URL and branch with your actual FastLogs repository. The `?path=/unity`
suffix tells Unity Package Manager to use only the `unity/` subdirectory as the
package root.

### Embedded / local

Copy the `unity/` folder into your project's `Packages/` directory and rename it
to `com.playjoy.fastlogs`. Unity detects it automatically.

**Supported Unity versions:** 6000.1 (Unity 6) and 2022.3 LTS.

---

## Creating a Config Asset

FastLogs reads its settings from a `FastLogsConfig` ScriptableObject placed in any
`Resources/` folder under `Assets/`. The included Editor tooling creates one for you:

1. Open `Tools > PlayJoy > FastLogs > Create Config Asset`.
   The asset is created at `Assets/Resources/FastLogsConfig.asset` and selected
   automatically in the Project window.
2. Alternatively, right-click anywhere in the Project window and choose
   `Create > PlayJoy > FastLogs > Config`.

If a config asset already exists anywhere in the project, the menu command pings it
instead of creating a duplicate.

---

## Configuration

Open the config asset in the Inspector. All sections are shown with foldouts.

### Server

| Field | Description |
|-------|-------------|
| `EndpointUrl` | Full ingest URL, e.g. `https://logs.example.com/api/logs`. Required for uploads. |
| `AppId` | Project identifier `[a-z0-9_-]{2,32}` - groups logs in the catalog. |
| `Token` | Optional Bearer token for the ingest endpoint. |
| `RetentionDaysOverride` | Per-request retention in days. 0 = server default. |

> On iOS the endpoint must be `https://` (App Transport Security). The Inspector
> shows a warning if you enter an `http://` URL.

### Capture

| Field | Default | Description |
|-------|---------|-------------|
| `RingCapacity` | 1000 | Max log entries kept in the ring buffer. Oldest entries are evicted. |
| `MaxLogTextBytes` | 1 MB | Client-side cap on serialized log text. 0 = no cap (server still clamps). |
| `UseSrDebuggerConsoleIfPresent` | true | Read SRDebugger's console buffer when available (soft dependency). |

### Recording

| Field | Default | Description |
|-------|---------|-------------|
| `AutoStartRecording` | false | Begin recording immediately on `Init`. |
| `PersistAcrossSessions` | true | Persist the ring buffer to disk across play sessions. |
| `MaxStoreBytes` | 2 MB | Max bytes of persisted log data. 0 = unlimited. |

### Screenshot

| Field | Default | Description |
|-------|---------|-------------|
| `CaptureByDefault` | false | Automatically include a screenshot when `SendAsync` is called. |
| `MaxDimension` | 1280 | Longest edge of the captured PNG in pixels; larger captures are downscaled. |

### Diagnostics

| Field | Default | Description |
|-------|---------|-------------|
| `IncludeSensitive` | false | Include device model, app identifier, page URL, and referrer in the device snapshot. |

### Trigger

Configures the gesture that opens/closes the overlay.

| Field | Default | Description |
|-------|---------|-------------|
| `EnableKeyboard` | true | Allow a keyboard shortcut to toggle the overlay. |
| `ToggleKey` | F8 | The keyboard key. |
| `Modifier` | None | Optional modifier: None, Ctrl, Alt, Shift, Cmd. |
| `MultiTouchFingerCount` | 0 | Number of simultaneous fingers to trigger on mobile. 0 = disabled. |
| `EnableShake` | false | Shake-to-open on mobile. |
| `ShakeThreshold` | 2.5 | Acceleration magnitude that counts as a shake. |
| `ShakeCooldownSeconds` | 1.0 | Minimum seconds between shake triggers. |

### Net

| Field | Default | Description |
|-------|---------|-------------|
| `TimeoutSeconds` | 20 | HTTP request timeout. |
| `MaxRetries` | 2 | Retry attempts after the first failure. |
| `GzipBody` | true | Gzip-compress the request body. Automatically disabled on WebGL. |

### UI

| Field | Default | Description |
|-------|---------|-------------|
| `EnableUI` | true | Enable the in-game share overlay. |

### Enable

Controls which build flavours activate FastLogs at runtime.

| Field | Default | Description |
|-------|---------|-------------|
| `EnableInEditor` | true | Active in the Unity Editor. |
| `EnableInDevelopment` | true | Active in Development Builds. |
| `EnableInRelease` | false | Active in release builds (requires `LOGSHARE_FORCE_ENABLED` and a non-console target). |

---

## Usage

### Initialization

Call `FastLogs.Init()` once early in your bootstrap (e.g. in `Awake` on a manager
that loads before everything else). Passing `null` loads `Resources/FastLogsConfig`;
you can also pass an explicit asset reference.

```csharp
using PlayJoy.FastLogs;

// Simplest - loads Resources/FastLogsConfig automatically:
FastLogs.Init();

// Or pass an explicit config (e.g. assigned in the Inspector):
[SerializeField] private FastLogsConfig _config;
FastLogs.Init(_config);
```

`Init` is idempotent - calling it more than once is safe.

### Recording

```csharp
// Start capturing log output into the ring buffer:
FastLogs.StartRecording();

// Stop without clearing:
FastLogs.StopRecording();

// Clear the ring buffer (session counters are NOT reset):
FastLogs.ClearRecording();

// Bracket a specific section:
using (FastLogs.RecordScope())
{
    // everything logged here is captured
    DoSomethingImportant();
}
```

### Manual log entries

```csharp
FastLogs.Log("Checkpoint reached");
FastLogs.Warn("Low memory: " + available + " MB");
FastLogs.Error("Enemy spawner failed to initialize");
// Or with explicit level:
FastLogs.Log("Verbose detail", FastLogLevel.Log);
```

### Sending a report

```csharp
// Fire-and-forget (result via event):
FastLogs.OnUploaded += r => Debug.Log("Uploaded: " + r.Url);
FastLogs.SendAsync(includeScreenshot: true, title: "Crash on level load");

// Or await (works on every Unity version and on WebGL):
var result = await FastLogs.SendAsync(includeScreenshot: true, title: "My report");
if (result.Success)
    GUIUtility.systemCopyBuffer = result.Url; // copy link
else
    Debug.LogWarning("Upload failed: " + result.Error);
```

### Overlay

The overlay provides a one-tap send UI with screenshot toggle, title input, and a
clickable result link. It is opened by the configured gesture (default: F8) or from code:

```csharp
FastLogs.ShowOverlay();
FastLogs.HideOverlay();
FastLogs.ToggleOverlay();
```

On WebGL, copying the link and opening it in a new tab must happen inside a
user-gesture handler (button click). The overlay handles this automatically.

---

## Gating and console safety

The build-gating model ensures **zero overhead in retail and console builds**:

- All initialization, networking, overlay, screenshot, and hook logic is wrapped in
  `#if UNITY_EDITOR || DEVELOPMENT_BUILD` (or `LOGSHARE_FORCE_ENABLED` with a
  console guard). In a retail build, these code paths are not compiled.
- Fire-and-forget void methods (`Init`, `Log`, `StartRecording`, `ShowOverlay`, ...)
  carry `[Conditional]` attributes. The C# compiler removes both the method body
  **and every call site** in a retail build, so your game code pays no call overhead.
- Value-returning methods (`IsRecording`, `SendAsync`, `RecordScope`, `Counts`)
  compile everywhere but return safe no-op defaults (false / disabled result / no-op
  disposable / zero counts).
- Console platforms (PS4, PS5, GameCore, Switch) are hard-blocked by a `#if`
  guard inside `LOGSHARE_FORCE_ENABLED`. There is no way to enable FastLogs on
  consoles without modifying the package source.

### Enabling FastLogs in a release build (mobile / standalone / WebGL)

Use `Tools > PlayJoy > FastLogs > Build Defines Helper` to add the
`LOGSHARE_FORCE_ENABLED` scripting define to the target platform group, then set
`Config > Enable > EnableInRelease = true`.

> This should only be done when you have a deliberate operational reason - HTTP
> traffic and optional screenshots will run in a production build.

---

## Samples

Import the **Basic Usage** sample from the Package Manager (Samples tab). It
demonstrates init, recording, RecordScope, SendAsync with await, and the OnUploaded
event. A README inside the sample folder explains each step.

---

## Privacy

- `Config > Diagnostics > IncludeSensitive = false` (the default) omits the device
  model name, application identifier, and (on WebGL) the page URL and referrer from
  the uploaded device snapshot.
- Screenshots are only captured when explicitly requested via the overlay toggle or
  `SendAsync(includeScreenshot: true)`.
- No data is sent automatically. All uploads are user-initiated (gesture / API call).

---

## Contract

The wire format shared with the FastLogs server and all other clients is defined
in the repository-level `CONTRACT.md`. This package emits requests that conform
to it exactly.

---

## License

MIT. See `LICENSE.md`.
