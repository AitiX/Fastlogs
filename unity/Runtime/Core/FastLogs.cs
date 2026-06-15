// FastLogs - the public static facade. THIS FILE ALWAYS COMPILES on every
// platform and build flavour, so game code calling FastLogs.* builds everywhere
// (including retail and console).
//
// Gating model (see RULES / FastLogsGate):
//   - Fire-and-forget VOID methods (Log/Warn/Error, StartRecording/StopRecording/
//     SetRecording/ClearRecording, ShowOverlay/HideOverlay/ToggleOverlay,
//     Init/Shutdown, SetServicesProvider) carry
//     [Conditional("UNITY_EDITOR"), Conditional("DEVELOPMENT_BUILD"), Conditional("LOGSHARE_FORCE_ENABLED")].
//     => In a retail/console build BOTH the method body AND every call site are
//        stripped by the compiler. No HTTP, no overlay, no screenshot, no hooks.
//   - VALUE-returning members (IsInitialized, IsRecording, Counts, SendAsync,
//     RecordScope) cannot be [Conditional] (callers need the return value), so
//     they always compile but return safe no-op defaults when FastLogs is
//     compiled out (#if FASTLOGS_ENABLED is false).
//
// Internally, all real work lives behind #if FASTLOGS_ENABLED and is delegated to
// the FastLogsRuntime MonoBehaviour host.

#if UNITY_EDITOR || DEVELOPMENT_BUILD || (LOGSHARE_FORCE_ENABLED && !(UNITY_PS4 || UNITY_PS5 || UNITY_GAMECORE || UNITY_SWITCH))
#define FASTLOGS_ENABLED
#endif

using System;
using System.Collections.Generic;
using System.Diagnostics;

namespace PlayJoy.FastLogs
{
    /// <summary>
    /// Static entry point for FastLogs. All members are safe to call on any
    /// platform; on retail/console builds the void calls are stripped and the
    /// value-returning calls are inert.
    /// </summary>
    public static class FastLogs
    {
        // Backing event - always present so subscribers compile in any build.
        private static event Action<UploadResultDto> _onUploaded;

        /// <summary>
        /// Raised after each completed upload (success or failure). Subscribing is
        /// always allowed; in stripped builds it simply never fires.
        /// </summary>
        public static event Action<UploadResultDto> OnUploaded
        {
            add { _onUploaded += value; }
            remove { _onUploaded -= value; }
        }

#if FASTLOGS_ENABLED
        private static FastLogsRuntime _runtime;
        private static IFastLogsServices _servicesProvider;
        private static bool _uploadedHooked;
#endif

        // ============================================================
        // Initialization
        // ============================================================

        /// <summary>
        /// Register the services builder (log source, uploader, overlay, etc.)
        /// BEFORE calling Init. Optional - if a builder auto-registers itself,
        /// game code never needs to call this. Stripped in retail/console.
        /// </summary>
        [Conditional("UNITY_EDITOR"), Conditional("DEVELOPMENT_BUILD"), Conditional("LOGSHARE_FORCE_ENABLED")]
        public static void SetServicesProvider(IFastLogsServices provider)
        {
#if FASTLOGS_ENABLED
            _servicesProvider = provider;
#endif
        }

        /// <summary>
        /// Initialize FastLogs with the given config (or the resolved default when
        /// null). Idempotent: a second call is ignored while already initialized.
        /// Stripped entirely in retail/console builds.
        /// </summary>
        [Conditional("UNITY_EDITOR"), Conditional("DEVELOPMENT_BUILD"), Conditional("LOGSHARE_FORCE_ENABLED")]
        public static void Init(FastLogsConfig config = null)
        {
#if FASTLOGS_ENABLED
            try
            {
                if (_runtime != null)
                {
                    return;
                }

                FastLogsConfig resolved = config != null ? config : FastLogsConfigLoader.LoadOrDefault();
                if (!FastLogsGate.IsEnabled(resolved))
                {
                    FlogLog.Info("Disabled by config for this build flavour - Init is a no-op.");
                    return;
                }

                _runtime = FastLogsRuntime.Create(resolved, _servicesProvider ?? new FastLogsDefaultServices());

                if (!_uploadedHooked)
                {
                    _runtime.Uploaded += RaiseUploaded;
                    _uploadedHooked = true;
                }
            }
            catch (Exception e)
            {
                FlogLog.Exception(e);
            }
#endif
        }

        /// <summary>Tear down FastLogs and destroy its host. Stripped in retail/console.</summary>
        [Conditional("UNITY_EDITOR"), Conditional("DEVELOPMENT_BUILD"), Conditional("LOGSHARE_FORCE_ENABLED")]
        public static void Shutdown()
        {
#if FASTLOGS_ENABLED
            try
            {
                if (_runtime != null)
                {
                    _runtime.Uploaded -= RaiseUploaded;
                    _uploadedHooked = false;
                    _runtime.Shutdown();
                    _runtime = null;
                }
            }
            catch (Exception e)
            {
                FlogLog.Exception(e);
            }
#endif
        }

        /// <summary>
        /// Whether FastLogs is currently active. Always false in stripped builds.
        /// Value-returning: compiles everywhere.
        /// </summary>
        public static bool IsInitialized
        {
#if FASTLOGS_ENABLED
            get { return _runtime != null; }
#else
            get { return false; }
#endif
        }

        // ============================================================
        // Overlay
        // ============================================================

        [Conditional("UNITY_EDITOR"), Conditional("DEVELOPMENT_BUILD"), Conditional("LOGSHARE_FORCE_ENABLED")]
        public static void ShowOverlay()
        {
#if FASTLOGS_ENABLED
            if (_runtime != null) _runtime.ShowOverlay();
#endif
        }

        [Conditional("UNITY_EDITOR"), Conditional("DEVELOPMENT_BUILD"), Conditional("LOGSHARE_FORCE_ENABLED")]
        public static void HideOverlay()
        {
#if FASTLOGS_ENABLED
            if (_runtime != null) _runtime.HideOverlay();
#endif
        }

        [Conditional("UNITY_EDITOR"), Conditional("DEVELOPMENT_BUILD"), Conditional("LOGSHARE_FORCE_ENABLED")]
        public static void ToggleOverlay()
        {
#if FASTLOGS_ENABLED
            if (_runtime != null) _runtime.ToggleOverlay();
#endif
        }

        // ============================================================
        // Logging
        // ============================================================

        [Conditional("UNITY_EDITOR"), Conditional("DEVELOPMENT_BUILD"), Conditional("LOGSHARE_FORCE_ENABLED")]
        public static void Log(string message, FastLogLevel level = FastLogLevel.Log)
        {
#if FASTLOGS_ENABLED
            if (_runtime != null) _runtime.Append(message, level);
#endif
        }

        [Conditional("UNITY_EDITOR"), Conditional("DEVELOPMENT_BUILD"), Conditional("LOGSHARE_FORCE_ENABLED")]
        public static void Warn(string message)
        {
#if FASTLOGS_ENABLED
            if (_runtime != null) _runtime.Append(message, FastLogLevel.Warning);
#endif
        }

        [Conditional("UNITY_EDITOR"), Conditional("DEVELOPMENT_BUILD"), Conditional("LOGSHARE_FORCE_ENABLED")]
        public static void Error(string message)
        {
#if FASTLOGS_ENABLED
            if (_runtime != null) _runtime.Append(message, FastLogLevel.Error);
#endif
        }

        // ============================================================
        // Context & breadcrumbs (feature #2)
        // ============================================================

        /// <summary>
        /// Set (or replace) a context key/value that rides with every subsequent
        /// report (e.g. "level" -> "3", "playerId" -> "abc"). Pass a null value to
        /// remove the key. Cheap: a dictionary write, no per-frame cost. Stripped in
        /// retail/console (body and call sites removed).
        /// </summary>
        [Conditional("UNITY_EDITOR"), Conditional("DEVELOPMENT_BUILD"), Conditional("LOGSHARE_FORCE_ENABLED")]
        public static void SetContext(string key, string value)
        {
#if FASTLOGS_ENABLED
            if (_runtime != null) _runtime.SetContext(key, value);
#endif
        }

        /// <summary>Remove all context entries. Stripped in retail/console.</summary>
        [Conditional("UNITY_EDITOR"), Conditional("DEVELOPMENT_BUILD"), Conditional("LOGSHARE_FORCE_ENABLED")]
        public static void ClearContext()
        {
#if FASTLOGS_ENABLED
            if (_runtime != null) _runtime.ClearContext();
#endif
        }

        /// <summary>
        /// Add a breadcrumb to the rolling buffer of recent app events (a ring of the
        /// last ~100). Included with every report. Cheap: O(1) ring write, no per-frame
        /// allocation beyond the message string. Stripped in retail/console.
        /// </summary>
        [Conditional("UNITY_EDITOR"), Conditional("DEVELOPMENT_BUILD"), Conditional("LOGSHARE_FORCE_ENABLED")]
        public static void Breadcrumb(string message, FastLogLevel level = FastLogLevel.Log)
        {
#if FASTLOGS_ENABLED
            if (_runtime != null) _runtime.AddBreadcrumb(message, level);
#endif
        }

        // ============================================================
        // Recording
        // ============================================================

        [Conditional("UNITY_EDITOR"), Conditional("DEVELOPMENT_BUILD"), Conditional("LOGSHARE_FORCE_ENABLED")]
        public static void StartRecording()
        {
#if FASTLOGS_ENABLED
            if (_runtime != null) _runtime.SetRecording(true);
#endif
        }

        [Conditional("UNITY_EDITOR"), Conditional("DEVELOPMENT_BUILD"), Conditional("LOGSHARE_FORCE_ENABLED")]
        public static void StopRecording()
        {
#if FASTLOGS_ENABLED
            if (_runtime != null) _runtime.SetRecording(false);
#endif
        }

        [Conditional("UNITY_EDITOR"), Conditional("DEVELOPMENT_BUILD"), Conditional("LOGSHARE_FORCE_ENABLED")]
        public static void SetRecording(bool value)
        {
#if FASTLOGS_ENABLED
            if (_runtime != null) _runtime.SetRecording(value);
#endif
        }

        [Conditional("UNITY_EDITOR"), Conditional("DEVELOPMENT_BUILD"), Conditional("LOGSHARE_FORCE_ENABLED")]
        public static void ClearRecording()
        {
#if FASTLOGS_ENABLED
            if (_runtime != null) _runtime.ClearRecording();
#endif
        }

        /// <summary>
        /// Whether recording is currently on. Always false in stripped builds.
        /// Value-returning: compiles everywhere.
        /// </summary>
        public static bool IsRecording
        {
#if FASTLOGS_ENABLED
            get { return _runtime != null && _runtime.IsRecording; }
#else
            get { return false; }
#endif
        }

        /// <summary>
        /// Start recording for the lifetime of the returned IDisposable, then stop
        /// on Dispose. In stripped builds returns a no-op disposable.
        /// Value-returning: compiles everywhere.
        /// </summary>
        public static IDisposable RecordScope()
        {
#if FASTLOGS_ENABLED
            return new RecordingScope();
#else
            return NoopDisposable.Instance;
#endif
        }

        // ============================================================
        // Counts
        // ============================================================

        /// <summary>
        /// Current per-session counters. Returns default (all zero) in stripped
        /// builds. Value-returning: compiles everywhere.
        /// </summary>
        public static CountsDto Counts
        {
#if FASTLOGS_ENABLED
            get { return _runtime != null ? _runtime.Counts : default; }
#else
            get { return default; }
#endif
        }

        // ============================================================
        // Send
        // ============================================================

        /// <summary>
        /// Fire-and-forget quick send: build and upload a report immediately, using
        /// config defaults (screenshot per Screenshot.CaptureByDefault, no title or
        /// comment) and WITHOUT opening the overlay. A status toast is shown if the
        /// overlay supports one. If there is nothing useful to send (no logs) it
        /// shows a hint instead of uploading. Never throws. Stripped in retail/console
        /// builds (both body and call sites are removed).
        /// </summary>
        [Conditional("UNITY_EDITOR"), Conditional("DEVELOPMENT_BUILD"), Conditional("LOGSHARE_FORCE_ENABLED")]
        public static void Send(
            [System.Runtime.CompilerServices.CallerFilePath] string callerFile = null,
            [System.Runtime.CompilerServices.CallerLineNumber] int callerLine = 0)
        {
#if FASTLOGS_ENABLED
            if (_runtime != null) _runtime.QuickSendFromCode(new CallSite(callerFile, callerLine));
#endif
        }

        /// <summary>
        /// Capture the current frame now and queue it for the next send, so you can take
        /// several screenshots in code and send them together (e.g. before/after a repro).
        /// Fire-and-forget; the FastLogs overlay is not included in the shot. The queue is
        /// capped and cleared once a send that carried it resolves. Stripped in
        /// retail/console (body and call sites removed).
        /// </summary>
        [Conditional("UNITY_EDITOR"), Conditional("DEVELOPMENT_BUILD"), Conditional("LOGSHARE_FORCE_ENABLED")]
        public static void CaptureScreenshot()
        {
#if FASTLOGS_ENABLED
            if (_runtime != null) _runtime.CaptureScreenshot();
#endif
        }

        /// <summary>Drop all screenshots queued by CaptureScreenshot without sending them.</summary>
        [Conditional("UNITY_EDITOR"), Conditional("DEVELOPMENT_BUILD"), Conditional("LOGSHARE_FORCE_ENABLED")]
        public static void ClearScreenshots()
        {
#if FASTLOGS_ENABLED
            if (_runtime != null) _runtime.ClearScreenshots();
#endif
        }

        /// <summary>
        /// Set a short correlation/debug code (&lt;=64 chars) attached to every subsequent
        /// report, so a specific log can be awaited and grabbed on the server (see the
        /// /api/await endpoint and the fastlogs-await tool). Pass null/empty to clear.
        /// Stripped in retail/console.
        /// </summary>
        [Conditional("UNITY_EDITOR"), Conditional("DEVELOPMENT_BUILD"), Conditional("LOGSHARE_FORCE_ENABLED")]
        public static void SetCorrelationCode(string code)
        {
#if FASTLOGS_ENABLED
            if (_runtime != null) _runtime.SetCorrelationCode(code);
#endif
        }

        /// <summary>
        /// Capture the full runtime scene hierarchy (all loaded scenes + DontDestroyOnLoad
        /// -&gt; objects -&gt; components -&gt; serialized fields) now and queue it for the
        /// next send, so it rides with the report and is viewable as a tree. Bounded by the
        /// SceneContext config limits. One-shot: ignored if a capture is already queued unless
        /// allowRepeat is true (loop guard, mirrors log throttling). Stripped in retail/console.
        /// </summary>
        [Conditional("UNITY_EDITOR"), Conditional("DEVELOPMENT_BUILD"), Conditional("LOGSHARE_FORCE_ENABLED")]
        public static void CaptureSceneContext(bool allowRepeat = false)
        {
#if FASTLOGS_ENABLED
            if (_runtime != null) _runtime.CaptureSceneContext(allowRepeat);
#endif
        }

        /// <summary>
        /// Capture the scene context now and send a report immediately (capture + Send), so a
        /// hierarchy snapshot ships in one call from code. One-shot: ignored if it already sent
        /// once unless allowRepeat is true (loop guard). Stripped in retail/console.
        /// </summary>
        [Conditional("UNITY_EDITOR"), Conditional("DEVELOPMENT_BUILD"), Conditional("LOGSHARE_FORCE_ENABLED")]
        public static void SendSceneContext(bool allowRepeat = false,
            [System.Runtime.CompilerServices.CallerFilePath] string callerFile = null,
            [System.Runtime.CompilerServices.CallerLineNumber] int callerLine = 0)
        {
#if FASTLOGS_ENABLED
            if (_runtime != null) _runtime.SendSceneContextFromCode(allowRepeat, new CallSite(callerFile, callerLine));
#endif
        }

        /// <summary>
        /// Build and upload a report, returning the result. Awaitable on all Unity
        /// versions (FlogTask, coroutine-driven). Optional title and comment are
        /// attached to the report (comment is the tester's free-form problem
        /// description). In stripped builds returns a completed "disabled" result
        /// immediately. Value-returning: compiles everywhere.
        /// </summary>
        public static FlogTask<UploadResultDto> SendAsync(bool includeScreenshot = false, string title = null, string comment = null,
            [System.Runtime.CompilerServices.CallerFilePath] string callerFile = null,
            [System.Runtime.CompilerServices.CallerLineNumber] int callerLine = 0)
        {
#if FASTLOGS_ENABLED
            if (_runtime == null)
            {
                return FlogTask.FromResult(UploadResultDto.Fail("FastLogs is not initialized."));
            }
            return _runtime.BeginSendFromCode(includeScreenshot, title, comment, new CallSite(callerFile, callerLine));
#else
            return FlogTask.FromResult(UploadResultDto.Disabled);
#endif
        }

        // ============================================================
        // Files (send an arbitrary file / folder, get a shareable link)
        // ============================================================
        // These target a SEPARATE endpoint (POST /api/files), independent of the log
        // report send. The blob is NEVER PII-scrubbed (explicit invariant) - only a
        // decoded-size cap (FilesSection.MaxFileBytes, default 25 MB) applies. Awaitable
        // members are value-returning (compile everywhere) and return a completed
        // "disabled" result in stripped builds. Path overloads cannot work on WebGL (no
        // file system); there they resolve to a clear failure - use the byte[] overload.

        /// <summary>
        /// Upload a single file by path and return its shareable link. Reads the file into
        /// memory and posts it. On WebGL (no file system) this fails with a clear message;
        /// use the byte[] overload instead. In stripped builds returns a "disabled" result.
        /// Value-returning: compiles everywhere.
        /// </summary>
        public static FlogTask<FileUploadResultDto> SendFileAsync(string path, string title = null,
            [System.Runtime.CompilerServices.CallerFilePath] string callerFile = null,
            [System.Runtime.CompilerServices.CallerLineNumber] int callerLine = 0)
        {
#if FASTLOGS_ENABLED
            if (_runtime == null)
            {
                return FlogTask.FromResult(FileUploadResultDto.Fail("FastLogs is not initialized."));
            }
            return _runtime.BeginSendFilePath(path, title);
#else
            return FlogTask.FromResult(FileUploadResultDto.Disabled);
#endif
        }

        /// <summary>
        /// Upload a file from in-memory bytes (WebGL-safe; no file system needed) and return
        /// its shareable link. In stripped builds returns a "disabled" result.
        /// Value-returning: compiles everywhere.
        /// </summary>
        public static FlogTask<FileUploadResultDto> SendFileAsync(byte[] bytes, string fileName, string title = null,
            [System.Runtime.CompilerServices.CallerFilePath] string callerFile = null,
            [System.Runtime.CompilerServices.CallerLineNumber] int callerLine = 0)
        {
#if FASTLOGS_ENABLED
            if (_runtime == null)
            {
                return FlogTask.FromResult(FileUploadResultDto.Fail("FastLogs is not initialized."));
            }
            return _runtime.BeginSendFileBytes(bytes, fileName, title);
#else
            return FlogTask.FromResult(FileUploadResultDto.Disabled);
#endif
        }

        /// <summary>
        /// WebGL only (feature #7): open the browser file dialog and upload the chosen file
        /// (via the byte[] path, WebGL-safe), returning its shareable link. MUST be called
        /// from a user-gesture handler (e.g. a UI button click) so the browser permits the
        /// dialog. On non-WebGL platforms it resolves immediately with a "not supported"
        /// failure - use <see cref="SendFileAsync(byte[], string, string, string, int)"/> (or a
        /// native picker) there. In stripped builds returns a "disabled" result.
        /// Value-returning: compiles everywhere.
        /// </summary>
        public static FlogTask<FileUploadResultDto> WebPickAndSendFile(string title = null)
        {
#if FASTLOGS_ENABLED
            if (_runtime == null)
            {
                return FlogTask.FromResult(FileUploadResultDto.Fail("FastLogs is not initialized."));
            }
            return _runtime.WebPickAndSendFile(title);
#else
            return FlogTask.FromResult(FileUploadResultDto.Disabled);
#endif
        }

        /// <summary>
        /// Zip a folder on the client into one archive and upload it, returning its link. On
        /// WebGL (no file system) this fails cleanly. In stripped builds returns a "disabled"
        /// result. Value-returning: compiles everywhere.
        /// </summary>
        public static FlogTask<FileUploadResultDto> SendFolderAsync(string path, string title = null,
            [System.Runtime.CompilerServices.CallerFilePath] string callerFile = null,
            [System.Runtime.CompilerServices.CallerLineNumber] int callerLine = 0)
        {
#if FASTLOGS_ENABLED
            if (_runtime == null)
            {
                return FlogTask.FromResult(FileUploadResultDto.Fail("FastLogs is not initialized."));
            }
            return _runtime.BeginSendFolder(path, title);
#else
            return FlogTask.FromResult(FileUploadResultDto.Disabled);
#endif
        }

        /// <summary>
        /// Zip several files on the client into one archive and upload it, returning its
        /// link. On WebGL (no file system) this fails cleanly. In stripped builds returns a
        /// "disabled" result. Value-returning: compiles everywhere.
        /// </summary>
        public static FlogTask<FileUploadResultDto> SendFilesAsync(IReadOnlyList<string> paths, string title = null,
            [System.Runtime.CompilerServices.CallerFilePath] string callerFile = null,
            [System.Runtime.CompilerServices.CallerLineNumber] int callerLine = 0)
        {
#if FASTLOGS_ENABLED
            if (_runtime == null)
            {
                return FlogTask.FromResult(FileUploadResultDto.Fail("FastLogs is not initialized."));
            }
            return _runtime.BeginSendFiles(paths, title);
#else
            return FlogTask.FromResult(FileUploadResultDto.Disabled);
#endif
        }

        /// <summary>
        /// Fire-and-forget: upload a file by path; a status toast shows the result. Stripped
        /// in retail/console (body and call sites removed). For an awaitable result use
        /// <see cref="SendFileAsync(string, string, string, int)"/>.
        /// </summary>
        [Conditional("UNITY_EDITOR"), Conditional("DEVELOPMENT_BUILD"), Conditional("LOGSHARE_FORCE_ENABLED")]
        public static void SendFile(string path, string title = null)
        {
#if FASTLOGS_ENABLED
            if (_runtime != null) _runtime.BeginSendFilePath(path, title);
#endif
        }

        /// <summary>
        /// Fire-and-forget: zip a folder and upload it; a status toast shows the result.
        /// Stripped in retail/console. For an awaitable result use
        /// <see cref="SendFolderAsync(string, string, string, int)"/>.
        /// </summary>
        [Conditional("UNITY_EDITOR"), Conditional("DEVELOPMENT_BUILD"), Conditional("LOGSHARE_FORCE_ENABLED")]
        public static void SendFolder(string path, string title = null)
        {
#if FASTLOGS_ENABLED
            if (_runtime != null) _runtime.BeginSendFolder(path, title);
#endif
        }

        /// <summary>
        /// Queue a file/folder path to ride as an attachment of the NEXT successful report
        /// send (linked to that report on the server). A folder is zipped at upload time.
        /// Capped (oldest dropped). No-op on WebGL (no file system). Stripped in retail/console.
        /// </summary>
        [Conditional("UNITY_EDITOR"), Conditional("DEVELOPMENT_BUILD"), Conditional("LOGSHARE_FORCE_ENABLED")]
        public static void AttachFile(string path)
        {
#if FASTLOGS_ENABLED
            if (_runtime != null) _runtime.AttachFile(path);
#endif
        }

        /// <summary>Drop all paths queued by AttachFile without sending them. Stripped in retail/console.</summary>
        [Conditional("UNITY_EDITOR"), Conditional("DEVELOPMENT_BUILD"), Conditional("LOGSHARE_FORCE_ENABLED")]
        public static void ClearAttachments()
        {
#if FASTLOGS_ENABLED
            if (_runtime != null) _runtime.ClearAttachments();
#endif
        }

        // ============================================================
        // Internals
        // ============================================================

        private static void RaiseUploaded(UploadResultDto result)
        {
            var handler = _onUploaded;
            if (handler != null)
            {
                try { handler(result); }
                catch (Exception e) { FlogLog.Exception(e); }
            }
        }

#if FASTLOGS_ENABLED
        // Disposable that brackets a recording session.
        private sealed class RecordingScope : IDisposable
        {
            private bool _disposed;

            public RecordingScope()
            {
                if (_runtime != null) _runtime.SetRecording(true);
            }

            public void Dispose()
            {
                if (_disposed) return;
                _disposed = true;
                if (_runtime != null) _runtime.SetRecording(false);
            }
        }
#else
        // No-op disposable used when FastLogs is compiled out.
        private sealed class NoopDisposable : IDisposable
        {
            public static readonly NoopDisposable Instance = new NoopDisposable();
            public void Dispose() { }
        }
#endif
    }
}
