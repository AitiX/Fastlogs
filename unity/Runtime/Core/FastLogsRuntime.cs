// FastLogsRuntime - the MonoBehaviour host for FastLogs.
//
// Created by FastLogs.Init (via the facade) and marked DontDestroyOnLoad. It:
//   - owns the concrete services (log source, trigger, uploader, screenshot,
//     clipboard, overlay) supplied by an IFastLogsServices builder;
//   - pumps triggers and the overlay every frame in Update();
//   - drives the send pipeline as a coroutine and completes a FlogTask result.
//
// The ENTIRE file is compiled only where FastLogs is enabled. In retail/console
// builds this type does not exist - and nothing references it, because the facade
// only touches it under the same #if. The async pipeline uses coroutines so it
// works identically on WebGL (no threads) and elsewhere; no Awaitable dependency.

#if UNITY_EDITOR || DEVELOPMENT_BUILD || (LOGSHARE_FORCE_ENABLED && !(UNITY_PS4 || UNITY_PS5 || UNITY_GAMECORE || UNITY_SWITCH))
#define FASTLOGS_ENABLED
#endif

#if FASTLOGS_ENABLED
using System;
using System.Collections;
using UnityEngine;

namespace PlayJoy.FastLogs
{
    /// <summary>
    /// Runtime host. One instance per app, hidden and persistent. Internal: the
    /// public surface is the static <see cref="FastLogs"/> facade.
    /// </summary>
    internal sealed class FastLogsRuntime : MonoBehaviour
    {
        private FastLogsConfig _config;
        private IFastLogsServices _services;

        private ILogSource _logSource;
        private ITriggerSource _triggerSource;
        private ITriggerSource _quickSendTrigger; // separate gesture: send without opening the overlay
        private ILogUploader _uploader;
        private IScreenshotCapturer _screenshot;
        private IClipboard _clipboard;
        private ILogShareOverlay _overlay;
        private IToastSink _toast;                 // optional toast seam (same object as _overlay when supported)
        private IWebDeviceInfoProvider _webInfo;

        private bool _isBusy;
        private UploadResultDto _lastResult = UploadResultDto.Disabled;

        // Remembers the parameters of the last send so a Retry toast can re-run it.
        private bool _lastSendIncludeScreenshot;
        private string _lastSendTitle;
        private string _lastSendComment;

        // ---- Auto-send-on-exception state (dedup + throttle + per-session cap) ----
        private bool _autoSendHooked;
        private int _autoSendCountThisSession;
        private float _lastAutoSendUnscaled = float.NegativeInfinity;
        private int _lastAutoSendStackHash;       // 0 = none yet
        private bool _inAutoSendDispatch;         // re-entrancy guard (our own logged exceptions must not re-trigger)

        public FastLogsConfig Config { get { return _config; } }
        public bool IsBusy { get { return _isBusy; } }

        public event Action<UploadResultDto> Uploaded;

        // ---- Lifecycle ----

        /// <summary>Create the persistent host GameObject and initialize it.</summary>
        public static FastLogsRuntime Create(FastLogsConfig config, IFastLogsServices services)
        {
            var go = new GameObject("FastLogsRuntime");
            go.hideFlags = HideFlags.HideAndDontSave;
            DontDestroyOnLoad(go);
            var runtime = go.AddComponent<FastLogsRuntime>();
            runtime.Initialize(config, services);
            return runtime;
        }

        private void Initialize(FastLogsConfig config, IFastLogsServices services)
        {
            _config = config;
            _services = services;

            if (_services != null)
            {
                TryCreate(() => _logSource = _services.CreateLogSource(config));
                TryCreate(() => _triggerSource = _services.CreateTriggerSource(config));
                TryCreate(() => _uploader = _services.CreateUploader(config));
                TryCreate(() => _screenshot = _services.CreateScreenshotCapturer(config));
                TryCreate(() => _clipboard = _services.CreateClipboard(config));
                TryCreate(() => _overlay = _services.CreateOverlay(config));
                TryCreate(() => _webInfo = _services.CreateWebDeviceInfoProvider(config));
            }

            if (_logSource != null)
            {
                _logSource.Start();
            }

            if (_triggerSource != null && _config != null)
            {
                _triggerSource.Configure(_config.Trigger);
            }

            // Quick-send is a package feature, built from the bundled triggers so it
            // works regardless of the (possibly custom) overlay trigger provider.
            // It reads the separate QuickSend* fields of TriggerConfig.
            _quickSendTrigger = BuildQuickSendTrigger();
            if (_quickSendTrigger != null && _config != null)
            {
                _quickSendTrigger.Configure(_config.Trigger);
            }

            if (_overlay != null)
            {
                _overlay.SendRequested += OnOverlaySendRequested;

                // Light up the toast seam only if the overlay implements it. Existing
                // overlays that do not implement IToastSink keep working (no toast).
                _toast = _overlay as IToastSink;
                if (_toast != null)
                {
                    _toast.RetryRequested += OnToastRetryRequested;
                }
            }

            if (_config != null && _config.Recording.Enabled && _config.Recording.AutoStartRecording)
            {
                SetRecording(true);
            }

            // Auto-send-on-exception: hook the (main-thread) log callback once.
            HookAutoSend();

            FlogLog.Info("Runtime initialized.");
        }

        private static void TryCreate(Action create)
        {
            try { create(); }
            catch (Exception e) { FlogLog.Exception(e); }
        }

        private void OnDestroy()
        {
            UnhookAutoSend();

            if (_overlay != null)
            {
                _overlay.SendRequested -= OnOverlaySendRequested;
            }
            if (_toast != null)
            {
                _toast.RetryRequested -= OnToastRetryRequested;
                _toast = null;
            }
            SafeDispose(_overlay);
            SafeDispose(_quickSendTrigger);
            SafeDispose(_triggerSource);
            SafeDispose(_logSource);
            FlogLog.Info("Runtime destroyed.");
        }

        private static void SafeDispose(IDisposable d)
        {
            try { d?.Dispose(); }
            catch (Exception e) { FlogLog.Exception(e); }
        }

        public void Shutdown()
        {
            if (this == null)
            {
                return;
            }
            Destroy(gameObject);
        }

        // ---- Per-frame pump ----

        private void Update()
        {
            // Two cheap, allocation-free input polls per frame: one for the overlay
            // gesture, one for the separate quick-send gesture.
            if (_triggerSource != null)
            {
                bool fired = false;
                try { fired = _triggerSource.Poll(); }
                catch (Exception e) { FlogLog.Exception(e); }
                if (fired)
                {
                    ToggleOverlay();
                }
            }

            if (_quickSendTrigger != null)
            {
                bool quick = false;
                try { quick = _quickSendTrigger.Poll(); }
                catch (Exception e) { FlogLog.Exception(e); }
                if (quick)
                {
                    QuickSend();
                }
            }

            if (_overlay != null && _overlay.IsVisible)
            {
                try { _overlay.Refresh(Counts, _isBusy, _lastResult); }
                catch (Exception e) { FlogLog.Exception(e); }
            }
        }

        // ---- Overlay ----

        public void ShowOverlay() { if (_overlay != null) SafeOverlay(_overlay.Show); }
        public void HideOverlay() { if (_overlay != null) SafeOverlay(_overlay.Hide); }
        public void ToggleOverlay() { if (_overlay != null) SafeOverlay(_overlay.Toggle); }

        private static void SafeOverlay(Action action)
        {
            try { action(); }
            catch (Exception e) { FlogLog.Exception(e); }
        }

        // ---- Toast (status visible even when the overlay is closed) ----

        private void ShowToast(ToastKind kind, string message, string url, float autoHideSeconds, bool allowRetry)
        {
            if (_toast == null)
            {
                return;
            }
            try { _toast.ShowToast(kind, message, url, autoHideSeconds, allowRetry); }
            catch (Exception e) { FlogLog.Exception(e); }
        }

        private void OnToastRetryRequested()
        {
            // Re-run the last send with the same parameters.
            BeginSend(_lastSendIncludeScreenshot, _lastSendTitle, _lastSendComment);
        }

        // ---- Quick-send (send immediately, without opening the overlay) ----

        /// <summary>
        /// Fire-and-forget quick send with config defaults (screenshot per
        /// Screenshot.CaptureByDefault, no title/comment). Shows a status toast. If
        /// there is nothing useful to send (no logs captured) it shows a hint toast
        /// instead of starting an empty upload. Never throws.
        /// </summary>
        public void QuickSend()
        {
            try
            {
                if (_isBusy)
                {
                    ShowToast(ToastKind.Info, "FastLogs: a send is already in progress", null, 2.5f, false);
                    return;
                }

                // If nothing useful is available, hint instead of uploading an empty
                // report. "Useful" = live ring has entries, or any log was counted
                // this session, or persistent recording holds history on disk.
                if (_logSource == null)
                {
                    ShowToast(ToastKind.Info, "FastLogs: capture unavailable", null, 3f, false);
                    return;
                }

                CountsDto c = _logSource.Counts;
                bool hasSomething = _logSource.EntryCount > 0 || c.Total > 0;
                if (!hasSomething)
                {
                    ShowToast(ToastKind.Info, "FastLogs: no logs captured yet", null, 3f, false);
                    return;
                }

                bool shot = _config != null && _config.Screenshot.CaptureByDefault;
                BeginSend(shot, null, null);
            }
            catch (Exception e)
            {
                FlogLog.Exception(e);
            }
        }

        // Builds the quick-send gesture from the bundled triggers. A composite of a
        // keyboard combo (Editor/standalone) and a corner multi-tap (mobile), both
        // reading the separate QuickSend* fields of TriggerConfig. Each child is
        // inert unless its config opts in, so the default is "no quick-send gesture".
        private static ITriggerSource BuildQuickSendTrigger()
        {
            return new CompositeTrigger(
                new KeyComboTrigger(quickSendBinding: true),
                new MultiTapCornerTrigger(ScreenCorner.TopLeft, quickSendBinding: true));
        }

        // ---- Auto-send on unhandled exception ----

        private void HookAutoSend()
        {
            if (_autoSendHooked)
            {
                return;
            }
            if (_config == null || _config.AutoSend == null || !_config.AutoSend.AutoSendOnException)
            {
                return;
            }
            // Main-thread callback: Unity raises logMessageReceived on the main thread,
            // so we can safely touch runtime state and start a coroutine from here.
            Application.logMessageReceived += OnLogMessageForAutoSend;
            _autoSendHooked = true;
        }

        private void UnhookAutoSend()
        {
            if (!_autoSendHooked)
            {
                return;
            }
            Application.logMessageReceived -= OnLogMessageForAutoSend;
            _autoSendHooked = false;
        }

        private void OnLogMessageForAutoSend(string condition, string stackTrace, LogType type)
        {
            // Only unhandled exceptions trigger an auto-send.
            if (type != LogType.Exception)
            {
                return;
            }

            // Re-entrancy guard: any exception logged by FastLogs' own send pipeline
            // (e.g. via FlogLog.Exception) arrives here too; never auto-send for that.
            if (_inAutoSendDispatch)
            {
                return;
            }

            // Re-check the live toggle (it may have been turned off via settings).
            if (_config == null || _config.AutoSend == null || !_config.AutoSend.AutoSendOnException)
            {
                return;
            }

            // Don't pile a second auto-send on top of an in-flight send.
            if (_isBusy)
            {
                return;
            }

            // Per-session cap.
            int cap = _config.AutoSend.MaxAutoSendsPerSession;
            if (cap > 0 && _autoSendCountThisSession >= cap)
            {
                return;
            }

            float now;
            try { now = Time.realtimeSinceStartup; } catch { now = 0f; }

            int stackHash = ComputeStackHash(condition, stackTrace);
            bool sameAsLast = stackHash == _lastAutoSendStackHash && _lastAutoSendStackHash != 0;

            float minGap = _config.AutoSend.MinSecondsBetweenAutoSends;
            float sinceLast = now - _lastAutoSendUnscaled;

            // Global throttle: never auto-send more than once per minGap seconds. This
            // alone keeps any flood (even of distinct exceptions) bounded.
            if (sinceLast < minGap)
            {
                return;
            }

            // Dedup: an exception with the SAME stack as the previous auto-send is
            // suppressed for an extended window (2x the gap), so a tight loop that
            // throws the identical exception does not keep re-sending once per gap.
            if (sameAsLast && sinceLast < minGap * 2f)
            {
                return;
            }

            RecordAutoSend(now, stackHash);

            // Title marks the report as an auto-captured crash; comment carries the
            // exception message so the report is self-describing.
            string title = "Auto crash report";
            string comment = "Unhandled exception (auto-sent by FastLogs):\n" + (condition ?? string.Empty);
            bool shot = _config.AutoSend.IncludeScreenshot;

            _inAutoSendDispatch = true;
            try
            {
                ShowToast(ToastKind.Progress, "FastLogs: crash detected, sending...", null, 0f, false);
                BeginSend(shot, title, comment);
            }
            catch (Exception e)
            {
                FlogLog.Exception(e);
            }
            finally
            {
                // Only the synchronous dispatch window is guarded; the send itself runs
                // as a coroutine and is protected separately by _isBusy.
                _inAutoSendDispatch = false;
            }
        }

        private void RecordAutoSend(float now, int stackHash)
        {
            _lastAutoSendUnscaled = now;
            _lastAutoSendStackHash = stackHash;
            _autoSendCountThisSession++;
        }

        // Cheap, allocation-light stack signature. Prefers the stack trace; falls back
        // to the message. Uses a stable FNV-1a hash so dedup is independent of the
        // default string-hash randomization across runs.
        private static int ComputeStackHash(string condition, string stackTrace)
        {
            string key = !string.IsNullOrEmpty(stackTrace) ? stackTrace : (condition ?? string.Empty);
            unchecked
            {
                const int prime = 16777619;
                int hash = (int)2166136261;
                for (int i = 0; i < key.Length; i++)
                {
                    hash = (hash ^ key[i]) * prime;
                }
                return hash == 0 ? 1 : hash; // reserve 0 for "none"
            }
        }

        // ---- Logging passthrough ----

        public void Append(string message, FastLogLevel level)
        {
            if (_logSource == null)
            {
                return;
            }
            try { _logSource.Append(message, level); }
            catch (Exception e) { FlogLog.Exception(e); }
        }

        public CountsDto Counts
        {
            get { return _logSource != null ? _logSource.Counts : default; }
        }

        // ---- Recording ----

        private bool _isRecording;
        public bool IsRecording { get { return _isRecording; } }

        public void SetRecording(bool value)
        {
            _isRecording = value;
            // The concrete persistence/ring behaviour lives in the log source
            // builder; here we only flip the flag and start/stop capture.
            if (_logSource != null)
            {
                try
                {
                    if (value) _logSource.Start();
                    else _logSource.Stop();
                }
                catch (Exception e) { FlogLog.Exception(e); }
            }
        }

        public void ClearRecording()
        {
            if (_logSource != null)
            {
                try { _logSource.Clear(); }
                catch (Exception e) { FlogLog.Exception(e); }
            }
        }

        // ---- Send pipeline ----

        private void OnOverlaySendRequested(bool includeScreenshot, string title, string comment)
        {
            BeginSend(includeScreenshot, title, comment);
        }

        /// <summary>
        /// Kick off a send and return an awaitable result. Never throws; failures
        /// surface through the returned task and OnUploaded.
        /// </summary>
        public FlogTask<UploadResultDto> BeginSend(bool includeScreenshot, string title, string comment)
        {
            // Remember the parameters so a Retry toast can re-run exactly this send.
            _lastSendIncludeScreenshot = includeScreenshot;
            _lastSendTitle = title;
            _lastSendComment = comment;

            var task = FlogTask.Create<UploadResultDto>();

            if (_isBusy)
            {
                var busy = UploadResultDto.Fail("A FastLogs upload is already in progress.");
                // Do not stomp the in-progress toast; just complete the task as busy.
                task.SetResult(busy);
                return task;
            }

            if (_uploader == null)
            {
                var noUploader = UploadResultDto.Fail("No uploader is configured.");
                ShowToast(ToastKind.Error, "FastLogs: no uploader configured", null, 4f, false);
                task.SetResult(noUploader);
                return task;
            }

            // Status to the player even when the overlay is closed.
            ShowToast(ToastKind.Progress, "FastLogs: sending...", null, 0f, false);

            try
            {
                StartCoroutine(SendRoutine(includeScreenshot, title, comment, task));
            }
            catch (Exception e)
            {
                FlogLog.Exception(e);
                var fail = UploadResultDto.Fail("Failed to start send: " + e.Message);
                ShowToast(ToastKind.Error, "FastLogs: " + fail.Error, null, 0f, true);
                task.SetResult(fail);
            }

            return task;
        }

        private IEnumerator SendRoutine(bool includeScreenshot, string title, string comment, FlogTask<UploadResultDto> task)
        {
            _isBusy = true;
            UploadResultDto result;

            // 1) Optional screenshot (async via FlogTask, polled here).
            string screenshotBase64 = null;
            bool wantShot = includeScreenshot && _screenshot != null;
            if (wantShot)
            {
                FlogTask<byte[]> shotTask = null;
                try { shotTask = _screenshot.CaptureAsync(ScreenshotMaxDimension()); }
                catch (Exception e) { FlogLog.Exception(e); }

                if (shotTask != null)
                {
                    while (!shotTask.IsCompleted)
                    {
                        yield return null;
                    }
                    if (!shotTask.IsFaulted && shotTask.Result != null && shotTask.Result.Length > 0)
                    {
                        screenshotBase64 = Convert.ToBase64String(shotTask.Result);
                    }
                }
            }

            // 2) Build the report off the current diagnostics + log text.
            LogReportDto report = null;
            try
            {
                report = BuildReport(title, comment, screenshotBase64);
            }
            catch (Exception e)
            {
                FlogLog.Exception(e);
            }

            if (report == null)
            {
                result = UploadResultDto.Fail("Failed to build report.");
                Complete(task, result);
                yield break;
            }

            // 3) Upload (async via FlogTask, polled here).
            FlogTask<UploadResultDto> uploadTask = null;
            try { uploadTask = _uploader.UploadAsync(report, _config); }
            catch (Exception e)
            {
                FlogLog.Exception(e);
                result = UploadResultDto.Fail("Upload threw: " + e.Message);
                Complete(task, result);
                yield break;
            }

            if (uploadTask == null)
            {
                result = UploadResultDto.Fail("Uploader returned no task.");
                Complete(task, result);
                yield break;
            }

            while (!uploadTask.IsCompleted)
            {
                yield return null;
            }

            result = uploadTask.IsFaulted
                ? UploadResultDto.Fail("Upload faulted: " + (uploadTask.Exception != null ? uploadTask.Exception.Message : "unknown"))
                : uploadTask.Result;

            Complete(task, result);
        }

        private void Complete(FlogTask<UploadResultDto> task, UploadResultDto result)
        {
            _isBusy = false;
            _lastResult = result;

            // Copy-on-send: after a successful upload, best-effort copy the short
            // link to the device clipboard via the same clipboard service the
            // overlay uses. On WebGL this runs from a coroutine continuation (not a
            // user gesture), so the browser may reject it - that is fine, we never
            // throw and the overlay's Copy button stays as the fallback.
            TryCopyLinkOnSend(result);

            // Player-facing status, visible even with the overlay closed. The link is
            // already auto-copied above; the toast also offers Copy/Open and, on
            // failure, Retry.
            if (result.Success)
            {
                bool copied = _config != null && _config.UI.CopyLinkOnSend
                              && !string.IsNullOrEmpty(result.Url);
                string msg = copied ? "FastLogs: done (link copied)" : "FastLogs: done";
                ShowToast(ToastKind.Success, msg, result.Url, 6f, false);
            }
            else
            {
                // Sticky error with a Retry affordance.
                ShowToast(ToastKind.Error, "FastLogs error: " + result.Error, null, 0f, true);
            }

            task.SetResult(result);
            try { Uploaded?.Invoke(result); }
            catch (Exception e) { FlogLog.Exception(e); }
        }

        private void TryCopyLinkOnSend(UploadResultDto result)
        {
            if (_clipboard == null)
            {
                return;
            }
            if (_config == null || !_config.UI.CopyLinkOnSend)
            {
                return;
            }
            if (!result.Success || string.IsNullOrEmpty(result.Url))
            {
                return;
            }

            try { _clipboard.CopyToClipboard(result.Url); }
            catch (Exception e) { FlogLog.Exception(e); }
        }

        private int ScreenshotMaxDimension()
        {
            return _config != null ? _config.Screenshot.MaxDimension : 1280;
        }

        // ---- Report assembly ----

        private LogReportDto BuildReport(string title, string comment, string screenshotBase64)
        {
            bool includeSensitive = _config != null && _config.Diagnostics.IncludeSensitive;

            var device = DiagnosticsCollector.Collect(includeSensitive);
            if (_webInfo != null && device != null)
            {
                try { _webInfo.Fill(device.Web, includeSensitive); }
                catch (Exception e) { FlogLog.Exception(e); }
            }

            int maxBytes = _config != null ? _config.Capture.MaxLogTextBytes : 0;
            string logText = _logSource != null ? _logSource.BuildLogText(maxBytes) : string.Empty;
            CountsDto counts = Counts;

            // Core defaults logEncoding to "plain" so an un-augmented build is
            // always contract-valid. A log-source/uploader builder may instead
            // gzip+base64 the logText on non-WebGL platforms and set the encoding
            // accordingly; on WebGL it MUST stay "plain" (no gzip body / threads).
            string encoding = "plain";

            int? retention = null;
            if (_config != null && _config.Server.RetentionDaysOverride > 0)
            {
                retention = _config.Server.RetentionDaysOverride;
            }

            // Tester name comes from settings/config and rides along with every
            // report. Empty stays null so the optional field is omitted.
            string tester = _config != null ? _config.UI.TesterName : null;

            var report = new LogReportDto
            {
                AppId = _config != null ? _config.Server.AppId : string.Empty,
                Platform = PlatformName(),
                AppVersion = Application.version,
                TimestampUtc = DateTime.UtcNow.ToString("yyyy-MM-ddTHH:mm:ssZ", System.Globalization.CultureInfo.InvariantCulture),
                Counts = counts,
                LogText = logText,
                LogEncoding = encoding,
                Device = device,
                ScreenshotPngBase64 = string.IsNullOrEmpty(screenshotBase64) ? null : screenshotBase64,
                RetentionDays = retention,
                Title = string.IsNullOrEmpty(title) ? null : Truncate(title, 120),
                Comment = string.IsNullOrEmpty(comment) ? null : Truncate(comment, 4000),
                Tester = string.IsNullOrEmpty(tester) ? null : Truncate(tester, 120)
            };

            return report;
        }

        private static string Truncate(string s, int max)
        {
            if (string.IsNullOrEmpty(s) || s.Length <= max)
            {
                return s;
            }
            return s.Substring(0, max);
        }

        private static string PlatformName()
        {
            switch (Application.platform)
            {
                case RuntimePlatform.WebGLPlayer: return "WebGL";
                case RuntimePlatform.Android: return "Android";
                case RuntimePlatform.IPhonePlayer: return "iOS";
                case RuntimePlatform.WindowsPlayer:
                case RuntimePlatform.WindowsEditor: return "Windows";
                case RuntimePlatform.OSXPlayer:
                case RuntimePlatform.OSXEditor: return "macOS";
                case RuntimePlatform.LinuxPlayer:
                case RuntimePlatform.LinuxEditor: return "Linux";
                case RuntimePlatform.PS4: return "PS4";
                case RuntimePlatform.PS5: return "PS5";
                case RuntimePlatform.Switch: return "Switch";
                default: return "Other";
            }
        }
    }
}
#endif
