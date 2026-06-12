// Extension interfaces for FastLogs.
//
// These are the seams that parallel builders implement to provide concrete
// behaviour (capturing logs, detecting triggers, uploading, screenshots,
// clipboard, overlay UI). The core wires them together; none of them are
// hardcoded to a platform.
//
// Kept dependency-light: they reference only the package's own DTOs and the
// async adapter (FlogTask) so they compile on both Unity 6 and 2022.3.

using System;
using System.Collections.Generic;

namespace PlayJoy.FastLogs
{
    /// <summary>
    /// A single captured log line, normalized across sources (our own hook,
    /// SRDebugger console, etc.).
    /// </summary>
    public struct LogEntry
    {
        public string Message;
        public string StackTrace;
        public FastLogLevel Level;

        /// <summary>Seconds since startup (Time.realtimeSinceStartup) when captured.</summary>
        public double TimeSinceStartup;

        public LogEntry(string message, string stackTrace, FastLogLevel level, double timeSinceStartup)
        {
            Message = message;
            StackTrace = stackTrace;
            Level = level;
            TimeSinceStartup = timeSinceStartup;
        }
    }

    /// <summary>Normalized log severity.</summary>
    public enum FastLogLevel
    {
        Log = 0,
        Warning = 1,
        Error = 2
    }

    /// <summary>
    /// Supplies captured log lines and per-session counts. Implementations may
    /// hook UnityEngine.Application.logMessageReceived, read SRDebugger's console,
    /// or read a WebGL console bridge.
    /// </summary>
    public interface ILogSource : IDisposable
    {
        /// <summary>Start capturing. Safe to call once after construction.</summary>
        void Start();

        /// <summary>Stop capturing (e.g. on shutdown). Counts/entries remain readable.</summary>
        void Stop();

        /// <summary>Manually inject a log line (used by FastLogs.Log/Warn/Error).</summary>
        void Append(string message, FastLogLevel level, string stackTrace = null);

        /// <summary>Clear the ring buffer. Session counts are NOT reset.</summary>
        void Clear();

        /// <summary>Per-session counters (NOT limited to the ring buffer contents).</summary>
        CountsDto Counts { get; }

        /// <summary>
        /// Snapshot the current ring buffer as a single text blob, truncated to
        /// maxBytes (0 = no client cap). A truncation marker is added when cut.
        /// </summary>
        string BuildLogText(int maxBytes);

        /// <summary>Current number of entries in the ring buffer.</summary>
        int EntryCount { get; }
    }

    /// <summary>
    /// Detects an overlay-summon gesture (key combo, multi-touch, shake).
    /// Polled by the runtime pump each frame.
    /// </summary>
    public interface ITriggerSource : IDisposable
    {
        /// <summary>Configure from the asset. Called once before polling.</summary>
        void Configure(TriggerConfig config);

        /// <summary>
        /// Poll for a trigger. Returns true exactly once per gesture (edge), so
        /// the caller can toggle the overlay without debouncing itself.
        /// </summary>
        bool Poll();
    }

    /// <summary>
    /// Uploads a finished report to the server and returns the parsed result.
    /// Implementations differ per platform (UnityWebRequest coroutine path on
    /// WebGL, async path elsewhere) but share this surface.
    /// </summary>
    public interface ILogUploader
    {
        /// <summary>
        /// Send the report. Must not throw; failures are returned as a non-success
        /// <see cref="UploadResultDto"/>. Honors config Net settings.
        /// </summary>
        FlogTask<UploadResultDto> UploadAsync(LogReportDto report, FastLogsConfig config);
    }

    /// <summary>Captures a PNG screenshot of the current frame.</summary>
    public interface IScreenshotCapturer
    {
        /// <summary>
        /// Capture a PNG, downscaled so the longest edge is at most maxDimension.
        /// Returns raw PNG bytes, or null if capture is unavailable/failed.
        /// </summary>
        FlogTask<byte[]> CaptureAsync(int maxDimension);
    }

    /// <summary>Abstracts copying text to the system clipboard (incl. WebGL).</summary>
    public interface IClipboard
    {
        /// <summary>
        /// Copy text to the clipboard. On WebGL this must be called synchronously
        /// from a user-gesture handler. Returns true if the copy was issued.
        /// </summary>
        bool CopyToClipboard(string text);
    }

    /// <summary>
    /// The in-game overlay UI: a button/list surface that shows counts, lets the
    /// user send a report and copy/open the resulting link.
    /// </summary>
    public interface ILogShareOverlay : IDisposable
    {
        /// <summary>Whether the overlay is currently visible.</summary>
        bool IsVisible { get; }

        void Show();
        void Hide();
        void Toggle();

        /// <summary>
        /// Push fresh data to the overlay (counts, last upload result, busy flag).
        /// Called by the runtime pump; cheap to call every frame.
        /// </summary>
        void Refresh(CountsDto counts, bool isBusy, UploadResultDto lastResult);

        /// <summary>Raised when the user requests a send from the overlay.</summary>
        event Action<bool, string> SendRequested; // (includeScreenshot, title)
    }

    /// <summary>
    /// Factory seam so a builder can supply the concrete implementations to the
    /// core in one place. All members may return null - the core treats a null
    /// component as "feature absent" and stays functional.
    /// </summary>
    public interface IFastLogsServices
    {
        ILogSource CreateLogSource(FastLogsConfig config);
        ITriggerSource CreateTriggerSource(FastLogsConfig config);
        ILogUploader CreateUploader(FastLogsConfig config);
        IScreenshotCapturer CreateScreenshotCapturer(FastLogsConfig config);
        IClipboard CreateClipboard(FastLogsConfig config);
        ILogShareOverlay CreateOverlay(FastLogsConfig config);

        /// <summary>
        /// Optional web-info filler (WebGL only). Populates DeviceInfoDto.Web from
        /// the browser via a jslib bridge. May be null on non-web platforms.
        /// </summary>
        IWebDeviceInfoProvider CreateWebDeviceInfoProvider(FastLogsConfig config);
    }

    /// <summary>WebGL-only browser info provider (userAgent, language, etc.).</summary>
    public interface IWebDeviceInfoProvider
    {
        /// <summary>Populate the web group in-place. No-op off WebGL.</summary>
        void Fill(DeviceInfoDto.WebGroup web, bool includeSensitive);
    }
}
