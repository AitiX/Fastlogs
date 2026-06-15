// FastLogsConfig - the ScriptableObject that drives all FastLogs behaviour.
//
// IMPORTANT: every default here is NEUTRAL. No endpoints, no app id, no token.
// A consuming project supplies these. Put the asset under any Resources/ folder
// named "FastLogsConfig" (see FastLogsConfigLoader), or pass one to FastLogs.Init.

using System;
using UnityEngine;

namespace PlayJoy.FastLogs
{
    /// <summary>
    /// All-in-one configuration asset for FastLogs. Grouped into Server, Capture,
    /// Recording, Screenshot, Diagnostics, Trigger, Net, UI and Enable sections.
    /// </summary>
    [CreateAssetMenu(fileName = "FastLogsConfig", menuName = "PlayJoy/FastLogs/Config", order = 0)]
    public sealed class FastLogsConfig : ScriptableObject
    {
        [Header("Server")]
        [SerializeField] private ServerSection _server = new ServerSection();

        [Header("Capture")]
        [SerializeField] private CaptureSection _capture = new CaptureSection();

        [Header("Recording")]
        [SerializeField] private RecordingSection _recording = new RecordingSection();

        [Header("Auto-send")]
        [SerializeField] private AutoSendSection _autoSend = new AutoSendSection();

        [Header("Screenshot")]
        [SerializeField] private ScreenshotSection _screenshot = new ScreenshotSection();

        [Header("Scene Context")]
        [SerializeField] private SceneContextSection _sceneContext = new SceneContextSection();

        [Header("Diagnostics")]
        [SerializeField] private DiagnosticsSection _diagnostics = new DiagnosticsSection();

        [Header("Trigger")]
        [SerializeField] private TriggerConfig _trigger = new TriggerConfig();

        [Header("Files")]
        [SerializeField] private FilesSection _files = new FilesSection();

        [Header("Snapshot")]
        [SerializeField] private SnapshotSection _snapshot = new SnapshotSection();

        [Header("Net")]
        [SerializeField] private NetSection _net = new NetSection();

        [Header("Retry")]
        [SerializeField] private RetrySection _retry = new RetrySection();

        [Header("Loop Guard")]
        [SerializeField] private LoopGuardSection _loopGuard = new LoopGuardSection();

        [Header("UI")]
        [SerializeField] private UiSection _ui = new UiSection();

        [Header("Enable")]
        [SerializeField] private EnableSection _enable = new EnableSection();

        // ---- Public access to sections ----
        public ServerSection Server => _server;
        public CaptureSection Capture => _capture;
        public RecordingSection Recording => _recording;
        public AutoSendSection AutoSend => _autoSend;
        public ScreenshotSection Screenshot => _screenshot;
        public SceneContextSection SceneContext => _sceneContext;
        public DiagnosticsSection Diagnostics => _diagnostics;
        public TriggerConfig Trigger => _trigger;
        public FilesSection Files => _files;
        public SnapshotSection Snapshot => _snapshot;
        public NetSection Net => _net;
        public RetrySection Retry => _retry;
        public LoopGuardSection LoopGuard => _loopGuard;
        public UiSection UI => _ui;
        public EnableSection Enable => _enable;

        // ---- Convenience flat accessors used by the gate / hot paths ----
        public bool EnableInEditor => _enable.EnableInEditor;
        public bool EnableInDevelopment => _enable.EnableInDevelopment;
        public bool EnableInRelease => _enable.EnableInRelease;

        /// <summary>Build an in-memory config with all defaults. Used when no asset exists.</summary>
        public static FastLogsConfig CreateDefault()
        {
            return CreateInstance<FastLogsConfig>();
        }

        // ============================================================
        // Sections
        // ============================================================

        [Serializable]
        public sealed class ServerSection
        {
            [Tooltip("Full ingest endpoint URL, e.g. https://logs.example.com/api/logs. Empty by default - set per project.")]
            public string EndpointUrl = string.Empty;

            [Tooltip("appId for the catalog: [a-z0-9_-]{2,32}. Empty by default.")]
            public string AppId = string.Empty;

            [Tooltip("Optional ingest bearer token (per game). Empty by default.")]
            public string Token = string.Empty;

            [Tooltip("Per-request retention override in days. 0 = let the server decide.")]
            [Min(0)]
            public int RetentionDaysOverride = 0;
        }

        [Serializable]
        public sealed class CaptureSection
        {
            [Tooltip("Number of recent log entries kept in the ring buffer.")]
            [Min(1)]
            public int RingCapacity = 1000;

            [Tooltip("Hard cap on serialized log text size in bytes (the server also clamps). 0 = no client cap.")]
            [Min(0)]
            public int MaxLogTextBytes = 1024 * 1024; // 1 MB

            [Tooltip("If SRDebugger is present, read its console instead of installing our own log hook.")]
            public bool UseSrDebuggerConsoleIfPresent = true;
        }

        [Serializable]
        public sealed class RecordingSection
        {
            [Tooltip("Master switch for the recording feature.")]
            public bool Enabled = false;

            [Tooltip("Start recording automatically on Init.")]
            public bool AutoStartRecording = false;

            [Tooltip("Keep the recorded buffer across play sessions (persist to disk).")]
            public bool PersistAcrossSessions = true;

            [Tooltip("Max bytes kept in the persistent store. 0 = unlimited.")]
            [Min(0)]
            public int MaxStoreBytes = 2 * 1024 * 1024; // 2 MB
        }

        [Serializable]
        public sealed class AutoSendSection
        {
            [Tooltip("Automatically build and send a report when an unhandled exception is captured. On by default in dev/editor (the package itself is stripped in retail/console).")]
            public bool AutoSendOnException = true;

            [Tooltip("Minimum seconds between two automatic sends. Repeated/looping exceptions within this window are throttled (not resent).")]
            [Min(0f)]
            public float MinSecondsBetweenAutoSends = 30f;

            [Tooltip("Maximum number of automatic sends allowed per play session. 0 = unlimited.")]
            [Min(0)]
            public int MaxAutoSendsPerSession = 10;

            [Tooltip("Capture a screenshot with auto-sent crash reports. Off by default (a crashed frame is rarely useful and capture costs a frame).")]
            public bool IncludeScreenshot = false;

            [Tooltip("Regex patterns matched against EVERY captured log line (any level, not just exceptions). When a line matches, a report is auto-sent, reusing the same throttle/cap as crash auto-sends (MinSecondsBetweenAutoSends + MaxAutoSendsPerSession), so a chatty match cannot spam the server. Empty by default (no pattern auto-send). Invalid patterns are skipped with a one-time warning. Read ONCE at FastLogs.Init (same as AutoSendOnException); changing it at runtime takes effect only after a re-Init.")]
            public string[] AutoSendPatterns = new string[0];
        }

        [Serializable]
        public sealed class ScreenshotSection
        {
            [Tooltip("Capture a screenshot with reports by default.")]
            public bool CaptureByDefault = false;

            [Tooltip("Longest screenshot edge in pixels; larger captures are downscaled.")]
            [Min(64)]
            public int MaxDimension = 1280;
        }

        [Serializable]
        public sealed class SceneContextSection
        {
            [Tooltip("Max GameObjects captured across all scenes. Capture stops (marked truncated) beyond this.")]
            [Min(1)]
            public int MaxObjects = 5000;

            [Tooltip("Max hierarchy depth to recurse into (a root object is depth 0).")]
            [Min(1)]
            public int MaxDepth = 12;

            [Tooltip("Max components dumped per GameObject.")]
            [Min(1)]
            public int MaxComponentsPerObject = 40;

            [Tooltip("Max fields dumped per component.")]
            [Min(1)]
            public int MaxFieldsPerComponent = 60;

            [Tooltip("Max length of a single formatted field value; longer values are truncated.")]
            [Min(16)]
            public int MaxStringLength = 200;

            [Tooltip("Max elements listed for a collection field; longer collections show count + first N.")]
            [Min(0)]
            public int MaxCollectionElements = 20;

            [Tooltip("Hard cap on the serialized scene-context JSON in bytes. Capture stops (marked truncated) beyond this.")]
            [Min(1024)]
            public int MaxBytes = 1024 * 1024; // 1 MB
        }

        [Serializable]
        public sealed class DiagnosticsSection
        {
            [Tooltip("Include potentially identifying fields (device name, urls, identifiers). Off by default (privacy-by-default).")]
            public bool IncludeSensitive = false;

            [Tooltip("Scrub PII (emails, IPs, bearer tokens, long digit runs) from the log text, context values and breadcrumb messages before upload. ON by default (privacy-by-default). Patterns are extensible via PiiScrubber.AddPattern.")]
            public bool ScrubPii = true;
        }

        [Serializable]
        public sealed class FilesSection
        {
            [Tooltip("Hard cap on the DECODED (pre-base64) size in bytes of a single file/folder upload. Checked on the client AFTER a folder is zipped, before sending; the server enforces its own MAX_FILE_BYTES too. Default 25 MB.")]
            [Min(1)]
            public int MaxFileBytes = 25 * 1024 * 1024; // 25 MB

            [Tooltip("Full files endpoint URL (POST /api/files). Empty by default - derived at runtime from Server.EndpointUrl by replacing '/api/logs' with '/api/files'. Set explicitly only to override that derivation.")]
            public string FilesEndpointUrl = string.Empty;

            [Tooltip("Request timeout in seconds for file uploads (larger than the log timeout: blobs are bigger).")]
            [Min(1)]
            public int TimeoutSeconds = 60;

            /// <summary>
            /// The effective files endpoint: <see cref="FilesEndpointUrl"/> when set,
            /// otherwise derived from the given log-ingest endpoint by replacing the
            /// '/api/logs' segment with '/api/files'. Returns null when neither is usable.
            /// </summary>
            public string ResolvedEndpoint(string serverEndpointUrl)
            {
                if (!string.IsNullOrEmpty(FilesEndpointUrl))
                {
                    return FilesEndpointUrl;
                }
                if (string.IsNullOrEmpty(serverEndpointUrl))
                {
                    return null;
                }
                // Derive from the log endpoint: .../api/logs -> .../api/files. If the log
                // endpoint does not contain that segment, append /api/files to the origin
                // is risky (unknown path), so fall back to a plain suffix swap only when
                // the marker is present; otherwise return null so the caller fails clearly.
                int idx = serverEndpointUrl.LastIndexOf("/api/logs", StringComparison.OrdinalIgnoreCase);
                if (idx < 0)
                {
                    return null;
                }
                return serverEndpointUrl.Substring(0, idx) + "/api/files"
                    + serverEndpointUrl.Substring(idx + "/api/logs".Length);
            }
        }

        [Serializable]
        public sealed class SnapshotSection
        {
            [Tooltip("Include the WHOLE saves folder (Application.persistentDataPath) as the default snapshot source, EXCLUDING FastLogs's own on-disk data dir (see ExcludePaths). On by default so a snapshot works out of the box with no registration. Turn off to ship ONLY the sources registered via FastLogs.AddSnapshotSource / AddSnapshotData.")]
            public bool IncludePersistentDataPath = true;

            [Tooltip("Absolute paths (files or folders) excluded from the default persistentDataPath source. FastLogs's own data dir (persistentDataPath/FastLogs - the recorder store + pending crash outbox) is ALWAYS excluded automatically at Init so a snapshot never re-bundles our own logs/recordings (no recursion/dupe); add more here to skip extra subfolders. Matched as a path prefix, case-insensitively.")]
            public string[] ExcludePaths = new string[0];

            [Tooltip("Hard cap on the DECODED size in bytes of the built snapshot.zip, enforced on the client AFTER zipping (the server caps too). Default = the Files.MaxFileBytes cap (25 MB). 0 = no client cap.")]
            [Min(0)]
            public long MaxSnapshotBytes = 25L * 1024 * 1024; // 25 MB - mirrors FilesSection.MaxFileBytes

            // Absolute path of FastLogs's own on-disk data dir, seeded into ExcludePaths
            // once at Init (it depends on Application.persistentDataPath, a runtime value, so
            // it cannot be a serialized constant). Idempotent: calling twice does not duplicate.
            // Keeps the default "whole persistentDataPath" source from ever including the
            // recorder store / pending crash outbox (which already are the report body).
            public void EnsureDataDirExcluded(string fastLogsDataDir)
            {
                if (string.IsNullOrEmpty(fastLogsDataDir))
                {
                    return;
                }
                if (ExcludePaths == null)
                {
                    ExcludePaths = new string[0];
                }
                for (int i = 0; i < ExcludePaths.Length; i++)
                {
                    if (string.Equals(ExcludePaths[i], fastLogsDataDir, StringComparison.OrdinalIgnoreCase))
                    {
                        return; // already present
                    }
                }
                var grown = new string[ExcludePaths.Length + 1];
                Array.Copy(ExcludePaths, grown, ExcludePaths.Length);
                grown[ExcludePaths.Length] = fastLogsDataDir;
                ExcludePaths = grown;
            }
        }

        [Serializable]
        public sealed class NetSection
        {
            [Tooltip("Request timeout in seconds.")]
            [Min(1)]
            public int TimeoutSeconds = 20;

            [Tooltip("Number of retry attempts after the first failure.")]
            [Min(0)]
            public int MaxRetries = 2;

            [Tooltip("Gzip the whole request body. Ignored on WebGL (always plain to avoid CORS preflight).")]
            public bool GzipBody = true;
        }

        [Serializable]
        public sealed class RetrySection
        {
            [Tooltip("Seconds to wait before re-attempting a report that failed all immediate uploader retries. This outer loop keeps retrying the SAME report until it finally succeeds (or the attempt cap is hit). 0 = the outer retry loop is disabled (a failed send just shows the error toast with a manual Retry).")]
            [Min(0f)]
            public float RetryIntervalSeconds = 30f;

            [Tooltip("Maximum number of outer retry attempts after the first failure. 0 = unlimited (keep retrying as long as the app is alive). Only one pending retry exists at a time; pressing Send again replaces it.")]
            [Min(0)]
            public int MaxRetryAttempts = 0;
        }

        [Serializable]
        public sealed class LoopGuardSection
        {
            [Tooltip("Catch a single CODE call site (FastLogs.Send/SendAsync/SendSceneContext) that keeps sending and ask the user to confirm before it floods the server. Does not apply to the manual overlay Send or auto-crash sends (those have their own gating). When off, the guard is a no-op (always send).")]
            public bool Enabled = true;

            [Tooltip("Cumulative code-sends allowed per call site per session before that site is considered a possible loop. The next send over this count triggers the confirm dialog (UI available) or is dropped (no UI).")]
            [Min(1)]
            public int MaxCodeSendsPerSite = 10;

            [Tooltip("With no UI to confirm, over-threshold sends are dropped silently; every Nth drop from a site logs one warning so the loop is visible without flooding. Set per how chatty you want the warning.")]
            [Min(1)]
            public int NoUiWarnEvery = 10;
        }

        [Serializable]
        public sealed class UiSection
        {
            [Tooltip("Enable the in-game overlay UI.")]
            public bool EnableUI = true;

            [Tooltip("Tester name attached to every report's 'tester' field. Empty by default.")]
            public string TesterName = string.Empty;

            [Tooltip("After a successful send, automatically copy the short link to the device clipboard. On by default. On WebGL this may be blocked outside a user gesture; the overlay's Copy button remains as a fallback.")]
            public bool CopyLinkOnSend = true;
        }

        [Serializable]
        public sealed class EnableSection
        {
            [Tooltip("Enable FastLogs in the Editor.")]
            public bool EnableInEditor = true;

            [Tooltip("Enable FastLogs in Development builds.")]
            public bool EnableInDevelopment = true;

            [Tooltip("Enable in release/player builds (only effective if LOGSHARE_FORCE_ENABLED is also defined and target is not a console).")]
            public bool EnableInRelease = false;
        }
    }
}
