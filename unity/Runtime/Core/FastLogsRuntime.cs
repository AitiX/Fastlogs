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
    /// Identity of a CODE send call site, captured via CallerInfo at the facade. The
    /// loop guard keys per-site state on <see cref="Key"/> = "filename:line" (filename
    /// only, no path). A default/empty struct (Key null) means "no call-site info"
    /// (e.g. a runtime-internal send); the guard treats those as ungated.
    /// </summary>
    internal readonly struct CallSite
    {
        public readonly string Key;

        // File name (no path) and 1-based line of the code call site, retained separately
        // from Key so a code send can surface them on the report DTO (callerFile/callerLine)
        // for the viewer badge. File is null when there was no call-site info.
        public readonly string File;
        public readonly int Line;

        public CallSite(string callerFile, int callerLine)
        {
            string file = string.IsNullOrEmpty(callerFile)
                ? null
                : System.IO.Path.GetFileName(callerFile);
            File = file;
            Line = callerLine;
            Key = file != null ? (file + ":" + callerLine) : null;
        }

        public bool HasValue { get { return !string.IsNullOrEmpty(Key); } }
    }

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
        private IFileUploader _fileUploader;
        private IScreenshotCapturer _screenshot;
        private IClipboard _clipboard;
        private ILogShareOverlay _overlay;
        private IToastSink _toast;                 // optional toast seam (same object as _overlay when supported)
        private IWebDeviceInfoProvider _webInfo;

        private bool _isBusy;
        private UploadResultDto _lastResult = UploadResultDto.Disabled;

        // WebGL <input type=file> bridge (feature #7), created lazily on first pick and
        // torn down with the runtime. Null until first used / on non-WebGL platforms.
        private WebFilePicker _webFilePicker;

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
        private bool _lastSendAttachQueued; // did this send attach the manual screenshot queue?
        private bool _lastSendViaCode;      // was the last send initiated from game CODE (vs overlay/auto)?
        private CallSite _lastSendSite;     // code call site of the last send (for callerFile/line); default for non-code sends

        // Screenshots captured in code via CaptureScreenshot(), queued for the next
        // user-initiated send and cleared once it resolves. Capped (oldest dropped).
        private const int MaxQueuedScreenshots = 8;
        private readonly List<string> _queuedShots = new List<string>();

        // File paths queued via AttachFile(), to be uploaded to /api/files as attachments
        // of the NEXT successful report send (logId = that report's id). Capped (oldest
        // dropped) and cleared once the send that carried them resolves successfully. A
        // path may be a file or a folder (folders are zipped at upload time).
        private const int MaxQueuedAttachments = 8;
        private readonly List<string> _queuedAttachments = new List<string>();

        // ---- Snapshot source registry (full game snapshot feature) ----
        // Extra sources added ON TOP of the default persistentDataPath source: file/folder
        // PATHS (AddSnapshotSource) and in-memory named DATA providers (AddSnapshotData).
        // Collected at SendSnapshot time, zipped into snapshot.zip and attached to the report
        // record (kind="snapshot"). The default source (whole persistentDataPath minus the
        // FastLogs data dir + config ExcludePaths) is applied by SendSnapshotRoutine itself,
        // NOT stored here. Data providers are evaluated lazily at send time. Insertion order
        // is preserved (List for paths, name->provider map for data).
        private readonly List<string> _snapshotSources = new List<string>();
        private readonly Dictionary<string, Func<byte[]>> _snapshotData = new Dictionary<string, Func<byte[]>>(StringComparer.Ordinal);

        // Absolute path of FastLogs's own on-disk data dir (persistentDataPath/FastLogs),
        // resolved once at Init and seeded into Snapshot.ExcludePaths so the default source
        // never re-bundles our own recorder store / pending crash outbox. Null off-disk.
        private string _fastLogsDataDir;

        // In-memory attachments (already-built bytes, e.g. snapshot.zip) queued to upload as
        // attachments of the NEXT successful report (logId = that report's id), in parallel
        // to the path-based _queuedAttachments. Each carries its own server kind (e.g.
        // "snapshot"). Drained alongside the path queue by UploadQueuedAttachments and cleared
        // on a successful send. Lets a built blob ride the report record without touching disk.
        private readonly List<BlobAttachment> _queuedBlobAttachments = new List<BlobAttachment>();

        // Re-entrancy guard for SendSnapshot. The report-level _isBusy flag is only set deep in
        // BeginSend, which the snapshot coroutine reaches AFTER a yield + the (synchronous) zip
        // build, so two SendSnapshot calls in the SAME frame would both pass the _isBusy check
        // and queue two snapshot.zip blobs onto one report. Set synchronously in StartSnapshotSend
        // before the coroutine starts and cleared when the routine resolves, this closes that
        // one-frame window the report-level guard cannot.
        private bool _snapshotInFlight;

        // A pre-built in-memory attachment (bytes + name + mime + server kind) for the report.
        private struct BlobAttachment
        {
            public byte[] Bytes;
            public string FileName;
            public string Mime;
            public string Kind;
        }

        // Scene-hierarchy snapshot captured via CaptureSceneContext(), queued for the next
        // send (like _queuedShots) and cleared once that send resolves. _sceneContextSentOnce
        // is the once-per-session loop guard for SendSceneContext() (bypassed with allowRepeat).
        private string _queuedSceneContext;
        private bool _sceneContextSentOnce;
        private bool _lastSendHadSceneContext; // did the in-flight/last send attach scene context?

        // Correlation/debug code attached to every report (FastLogs.SetCorrelationCode), so a
        // specific log can be awaited + grabbed on the server. Null = none.
        private string _correlationCode;

        // Per-run session id: one GUID generated at Init, attached to EVERY report of this
        // process run, so the server can group reports from the same play session. Stays
        // constant for the lifetime of the runtime.
        private string _sessionId;

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

        // ---- Auto-send-on-pattern state (feature #9) ----
        // Regex patterns (AutoSendSection.AutoSendPatterns) compiled once at Init and
        // matched against every captured log line. A match triggers an auto-send that
        // reuses the SAME throttle/cap/dedup as the crash path (above), so a chatty
        // match cannot spam the server. Empty/null = the feature is off. Invalid
        // patterns are dropped at compile time with one warning.
        private System.Text.RegularExpressions.Regex[] _autoSendPatterns;

        // ---- Loop guard (per CODE call site) ----
        // Catches a single code call site (FastLogs.Send / SendAsync / SendSceneContext)
        // that keeps sending. Counts are CUMULATIVE per session, no time window. Over the
        // threshold and with UI present, a confirm is shown (Send -> reset + proceed, tagged
        // with the confirmer; Cancel -> disable that site for the session). Over threshold
        // with no UI, the send is dropped and every Nth drop logs one warning. Sites under
        // threshold send normally. Sits at the code-API entry only (NOT the overlay Send or
        // auto-crash send).
        private readonly Dictionary<string, int> _siteSendCount = new Dictionary<string, int>(StringComparer.Ordinal);
        private readonly HashSet<string> _disabledSites = new HashSet<string>(StringComparer.Ordinal);
        private readonly Dictionary<string, int> _siteDropCount = new Dictionary<string, int>(StringComparer.Ordinal); // no-UI drops, per site (warn cadence)
        private bool _confirmPending;                 // a confirm dialog is showing; only one at a time
        private PendingLoopConfirm _pendingConfirm;   // the send to replay if the showing confirm is answered "Send"

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

            // Per-run session id (feature #9): one GUID for this process run, stamped on
            // every report so the server can group a single play session's reports. "N"
            // gives a compact 32-hex-char form with no separators.
            _sessionId = Guid.NewGuid().ToString("N");

            if (_services != null)
            {
                TryCreate(() => _logSource = _services.CreateLogSource(config));
                TryCreate(() => _triggerSource = _services.CreateTriggerSource(config));
                TryCreate(() => _uploader = _services.CreateUploader(config));
                TryCreate(() => _fileUploader = _services.CreateFileUploader(config));
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
                _overlay.SceneContextRequested += OnOverlaySceneContextRequested;
                _overlay.ConfirmAnswered += OnLoopConfirmAnswered;

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

            // Auto-send-on-pattern (feature #9): compile the configured regex patterns once,
            // before hooking, so the per-line callback only does a cheap IsMatch.
            CompileAutoSendPatterns();

            // Auto-send (on exception and/or on pattern): hook the (main-thread) log
            // callback once.
            HookAutoSend();

            // Snapshot default-exclude seeding: resolve FastLogs's own data dir
            // (persistentDataPath/FastLogs - same FolderName the recorder + pending crash
            // queue use) and add it to Snapshot.ExcludePaths so the default "whole
            // persistentDataPath" snapshot source never re-bundles our own logs/recordings/
            // outbox (no recursion/dupe). Idempotent (EnsureDataDirExcluded de-dups).
            ResolveFastLogsDataDir();
            if (_config != null && _config.Snapshot != null)
            {
                _config.Snapshot.EnsureDataDirExcluded(_fastLogsDataDir);
            }

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
                _overlay.SceneContextRequested -= OnOverlaySceneContextRequested;
                _overlay.ConfirmAnswered -= OnLoopConfirmAnswered;
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

            // Tear down the WebGL file picker host (resolves any in-flight pick).
            if (_webFilePicker != null)
            {
                try { _webFilePicker.Shutdown(); }
                catch (Exception e) { FlogLog.Exception(e); }
                _webFilePicker = null;
            }

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
            // Re-run the last send with the same parameters, preserving its code-vs-overlay
            // provenance and call site so the retry's report keeps the same badge.
            BeginSend(_lastSendIncludeScreenshot, _lastSendTitle, _lastSendComment, _lastSendAttachQueued,
                _lastSendViaCode, _lastSendSite);
        }

        // ---- Quick-send (send immediately, without opening the overlay) ----

        /// <summary>
        /// Fire-and-forget quick send with config defaults (screenshot per
        /// Screenshot.CaptureByDefault, no title/comment). Shows a status toast. If
        /// there is nothing useful to send (no logs captured) it shows a hint toast
        /// instead of starting an empty upload. Never throws.
        /// </summary>
        public void QuickSend(bool viaCode = false, CallSite site = default)
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
                BeginSend(shot, null, null, attachQueuedShots: true, viaCode: viaCode, site: site);
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

        // ============================================================
        // Loop guard - CODE-API send entry points
        // ============================================================
        // These wrap the shared send pipeline for sends triggered from game code
        // (FastLogs.Send / SendAsync / SendSceneContext). They run the per-call-site
        // loop guard FIRST; only if it lets the send through do they fall through to
        // the same path the overlay/auto paths use. The overlay Send and auto-crash
        // send deliberately do NOT call these, so they are never guarded.

        /// <summary>FastLogs.Send() entry. Guards the call site, then quick-sends.</summary>
        public void QuickSendFromCode(CallSite site)
        {
            switch (EvaluateLoopGuard(site, PendingLoopConfirm.QuickSend(site)))
            {
                case LoopGuardDecision.Proceed:
                    QuickSend(viaCode: true, site: site);
                    break;
                case LoopGuardDecision.Deferred:
                case LoopGuardDecision.Dropped:
                    break; // dialog shown / silently dropped; nothing to send now
            }
        }

        /// <summary>FastLogs.SendAsync() entry. Guards the call site, then begins a send.</summary>
        public FlogTask<UploadResultDto> BeginSendFromCode(bool includeScreenshot, string title, string comment, CallSite site)
        {
            var task = FlogTask.Create<UploadResultDto>();
            switch (EvaluateLoopGuard(site, PendingLoopConfirm.BeginSend(site, includeScreenshot, title, comment, task)))
            {
                case LoopGuardDecision.Proceed:
                    // A fresh, code-initiated report: detach from any pending crash file.
                    ForgetPendingCrashOwnership();
                    return BeginSend(includeScreenshot, title, comment, attachQueuedShots: true, viaCode: true, site: site);
                case LoopGuardDecision.Dropped:
                    // No UI to confirm a looping site: resolve the awaited task with a
                    // non-success "declined" result rather than leaving it pending.
                    task.SetResult(LoopDeclinedResult(site.Key));
                    return task;
                case LoopGuardDecision.Deferred:
                    // Confirm shown: the returned task stays pending and is resolved later
                    // by OnLoopConfirmAnswered (real result on Send, declined on Cancel).
                    return task;
                default:
                    task.SetResult(_lastResult);
                    return task;
            }
        }

        /// <summary>FastLogs.SendSceneContext() entry. Guards the call site, then sends scene context.</summary>
        public void SendSceneContextFromCode(bool allowRepeat, CallSite site)
        {
            switch (EvaluateLoopGuard(site, PendingLoopConfirm.SceneContext(site, allowRepeat)))
            {
                case LoopGuardDecision.Proceed:
                    SendSceneContext(allowRepeat, viaCode: true, site: site);
                    break;
                case LoopGuardDecision.Deferred:
                case LoopGuardDecision.Dropped:
                    break;
            }
        }

        // Outcome of the loop-guard check for a single code send.
        private enum LoopGuardDecision
        {
            Proceed,  // under threshold (or guard off / no site info): send now
            Deferred, // over threshold + UI: a confirm dialog was shown; do not send yet
            Dropped   // over threshold + no UI, OR a confirm is already pending: do not send
        }

        // Core decision for a code send from the given site. On the FIRST over-threshold
        // hit with UI available it shows the confirm dialog and stashes `deferred` to
        // replay on a "Send" answer. Under threshold it increments the per-site counter
        // and returns Proceed. Never throws.
        private LoopGuardDecision EvaluateLoopGuard(CallSite site, PendingLoopConfirm deferred)
        {
            // Guard off, or no call-site info to key on: always send (no-op guard).
            var cfg = _config != null ? _config.LoopGuard : null;
            if (cfg == null || !cfg.Enabled || !site.HasValue)
            {
                return LoopGuardDecision.Proceed;
            }

            string key = site.Key;

            // A site disabled by an earlier "Cancel" stays disabled for the session.
            if (_disabledSites.Contains(key))
            {
                return LoopGuardDecision.Dropped;
            }

            int max = cfg.MaxCodeSendsPerSite > 0 ? cfg.MaxCodeSendsPerSite : 10;
            int count;
            _siteSendCount.TryGetValue(key, out count);

            // Under threshold: count this send and let it through.
            if (count < max)
            {
                _siteSendCount[key] = count + 1;
                return LoopGuardDecision.Proceed;
            }

            // Over threshold (the (max+1)th and beyond). UI confirm if available,
            // otherwise drop with throttled warning.
            bool uiAvailable = _overlay != null && _config != null && _config.UI.EnableUI;
            if (!uiAvailable)
            {
                CountNoUiDrop(key, cfg.NoUiWarnEvery);
                return LoopGuardDecision.Dropped;
            }

            // Only ONE confirm pending at a time. While one is showing, further
            // over-threshold sends from any site are just dropped (no stacked dialogs).
            if (_confirmPending)
            {
                return LoopGuardDecision.Dropped;
            }

            ShowLoopConfirm(deferred);
            return LoopGuardDecision.Deferred;
        }

        // Count a no-UI drop for a site and warn once every NoUiWarnEvery drops so a
        // loop is visible without flooding the log.
        private void CountNoUiDrop(string key, int warnEvery)
        {
            int drops;
            _siteDropCount.TryGetValue(key, out drops);
            drops++;
            _siteDropCount[key] = drops;

            int every = warnEvery > 0 ? warnEvery : 10;
            if (drops % every == 0)
            {
                FlogLog.Warn("FastLogs: dropped " + drops + " looping sends from " + key + " (no UI to confirm)");
            }
        }

        // Show the loop-guard confirm dialog for `deferred`'s site and stash it so a
        // "Send" answer replays exactly this send. The dialog is rendered by the overlay
        // (toast-like, visible even when closed).
        private void ShowLoopConfirm(PendingLoopConfirm deferred)
        {
            _confirmPending = true;
            _pendingConfirm = deferred;

            int kb = _logSource != null ? Math.Max(1, _logSource.ApproxLogBytes / 1024) : 0;
            string size = kb > 0 ? ("~" + kb + " KB") : "a log";
            string msg = "FastLogs: this call keeps sending (" + deferred.SiteKey
                + ") - possible loop. Send " + size + " anyway? (avoid filling the server)";
            try { _overlay.ShowConfirm(msg); }
            catch (Exception e) { FlogLog.Exception(e); }
        }

        // Answer of the loop-guard confirm dialog: true = Send (reset the site counter,
        // tag the report with the confirmer + site, then replay the stashed send); false =
        // Cancel (disable the site for the session, resolve any awaited task as declined).
        private void OnLoopConfirmAnswered(bool send)
        {
            if (!_confirmPending)
            {
                return;
            }

            PendingLoopConfirm pending = _pendingConfirm;
            _confirmPending = false;
            _pendingConfirm = default;

            string key = pending.SiteKey;
            if (string.IsNullOrEmpty(key))
            {
                return;
            }

            if (!send)
            {
                // Cancel: disable this exact site for the rest of the session.
                _disabledSites.Add(key);
                if ((pending.Kind == PendingLoopConfirm.SendKind.BeginSend
                     || pending.Kind == PendingLoopConfirm.SendKind.Snapshot)
                    && pending.Task != null)
                {
                    pending.Task.SetResult(LoopDeclinedResult(key));
                }
                return;
            }

            // Send: reset the site's counter so it gets a fresh budget, then tag THIS
            // report with the confirmer (accountability goes to who confirmed, not the
            // author) and the site, via the existing context mechanism the viewer shows.
            _siteSendCount[key] = 0;
            TagLoopConfirmContext(key);

            try
            {
                switch (pending.Kind)
                {
                    case PendingLoopConfirm.SendKind.QuickSend:
                        QuickSend(viaCode: true, site: pending.Site);
                        break;
                    case PendingLoopConfirm.SendKind.BeginSend:
                        ForgetPendingCrashOwnership();
                        ReplayBeginSend(pending);
                        break;
                    case PendingLoopConfirm.SendKind.SceneContext:
                        SendSceneContext(pending.AllowRepeat, viaCode: true, site: pending.Site);
                        break;
                    case PendingLoopConfirm.SendKind.Snapshot:
                        ForgetPendingCrashOwnership();
                        StartSnapshotSend(pending.Title, pending.IncludeScreenshot, pending.Site, pending.Task);
                        break;
                }
            }
            catch (Exception e)
            {
                FlogLog.Exception(e);
            }
        }

        // Replay a deferred SendAsync, completing the ORIGINAL task the caller awaits
        // with the real result rather than fabricating a new one. We start the send via
        // BeginSend (its own task) and forward that result onto the original.
        private void ReplayBeginSend(PendingLoopConfirm pending)
        {
            FlogTask<UploadResultDto> inner = BeginSend(
                pending.IncludeScreenshot, pending.Title, pending.Comment, attachQueuedShots: true,
                viaCode: true, site: pending.Site);

            FlogTask<UploadResultDto> original = pending.Task;
            if (original == null)
            {
                return;
            }
            if (inner == null)
            {
                original.SetResult(_lastResult);
                return;
            }

            // Forward the inner result to the caller's task once it resolves. inner is
            // completed on the main thread (coroutine), so the continuation is inline.
            try
            {
                var awaiter = inner.GetAwaiter();
                awaiter.OnCompleted(() =>
                {
                    try { original.SetResult(inner.Result); }
                    catch (Exception e)
                    {
                        FlogLog.Exception(e);
                        original.SetResult(UploadResultDto.Fail("Send faulted: " + e.Message));
                    }
                });
            }
            catch (Exception e)
            {
                FlogLog.Exception(e);
                original.SetResult(UploadResultDto.Fail("Failed to replay send: " + e.Message));
            }
        }

        // Inject the confirmer + site into the context map that rides with the very next
        // report (reusing FastLogs.SetContext's store, which the viewer renders in its
        // Context section). loopConfirmedBy = the tester name (or "unknown" if empty).
        private void TagLoopConfirmContext(string siteKey)
        {
            string tester = _config != null ? _config.UI.TesterName : null;
            string confirmedBy = string.IsNullOrEmpty(tester) ? "unknown" : tester;
            SetContext("loopConfirmedBy", confirmedBy);
            SetContext("loopSite", siteKey);
        }

        // A non-success result returned/resolved when a code send is declined by the loop
        // guard (Cancel) or dropped for lack of UI. Not retryable - it is a deliberate
        // local decision, not a transient failure.
        private static UploadResultDto LoopDeclinedResult(string siteKey)
        {
            string where = string.IsNullOrEmpty(siteKey) ? string.Empty : (" from " + siteKey);
            return UploadResultDto.Fail("FastLogs: send declined by loop guard" + where + ".");
        }

        // Captures a deferred code send so a "Send" confirm answer can replay it exactly.
        private struct PendingLoopConfirm
        {
            public enum SendKind { QuickSend, BeginSend, SceneContext, Snapshot }

            public SendKind Kind;
            public string SiteKey;

            // Full call site of the deferred CODE send, so a "Send" replay carries the same
            // sentViaCode=true + callerFile/line as the original (SiteKey is the loop-guard key).
            public CallSite Site;

            // BeginSend (SendAsync) params + the caller's awaited task to resolve.
            public bool IncludeScreenshot;
            public string Title;
            public string Comment;
            public FlogTask<UploadResultDto> Task;

            // SceneContext param.
            public bool AllowRepeat;

            public static PendingLoopConfirm QuickSend(CallSite site)
            {
                return new PendingLoopConfirm { Kind = SendKind.QuickSend, SiteKey = site.Key, Site = site };
            }

            public static PendingLoopConfirm BeginSend(CallSite site, bool includeScreenshot, string title, string comment, FlogTask<UploadResultDto> task)
            {
                return new PendingLoopConfirm
                {
                    Kind = SendKind.BeginSend,
                    SiteKey = site.Key,
                    Site = site,
                    IncludeScreenshot = includeScreenshot,
                    Title = title,
                    Comment = comment,
                    Task = task
                };
            }

            public static PendingLoopConfirm SceneContext(CallSite site, bool allowRepeat)
            {
                return new PendingLoopConfirm { Kind = SendKind.SceneContext, SiteKey = site.Key, Site = site, AllowRepeat = allowRepeat };
            }

            // A deferred SendSnapshot: on confirm it rebuilds snapshot.zip and sends (Title +
            // IncludeScreenshot reused from the BeginSend fields, the caller's awaited Task too).
            public static PendingLoopConfirm Snapshot(CallSite site, string title, bool includeScreenshot, FlogTask<UploadResultDto> task)
            {
                return new PendingLoopConfirm
                {
                    Kind = SendKind.Snapshot,
                    SiteKey = site.Key,
                    Site = site,
                    IncludeScreenshot = includeScreenshot,
                    Title = title,
                    Task = task
                };
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
            // Hook when EITHER auto-send-on-exception is on OR there is at least one
            // compiled auto-send pattern; otherwise the callback would be dead weight.
            bool wantExceptions = _config != null && _config.AutoSend != null && _config.AutoSend.AutoSendOnException;
            bool wantPatterns = _autoSendPatterns != null && _autoSendPatterns.Length > 0;
            if (!wantExceptions && !wantPatterns)
            {
                return;
            }
            // Main-thread callback: Unity raises logMessageReceived on the main thread,
            // so we can safely touch runtime state and start a coroutine from here.
            Application.logMessageReceived += OnLogMessageForAutoSend;
            _autoSendHooked = true;
        }

        // Compile the configured auto-send regex patterns once. Invalid patterns are
        // skipped with a single warning naming them, so one bad entry does not disable
        // the rest. Null/empty config leaves _autoSendPatterns null (feature off).
        private void CompileAutoSendPatterns()
        {
            _autoSendPatterns = null;
            string[] raw = _config != null && _config.AutoSend != null ? _config.AutoSend.AutoSendPatterns : null;
            if (raw == null || raw.Length == 0)
            {
                return;
            }

            var compiled = new List<System.Text.RegularExpressions.Regex>(raw.Length);
            for (int i = 0; i < raw.Length; i++)
            {
                string pattern = raw[i];
                if (string.IsNullOrEmpty(pattern))
                {
                    continue;
                }
                try
                {
                    compiled.Add(new System.Text.RegularExpressions.Regex(
                        pattern, System.Text.RegularExpressions.RegexOptions.CultureInvariant));
                }
                catch (Exception e)
                {
                    FlogLog.Warn("FastLogs: ignoring invalid AutoSendPattern '" + pattern + "': " + e.Message);
                }
            }

            _autoSendPatterns = compiled.Count > 0 ? compiled.ToArray() : null;
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
            // Re-entrancy guard: any log raised by FastLogs' own send pipeline (e.g. via
            // FlogLog.*) arrives here too; never auto-send for that. Guards both paths.
            if (_inAutoSendDispatch)
            {
                return;
            }

            // Ignore FastLogs' OWN diagnostic lines: FlogLog routes Info/Warn/Error
            // through Debug.Log* with the "[FastLogs] " prefix, so those reach this
            // callback too. Without this, a broad user pattern could match a line FastLogs
            // emits DURING/AFTER a send (outside the _inAutoSendDispatch window) and start a
            // self-sustaining send loop when the shared throttle/cap are configured to 0.
            if (!string.IsNullOrEmpty(condition) && condition.StartsWith(FlogLog.Prefix, StringComparison.Ordinal))
            {
                return;
            }

            if (_config == null || _config.AutoSend == null)
            {
                return;
            }

            // Unhandled exceptions take the crash path (durable capture + gated delivery).
            // Re-check the live toggle (it may have been turned off via settings).
            if (type == LogType.Exception)
            {
                if (_config.AutoSend.AutoSendOnException)
                {
                    HandleExceptionAutoSend(condition, stackTrace);
                }
                return;
            }

            // Any other level: auto-send only if a configured pattern matches the line.
            if (MatchesAutoSendPattern(condition))
            {
                HandlePatternAutoSend(condition, type);
            }
        }

        // Crash auto-send: durably capture, then gated immediate delivery (PHASE 1/2).
        private void HandleExceptionAutoSend(string condition, string stackTrace)
        {
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

                // Auto-crash is not a manual overlay send: mark it as a code/automatic
                // send (sentViaCode=true) so the viewer shows the "via code" badge and
                // does not expect a QA name. No game call site, so callerFile/line stay null.
                BeginSend(shot, title, comment, viaCode: true);
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

        // True if any compiled auto-send pattern matches the log line. Cheap and
        // allocation-free; returns false fast when the feature is off or the line is empty.
        private bool MatchesAutoSendPattern(string condition)
        {
            if (_autoSendPatterns == null || _autoSendPatterns.Length == 0 || string.IsNullOrEmpty(condition))
            {
                return false;
            }
            for (int i = 0; i < _autoSendPatterns.Length; i++)
            {
                var rx = _autoSendPatterns[i];
                if (rx == null)
                {
                    continue;
                }
                try
                {
                    if (rx.IsMatch(condition))
                    {
                        return true;
                    }
                }
                catch (Exception e)
                {
                    FlogLog.Exception(e);
                }
            }
            return false;
        }

        // Pattern auto-send (feature #9): a non-exception log line matched a configured
        // pattern. We immediately send a report, REUSING the crash auto-send throttle/cap/
        // dedup (_autoSendCountThisSession + MaxAutoSendsPerSession, _lastAutoSendUnscaled +
        // MinSecondsBetweenAutoSends, _lastAutoSendStackHash) so a chatty match cannot spam
        // the server. Unlike the crash path this does NOT persist to the on-disk outbox: a
        // matched info/warn line is not a crash and need not survive a process death. Never
        // throws.
        private void HandlePatternAutoSend(string condition, LogType type)
        {
            float now;
            try { now = Time.realtimeSinceStartup; } catch { now = 0f; }

            // Dedup keys on the matched message (no useful stack for a plain log line).
            int stackHash = ComputeStackHash(condition, null);

            _inAutoSendDispatch = true;
            try
            {
                // Don't pile on an in-flight send or a pending retry; the match is dropped
                // (the line is also already in the captured log, so the next send carries it).
                if (_isBusy || _retryCoroutine != null)
                {
                    return;
                }

                // Per-session cap (shared with crash auto-sends).
                int cap = _config.AutoSend.MaxAutoSendsPerSession;
                if (cap > 0 && _autoSendCountThisSession >= cap)
                {
                    return;
                }

                bool sameAsLastSent = stackHash == _lastAutoSendStackHash && _lastAutoSendStackHash != 0;

                float minGap = _config.AutoSend.MinSecondsBetweenAutoSends;
                float sinceLastSent = now - _lastAutoSendUnscaled;

                // Global throttle (shared): never auto-send more than once per minGap.
                if (sinceLastSent < minGap)
                {
                    return;
                }

                // Dedup: same matched line as the previous auto-send is suppressed for an
                // extended window (2x the gap), mirroring the crash path.
                if (sameAsLastSent && sinceLastSent < minGap * 2f)
                {
                    return;
                }

                RecordAutoSend(now, stackHash);

                string title = "Auto report (pattern)";
                string comment = "Log line (" + type + ") matched an auto-send pattern (auto-sent by FastLogs):\n" + (condition ?? string.Empty);
                bool shot = _config.AutoSend.IncludeScreenshot;

                ShowToast(ToastKind.Progress, "FastLogs: log pattern matched, sending...", null, 0f, false);

                // Not a crash: own no persisted file, so a success deletes nothing.
                ForgetPendingCrashOwnership();
                // Auto-pattern is not a manual overlay send: mark as code/automatic
                // (sentViaCode=true) so the viewer shows "via code". No game call site.
                BeginSend(shot, title, comment, viaCode: true);
            }
            catch (Exception e)
            {
                FlogLog.Exception(e);
            }
            finally
            {
                _inAutoSendDispatch = false;
            }
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
                SessionId = string.IsNullOrEmpty(_sessionId) ? null : _sessionId,
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

        // ---- Screenshot queue (capture several in code, send them together) ----

        /// <summary>
        /// Capture the current frame now and add it to a queue that rides with the next
        /// user-initiated send. Lets game code take several screenshots before sending.
        /// Fire-and-forget (the grab is end-of-frame async); the FastLogs overlay is not
        /// included in the shot. The queue is capped (oldest dropped) and cleared once a
        /// send that carried it resolves.
        /// </summary>
        public void CaptureScreenshot()
        {
            if (_screenshot == null)
            {
                return;
            }
            FlogTask<byte[]> shotTask = null;
            try { shotTask = _screenshot.CaptureAsync(ScreenshotMaxDimension()); }
            catch (Exception e) { FlogLog.Exception(e); return; }
            if (shotTask == null)
            {
                return;
            }
            try { StartCoroutine(CollectScreenshot(shotTask)); }
            catch (Exception e) { FlogLog.Exception(e); }
        }

        private IEnumerator CollectScreenshot(FlogTask<byte[]> shotTask)
        {
            while (!shotTask.IsCompleted)
            {
                yield return null;
            }
            if (shotTask.IsFaulted || shotTask.Result == null || shotTask.Result.Length == 0)
            {
                yield break;
            }
            string b64;
            try { b64 = Convert.ToBase64String(shotTask.Result); }
            catch (Exception e) { FlogLog.Exception(e); yield break; }

            // Cap the queue: drop the oldest so the most recent shots survive.
            if (_queuedShots.Count >= MaxQueuedScreenshots)
            {
                _queuedShots.RemoveAt(0);
            }
            _queuedShots.Add(b64);
        }

        /// <summary>Drop all queued screenshots without sending them.</summary>
        public void ClearScreenshots()
        {
            _queuedShots.Clear();
        }

        // ---- Scene context + correlation code ----

        public void SetCorrelationCode(string code)
        {
            _correlationCode = string.IsNullOrEmpty(code) ? null : code.Trim();
        }

        /// <summary>Capture the scene hierarchy now and queue it for the next send.</summary>
        public void CaptureSceneContext(bool allowRepeat)
        {
            // Loop guard: if a snapshot is already queued, don't recapture unless asked.
            if (!allowRepeat && !string.IsNullOrEmpty(_queuedSceneContext))
            {
                return;
            }
            CaptureSceneContextNow();
        }

        /// <summary>Capture the scene context and send a report immediately (capture + Send).</summary>
        public void SendSceneContext(bool allowRepeat, bool viaCode = false, CallSite site = default)
        {
            // Loop guard: send once per session unless allowRepeat is passed.
            if (!allowRepeat && _sceneContextSentOnce)
            {
                ShowToast(ToastKind.Info, "FastLogs: scene context already sent (allowRepeat to resend)", null, 3f, false);
                return;
            }
            CaptureSceneContextNow();
            _sceneContextSentOnce = true;
            ForgetPendingCrashOwnership();
            BeginSend(false, null, null, attachQueuedShots: true, viaCode: viaCode, site: site);
        }

        private void CaptureSceneContextNow()
        {
            try
            {
                _queuedSceneContext = SceneContextCapturer.Capture(_config != null ? _config.SceneContext : null);
            }
            catch (Exception e) { FlogLog.Exception(e); }
        }

        /// <summary>Drop the queued scene context without sending it.</summary>
        public void ClearSceneContext()
        {
            _queuedSceneContext = null;
        }

        // ============================================================
        // File / folder upload (feature: SendFile / SendFolder / SendFiles)
        // ============================================================
        // A separate endpoint (POST /api/files) from the log report send, so these run
        // independently of _isBusy / the retry loop and have their own toasts. The blob
        // is NEVER PII-scrubbed (explicit invariant) - only the decoded-size cap applies.
        // Path-based entries read the file system, which is unavailable on WebGL; there
        // they fail with a clear message (game code should use the byte[] overload).

        /// <summary>
        /// Upload a single file by path. Reads the bytes, then uploads them. On WebGL the
        /// file system is unavailable, so this fails cleanly (use the byte[] overload).
        /// </summary>
        public FlogTask<FileUploadResultDto> BeginSendFilePath(string path, string title)
        {
#if UNITY_WEBGL && !UNITY_EDITOR
            return FlogTask.FromResult(FileUploadResultDto.Fail(
                "File path access unavailable on WebGL; use the byte[] overload (SendFileAsync(byte[], fileName, ...))."));
#else
            if (string.IsNullOrEmpty(path))
            {
                return FlogTask.FromResult(FileUploadResultDto.Fail("SendFile: empty path."));
            }

            byte[] bytes;
            string fileName;
            try
            {
                if (!System.IO.File.Exists(path))
                {
                    return FlogTask.FromResult(FileUploadResultDto.Fail("SendFile: file does not exist: " + path));
                }
                bytes = System.IO.File.ReadAllBytes(path);
                fileName = System.IO.Path.GetFileName(path);
            }
            catch (Exception e)
            {
                FlogLog.Exception(e);
                return FlogTask.FromResult(FileUploadResultDto.Fail("SendFile: failed to read file: " + e.Message));
            }

            return BeginSendBytes(bytes, fileName, GuessMime(fileName), title, "file", null, null);
#endif
        }

        /// <summary>Upload a file from in-memory bytes. Works on every platform (incl. WebGL).</summary>
        public FlogTask<FileUploadResultDto> BeginSendFileBytes(byte[] bytes, string fileName, string title)
        {
            if (bytes == null)
            {
                return FlogTask.FromResult(FileUploadResultDto.Fail("SendFile: null bytes."));
            }
            string name = string.IsNullOrEmpty(fileName) ? "file.bin" : fileName;
            return BeginSendBytes(bytes, name, GuessMime(name), title, "file", null, null);
        }

        /// <summary>
        /// Zip a folder on the client and upload the single archive. WebGL has no file
        /// system, so this fails cleanly.
        /// </summary>
        public FlogTask<FileUploadResultDto> BeginSendFolder(string path, string title)
        {
#if UNITY_WEBGL && !UNITY_EDITOR
            return FlogTask.FromResult(FileUploadResultDto.Fail(
                "File path access unavailable on WebGL; use the byte[] overload (SendFileAsync(byte[], fileName, ...))."));
#else
            if (string.IsNullOrEmpty(path))
            {
                return FlogTask.FromResult(FileUploadResultDto.Fail("SendFolder: empty path."));
            }

            byte[] zip;
            try
            {
                zip = FolderZipUtil.ZipFolder(path);
            }
            catch (Exception e)
            {
                FlogLog.Exception(e);
                return FlogTask.FromResult(FileUploadResultDto.Fail("SendFolder: zipping failed: " + e.Message));
            }
            if (zip == null)
            {
                return FlogTask.FromResult(FileUploadResultDto.Fail("SendFolder: nothing to send (missing/empty folder or zip failed)."));
            }

            string name = FolderArchiveName(path);
            return BeginSendBytes(zip, name, "application/zip", title, "folder", null, null);
#endif
        }

        /// <summary>Zip several files on the client and upload the single archive. WebGL fails cleanly.</summary>
        public FlogTask<FileUploadResultDto> BeginSendFiles(IReadOnlyList<string> paths, string title)
        {
#if UNITY_WEBGL && !UNITY_EDITOR
            return FlogTask.FromResult(FileUploadResultDto.Fail(
                "File path access unavailable on WebGL; use the byte[] overload (SendFileAsync(byte[], fileName, ...))."));
#else
            if (paths == null || paths.Count == 0)
            {
                return FlogTask.FromResult(FileUploadResultDto.Fail("SendFiles: no paths."));
            }

            byte[] zip;
            try
            {
                zip = FolderZipUtil.ZipFiles(paths);
            }
            catch (Exception e)
            {
                FlogLog.Exception(e);
                return FlogTask.FromResult(FileUploadResultDto.Fail("SendFiles: zipping failed: " + e.Message));
            }
            if (zip == null)
            {
                return FlogTask.FromResult(FileUploadResultDto.Fail("SendFiles: nothing to send (no readable files or zip failed)."));
            }

            return BeginSendBytes(zip, "files.zip", "application/zip", title, "folder", null, null);
#endif
        }

        /// <summary>
        /// Queue a file/folder path to be uploaded as an attachment of the NEXT successful
        /// report send (linked by logId). Capped (oldest dropped). A folder is zipped at
        /// upload time. No-op on WebGL (no file system) and for empty paths.
        /// </summary>
        public void AttachFile(string path)
        {
            if (string.IsNullOrEmpty(path))
            {
                return;
            }
#if UNITY_WEBGL && !UNITY_EDITOR
            FlogLog.Warn("AttachFile is unavailable on WebGL (no file system); ignored.");
            return;
#else
            if (_queuedAttachments.Count >= MaxQueuedAttachments)
            {
                _queuedAttachments.RemoveAt(0);
            }
            _queuedAttachments.Add(path);
#endif
        }

        /// <summary>Drop all queued attachments without sending them.</summary>
        public void ClearAttachments()
        {
            _queuedAttachments.Clear();
        }

        /// <summary>
        /// WebGL only (feature #7): open the browser file dialog, then upload the chosen
        /// file via the byte[] path (SendFileAsync(bytes, fileName)), returning an awaitable
        /// result. Must be called from a user-gesture handler so the browser allows the
        /// dialog. On non-WebGL platforms this resolves immediately with a "not supported"
        /// failure (use SendFileAsync(byte[], fileName) or a native picker there). Never throws.
        /// </summary>
        public FlogTask<FileUploadResultDto> WebPickAndSendFile(string title)
        {
#if UNITY_WEBGL && !UNITY_EDITOR
            try
            {
                if (_webFilePicker == null)
                {
                    // The send sink reuses the existing byte[] file-upload path, so the
                    // picked file goes through the very same /api/files pipeline.
                    _webFilePicker = WebFilePicker.Create((bytes, fileName) => BeginSendFileBytes(bytes, fileName, title));
                }
                return _webFilePicker.Pick(title);
            }
            catch (Exception e)
            {
                FlogLog.Exception(e);
                return FlogTask.FromResult(FileUploadResultDto.Fail("FastLogs: failed to open the file picker: " + e.Message));
            }
#else
            // Off WebGL there is no browser file dialog, so do NOT create a persistent
            // DontDestroyOnLoad host that could only ever fail; resolve with the same
            // "not supported" failure WebFilePicker.Pick would return.
            return FlogTask.FromResult(FileUploadResultDto.Fail(
                "FastLogs: WebPickAndSendFile is only supported on WebGL. Use SendFileAsync(byte[], fileName) on other platforms."));
#endif
        }

        // Core file-upload entry: validates the uploader, the decoded-size cap (AFTER any
        // zip, so it bounds the actual payload) and starts the upload coroutine. Never
        // throws; the returned task always resolves.
        private FlogTask<FileUploadResultDto> BeginSendBytes(byte[] bytes, string fileName, string mime, string title, string kind, string logId, string groupId)
        {
            var task = FlogTask.Create<FileUploadResultDto>();

            if (_fileUploader == null)
            {
                ShowToast(ToastKind.Error, "FastLogs: no file uploader configured", null, 4f, false);
                task.SetResult(FileUploadResultDto.Fail("No file uploader is configured."));
                return task;
            }

            // Decoded-size cap, enforced on the client (the server caps too). Checked here,
            // after any folder zip, so it bounds the real bytes about to be base64'd/sent.
            int cap = _config != null && _config.Files != null ? _config.Files.MaxFileBytes : (25 * 1024 * 1024);
            if (cap > 0 && bytes != null && bytes.Length > cap)
            {
                string msg = "FastLogs: file too large (" + (bytes.Length / 1024) + " KB > "
                    + (cap / 1024) + " KB cap)";
                ShowToast(ToastKind.Error, msg, null, 5f, false);
                task.SetResult(FileUploadResultDto.Fail(msg, 413));
                return task;
            }

            var req = new FileUploadRequest
            {
                Bytes = bytes,
                FileName = string.IsNullOrEmpty(fileName) ? "file.bin" : fileName,
                Mime = mime,
                Title = string.IsNullOrEmpty(title) ? null : Truncate(title, 120),
                Kind = kind,
                LogId = logId,
                GroupId = groupId
            };

            ShowToast(ToastKind.Progress, "FastLogs: uploading " + req.FileName + "...", null, 0f, false);

            try
            {
                StartCoroutine(SendFileRoutine(req, task));
            }
            catch (Exception e)
            {
                FlogLog.Exception(e);
                var fail = FileUploadResultDto.Fail("Failed to start file upload: " + e.Message);
                ShowToast(ToastKind.Error, "FastLogs: " + fail.Error, null, 0f, false);
                task.SetResult(fail);
            }

            return task;
        }

        private IEnumerator SendFileRoutine(FileUploadRequest req, FlogTask<FileUploadResultDto> task)
        {
            FlogTask<FileUploadResultDto> uploadTask = null;
            try { uploadTask = _fileUploader.UploadFileAsync(req, _config); }
            catch (Exception e)
            {
                FlogLog.Exception(e);
                CompleteFile(task, FileUploadResultDto.Fail("File upload threw: " + e.Message));
                yield break;
            }

            if (uploadTask == null)
            {
                CompleteFile(task, FileUploadResultDto.Fail("File uploader returned no task."));
                yield break;
            }

            while (!uploadTask.IsCompleted)
            {
                yield return null;
            }

            FileUploadResultDto result = uploadTask.IsFaulted
                ? FileUploadResultDto.Fail("File upload faulted: " + (uploadTask.Exception != null ? uploadTask.Exception.Message : "unknown"))
                : uploadTask.Result;

            CompleteFile(task, result);
        }

        private void CompleteFile(FlogTask<FileUploadResultDto> task, FileUploadResultDto result)
        {
            if (result.Success)
            {
                // Best-effort copy of the download/viewer link, mirroring the log send.
                TryCopyFileLinkOnSend(result);

                bool copied = _config != null && _config.UI.CopyLinkOnSend && !string.IsNullOrEmpty(result.Url);
                ShowToast(ToastKind.Success, "FastLogs: file sent" + (copied ? " (link copied)" : ""), result.Url, 6f, false);
            }
            else
            {
                ShowToast(ToastKind.Error, "FastLogs file error: " + result.Error, null, 0f, false);
            }

            task.SetResult(result);
        }

        private void TryCopyFileLinkOnSend(FileUploadResultDto result)
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

        // Upload all queued attachments (AttachFile) as attachments of the just-sent report
        // (logId). Files are read/zipped and sent one at a time via the file uploader, then
        // the queue is cleared. Best-effort: a failed attachment is logged and skipped.
        private void UploadQueuedAttachments(string logId)
        {
            if (_fileUploader == null || string.IsNullOrEmpty(logId))
            {
                return;
            }
            if (_queuedAttachments.Count == 0 && _queuedBlobAttachments.Count == 0)
            {
                return;
            }
            // Snapshot + clear up front so a re-entrant send does not double-upload.
            var paths = new List<string>(_queuedAttachments);
            _queuedAttachments.Clear();
            var blobs = new List<BlobAttachment>(_queuedBlobAttachments);
            _queuedBlobAttachments.Clear();
            try { StartCoroutine(UploadAttachmentsRoutine(paths, blobs, logId)); }
            catch (Exception e) { FlogLog.Exception(e); }
        }

        private IEnumerator UploadAttachmentsRoutine(List<string> paths, List<BlobAttachment> blobs, string logId)
        {
            for (int i = 0; i < paths.Count; i++)
            {
                string path = paths[i];
                if (string.IsNullOrEmpty(path))
                {
                    continue;
                }

                byte[] bytes = null;
                string fileName = null;
                string mime = null;
                try
                {
                    if (System.IO.Directory.Exists(path))
                    {
                        bytes = FolderZipUtil.ZipFolder(path);
                        fileName = FolderArchiveName(path);
                        mime = "application/zip";
                    }
                    else if (System.IO.File.Exists(path))
                    {
                        bytes = System.IO.File.ReadAllBytes(path);
                        fileName = System.IO.Path.GetFileName(path);
                        mime = GuessMime(fileName);
                    }
                    else
                    {
                        FlogLog.Warn("AttachFile: path no longer exists, skipped: " + path);
                    }
                }
                catch (Exception e) { FlogLog.Exception(e); }

                if (bytes == null)
                {
                    continue;
                }

                // Same decoded-size cap as a direct send.
                int cap = _config != null && _config.Files != null ? _config.Files.MaxFileBytes : (25 * 1024 * 1024);
                if (cap > 0 && bytes.Length > cap)
                {
                    FlogLog.Warn("AttachFile: " + fileName + " exceeds the size cap, skipped.");
                    continue;
                }

                // "other" is a server-valid kind (VALID_KINDS); the attachment is linked to
                // the report via LogId, which is what the viewer renders it under.
                var req = new FileUploadRequest
                {
                    Bytes = bytes,
                    FileName = string.IsNullOrEmpty(fileName) ? "attachment.bin" : fileName,
                    Mime = mime,
                    Kind = "other",
                    LogId = logId
                };

                FlogTask<FileUploadResultDto> upload = null;
                try { upload = _fileUploader.UploadFileAsync(req, _config); }
                catch (Exception e) { FlogLog.Exception(e); }

                if (upload == null)
                {
                    continue;
                }
                while (!upload.IsCompleted)
                {
                    yield return null;
                }
                if (upload.IsFaulted || !upload.Result.Success)
                {
                    FlogLog.Warn("AttachFile: upload of " + req.FileName + " failed.");
                }
            }

            // In-memory blob attachments (e.g. snapshot.zip) uploaded with their own kind,
            // linked to the same report via LogId. Bytes are already built; just enforce the
            // size cap and upload one at a time (best-effort, like the path loop above).
            for (int i = 0; blobs != null && i < blobs.Count; i++)
            {
                BlobAttachment blob = blobs[i];
                if (blob.Bytes == null || blob.Bytes.Length == 0)
                {
                    continue;
                }

                int cap = _config != null && _config.Files != null ? _config.Files.MaxFileBytes : (25 * 1024 * 1024);
                if (cap > 0 && blob.Bytes.Length > cap)
                {
                    FlogLog.Warn("Snapshot attachment " + blob.FileName + " exceeds the file size cap, skipped.");
                    continue;
                }

                var blobReq = new FileUploadRequest
                {
                    Bytes = blob.Bytes,
                    FileName = string.IsNullOrEmpty(blob.FileName) ? "attachment.bin" : blob.FileName,
                    Mime = string.IsNullOrEmpty(blob.Mime) ? "application/octet-stream" : blob.Mime,
                    Kind = string.IsNullOrEmpty(blob.Kind) ? "other" : blob.Kind,
                    LogId = logId
                };

                FlogTask<FileUploadResultDto> blobUpload = null;
                try { blobUpload = _fileUploader.UploadFileAsync(blobReq, _config); }
                catch (Exception e) { FlogLog.Exception(e); }

                if (blobUpload == null)
                {
                    continue;
                }
                while (!blobUpload.IsCompleted)
                {
                    yield return null;
                }
                if (blobUpload.IsFaulted || !blobUpload.Result.Success)
                {
                    FlogLog.Warn("Snapshot attachment upload of " + blobReq.FileName + " failed.");
                }
            }
        }

        // Archive name for a folder upload: "<folderName>.zip" (or "folder.zip" as a fallback).
        private static string FolderArchiveName(string folderPath)
        {
            try
            {
                string trimmed = folderPath.TrimEnd('/', '\\');
                string leaf = System.IO.Path.GetFileName(trimmed);
                return string.IsNullOrEmpty(leaf) ? "folder.zip" : (leaf + ".zip");
            }
            catch
            {
                return "folder.zip";
            }
        }

        // Cheap MIME guess from a file extension; defaults to octet-stream. Not exhaustive
        // by design (the server stores the blob opaquely) - just enough for common cases.
        private static string GuessMime(string fileName)
        {
            if (string.IsNullOrEmpty(fileName))
            {
                return "application/octet-stream";
            }
            string ext;
            try { ext = System.IO.Path.GetExtension(fileName); }
            catch { ext = null; }
            if (string.IsNullOrEmpty(ext))
            {
                return "application/octet-stream";
            }
            switch (ext.ToLowerInvariant())
            {
                case ".txt": case ".log": return "text/plain";
                case ".json": return "application/json";
                case ".xml": return "application/xml";
                case ".csv": return "text/csv";
                case ".png": return "image/png";
                case ".jpg": case ".jpeg": return "image/jpeg";
                case ".zip": return "application/zip";
                case ".gz": return "application/gzip";
                case ".pdf": return "application/pdf";
                default: return "application/octet-stream";
            }
        }

        // ============================================================
        // Snapshot (full game snapshot: report + snapshot.zip on the SAME record)
        // ============================================================
        // SendSnapshot orchestrates two EXISTING pieces, reimplementing neither:
        //   1) the normal report send (BeginSend -> SendRoutine -> BuildReport): logs +
        //      context + breadcrumbs + device + optional screenshot + scene context. This is
        //      the readable record body, sent UNCHANGED;
        //   2) snapshot.zip - ONLY the saves/registered data - built in memory via the
        //      existing FolderZipUtil and queued as an in-memory attachment (kind="snapshot")
        //      that UploadQueuedAttachments uploads with logId = the report's id.
        // The zip never contains the FastLogs logs (they are already the report body) nor the
        // FastLogs data dir (recorder store / pending outbox), which is excluded by default.

        /// <summary>Register an extra file/folder path to include in snapshot.zip. Idempotent on the same path.</summary>
        public void AddSnapshotSource(string path)
        {
            if (string.IsNullOrEmpty(path))
            {
                return;
            }
#if UNITY_WEBGL && !UNITY_EDITOR
            FlogLog.Warn("AddSnapshotSource is unavailable on WebGL (no file system); ignored. Use AddSnapshotData(name, bytes).");
            return;
#else
            for (int i = 0; i < _snapshotSources.Count; i++)
            {
                if (string.Equals(_snapshotSources[i], path, StringComparison.OrdinalIgnoreCase))
                {
                    return; // already registered
                }
            }
            _snapshotSources.Add(path);
#endif
        }

        /// <summary>Register an in-memory data entry (name -> bytes) to include in snapshot.zip. Re-registering a name replaces it.</summary>
        public void AddSnapshotData(string name, byte[] data)
        {
            if (string.IsNullOrEmpty(name) || data == null)
            {
                return;
            }
            byte[] copy = data; // captured by value; provider returns the same reference
            _snapshotData[name] = () => copy;
        }

        /// <summary>Register an in-memory data entry produced lazily at send time. Re-registering a name replaces it.</summary>
        public void AddSnapshotData(string name, Func<byte[]> provider)
        {
            if (string.IsNullOrEmpty(name) || provider == null)
            {
                return;
            }
            _snapshotData[name] = provider;
        }

        /// <summary>Unregister a path previously added with AddSnapshotSource.</summary>
        public void RemoveSnapshotSource(string path)
        {
            if (string.IsNullOrEmpty(path))
            {
                return;
            }
            for (int i = _snapshotSources.Count - 1; i >= 0; i--)
            {
                if (string.Equals(_snapshotSources[i], path, StringComparison.OrdinalIgnoreCase))
                {
                    _snapshotSources.RemoveAt(i);
                }
            }
        }

        /// <summary>Drop all registered snapshot sources and data (the default persistentDataPath source still applies per config).</summary>
        public void ClearSnapshotSources()
        {
            _snapshotSources.Clear();
            _snapshotData.Clear();
        }

        // FastLogs.SendSnapshot() entry. Guards the call site (like SendAsync), then builds
        // snapshot.zip + sends the report. On a deferred (UI-confirm) loop-guard hit the build
        // is postponed to the confirm answer (no zip work / no queued blob unless confirmed).
        public FlogTask<UploadResultDto> BeginSendSnapshotFromCode(string title, bool includeScreenshot, CallSite site)
        {
            var task = FlogTask.Create<UploadResultDto>();
            switch (EvaluateLoopGuard(site, PendingLoopConfirm.Snapshot(site, title, includeScreenshot, task)))
            {
                case LoopGuardDecision.Proceed:
                    // A fresh, code-initiated report: detach from any pending crash file.
                    ForgetPendingCrashOwnership();
                    StartSnapshotSend(title, includeScreenshot, site, task);
                    return task;
                case LoopGuardDecision.Dropped:
                    task.SetResult(LoopDeclinedResult(site.Key));
                    return task;
                case LoopGuardDecision.Deferred:
                    // Confirm shown: task stays pending, resolved later by OnLoopConfirmAnswered
                    // (which calls StartSnapshotSend on "Send", or declines on "Cancel").
                    return task;
                default:
                    task.SetResult(_lastResult);
                    return task;
            }
        }

        // Start the snapshot pipeline: build the zip + queue it, then send the report. Drives
        // SendSnapshotRoutine, which forwards the report result onto the caller's task. Never
        // throws; failures resolve the task.
        private void StartSnapshotSend(string title, bool includeScreenshot, CallSite site, FlogTask<UploadResultDto> task)
        {
            // Block while a send is in flight or a retry is pending, mirroring BeginSend's
            // guard (the report send underneath would refuse anyway; we stop before zipping).
            // _snapshotInFlight additionally rejects a SECOND snapshot started in the same frame
            // as the first (before the first reaches BeginSend / sets _isBusy), which would
            // otherwise double-attach snapshot.zip onto one report.
            if (_isBusy || _retryCoroutine != null || _snapshotInFlight)
            {
                ShowToast(ToastKind.Info,
                    _retryCoroutine != null
                        ? "FastLogs: waiting to retry the current send"
                        : "FastLogs: a send is already in progress",
                    null, 2.5f, false);
                task.SetResult(_lastResult);
                return;
            }

            try
            {
                // Set synchronously, before the coroutine yields, so a same-frame second call is
                // rejected by the guard above. Cleared when SendSnapshotRoutine resolves the task.
                _snapshotInFlight = true;
                StartCoroutine(SendSnapshotRoutine(title, includeScreenshot, site, task));
            }
            catch (Exception e)
            {
                _snapshotInFlight = false;
                FlogLog.Exception(e);
                var fail = UploadResultDto.Fail("Failed to start snapshot send: " + e.Message);
                ShowToast(ToastKind.Error, "FastLogs: " + fail.Error, null, 0f, false);
                task.SetResult(fail);
            }
        }

        // The snapshot coroutine: (1) capture scene context for the REPORT (queued like the
        // overlay does), (2) build snapshot.zip in memory from the default + registered sources,
        // (3) queue it as a kind="snapshot" attachment, (4) send the report via the existing
        // BeginSend path and forward its result to the caller. The attachment uploads after the
        // report succeeds (UploadQueuedAttachments, logId = result.Id). The report still sends
        // even when the zip is empty/over-cap (the readable record is the primary value).
        private IEnumerator SendSnapshotRoutine(string title, bool includeScreenshot, CallSite site, FlogTask<UploadResultDto> task)
        {
            // Scene context rides the REPORT (allowRepeat so a fresh hierarchy is captured each
            // snapshot). Mirrors the overlay's "arm scene context, then send" flow.
            CaptureSceneContext(true);

            // Show progress immediately; the zip build below can take a frame for big saves.
            ShowToast(ToastKind.Progress, "FastLogs: building snapshot...", null, 0f, false);
            yield return null; // let the toast paint before the (synchronous) zip work

            // Build snapshot.zip in memory. Never throws; null/empty means "nothing to bundle".
            byte[] zip = null;
            try { zip = BuildSnapshotZip(); }
            catch (Exception e) { FlogLog.Exception(e); }

            if (zip != null && zip.Length > 0)
            {
                // Enforce MaxSnapshotBytes AFTER zipping (it bounds the real payload). 0 = no cap.
                long cap = _config != null && _config.Snapshot != null ? _config.Snapshot.MaxSnapshotBytes : (25L * 1024 * 1024);
                // The file/server upload cap is the HARD upper bound: a blob above Files.MaxFileBytes
                // is skipped by UploadQueuedAttachments (Warn only) and would 413 server-side, so a
                // zip between the two caps would "pass" here yet silently vanish at upload under a
                // success toast. Clamp the snapshot cap down to the file cap so the "too large"
                // branch below fires honestly instead.
                long fileCap = _config != null && _config.Files != null ? _config.Files.MaxFileBytes : 0;
                if (fileCap > 0 && (cap <= 0 || cap > fileCap)) cap = fileCap;
                if (cap > 0 && zip.Length > cap)
                {
                    FlogLog.Warn("Snapshot: snapshot.zip (" + (zip.Length / 1024) + " KB) exceeds MaxSnapshotBytes ("
                        + (cap / 1024) + " KB); the report is still sent without it.");
                    ShowToast(ToastKind.Info, "FastLogs: snapshot too large, sending report only", null, 4f, false);
                }
                else
                {
                    // Queue snapshot.zip as an in-memory attachment of the report being sent
                    // next; UploadQueuedAttachments uploads it with logId = result.Id.
                    _queuedBlobAttachments.Add(new BlobAttachment
                    {
                        Bytes = zip,
                        FileName = "snapshot.zip",
                        Mime = "application/zip",
                        Kind = "snapshot"
                    });
                }
            }
            else
            {
                FlogLog.Info("Snapshot: no saves/data to bundle; sending the report only.");
            }

            // Send the report through the EXISTING path (attachQueuedShots true so the live/
            // queued screenshots + scene context ride along; viaCode preserves the badge).
            FlogTask<UploadResultDto> inner = BeginSend(includeScreenshot, title, null, attachQueuedShots: true, viaCode: true, site: site);

            if (inner == null)
            {
                // Could not start (e.g. no uploader): drop the queued blob so it does not ride
                // an unrelated later send, and resolve with the last known result.
                _queuedBlobAttachments.Clear();
                _snapshotInFlight = false;
                task.SetResult(_lastResult);
                yield break;
            }

            while (!inner.IsCompleted)
            {
                yield return null;
            }

            UploadResultDto result;
            try { result = inner.Result; }
            catch (Exception e)
            {
                FlogLog.Exception(e);
                result = UploadResultDto.Fail("Snapshot send faulted: " + e.Message);
            }
            _snapshotInFlight = false;
            task.SetResult(result);
        }

        // Build snapshot.zip in memory from: the default source (the WHOLE persistentDataPath
        // minus Snapshot.ExcludePaths, when IncludePersistentDataPath) + registered source
        // paths (files/folders) + registered in-memory data. Returns the zip bytes, or null
        // when there is nothing to bundle. Never throws.
        //
        // Reuse note: the existing FolderZipUtil exposes only ZipFolder(root) (single tree,
        // no excludes) and ZipFiles(paths) (flat names). To compose multiple roots WITH
        // exclusions AND in-memory data into one tree-preserving archive without duplicating
        // the zip mechanics (and without editing the Net assembly), we STAGE the selected
        // content into one temp directory under Application.temporaryCachePath - never inside
        // persistentDataPath - and call FolderZipUtil.ZipFolder once on it, then delete the
        // staging dir. This keeps all zip mechanics in the shared util. (A future composing
        // overload on FolderZipUtil would let this stream straight from the sources.)
        private byte[] BuildSnapshotZip()
        {
            // Staging-then-zip uses the file system. On WebGL the player has no real writable
            // disk for Directory/File ops the way desktop/mobile do; persistentDataPath is
            // IDBFS and temporaryCachePath staging is unreliable, so a snapshot there is
            // effectively a no-op (build returns null and only the report is sent). Snapshots
            // are a dev action and primarily target editor/standalone/mobile dev builds.
            string staging = null;
            try
            {
                string tempRoot;
                try { tempRoot = Application.temporaryCachePath; }
                catch { tempRoot = null; }
                if (string.IsNullOrEmpty(tempRoot))
                {
                    tempRoot = System.IO.Path.GetTempPath();
                }

                staging = System.IO.Path.Combine(tempRoot, "FastLogsSnapshot_" + Guid.NewGuid().ToString("N"));
                System.IO.Directory.CreateDirectory(staging);

                int staged = 0;

                // 1) Default source: the whole persistentDataPath, minus the exclude prefixes
                //    (which always include the FastLogs data dir, seeded at Init).
                if (_config == null || _config.Snapshot == null || _config.Snapshot.IncludePersistentDataPath)
                {
                    string saves = null;
                    try { saves = Application.persistentDataPath; }
                    catch { saves = null; }
                    if (!string.IsNullOrEmpty(saves) && System.IO.Directory.Exists(saves))
                    {
                        staged += StageDirectory(saves, System.IO.Path.Combine(staging, "persistentData"), GetExcludePaths());
                    }
                }

                // 2) Registered extra source paths (files or folders), each under sources/<leaf>.
                var usedSourceNames = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                for (int i = 0; i < _snapshotSources.Count; i++)
                {
                    string src = _snapshotSources[i];
                    if (string.IsNullOrEmpty(src))
                    {
                        continue;
                    }
                    try
                    {
                        if (System.IO.Directory.Exists(src))
                        {
                            string leaf = UniqueStagingName(usedSourceNames, SafeLeafName(src));
                            staged += StageDirectory(src, System.IO.Path.Combine(staging, "sources", leaf), GetExcludePaths());
                        }
                        else if (System.IO.File.Exists(src))
                        {
                            string leaf = UniqueStagingName(usedSourceNames, SafeLeafName(src));
                            string destDir = System.IO.Path.Combine(staging, "sources");
                            System.IO.Directory.CreateDirectory(destDir);
                            System.IO.File.Copy(src, System.IO.Path.Combine(destDir, leaf), true);
                            staged++;
                        }
                        else
                        {
                            FlogLog.Warn("Snapshot source no longer exists, skipped: " + src);
                        }
                    }
                    catch (Exception e) { FlogLog.Exception(e); }
                }

                // 3) Registered in-memory data, written under data/<name> (provider evaluated now).
                if (_snapshotData.Count > 0)
                {
                    string dataDir = System.IO.Path.Combine(staging, "data");
                    var usedDataNames = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                    foreach (var kv in _snapshotData)
                    {
                        byte[] bytes = null;
                        try { bytes = kv.Value != null ? kv.Value() : null; }
                        catch (Exception e) { FlogLog.Exception(e); }
                        if (bytes == null)
                        {
                            continue;
                        }
                        try
                        {
                            System.IO.Directory.CreateDirectory(dataDir);
                            string fileName = UniqueStagingName(usedDataNames, SanitizeEntryName(kv.Key));
                            System.IO.File.WriteAllBytes(System.IO.Path.Combine(dataDir, fileName), bytes);
                            staged++;
                        }
                        catch (Exception e) { FlogLog.Exception(e); }
                    }
                }

                if (staged == 0)
                {
                    return null; // nothing selected -> no snapshot.zip
                }

                // One reuse of the shared zip util on the composed tree.
                return FolderZipUtil.ZipFolder(staging);
            }
            catch (Exception e)
            {
                FlogLog.Exception(e);
                return null;
            }
            finally
            {
                if (!string.IsNullOrEmpty(staging))
                {
                    try
                    {
                        if (System.IO.Directory.Exists(staging))
                        {
                            System.IO.Directory.Delete(staging, true);
                        }
                    }
                    catch (Exception e) { FlogLog.Exception(e); }
                }
            }
        }

        // Copy every file under sourceDir into destDir, preserving the relative tree, skipping
        // any file whose full path starts with one of the exclude prefixes (case-insensitive).
        // Returns the number of files staged. Best-effort: an unreadable file is skipped.
        private static int StageDirectory(string sourceDir, string destDir, string[] excludePrefixes)
        {
            int count = 0;
            string sourceFull;
            try { sourceFull = System.IO.Path.GetFullPath(sourceDir); }
            catch { return 0; }

            string[] files;
            try { files = System.IO.Directory.GetFiles(sourceFull, "*", System.IO.SearchOption.AllDirectories); }
            catch (Exception e) { FlogLog.Exception(e); return 0; }

            string baseDir = sourceFull.EndsWith(System.IO.Path.DirectorySeparatorChar.ToString(), StringComparison.Ordinal)
                ? sourceFull
                : sourceFull + System.IO.Path.DirectorySeparatorChar;

            for (int i = 0; i < files.Length; i++)
            {
                string file = files[i];
                if (IsExcluded(file, excludePrefixes))
                {
                    continue;
                }
                try
                {
                    string rel = file.StartsWith(baseDir, StringComparison.OrdinalIgnoreCase)
                        ? file.Substring(baseDir.Length)
                        : System.IO.Path.GetFileName(file);
                    string dest = System.IO.Path.Combine(destDir, rel);
                    string destParent = System.IO.Path.GetDirectoryName(dest);
                    if (!string.IsNullOrEmpty(destParent))
                    {
                        System.IO.Directory.CreateDirectory(destParent);
                    }
                    System.IO.File.Copy(file, dest, true);
                    count++;
                }
                catch (Exception e) { FlogLog.Exception(e); }
            }
            return count;
        }

        // True when fullPath sits under (or equals) any exclude prefix. Both sides are
        // normalized to full paths so the FastLogs data dir prefix matches its files.
        private static bool IsExcluded(string fullPath, string[] excludePrefixes)
        {
            if (excludePrefixes == null || excludePrefixes.Length == 0)
            {
                return false;
            }
            string norm;
            try { norm = System.IO.Path.GetFullPath(fullPath); }
            catch { norm = fullPath; }

            for (int i = 0; i < excludePrefixes.Length; i++)
            {
                string ex = excludePrefixes[i];
                if (string.IsNullOrEmpty(ex))
                {
                    continue;
                }
                string exNorm;
                try { exNorm = System.IO.Path.GetFullPath(ex); }
                catch { exNorm = ex; }

                if (norm.StartsWith(exNorm, StringComparison.OrdinalIgnoreCase))
                {
                    // Guard against a partial-segment match ("/save" matching "/saves"):
                    // accept only an exact match or a real subpath (next char is a separator).
                    if (norm.Length == exNorm.Length)
                    {
                        return true;
                    }
                    char next = norm[exNorm.Length];
                    char trailing = exNorm.Length > 0 ? exNorm[exNorm.Length - 1] : '\0';
                    if (next == System.IO.Path.DirectorySeparatorChar || next == System.IO.Path.AltDirectorySeparatorChar
                        || trailing == System.IO.Path.DirectorySeparatorChar || trailing == System.IO.Path.AltDirectorySeparatorChar)
                    {
                        return true;
                    }
                }
            }
            return false;
        }

        // The effective exclude prefix list for the default source: the config ExcludePaths
        // (already seeded with the FastLogs data dir at Init). Returns an empty array, never null.
        private string[] GetExcludePaths()
        {
            string[] cfg = _config != null && _config.Snapshot != null ? _config.Snapshot.ExcludePaths : null;
            if (cfg != null && cfg.Length > 0)
            {
                return cfg;
            }
            // Defensive: if the config seed was somehow missed, still exclude our own data dir.
            return string.IsNullOrEmpty(_fastLogsDataDir) ? new string[0] : new[] { _fastLogsDataDir };
        }

        // Resolve FastLogs's own on-disk data dir (Application.persistentDataPath/FastLogs - the
        // same FolderName the LogRecorder store and PendingCrashQueue outbox live under), to be
        // excluded by default. Null when persistentDataPath is unavailable.
        private void ResolveFastLogsDataDir()
        {
            string root = null;
            try { root = Application.persistentDataPath; }
            catch { root = null; }
            _fastLogsDataDir = string.IsNullOrEmpty(root) ? null : System.IO.Path.Combine(root, "FastLogs");
        }

        // Leaf folder/file name of a source path, for the staging subfolder. Falls back to a
        // generic name when the path has no usable leaf.
        private static string SafeLeafName(string path)
        {
            try
            {
                string trimmed = path.TrimEnd('/', '\\');
                string leaf = System.IO.Path.GetFileName(trimmed);
                return string.IsNullOrEmpty(leaf) ? "source" : SanitizeEntryName(leaf);
            }
            catch
            {
                return "source";
            }
        }

        // Replace path separators / invalid file chars in a registered data name so it is a
        // single safe file name inside the staging "data" folder.
        private static string SanitizeEntryName(string name)
        {
            if (string.IsNullOrEmpty(name))
            {
                return "entry";
            }
            var sb = new System.Text.StringBuilder(name.Length);
            char[] invalid = System.IO.Path.GetInvalidFileNameChars();
            for (int i = 0; i < name.Length; i++)
            {
                char c = name[i];
                bool bad = c == '/' || c == '\\';
                if (!bad)
                {
                    for (int j = 0; j < invalid.Length; j++)
                    {
                        if (invalid[j] == c) { bad = true; break; }
                    }
                }
                sb.Append(bad ? '_' : c);
            }
            string result = sb.ToString();
            return string.IsNullOrEmpty(result) ? "entry" : result;
        }

        // Ensure a staging name is unique within its folder ("save", "save (1)", ...).
        private static string UniqueStagingName(HashSet<string> used, string name)
        {
            if (used.Add(name))
            {
                return name;
            }
            string stem;
            string ext;
            int dot = name.LastIndexOf('.');
            if (dot > 0)
            {
                stem = name.Substring(0, dot);
                ext = name.Substring(dot);
            }
            else
            {
                stem = name;
                ext = string.Empty;
            }
            for (int n = 1; n < 10000; n++)
            {
                string candidate = stem + " (" + n + ")" + ext;
                if (used.Add(candidate))
                {
                    return candidate;
                }
            }
            return name;
        }

        // ---- Send pipeline ----

        private void OnOverlaySendRequested(bool includeScreenshot, string title, string comment)
        {
            // A manual overlay send is a fresh, user-initiated report; detach it from any
            // pending crash file so its success cannot delete a leftover crash report.
            ForgetPendingCrashOwnership();
            BeginSend(includeScreenshot, title, comment, attachQueuedShots: true);
        }

        private void OnOverlaySceneContextRequested()
        {
            // Overlay armed scene-context capture: queue a snapshot now (allowRepeat so the
            // toggle always refreshes it); it rides with the send the overlay raises next.
            CaptureSceneContext(true);
        }

        /// <summary>
        /// Kick off a send and return an awaitable result. Never throws; failures
        /// surface through the returned task and OnUploaded.
        /// </summary>
        public FlogTask<UploadResultDto> BeginSend(bool includeScreenshot, string title, string comment, bool attachQueuedShots = false,
            bool viaCode = false, CallSite site = default)
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

            // Remember the parameters so a Retry toast can re-run exactly this send (keeping
            // its code-vs-overlay provenance and call site, so retries do not flip the badge).
            _lastSendIncludeScreenshot = includeScreenshot;
            _lastSendTitle = title;
            _lastSendComment = comment;
            _lastSendAttachQueued = attachQueuedShots;
            _lastSendViaCode = viaCode;
            _lastSendSite = site;

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
                StartCoroutine(SendRoutine(includeScreenshot, title, comment, attachQueuedShots, viaCode, site, task));
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

        private IEnumerator SendRoutine(bool includeScreenshot, string title, string comment, bool attachQueuedShots, bool viaCode, CallSite site, FlogTask<UploadResultDto> task)
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

            // 2) Gather screenshots: the queued ones (CaptureScreenshot) for a
            //    user-initiated send, plus the optional live shot captured above.
            List<string> shots = null;
            bool haveQueued = attachQueuedShots && _queuedShots.Count > 0;
            if (haveQueued || !string.IsNullOrEmpty(screenshotBase64))
            {
                shots = new List<string>(_queuedShots.Count + 1);
                if (haveQueued) shots.AddRange(_queuedShots);
                if (!string.IsNullOrEmpty(screenshotBase64)) shots.Add(screenshotBase64);
            }

            // Scene context (queued via CaptureSceneContext) rides along on a send that
            // attaches the queue, mirroring the screenshot queue.
            string sceneCtx = (attachQueuedShots && !string.IsNullOrEmpty(_queuedSceneContext)) ? _queuedSceneContext : null;
            _lastSendHadSceneContext = sceneCtx != null;

            // 3) Build the report off the current diagnostics + log text.
            LogReportDto report = null;
            try
            {
                report = BuildReport(title, comment, shots, sceneCtx, viaCode, site);
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
                // The queued screenshots rode with this send (if it attached them); they
                // are now delivered, so drop them. Same for the queued scene context.
                if (_lastSendAttachQueued) _queuedShots.Clear();
                if (_lastSendHadSceneContext) _queuedSceneContext = null;

                // Files queued via AttachFile() are uploaded now to /api/files as
                // attachments of this report (logId = result.Id), then the queue clears.
                // Best-effort and out-of-band: it does not affect this send's result.
                if (!string.IsNullOrEmpty(result.Id))
                {
                    UploadQueuedAttachments(result.Id);
                }

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
                string what = _lastSendHadSceneContext ? "logs + context" : "logs";
                string msg = "FastLogs: " + what + " sent" + (copied ? " (link copied)" : "");
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

                // Terminal failure consumes the queued screenshots + scene context too
                // (this send is done; kept only across transient retries, handled above).
                if (_lastSendAttachQueued) _queuedShots.Clear();
                if (_lastSendHadSceneContext) _queuedSceneContext = null;

                // Drop any queued in-memory attachment (e.g. snapshot.zip) too: it was built
                // for THIS report; a terminal failure means it never rode a record, so it must
                // not linger and attach to a later unrelated send. Survives transient retries
                // (only this terminal branch clears it; success clears it in UploadQueuedAttachments).
                _queuedBlobAttachments.Clear();

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
            BeginSend(_lastSendIncludeScreenshot, _lastSendTitle, _lastSendComment, _lastSendAttachQueued,
                _lastSendViaCode, _lastSendSite);
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

        private LogReportDto BuildReport(string title, string comment, List<string> screenshots, string sceneContext = null,
            bool viaCode = false, CallSite site = default)
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
                ScreenshotsPngBase64 = (screenshots != null && screenshots.Count > 0) ? screenshots : null,
                RetentionDays = retention,
                Title = string.IsNullOrEmpty(title) ? null : Truncate(title, 120),
                Comment = string.IsNullOrEmpty(comment) ? null : Truncate(comment, 4000),
                Tester = string.IsNullOrEmpty(tester) ? null : Truncate(tester, 120),
                Context = context,
                Breadcrumbs = breadcrumbs,
                SceneContextJson = string.IsNullOrEmpty(sceneContext) ? null : sceneContext,
                CorrelationCode = string.IsNullOrEmpty(_correlationCode) ? null : Truncate(_correlationCode, 64),
                SessionId = string.IsNullOrEmpty(_sessionId) ? null : _sessionId,

                // Code-send provenance (batch B): true only for sends started from game code
                // (FastLogs.Send*/SendAsync/SendSceneContext); the caller file/line ride along
                // only then (and only when CallerInfo gave us a site), for the viewer badge.
                // Overlay and auto-crash/pattern sends leave SentViaCode false and omit both.
                SentViaCode = viaCode,
                CallerFile = (viaCode && site.HasValue) ? site.File : null,
                CallerLine = (viaCode && site.HasValue) ? site.Line : (int?)null
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
