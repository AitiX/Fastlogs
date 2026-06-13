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

        [Header("Screenshot")]
        [SerializeField] private ScreenshotSection _screenshot = new ScreenshotSection();

        [Header("Diagnostics")]
        [SerializeField] private DiagnosticsSection _diagnostics = new DiagnosticsSection();

        [Header("Trigger")]
        [SerializeField] private TriggerConfig _trigger = new TriggerConfig();

        [Header("Net")]
        [SerializeField] private NetSection _net = new NetSection();

        [Header("UI")]
        [SerializeField] private UiSection _ui = new UiSection();

        [Header("Enable")]
        [SerializeField] private EnableSection _enable = new EnableSection();

        // ---- Public access to sections ----
        public ServerSection Server => _server;
        public CaptureSection Capture => _capture;
        public RecordingSection Recording => _recording;
        public ScreenshotSection Screenshot => _screenshot;
        public DiagnosticsSection Diagnostics => _diagnostics;
        public TriggerConfig Trigger => _trigger;
        public NetSection Net => _net;
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
        public sealed class ScreenshotSection
        {
            [Tooltip("Capture a screenshot with reports by default.")]
            public bool CaptureByDefault = false;

            [Tooltip("Longest screenshot edge in pixels; larger captures are downscaled.")]
            [Min(64)]
            public int MaxDimension = 1280;
        }

        [Serializable]
        public sealed class DiagnosticsSection
        {
            [Tooltip("Include potentially identifying fields (device name, urls, identifiers). Off by default.")]
            public bool IncludeSensitive = false;
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
