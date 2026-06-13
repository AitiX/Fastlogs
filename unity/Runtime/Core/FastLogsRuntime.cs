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
        private ILogUploader _uploader;
        private IScreenshotCapturer _screenshot;
        private IClipboard _clipboard;
        private ILogShareOverlay _overlay;
        private IWebDeviceInfoProvider _webInfo;

        private bool _isBusy;
        private UploadResultDto _lastResult = UploadResultDto.Disabled;

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

            if (_overlay != null)
            {
                _overlay.SendRequested += OnOverlaySendRequested;
            }

            if (_config != null && _config.Recording.Enabled && _config.Recording.AutoStartRecording)
            {
                SetRecording(true);
            }

            FlogLog.Info("Runtime initialized.");
        }

        private static void TryCreate(Action create)
        {
            try { create(); }
            catch (Exception e) { FlogLog.Exception(e); }
        }

        private void OnDestroy()
        {
            if (_overlay != null)
            {
                _overlay.SendRequested -= OnOverlaySendRequested;
            }
            SafeDispose(_overlay);
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
            var task = FlogTask.Create<UploadResultDto>();

            if (_isBusy)
            {
                var busy = UploadResultDto.Fail("A FastLogs upload is already in progress.");
                task.SetResult(busy);
                return task;
            }

            if (_uploader == null)
            {
                var noUploader = UploadResultDto.Fail("No uploader is configured.");
                task.SetResult(noUploader);
                return task;
            }

            try
            {
                StartCoroutine(SendRoutine(includeScreenshot, title, comment, task));
            }
            catch (Exception e)
            {
                FlogLog.Exception(e);
                task.SetResult(UploadResultDto.Fail("Failed to start send: " + e.Message));
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
