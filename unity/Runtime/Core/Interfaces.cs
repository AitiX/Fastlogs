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

        /// <summary>Approximate size in bytes of the buffered log text (cheap O(1); for size hints, not exact).</summary>
        int ApproxLogBytes { get; }
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

    /// <summary>
    /// A single file/folder upload request. The payload is already the final bytes to
    /// send (a raw file read into memory, or a zip archive produced on the client for a
    /// folder / multiple files). The uploader base64-encodes the bytes onto the JSON
    /// body of POST /api/files. Unlike a log report, the blob is NEVER PII-scrubbed
    /// (explicit invariant): only the decoded-size cap applies.
    /// </summary>
    public struct FileUploadRequest
    {
        /// <summary>Final bytes to upload (file content or client-side zip).</summary>
        public byte[] Bytes;

        /// <summary>Display/download file name, e.g. "save.dat" or "folder.zip".</summary>
        public string FileName;

        /// <summary>MIME type (e.g. "application/octet-stream", "application/zip"). May be null.</summary>
        public string Mime;

        /// <summary>Optional human-facing title shown in the viewer. May be null.</summary>
        public string Title;

        /// <summary>Optional id of the log this file is an attachment of. May be null.</summary>
        public string LogId;

        /// <summary>Optional group id tying several files into one upload batch. May be null.</summary>
        public string GroupId;

        /// <summary>Optional kind tag (e.g. "file", "folder", "attachment"). May be null.</summary>
        public string Kind;
    }

    /// <summary>
    /// Uploads a single file/folder blob to the server's files endpoint (POST /api/files,
    /// JSON + base64) and returns the parsed result. Separate from <see cref="ILogUploader"/>
    /// because it targets a different endpoint and does not carry a log report. Like the
    /// log uploader, implementations must not throw - failures are returned as a
    /// non-success <see cref="FileUploadResultDto"/>.
    /// </summary>
    public interface IFileUploader
    {
        /// <summary>
        /// Upload the file blob in <paramref name="req"/>. Honors config Files settings
        /// (endpoint, timeout). The body is sent plain (no gzip applied to the blob).
        /// </summary>
        FlogTask<FileUploadResultDto> UploadFileAsync(FileUploadRequest req, FastLogsConfig config);
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
        event Action<bool, string, string> SendRequested; // (includeScreenshot, title, comment)

        /// <summary>Raised when the user arms scene-context capture (queue a hierarchy snapshot for the next send).</summary>
        event Action SceneContextRequested;

        /// <summary>
        /// Show a confirm prompt with the given message and two choices (Send / Cancel),
        /// rendered like a toast so it is visible even when the overlay is closed. Replaces
        /// any pending confirm. The answer is delivered via <see cref="ConfirmAnswered"/>.
        /// Used by the loop guard: a code call site that keeps sending asks the user before
        /// it floods the server.
        /// </summary>
        void ShowConfirm(string message);

        /// <summary>
        /// Raised once when the user answers an active confirm prompt: true = proceed with
        /// the send, false = cancel. The prompt is hidden before this fires.
        /// </summary>
        event Action<bool> ConfirmAnswered;
    }

    /// <summary>Severity / intent of a transient on-screen toast.</summary>
    public enum ToastKind
    {
        Info = 0,
        Progress = 1,
        Success = 2,
        Error = 3
    }

    /// <summary>
    /// Optional seam for showing a lightweight, transient status toast that is
    /// visible even when the overlay is closed (send progress / result / errors).
    /// An overlay implementation MAY also implement this; the runtime checks for it
    /// at runtime, so existing <see cref="ILogShareOverlay"/> implementations that
    /// do not implement it keep working (no toast, no cost).
    ///
    /// Implementations must render NOTHING (zero per-frame work / allocations) while
    /// no toast is active, so a closed overlay with no pending toast is free.
    /// </summary>
    public interface IToastSink
    {
        /// <summary>
        /// Show or replace the current toast.
        /// </summary>
        /// <param name="kind">Severity / intent (drives colour and behaviour).</param>
        /// <param name="message">Short status line.</param>
        /// <param name="url">Optional shareable url shown/copyable on success (may be null).</param>
        /// <param name="autoHideSeconds">Seconds before the toast auto-hides. &lt;= 0 keeps it until replaced/dismissed (used for in-progress and retryable errors).</param>
        /// <param name="allowRetry">When true the toast offers a Retry affordance that re-runs the last send.</param>
        void ShowToast(ToastKind kind, string message, string url, float autoHideSeconds, bool allowRetry);

        /// <summary>Hide any active toast immediately.</summary>
        void HideToast();

        /// <summary>
        /// Raised when the user taps the toast's Retry affordance. The host re-runs
        /// the last send that produced an error toast.
        /// </summary>
        event Action RetryRequested;
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

        /// <summary>
        /// Optional file/folder uploader (POST /api/files). May return null - the core
        /// then treats SendFile/SendFolder/SendFiles as unavailable and fails them with a
        /// clear message rather than crashing.
        /// </summary>
        IFileUploader CreateFileUploader(FastLogsConfig config);

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
