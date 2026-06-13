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

> **Wiring it into your game.** Add `PlayJoy.FastLogs` to the assembly definition
> references of the assembly that calls `FastLogs.Init()` (in Terraformers that is
> `_GameAssembly.asmdef`). Out of the box `Init()` uses the bundled
> `FastLogsDefaultServices`, so no service provider has to be registered by hand.

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
| `Token` | Bearer token for the ingest endpoint. Leave empty for an app registered with open ingest. |
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
| `MultiTouchFingerCount` | 0 | With the default corner-tap trigger this is the **number of taps** in the corner that opens the overlay. 0 = keep the trigger's own default (3). |
| `EnableShake` | false | Shake-to-open on mobile. |
| `ShakeThreshold` | 2.5 | Acceleration magnitude that counts as a shake. |
| `ShakeCooldownSeconds` | 1.0 | Minimum seconds between shake triggers. |

> **Default gesture (works out of the box).** `FastLogs.Init()` wires a default
> trigger with no extra setup: **tap the top-right screen corner 3 times quickly**
> (under ~0.6 s between taps) to toggle the overlay, or press the keyboard
> `ToggleKey` (default F8). The corner hot zone is safe-area aware and sized for
> touch. `MultiTouchFingerCount` (if > 0) sets the required tap count. To move the
> zone to another corner or swap the gesture, register a custom `IFastLogsServices`
> via `FastLogs.SetServicesProvider(...)` before `Init()`.

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
| `TesterName` | "" | Tester name attached to every report's `tester` field. Editable at runtime in the overlay's Settings tab. Empty is omitted. |
| `CopyLinkOnSend` | true | After a successful send, automatically copy the short link to the device clipboard. On WebGL this may be blocked outside a user gesture; the overlay's **Copy** button remains as a fallback. |

### Enable

Controls which build flavours activate FastLogs at runtime.

| Field | Default | Description |
|-------|---------|-------------|
| `EnableInEditor` | true | Active in the Unity Editor. |
| `EnableInDevelopment` | true | Active in Development Builds. |
| `EnableInRelease` | false | Active in release builds (requires `LOGSHARE_FORCE_ENABLED` and a non-console target). |

---

## Server: registering an app

Logs are accepted only for an `AppId` the FastLogs server already knows (or one that
self-onboards). Pick one model:

- **Open ingest (no token)** - register the app without a token and leave
  `Config > Server > Token` empty. Simplest for internal QA. On the server / inside
  the container: `node scripts/add-app.js <appId> "<Display Name>" --no-token`.
- **Per-app token** - register the app with a token and put it in
  `Config > Server > Token`.
- **Shared team token + auto-register** - set one `TEAM_INGEST_TOKEN` on the server
  with `ALLOW_AUTO_REGISTER=1`, and put that token in `Config > Server > Token`. An
  unknown `AppId` then self-onboards on its first upload, so new projects need no
  manual registration.

See the FastLogs server repository for the admin CLI and environment variables.

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
var result = await FastLogs.SendAsync(
    includeScreenshot: true,
    title: "My report",
    comment: "Opened level 3, froze on the loading screen."); // optional free-form description
if (result.Success)
    Debug.Log("Link: " + result.Url); // already on the clipboard if CopyLinkOnSend is on
else
    Debug.LogWarning("Upload failed: " + result.Error);
```

`title` is a short headline (<=120 chars); `comment` is the tester's free-form
problem description (<=4000 chars). Both are optional and omitted from the request
when empty. The tester name (`Config > UI > TesterName`) rides along with every
report's `tester` field automatically. When `Config > UI > CopyLinkOnSend` is on
(the default), the short link is copied to the clipboard right after a successful
upload (best-effort on WebGL - see the overlay note below).

### Overlay

The overlay provides a one-tap send UI with a screenshot toggle, a single-line
**Title** input, a multi-line **Comment** input (the tester's free-form problem
description), the current tester name (read-only; edit it in the **Settings** tab),
and a clickable result link. The Settings tab also exposes the **Tester Name** field
and a **Copy link on send** toggle. The overlay is opened by the default gesture
(3 taps in the top-right corner, or F8) or from code:

```csharp
FastLogs.ShowOverlay();
FastLogs.HideOverlay();
FastLogs.ToggleOverlay();
```

On WebGL, copying the link and opening it in a new tab must happen inside a
user-gesture handler (button click). The overlay handles this automatically.

---

## For QA: capture and share a report

1. Install a build with FastLogs enabled (a Development build, or a release build
   made with the `LOGSHARE_FORCE_ENABLED` define - see below).
2. Reproduce the issue in the app.
3. Open the overlay: **tap the top-right corner 3 times quickly** (or press F8 on a
   device with a keyboard).
4. Optional: toggle the screenshot, type a short **Title** and a longer **Comment**
   describing the problem. Set your **Tester Name** once in the Settings tab - it is
   attached to every report you send.
5. Tap **Send**. A short link (e.g. `https://<server>/abc123`) appears in the panel.
6. Copy the link and send it to the developer. It opens in any browser with **no
   token** - showing the console, error/warning/log counts, device snapshot and the
   screenshot.

Recent-reports dashboard (optional): `https://<server>/browse/<appId>` lists versions
and then logs. The catalog is gated by a team **viewer token** - append
`?token=<viewer-token>` to the URL. Individual Send links never need a token.

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

### Passing the define through CI

When a CI step forwards build arguments through a shell (for example a Python or
bash wrapper that appends `--extradefines` to the Unity command line), a bare `;`
in the value is read by the shell as a command separator and the build breaks
(`SOMETHING: command not found`). Quote the whole value so several defines survive
as one token:

```text
# wrong - the shell splits on ';' and the second define becomes a "command":
--extradefines=LOGSHARE_FORCE_ENABLED;ENABLE_SRDEBUG_IN_RELEASE

# right - quoted, reaches Unity intact:
"--extradefines=LOGSHARE_FORCE_ENABLED;ENABLE_SRDEBUG_IN_RELEASE"
```

A single define needs no quotes. `--extradefines` is split on `;` inside the build,
so the `;` separators must arrive at Unity unmangled.

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
