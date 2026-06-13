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
using System.Collections.Generic;
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

        // ---- Context & breadcrumbs (feature #2) ----
        private FastLogsCrumbStore _crumbs;

        // ---- Crash-report persistence (feature #1) ----
        private PendingCrashQueue _pendingQueue;
        // Path of the on-disk crash file OWNED by the send currently in flight. Set only
        // when an immediate auto-send is started for a freshly captured file, so that
        // send's success deletes exactly that file. Cleared on success (after delete), on
        // terminal failure (file left for the idle drain / next start), and whenever a
        // non-crash send takes over (ForgetPendingCrashOwnership). A scheduled retry keeps
        // it set across attempts. null = the in-flight send (if any) owns no crash file.
        private string _pendingCrashFilePath;

        // Remembers the parameters of the last send so a Retry toast can re-run it.
        private bool _lastSendIncludeScreenshot;
        private string _lastSendTitle;
        private string _lastSendComment;

        // ---- Retry-until-success state (outer loop, on top of the uploader's own
        //      immediate retries). At most ONE pending retry exists at a time. ----
        private Coroutine _retryCoroutine; // non-null while a retry is scheduled/counting down; null = none pending
        private int _retryAttempt;         // number of outer retries already performed for the current report

        // ---- Auto-send-on-exception state (dedup + throttle + per-session cap) ----
        private bool _autoSendHooked;
        private int _autoSendCountThisSession;
        // Delivery (immediate-send) dedup/throttle state.
        private float _lastAutoSendUnscaled = float.NegativeInfinity;
        private int _lastAutoSendStackHash;       // 0 = none yet
        // CAPTURE dedup state - deliberately SEPARATE from the delivery state above so a
        // crash captured (but not immediately sent) still updates capture-dedup without
        // touching send-dedup, and vice versa. Prevents a tight crash loop from spamming
        // the outbox while still letting every distinct crash be captured.
        private float _lastCapturedUnscaled = float.NegativeInfinity;
        private int _lastCapturedStackHash;       // 0 = none yet
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

            // Context + breadcrumb store (feature #2). Ring capacity is the breadcrumb
            // cap (100), independent of the log ring.
            _crumbs = new FastLogsCrumbStore(BreadcrumbCapacity);

            // Crash-report persistence (feature #1). Build the queue, then resend any
            // reports left pending from a previous (possibly crashed) session. Resend
            // runs as a coroutine so it never blocks startup.
            _pendingQueue = new PendingCrashQueue(PendingCrashCap);
            if (_uploader != null)
            {
                try { _pendingQueue.ResendAll(_uploader, _config); }
                catch (Exception e) { FlogLog.Exception(e); }
            }

            // Auto-send-on-exception: hook the (main-thread) log callback once.
            HookAutoSend();

            FlogLog.Info("Runtime initialized.");
        }

        // Breadcrumb ring capacity (cap of the rolling buffer included with reports).
        private const int BreadcrumbCapacity = 100;

        // Max pending crash-report files retained on disk for resend.
        private const int PendingCrashCap = 5;

        private static void TryCreate(Action create)
        {
            try { create(); }
            catch (Exception e) { FlogLog.Exception(e); }
        }

        private void OnDestroy()
        {
            // Stop any pending retry countdown (Unity also kills coroutines on Destroy,
            // but clearing the handle keeps our state consistent).
            CancelPendingRetry(resetAttempts: true);

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
                if (_isBusy || _retryCoroutine != null)
                {
                    ShowToast(ToastKind.Info,
                        _retryCoroutine != null
                            ? "FastLogs: waiting to retry the current send"
                            : "FastLogs: a send is already in progress",
                        null, 2.5f, false);
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
                // A user-initiated send is unrelated to any pending crash report; drop
                // ownership so its success does not delete a leftover crash file.
                ForgetPendingCrashOwnership();
                BeginSend(shot, null, null);
            }
            catch (Exception e)
            {
                FlogLog.Exception(e);
            }
        }

        // Detach the current send from any persisted crash file, WITHOUT deleting it
        // (the file stays for resend-on-next-start). Used when a fresh, user-initiated
        // send starts that is not a continuation of a crash send.
        private void ForgetPendingCrashOwnership()
        {
            _pendingCrashFilePath = null;
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

            float now;
            try { now = Time.realtimeSinceStartup; } catch { now = 0f; }

            int stackHash = ComputeStackHash(condition, stackTrace);

            // Title marks the report as an auto-captured crash; comment carries the
            // exception message so the report is self-describing.
            string title = "Auto crash report";
            string comment = "Unhandled exception (auto-sent by FastLogs):\n" + (condition ?? string.Empty);
            bool shot = _config.AutoSend.IncludeScreenshot;

            _inAutoSendDispatch = true;
            try
            {
                // ============================================================
                // PHASE 1 - CAPTURE (always, before any delivery guard).
                // ============================================================
                // An unhandled crash must NEVER be lost in an enabled build, so the
                // very first thing we do - ahead of every throttle/cap/busy/dedup gate -
                // is durably persist the report to the on-disk outbox. If the upload
                // below is skipped (busy / over cap / throttled) or the process dies,
                // the file is still on disk and gets drained on idle or on the next
                // start. The persisted copy carries NO screenshot (heavy, rarely useful
                // for a crashed frame) and is PII-scrubbed by BuildReport. Synchronous
                // and best-effort: one byte-capped JSON write, never throws out of here.
                //
                // Capture dedup (separate from send dedup): if the IDENTICAL stack was
                // already captured within the throttle window, skip writing a new file
                // so a tight crash loop does not spam the outbox. The OUTBOX CAP
                // (PendingCrashCap + TrimToCap) bounds the file count regardless.
                string capturedPath = CaptureCrashIfNew(title, comment, now, stackHash, condition, stackTrace);

                // ============================================================
                // PHASE 2 - DELIVERY (immediate upload + toast), gated.
                // ============================================================
                // The guards below decide ONLY whether to attempt an immediate upload
                // now; they never affect the capture above. A report skipped here stays
                // safely in the outbox for the idle-drain / next-start backstop.

                // Don't pile a second auto-send on top of an in-flight send OR while a
                // retry of the current report is pending/counting down. The internal
                // retry loop keeps running its own report; this just defers delivery of
                // the freshly captured file to the idle drain after that send finishes.
                if (_isBusy || _retryCoroutine != null)
                {
                    return;
                }

                // Per-session cap on IMMEDIATE auto-sends (capture is uncapped except by
                // the outbox cap).
                int cap = _config.AutoSend.MaxAutoSendsPerSession;
                if (cap > 0 && _autoSendCountThisSession >= cap)
                {
                    return;
                }

                bool sameAsLastSent = stackHash == _lastAutoSendStackHash && _lastAutoSendStackHash != 0;

                float minGap = _config.AutoSend.MinSecondsBetweenAutoSends;
                float sinceLastSent = now - _lastAutoSendUnscaled;

                // Global throttle: never auto-send more than once per minGap seconds.
                if (sinceLastSent < minGap)
                {
                    return;
                }

                // Send dedup: same stack as the previous auto-send is suppressed for an
                // extended window (2x the gap), so a tight loop does not keep re-sending
                // the identical exception once per gap.
                if (sameAsLastSent && sinceLastSent < minGap * 2f)
                {
                    return;
                }

                RecordAutoSend(now, stackHash);

                ShowToast(ToastKind.Progress, "FastLogs: crash detected, sending...", null, 0f, false);

                // Bind THIS immediate upload to the file we just captured so its success
                // deletes exactly that file (and nothing else). If capture failed we
                // still attempt the send, but own no file (null) - nothing to delete and
                // no orphan, since there is no file on disk in that case.
                _pendingCrashFilePath = capturedPath;

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

        // ---- Crash-report capture (feature #1) ----

        // CAPTURE: build a screenshot-less, PII-scrubbed report NOW and write it to the
        // on-disk outbox, RETURNING its path (or null on skip/failure). This is the
        // unconditional first step of the crash path - it runs ahead of every
        // delivery guard so a crash is never lost. It does NOT touch
        // _pendingCrashFilePath: ownership of a file by an in-flight upload is assigned
        // by the caller only when it actually starts that upload.
        //
        // Capture dedup (separate state from delivery dedup): if the identical stack was
        // already captured within the throttle window, return null without writing a new
        // file, so a crash loop does not flood the outbox. The outbox cap still bounds
        // the file count in every case.
        //
        // Best-effort: any failure is logged and ignored (delivery still proceeds; with
        // no file it simply owns nothing to delete).
        //
        // FALLBACK (feature: "capture ALWAYS"): the full BuildReport touches the log
        // source, diagnostics collector, web-info provider and breadcrumb store - any of
        // which can fail or stall on a crashed frame. If BuildReport returns null OR
        // throws, we do NOT lose the crash: we assemble a MINIMAL, self-contained report
        // straight from what is reliably available (config ids, platform, version, the
        // exception text) and persist THAT instead. The fallback deliberately depends on
        // nothing that BuildReport depends on, so it survives the same crash that broke
        // the full builder. The only thing it cannot work around is having nowhere to
        // send to (no config / empty endpoint): then we honestly persist nothing.
        private string CaptureCrashIfNew(string title, string comment, float now, int stackHash,
            string condition, string stackTrace)
        {
            if (_pendingQueue == null)
            {
                return null;
            }

            // Capture dedup: same stack as the last CAPTURE, within the throttle window,
            // is not re-written. Uses capture-specific state, independent of send dedup.
            float minGap = _config != null && _config.AutoSend != null
                ? _config.AutoSend.MinSecondsBetweenAutoSends
                : 0f;
            bool sameAsLastCapture = stackHash == _lastCapturedStackHash && _lastCapturedStackHash != 0;
            float sinceLastCapture = now - _lastCapturedUnscaled;
            if (sameAsLastCapture && sinceLastCapture < minGap)
            {
                return null;
            }

            // HAPPY PATH: the full builder. Kept exactly as before. Note a throw here is
            // caught below and routed to the fallback instead of losing the crash.
            LogReportDto report = null;
            try
            {
                report = BuildReport(title, comment, null); // null = no screenshot
            }
            catch (Exception e)
            {
                FlogLog.Exception(e);
                report = null; // fall through to the minimal fallback below
            }

            // FALLBACK PATH: BuildReport failed (returned null or threw). Build the
            // minimal report directly. Returns null only when there is genuinely nowhere
            // to send (no config / empty endpoint), in which case persisting is pointless.
            if (report == null)
            {
                report = BuildMinimalCrashReport(title, comment, condition, stackTrace);
                if (report == null)
                {
                    return null;
                }
            }

            try
            {
                // Persisted copy is the plain contract body (no gzip); the resend path
                // re-applies any gzip via the uploader.
                report.LogEncoding = "plain";
                string path = _pendingQueue.Persist(report);

                // Record capture-dedup state only when a file was actually written.
                if (!string.IsNullOrEmpty(path))
                {
                    _lastCapturedUnscaled = now;
                    _lastCapturedStackHash = stackHash;
                }
                return path;
            }
            catch (Exception e)
            {
                FlogLog.Exception(e);
                return null;
            }
        }

        // Minimal, dependency-free crash report used only when the full BuildReport could
        // not produce one (it returned null or threw on a crashed frame). It reads ONLY
        // from _config and the exception text passed in, plus the same cheap platform /
        // version Unity properties BuildReport uses - NONE of the heavier sources
        // (DiagnosticsCollector, _logSource, _webInfo, _crumbs) that may have caused the
        // original failure. The log source is consulted only opportunistically, in its own
        // guarded block, so if it is the thing that broke we still fall back to the raw
        // exception text. PII is scrubbed exactly like the normal path (ScrubPii default
        // ON). Returns null when there is no endpoint to send to (nothing worth persisting).
        private LogReportDto BuildMinimalCrashReport(string title, string comment,
            string condition, string stackTrace)
        {
            // Nowhere to send -> nothing to persist. Endpoint is the deciding signal: the
            // uploader rejects an empty endpoint outright, so a persisted file would only
            // ever be dropped. AppId rides along in the body but is not the send gate.
            string endpoint = _config != null && _config.Server != null ? _config.Server.EndpointUrl : null;
            if (string.IsNullOrEmpty(endpoint))
            {
                return null;
            }

            bool scrubPii = _config == null || _config.Diagnostics.ScrubPii; // default ON

            // Prefer the captured log text (recorder/ring) if the source can still produce
            // it; this is best-effort and isolated so a faulty/half-dead source cannot take
            // the fallback down with it. If empty/unavailable, fall back to the raw
            // exception text (condition + stack), which is always present on this path.
            string logText = null;
            try
            {
                if (_logSource != null)
                {
                    int maxBytes = _config != null ? _config.Capture.MaxLogTextBytes : 0;
                    logText = _logSource.BuildLogText(maxBytes);
                }
            }
            catch (Exception e)
            {
                FlogLog.Exception(e);
                logText = null;
            }

            if (string.IsNullOrEmpty(logText))
            {
                string cond = condition ?? string.Empty;
                string st = stackTrace ?? string.Empty;
                logText = string.IsNullOrEmpty(st) ? cond : (cond + "\n" + st);
            }

            // Counts if the source can give them cheaply; zeros otherwise. Isolated.
            CountsDto counts;
            try { counts = _logSource != null ? _logSource.Counts : default; }
            catch { counts = default; }

            if (scrubPii)
            {
                logText = PiiScrubber.Scrub(logText);
            }

            // Platform / version come from the same cheap Unity properties BuildReport
            // uses; guarded so even those cannot abort the fallback.
            string platform;
            try { platform = PlatformName(); } catch { platform = "Other"; }

            string appVersion;
            try { appVersion = Application.version; } catch { appVersion = null; }

            string timestamp;
            try
            {
                timestamp = DateTime.UtcNow.ToString("yyyy-MM-ddTHH:mm:ssZ",
                    System.Globalization.CultureInfo.InvariantCulture);
            }
            catch { timestamp = null; }

            // Comment carries the exception message so the minimal report is still
            // self-describing; fall back to the passed-in comment when condition is empty.
            string minimalComment = !string.IsNullOrEmpty(condition) ? condition : comment;

            var report = new LogReportDto
            {
                AppId = _config != null && _config.Server != null ? _config.Server.AppId : string.Empty,
                Platform = platform,
                AppVersion = appVersion,
                TimestampUtc = timestamp,
                Counts = counts,
                LogText = logText,
                LogEncoding = "plain",
                Device = null, // serializer emits an empty {} device object; contract-valid
                ScreenshotPngBase64 = null,
                Title = string.IsNullOrEmpty(title) ? null : Truncate(title, 120),
                Comment = string.IsNullOrEmpty(minimalComment) ? null : Truncate(minimalComment, 4000),
            };

            return report;
        }

        // ---- Context & breadcrumbs (feature #2) ----

        public void SetContext(string key, string value)
        {
            if (_crumbs == null)
            {
                return;
            }
            try { _crumbs.SetContext(key, value); }
            catch (Exception e) { FlogLog.Exception(e); }
        }

        public void ClearContext()
        {
            if (_crumbs == null)
            {
                return;
            }
            try { _crumbs.ClearContext(); }
            catch (Exception e) { FlogLog.Exception(e); }
        }

        public void AddBreadcrumb(string message, FastLogLevel level)
        {
            if (_crumbs == null)
            {
                return;
            }
            try
            {
                double now;
                try { now = Time.realtimeSinceStartupAsDouble; } catch { now = 0; }
                _crumbs.AddBreadcrumb(message, level, now);
            }
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
            // A manual overlay send is a fresh, user-initiated report; detach it from any
            // pending crash file so its success cannot delete a leftover crash report.
            ForgetPendingCrashOwnership();
            BeginSend(includeScreenshot, title, comment);
        }

        /// <summary>
        /// Kick off a send and return an awaitable result. Never throws; failures
        /// surface through the returned task and OnUploaded.
        /// </summary>
        public FlogTask<UploadResultDto> BeginSend(bool includeScreenshot, string title, string comment)
        {
            var task = FlogTask.Create<UploadResultDto>();

            // Block a new EXTERNAL send while one is already in flight OR a retry is
            // pending/counting down: "until the current log is sent, a new one cannot be
            // sent" (including the wait window between retry attempts). The retry loop
            // continuing itself is NOT blocked here: RetryRoutine clears _retryCoroutine
            // to null BEFORE it calls back into BeginSend, so a non-null coroutine always
            // means an external caller (manual Send / toast Retry / quick-send / auto-send),
            // never the retry loop. We do NOT cancel the pending retry and do NOT start a
            // fresh attempt; we surface a status toast and return the current result.
            if (_isBusy || _retryCoroutine != null)
            {
                ShowToast(ToastKind.Info,
                    _retryCoroutine != null
                        ? "FastLogs: waiting to retry the current send"
                        : "FastLogs: a send is already in progress",
                    null, 2.5f, false);
                // Surface the last known result rather than stomping the in-progress/
                // counting-down toast or completing with a fabricated busy failure.
                task.SetResult(_lastResult);
                return task;
            }

            // Remember the parameters so a Retry toast can re-run exactly this send.
            _lastSendIncludeScreenshot = includeScreenshot;
            _lastSendTitle = title;
            _lastSendComment = comment;

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
                // FEATURE #1: this send succeeded, so drop its persisted crash file (if
                // this send owned one) and release ownership.
                if (!string.IsNullOrEmpty(_pendingCrashFilePath))
                {
                    _pendingQueue?.Remove(_pendingCrashFilePath);
                    _pendingCrashFilePath = null;
                }

                // Success reached (possibly after one or more outer retries): make sure
                // no stale retry stays pending and the attempt counter is cleared, then
                // show the existing success toast.
                CancelPendingRetry(resetAttempts: true);
                _retryAttempt = 0;

                bool copied = _config != null && _config.UI.CopyLinkOnSend
                              && !string.IsNullOrEmpty(result.Url);
                string msg = copied ? "FastLogs: done (link copied)" : "FastLogs: done";
                ShowToast(ToastKind.Success, msg, result.Url, 6f, false);

                // "AT THE FIRST OPPORTUNITY": now that a send completed and the client is
                // idle (no in-flight send, no pending retry), drain the outbox so any
                // reports captured while we were busy/throttled/over-cap get delivered,
                // one at a time with a frame gap. The file just sent was already removed
                // above, so the drain never re-sends it. No-op when the outbox is empty.
                DrainOutboxIfIdle();
            }
            else if (IsRetryable(result) && TryScheduleRetry())
            {
                // A transient failure was rescheduled; the same crash file (if owned)
                // stays on disk AND _pendingCrashFilePath keeps pointing at it so the
                // retry continues to own it. The countdown toast ("Retrying in Ns...") is
                // shown by the retry coroutine. Do not show the sticky error toast here.
            }
            else
            {
                // Terminal failure: a permanent client rejection (4xx/415/413/local) OR a
                // transient failure with retries exhausted/disabled. Release ownership of
                // the crash file (if any) WITHOUT deleting it from disk: the idle drain /
                // next-start backstop will retry it later (and the poison-pill rule in
                // the resend path drops it if the server keeps rejecting it permanently).
                // Clearing the field here prevents a later, unrelated success from
                // deleting a now-stale file and prevents the drain from double-owning it.
                _pendingCrashFilePath = null;

                ShowToast(ToastKind.Error, "FastLogs error: " + result.Error, null, 0f, true);

                // The client is idle again (no retry scheduled): drain any reports waiting
                // in the outbox. The just-failed file stays on disk and is picked up by
                // this drain in turn.
                DrainOutboxIfIdle();
            }

            task.SetResult(result);
            try { Uploaded?.Invoke(result); }
            catch (Exception e) { FlogLog.Exception(e); }
        }

        // "AT THE FIRST OPPORTUNITY" drain: when the client is idle (no in-flight send,
        // no pending retry) and the outbox holds files, resend them one at a time with a
        // frame gap (PendingCrashQueue.ResendAll). Soft and best-effort; never throws.
        // Files successfully delivered are removed by the resend path, so nothing is
        // double-sent, and the file just delivered by the current send (already removed)
        // is never re-sent.
        private void DrainOutboxIfIdle()
        {
            if (_pendingQueue == null || _uploader == null)
            {
                return;
            }
            if (_isBusy || _retryCoroutine != null)
            {
                return; // not idle - wait; a later Complete will drain
            }
            try { _pendingQueue.ResendAll(_uploader, _config); }
            catch (Exception e) { FlogLog.Exception(e); }
        }

        // ---- Retry-until-success (outer loop) ----

        /// <summary>
        /// Whether a failed upload is transient and worth re-sending the SAME report.
        /// Permanent client rejections (4xx: 400 bad_request, 401/403 wrong token or
        /// unregistered appId, 413 payload_too_large, 415) must NOT be retried - otherwise
        /// an unlimited (MaxRetryAttempts=0) loop would re-send a doomed request forever.
        /// Mirrors GameMaker's deferred-retry gate (net_error || http_status &gt;= 500).
        /// Primary source is the uploader's own classification (<see cref="UploadResultDto.Retryable"/>),
        /// which already flags network/transport blips and 5xx as transient. The StatusCode
        /// fallback only adds server 5xx (a result built outside the uploader's per-attempt
        /// path): we deliberately do NOT treat statusCode == 0 as retryable here, because the
        /// core's own pre-upload failures (build report / serialize / no uploader) carry
        /// status 0 and are deterministic - re-sending them would loop forever with no chance
        /// of success. Genuine network blips already arrive with Retryable == true.
        /// </summary>
        private static bool IsRetryable(UploadResultDto result)
        {
            if (result.Success)
            {
                return false;
            }
            if (result.Retryable)
            {
                return true;
            }
            return result.StatusCode >= 500;
        }

        /// <summary>
        /// Schedule a re-send of the same report after Retry.RetryIntervalSeconds if
        /// retrying is enabled and the attempt cap has not been reached. Returns true
        /// when a retry was scheduled (so the caller suppresses the error toast).
        /// Guarantees a single pending retry: this only runs when no retry was pending
        /// (external sends are blocked while one is, and the internal retry loop nulls
        /// _retryCoroutine before re-entering BeginSend), so there is nothing to stack on.
        /// </summary>
        private bool TryScheduleRetry()
        {
            if (this == null || !isActiveAndEnabled)
            {
                return false; // host is being torn down; nothing to schedule on
            }

            var retry = _config != null ? _config.Retry : null;
            if (retry == null)
            {
                return false;
            }

            float interval = retry.RetryIntervalSeconds;
            if (interval <= 0f)
            {
                return false; // 0 = outer retry disabled
            }

            int maxAttempts = retry.MaxRetryAttempts; // 0 = unlimited
            if (maxAttempts > 0 && _retryAttempt >= maxAttempts)
            {
                return false; // attempt cap reached; give up and surface the error
            }

            _retryAttempt++;
            _retryCoroutine = StartCoroutine(RetryRoutine(interval));
            return true;
        }

        // Waits on a real-time (unscaled) timer, updating a "Retrying in Ns..." status once
        // per second, then re-runs the last send. The countdown is driven by an unscaled
        // deadline (Time.realtimeSinceStartup), mirroring the uploader's backoff and the
        // toast deadline, so it keeps ticking when the tester pauses the game
        // (Time.timeScale == 0) and never allocates per frame or per tick.
        private IEnumerator RetryRoutine(float intervalSeconds)
        {
            // Whole seconds remaining for the visible countdown.
            int remaining = Mathf.Max(1, Mathf.CeilToInt(intervalSeconds));

            while (remaining > 0)
            {
                ShowToast(ToastKind.Progress, "FastLogs: retrying in " + remaining + "s...", null, 0f, false);

                // Unscaled 1s wait: poll the frame loop until the real-time deadline. This
                // is a per-frame yield, but it does no work and allocates nothing per frame
                // (no new WaitForSeconds), and is immune to Time.timeScale.
                float until = Time.realtimeSinceStartup + 1f;
                while (Time.realtimeSinceStartup < until)
                {
                    yield return null;
                }

                remaining--;
            }

            // Hand off to a fresh send of the SAME report. Clear the handle FIRST so the
            // BeginSend below is recognised as the retry loop continuing (it must NOT
            // reset the attempt counter), not an external replacement.
            _retryCoroutine = null;
            BeginSend(_lastSendIncludeScreenshot, _lastSendTitle, _lastSendComment);
        }

        /// <summary>
        /// Cancel any pending/counting-down retry. When resetAttempts is true the
        /// attempt counter is reset ONLY if there actually was a pending retry to
        /// cancel - so the retry loop calling BeginSend on itself (after it has already
        /// nulled _retryCoroutine) does not wipe its own progress toward the cap.
        /// </summary>
        private void CancelPendingRetry(bool resetAttempts)
        {
            if (_retryCoroutine == null)
            {
                return; // nothing pending: leave the attempt counter untouched
            }

            try { StopCoroutine(_retryCoroutine); }
            catch (Exception e) { FlogLog.Exception(e); }
            _retryCoroutine = null;

            if (resetAttempts)
            {
                _retryAttempt = 0;
            }
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
            bool scrubPii = _config == null || _config.Diagnostics.ScrubPii; // default ON

            var device = DiagnosticsCollector.Collect(includeSensitive);
            if (_webInfo != null && device != null)
            {
                try { _webInfo.Fill(device.Web, includeSensitive); }
                catch (Exception e) { FlogLog.Exception(e); }
            }

            int maxBytes = _config != null ? _config.Capture.MaxLogTextBytes : 0;
            string logText = _logSource != null ? _logSource.BuildLogText(maxBytes) : string.Empty;
            CountsDto counts = Counts;

            // Snapshot context + breadcrumbs (feature #2). One-shot copy, off the hot
            // path. Null when empty so the serializer omits the fields.
            Dictionary<string, string> context = _crumbs != null ? _crumbs.SnapshotContext() : null;
            List<BreadcrumbDto> breadcrumbs = _crumbs != null ? _crumbs.SnapshotBreadcrumbs() : null;

            // PII scrub (feature #3, privacy-by-default). One-shot pass at send time over
            // the log text, every context value and every breadcrumb message.
            if (scrubPii)
            {
                logText = PiiScrubber.Scrub(logText);
                context = ScrubContext(context);
                breadcrumbs = ScrubBreadcrumbs(breadcrumbs);
            }

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
                Tester = string.IsNullOrEmpty(tester) ? null : Truncate(tester, 120),
                Context = context,
                Breadcrumbs = breadcrumbs
            };

            return report;
        }

        // Scrub PII from context values in place (keys are not scrubbed - they are app
        // labels like "level"/"playerId", not user data). Returns the same map.
        private static Dictionary<string, string> ScrubContext(Dictionary<string, string> context)
        {
            if (context == null || context.Count == 0)
            {
                return context;
            }
            // Snapshot keys first - we are mutating values, not the key set.
            var keys = new List<string>(context.Keys);
            for (int i = 0; i < keys.Count; i++)
            {
                context[keys[i]] = PiiScrubber.Scrub(context[keys[i]]);
            }
            return context;
        }

        // Scrub PII from breadcrumb messages in place. Returns the same list.
        private static List<BreadcrumbDto> ScrubBreadcrumbs(List<BreadcrumbDto> crumbs)
        {
            if (crumbs == null || crumbs.Count == 0)
            {
                return crumbs;
            }
            for (int i = 0; i < crumbs.Count; i++)
            {
                BreadcrumbDto c = crumbs[i];
                c.Message = PiiScrubber.Scrub(c.Message);
                crumbs[i] = c;
            }
            return crumbs;
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
