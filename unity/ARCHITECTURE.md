# FastLogs (Unity) - Core Architecture & Builder Contract

This document is the **authoritative contract for parallel builders**. It lists
the exact public signatures of the core (facade, config, DTOs) and the extension
interfaces the builders must implement. Treat the signatures here as fixed - the
core wires against them. Wire-level JSON is defined in the repo-root `CONTRACT.md`.

- Namespace (all runtime types): `PlayJoy.FastLogs`
- Editor types: `PlayJoy.FastLogs.Editor`
- Sample types: `PlayJoy.FastLogs.Samples`
- Target: Unity **6000.1** (Unity 6); also compiles on **2022.3 LTS**.
- No third-party dependencies. No `em dash` anywhere. SRDebugger is soft
  (`SRDEBUGGER` versionDefine), never a hard reference.

---

## 0. Build gating (read first)

Every file that does init / networking / overlay / screenshot / log-hooking
begins with this identical header:

```csharp
#if UNITY_EDITOR || DEVELOPMENT_BUILD || (LOGSHARE_FORCE_ENABLED && !(UNITY_PS4 || UNITY_PS5 || UNITY_GAMECORE || UNITY_SWITCH))
#define FASTLOGS_ENABLED
#endif
```

Rules builders MUST follow:

- The **public `FastLogs.*` facade always compiles** (verified). Game code that
  calls FastLogs builds in retail/console.
- Void fire-and-forget methods carry
  `[Conditional("UNITY_EDITOR"), Conditional("DEVELOPMENT_BUILD"), Conditional("LOGSHARE_FORCE_ENABLED")]`
  so both body and call sites strip in retail.
- Value-returning methods (`IsInitialized`, `IsRecording`, `Counts`, `SendAsync`,
  `RecordScope`) always compile; in a stripped build they are inert no-ops/defaults.
- Builder implementation types (uploader, overlay, screenshot, etc.) should gate
  their whole file with the same `#if FASTLOGS_ENABLED` header, and only be
  referenced by the core under the same guard. (`FastLogsRuntime` and
  `DiagnosticsCollector` already do this - confirmed absent from the stripped DLL.)

Verified (isolated `dotnet` compile + reflection) across 5 permutations
(Editor+Dev / retail-stripped / pre-2022.2 / forced-Android / forced-PS5):
all compile with 0 warnings; in the stripped DLL `FastLogsRuntime` and
`DiagnosticsCollector` are **gone**, the facade and its methods remain.

---

## 1. Public facade - `static class FastLogs`

File: `Runtime/Core/FastLogs.cs`

```csharp
public static class FastLogs
{
    // Event - always compiles; never fires in stripped builds.
    public static event Action<UploadResultDto> OnUploaded;

    // --- Setup (void, [Conditional] -> stripped in retail) ---
    public static void SetServicesProvider(IFastLogsServices provider);
    public static void Init(FastLogsConfig config = null);
    public static void Shutdown();

    // --- State (value-returning, always compiles) ---
    public static bool IsInitialized { get; }   // false when stripped

    // --- Overlay (void, [Conditional]) ---
    public static void ShowOverlay();
    public static void HideOverlay();
    public static void ToggleOverlay();

    // --- Logging (void, [Conditional]) ---
    public static void Log(string message, FastLogLevel level = FastLogLevel.Log);
    public static void Warn(string message);
    public static void Error(string message);

    // --- Recording (void, [Conditional]) ---
    public static void StartRecording();
    public static void StopRecording();
    public static void SetRecording(bool value);
    public static void ClearRecording();

    // --- Recording state (value-returning, always compiles) ---
    public static bool IsRecording { get; }            // false when stripped
    public static IDisposable RecordScope();           // no-op disposable when stripped

    // --- Counts (value-returning) ---
    public static CountsDto Counts { get; }            // default(all-zero) when stripped

    // --- Send (value-returning, awaitable on all Unity versions) ---
    public static FlogTask<UploadResultDto> SendAsync(bool includeScreenshot = false, string title = null);
    // stripped build returns FlogTask.FromResult(UploadResultDto.Disabled)
}
```

Usage: `var r = await FastLogs.SendAsync(true, "title");` (the `await` resolves
via `FlogTask<T>`'s custom awaiter - no `Task`/`Awaitable` dependency).

---

## 2. Async adapter - `FlogTask<T>`

File: `Runtime/Core/FlogTask.cs`

Why: Unity 6 has `Awaitable`, 2022.3 does not; WebGL has no threads. `FlogTask<T>`
is a tiny main-thread future completed from a coroutine. Builders that do async
work (uploader, screenshot) **return a `FlogTask<T>` and complete it from a
coroutine** (`SetResult`/`SetException`). The core polls `IsCompleted` inside its
own driving coroutine, so the whole pipeline is coroutine-based and WebGL-safe.

```csharp
public static class FlogTask
{
    public static FlogTask<T> FromResult<T>(T value);
    public static FlogTask<T> FromException<T>(Exception error);
    public static FlogTask<T> Create<T>();
}

public sealed class FlogTask<T>
{
    public bool IsCompleted { get; }
    public bool IsFaulted   { get; }
    public T Result { get; }            // throws if faulted
    public Exception Exception { get; }

    public void SetResult(T value);     // idempotent (double-complete ignored)
    public void SetException(Exception error);

    public Awaiter GetAwaiter();        // enables `await`
    public readonly struct Awaiter : INotifyCompletion
    {
        public bool IsCompleted { get; }
        public T GetResult();
        public void OnCompleted(Action continuation);
    }
}
```

Builder pattern (uploader/screenshot):

```csharp
public FlogTask<UploadResultDto> UploadAsync(LogReportDto report, FastLogsConfig config)
{
    var task = FlogTask.Create<UploadResultDto>();
    _hostMonoBehaviour.StartCoroutine(UploadRoutine(report, config, task)); // completes task at the end
    return task;
}
```

`FlogTask` completes on the main thread, so continuations run inline (or via the
captured `SynchronizationContext` when present). Do not complete from a worker thread.

---

## 3. Extension interfaces (BUILDERS IMPLEMENT THESE)

File: `Runtime/Core/Interfaces.cs`

```csharp
public enum FastLogLevel { Log = 0, Warning = 1, Error = 2 }

public struct LogEntry
{
    public string Message;
    public string StackTrace;
    public FastLogLevel Level;
    public double TimeSinceStartup;   // Time.realtimeSinceStartup at capture
    public LogEntry(string message, string stackTrace, FastLogLevel level, double timeSinceStartup);
}

public interface ILogSource : IDisposable
{
    void Start();
    void Stop();
    void Append(string message, FastLogLevel level, string stackTrace = null);
    void Clear();                       // clears ring buffer; session Counts NOT reset
    CountsDto Counts { get; }           // per-session totals (not limited to ring)
    string BuildLogText(int maxBytes);  // 0 = no client cap; add truncation marker when cut
    int EntryCount { get; }
}

public interface ITriggerSource : IDisposable
{
    void Configure(TriggerConfig config);
    bool Poll();                        // true exactly once per gesture (edge)
}

public interface ILogUploader
{
    FlogTask<UploadResultDto> UploadAsync(LogReportDto report, FastLogsConfig config);
    // MUST NOT throw; return a non-success UploadResultDto on failure.
    // WebGL: plain body only (no gzip), coroutine path. Honor config.Net.
}

public interface IScreenshotCapturer
{
    FlogTask<byte[]> CaptureAsync(int maxDimension);  // PNG bytes (longest edge <= maxDimension), or null
}

public interface IClipboard
{
    bool CopyToClipboard(string text);  // WebGL: call from a user-gesture handler
}

public interface ILogShareOverlay : IDisposable
{
    bool IsVisible { get; }
    void Show();
    void Hide();
    void Toggle();
    void Refresh(CountsDto counts, bool isBusy, UploadResultDto lastResult); // called each frame while visible
    event Action<bool, string> SendRequested;   // (includeScreenshot, title)
}

// Web-only (WebGL) browser info filler. May be null elsewhere.
public interface IWebDeviceInfoProvider
{
    void Fill(DeviceInfoDto.WebGroup web, bool includeSensitive);
}

// One factory the builder registers via FastLogs.SetServicesProvider(...).
// Any member may return null -> the core treats that feature as absent and
// stays functional.
public interface IFastLogsServices
{
    ILogSource             CreateLogSource(FastLogsConfig config);
    ITriggerSource         CreateTriggerSource(FastLogsConfig config);
    ILogUploader           CreateUploader(FastLogsConfig config);
    IScreenshotCapturer    CreateScreenshotCapturer(FastLogsConfig config);
    IClipboard             CreateClipboard(FastLogsConfig config);
    ILogShareOverlay       CreateOverlay(FastLogsConfig config);
    IWebDeviceInfoProvider CreateWebDeviceInfoProvider(FastLogsConfig config);
}
```

### How the core consumes builders (orchestration, already implemented)

`FastLogsRuntime` (internal MonoBehaviour, `Runtime/Core/FastLogsRuntime.cs`,
gated) does the wiring; builders never touch it directly:

1. `FastLogs.SetServicesProvider(yourServices)` then `FastLogs.Init()`.
2. `Init` resolves config, checks `FastLogsGate.IsEnabled`, then
   `FastLogsRuntime.Create(config, services)`.
3. The host calls each `Create*`, then `ILogSource.Start()`,
   `ITriggerSource.Configure(config.Trigger)`, subscribes to
   `ILogShareOverlay.SendRequested`, and auto-starts recording if configured.
4. `Update()` pumps: `ITriggerSource.Poll()` -> toggle overlay; refresh overlay.
5. `SendAsync`/overlay-send drives a coroutine:
   `IScreenshotCapturer.CaptureAsync` (optional, polled) ->
   `DiagnosticsCollector.Collect` + `IWebDeviceInfoProvider.Fill` + `ILogSource.BuildLogText` ->
   `ILogUploader.UploadAsync` (polled) -> result -> `OnUploaded`.

The core sets `LogEncoding = "plain"` by default (always contract-valid). A
non-WebGL uploader/log-source MAY gzip+base64 `logText` and set the encoding
accordingly; **WebGL must keep "plain"**.

---

## 4. Config - `FastLogsConfig` (ScriptableObject)

File: `Runtime/Core/FastLogsConfig.cs`. `[CreateAssetMenu]` menu
`PlayJoy/FastLogs/Config`. Resolved from `Resources/FastLogsConfig` or an
in-memory default. **All defaults neutral / empty.**

```csharp
public sealed class FastLogsConfig : ScriptableObject
{
    public ServerSection      Server      { get; }
    public CaptureSection     Capture     { get; }
    public RecordingSection   Recording   { get; }
    public ScreenshotSection  Screenshot  { get; }
    public DiagnosticsSection Diagnostics { get; }
    public TriggerConfig      Trigger     { get; }
    public NetSection         Net         { get; }
    public UiSection          UI          { get; }
    public EnableSection      Enable      { get; }

    // flat convenience (used by the gate)
    public bool EnableInEditor { get; }
    public bool EnableInDevelopment { get; }
    public bool EnableInRelease { get; }

    public static FastLogsConfig CreateDefault();

    [Serializable] public sealed class ServerSection {
        public string EndpointUrl = "";          // e.g. https://logs.example.com/api/logs
        public string AppId = "";                // [a-z0-9_-]{2,32}
        public string Token = "";                // optional bearer
        public int RetentionDaysOverride = 0;    // 0 = server decides
    }
    [Serializable] public sealed class CaptureSection {
        public int RingCapacity = 1000;
        public int MaxLogTextBytes = 1048576;    // 1 MB; 0 = no client cap
        public bool UseSrDebuggerConsoleIfPresent = true;
    }
    [Serializable] public sealed class RecordingSection {
        public bool Enabled = false;
        public bool AutoStartRecording = false;
        public bool PersistAcrossSessions = true;
        public int MaxStoreBytes = 2097152;      // 2 MB; 0 = unlimited
    }
    [Serializable] public sealed class ScreenshotSection {
        public bool CaptureByDefault = false;
        public int MaxDimension = 1280;
    }
    [Serializable] public sealed class DiagnosticsSection {
        public bool IncludeSensitive = false;    // deviceModel/identifier/url/referrer
    }
    [Serializable] public sealed class NetSection {
        public int TimeoutSeconds = 20;
        public int MaxRetries = 2;
        public bool GzipBody = true;             // ignored on WebGL
    }
    [Serializable] public sealed class UiSection {
        public bool EnableUI = true;
    }
    [Serializable] public sealed class EnableSection {
        public bool EnableInEditor = true;
        public bool EnableInDevelopment = true;
        public bool EnableInRelease = false;     // effective only with LOGSHARE_FORCE_ENABLED on non-console
    }
}
```

### `TriggerConfig` (`Runtime/Core/TriggerConfig.cs`, `[Serializable]`)

```csharp
[Serializable] public sealed class TriggerConfig
{
    public bool EnableKeyboard = true;
    public KeyCode ToggleKey = KeyCode.F8;
    public TriggerModifier Modifier = TriggerModifier.None;  // None|Ctrl|Alt|Shift|Cmd
    public int MultiTouchFingerCount = 0;                    // 0 = disabled
    public bool EnableShake = false;
    public float ShakeThreshold = 2.5f;
    public float ShakeCooldownSeconds = 1.0f;
    public enum TriggerModifier { None, Ctrl, Alt, Shift, Cmd }
}
```

### `FastLogsConfigLoader` (internal)

```csharp
internal static class FastLogsConfigLoader
{
    public const string ResourceName = "FastLogsConfig";
    public static FastLogsConfig LoadOrDefault();   // never null
}
```

### `FastLogsGate` (internal)

```csharp
internal static class FastLogsGate
{
    public static bool IsCompiledIn { get; }             // FASTLOGS_ENABLED
    public static bool IsEnabled(FastLogsConfig config); // compiled-in AND config opt-in for this flavour
}
```

### `FlogLog` (internal, all `[Conditional]`)

```csharp
internal static class FlogLog
{
    public static void Info(string message);
    public static void Warn(string message);
    public static void Error(string message);
    public static void Exception(System.Exception exception);
}
```
Use `FlogLog`, never `UnityEngine.Debug`, inside the package.

---

## 5. DTOs (Model)

```csharp
// CountsDto.cs
public struct CountsDto
{
    public int Error, Warn, Log;
    public CountsDto(int error, int warn, int log);
    public int Total { get; }
}

// UploadResultDto.cs
public struct UploadResultDto
{
    public bool Success;
    public string Id, Url, RawUrl, ExpiresAt;
    public long StatusCode;
    public string Error;
    public static UploadResultDto Ok(string id, string url, string rawUrl, string expiresAt, long statusCode);
    public static UploadResultDto Fail(string error, long statusCode = 0);
    public static UploadResultDto Disabled { get; }
}

// LogReportDto.cs - top-level request body
public sealed class LogReportDto
{
    public string AppId;                 // required
    public string Platform;              // required (WebGL|Android|iOS|Windows|macOS|Linux|GameMaker|PS4|PS5|Switch|Xbox|Other)
    public string AppVersion;            // required
    public string TimestampUtc;          // required, ISO-8601 UTC
    public CountsDto Counts;             // required
    public string LogText;               // required
    public string LogEncoding;           // required ("plain" | "gzip+base64"); WebGL -> "plain"
    public DeviceInfoDto Device;         // required
    public string ScreenshotPngBase64;   // optional - omitted when empty (NO "data:" prefix)
    public int? RetentionDays;           // optional - omitted when null
    public string Title;                 // optional - omitted when empty (<=120 chars)
}

// DeviceInfoDto.cs - grouped; null fields/empty groups OMITTED by MiniJson
public sealed class DeviceInfoDto
{
    public SystemGroup System; public GraphicsGroup Graphics; public DisplayGroup Display;
    public ApplicationGroup Application; public RuntimeGroup Runtime; public MemoryGroup Memory;
    public NetworkGroup Network; public BuildGroup Build; public WebGroup Web;

    public sealed class SystemGroup {
        public string Model;           // sensitive-gated
        public string Os, OsFamily, Cpu;
        public int? Cores, CpuFreqMHz, MemoryMB;
        public string DeviceType;
        public float? Battery;
        public string BatteryStatus, Locale, Timezone;
    }
    public sealed class GraphicsGroup {
        public string Gpu, Vendor, ApiVersion, DeviceType;
        public int? VramMB, ShaderLevel, MaxTextureSize;
        public Dictionary<string, object> Supports;   // nested object; omitted when empty
    }
    public sealed class DisplayGroup {
        public string Screen;           // "WxH"
        public int? Dpi;
        public string Orientation, SafeArea;          // SafeArea "x,y,w,h"
        public bool? FullScreen;
        public int? RefreshHz, Displays;
    }
    public sealed class ApplicationGroup {
        public string EngineVersion, Platform;
        public string Identifier;       // sensitive-gated
        public string InstallMode, SandboxType;
        public int? TargetFrameRate;
        public string QualityLevel;
        public bool? Genuine;
    }
    public sealed class RuntimeGroup {
        public string Scene;
        public List<string> LoadedScenes;
        public float? TimeScale, UptimeSec;
        public int? Fps, FrameCount;
    }
    public sealed class MemoryGroup { public float? ManagedMB, TotalAllocatedMB, GcMB; }
    public sealed class NetworkGroup { public string Reachability; }
    public sealed class BuildGroup   { public string Commit, Branch, BuildNumber, BuildDate; }
    public sealed class WebGroup {      // WebGL only, filled via IWebDeviceInfoProvider
        public string UserAgent;
        public string Url, Referrer;    // sensitive-gated
        public string Language;
        public int? HardwareConcurrency;
        public float? DeviceMemoryGB;
        public string Connection;
    }
}
```

### `MiniJson` (internal) - `Runtime/Model/MiniJson.cs`

```csharp
internal static class MiniJson
{
    public static string SerializeReport(LogReportDto report);
    public static bool TryParseUploadResponse(string json,
        out string id, out string url, out string rawUrl, out string expiresAt,
        out string error, out string message);
    public static object Parse(string json);   // Dictionary<string,object>/List<object>/string/double/bool/null
}
```

Serializer behavior (functionally verified): omits empty strings / null
`Nullable<T>` / empty groups, escapes `" \\ \b \f \n \t` and control chars,
invariant-culture numbers, `counts`/required fields always present. Reader is a
small tolerant parser used only for the upload response (and the cloud-build
manifest).

---

## 6. DiagnosticsCollector (internal, gated)

File: `Runtime/Device/DiagnosticsCollector.cs`

```csharp
internal static class DiagnosticsCollector
{
    public static DeviceInfoDto Collect(bool includeSensitive);  // Web group left for IWebDeviceInfoProvider
}
```

Fills system/graphics/display/application/runtime/memory/network/build from
`SystemInfo`, `Application`, `Screen`/`Display`, `QualitySettings`, `Time`,
`SceneManager`, `GC`/`Profiler`, `Application.internetReachability`, and the
`UnityCloudBuildManifest.json` resource (commit/branch/buildNumber/buildStartTime).
`deviceModel`, `Application.identifier`, web `url`/`referrer` only when
`includeSensitive`. Refresh-rate uses `#if UNITY_2022_2_OR_NEWER`
(`refreshRateRatio.value`) else `refreshRate`.

---

## 7. Files created

```
unity/package.json                              com.playjoy.fastlogs 0.1.0, unity 2022.3, MIT, sample
unity/README.md  CHANGELOG.md  LICENSE.md  ARCHITECTURE.md
unity/Runtime/PlayJoy.FastLogs.asmdef           autoReferenced; SRDEBUGGER versionDefine; no hard refs
unity/Editor/PlayJoy.FastLogs.Editor.asmdef     includePlatforms:[Editor]; refs Runtime by name
unity/Editor/FastLogsConfigMenu.cs              Tools/FastLogs/Create+Select Config Asset
unity/Runtime/Core/FastLogs.cs                  static facade (always compiles)
unity/Runtime/Core/FastLogsRuntime.cs           MonoBehaviour host (gated)
unity/Runtime/Core/FastLogsConfig.cs            ScriptableObject + sections
unity/Runtime/Core/TriggerConfig.cs             [Serializable] trigger settings
unity/Runtime/Core/FastLogsConfigLoader.cs      Resources/FastLogsConfig or default
unity/Runtime/Core/FastLogsGate.cs              enable decision (#if + config)
unity/Runtime/Core/FlogLog.cs                   internal [Conditional] logger
unity/Runtime/Core/FlogTask.cs                  awaitable future (no Task/Awaitable dep)
unity/Runtime/Core/Interfaces.cs                ILogSource/ITriggerSource/ILogUploader/
                                                IScreenshotCapturer/IClipboard/ILogShareOverlay/
                                                IWebDeviceInfoProvider/IFastLogsServices + LogEntry/FastLogLevel
unity/Runtime/Model/CountsDto.cs  UploadResultDto.cs  LogReportDto.cs  DeviceInfoDto.cs  MiniJson.cs
unity/Runtime/Device/DiagnosticsCollector.cs    (gated)
unity/Samples~/BasicUsage/FastLogsBasicUsage.cs sample MonoBehaviour
```

---

## 8. Notes for whoever compiles in Unity (attention points)

- `.meta` files are not authored here (no Unity available). Unity generates them
  on first import; asmdef cross-refs are by **name** (`"PlayJoy.FastLogs"`), so
  they resolve without a GUID. If your pipeline requires committed `.meta`, run an
  import once and commit them.
- The `SRDEBUGGER` versionDefine has an empty expression (any installed version);
  no code in the core uses it yet - the log-source builder will, softly.
- `FastLogsRuntime.SetRecording` currently toggles capture start/stop and a flag;
  ring/persistence semantics (RingCapacity, PersistAcrossSessions, MaxStoreBytes)
  live in the `ILogSource` builder.
- `IWebDeviceInfoProvider` is the only WebGL-specific seam; everything else is
  platform-neutral. The jslib bridge pattern to follow is
  `LookingForAliens/.../WebPlatformBridge.{cs,jslib}`.
- Cross-version compile verified via standalone `dotnet` (Editor+Dev, retail,
  pre-2022.2, forced-Android, forced-PS5) - all 0 warnings/0 errors. Unity's own
  compiler is the final authority; this package avoids version-specific APIs
  except the `#if`-guarded refresh-rate read.
```
