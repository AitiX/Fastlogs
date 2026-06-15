// FastLogsConfigEditor - custom Inspector for FastLogsConfig.
// Shows contextual warnings (empty endpoint, iOS+http), and provides
// quick-action buttons (Ping config, Open README, add LOGSHARE_FORCE_ENABLED).

using UnityEditor;
using UnityEngine;

namespace PlayJoy.FastLogs.Editor
{
    [CustomEditor(typeof(FastLogsConfig))]
    internal sealed class FastLogsConfigEditor : UnityEditor.Editor
    {
        // Foldout state (per-Editor instance, not persisted).
        private bool _serverFoldout   = true;
        private bool _captureFoldout  = true;
        private bool _recordFoldout   = true;
        private bool _autoSendFoldout = true;
        private bool _screenshotFold  = false;
        private bool _diagFoldout     = false;
        private bool _triggerFoldout  = true;
        private bool _filesFoldout     = false;
        private bool _netFoldout      = false;
        private bool _retryFoldout    = false;
        private bool _uiFoldout       = false;
        private bool _enableFoldout   = true;

        private SerializedProperty _server;
        private SerializedProperty _capture;
        private SerializedProperty _recording;
        private SerializedProperty _autoSend;
        private SerializedProperty _screenshot;
        private SerializedProperty _diagnostics;
        private SerializedProperty _trigger;
        private SerializedProperty _files;
        private SerializedProperty _net;
        private SerializedProperty _retry;
        private SerializedProperty _ui;
        private SerializedProperty _enable;

        private void OnEnable()
        {
            _server      = serializedObject.FindProperty("_server");
            _capture     = serializedObject.FindProperty("_capture");
            _recording   = serializedObject.FindProperty("_recording");
            _autoSend    = serializedObject.FindProperty("_autoSend");
            _screenshot  = serializedObject.FindProperty("_screenshot");
            _diagnostics = serializedObject.FindProperty("_diagnostics");
            _trigger     = serializedObject.FindProperty("_trigger");
            _files       = serializedObject.FindProperty("_files");
            _net         = serializedObject.FindProperty("_net");
            _retry       = serializedObject.FindProperty("_retry");
            _ui          = serializedObject.FindProperty("_ui");
            _enable      = serializedObject.FindProperty("_enable");
        }

        public override void OnInspectorGUI()
        {
            serializedObject.Update();

            var cfg = (FastLogsConfig)target;

            DrawConfigHeader();
            DrawValidationMessages(cfg);
            EditorGUILayout.Space(4);

            _serverFoldout  = DrawGroup("Server",      _server,      _serverFoldout);
            _captureFoldout = DrawGroup("Capture",     _capture,     _captureFoldout);
            _recordFoldout  = DrawGroup("Recording",   _recording,   _recordFoldout);
            _autoSendFoldout = DrawGroup("Auto-send",  _autoSend,    _autoSendFoldout);
            _screenshotFold = DrawGroup("Screenshot",  _screenshot,  _screenshotFold);
            _diagFoldout    = DrawGroup("Diagnostics", _diagnostics, _diagFoldout);
            _triggerFoldout = DrawGroup("Trigger",     _trigger,     _triggerFoldout);
            _filesFoldout   = DrawGroup("Files",       _files,       _filesFoldout);
            _netFoldout     = DrawGroup("Net",         _net,         _netFoldout);
            _retryFoldout   = DrawGroup("Retry",       _retry,       _retryFoldout);
            _uiFoldout      = DrawGroup("UI",          _ui,          _uiFoldout);
            _enableFoldout  = DrawGroup("Enable",      _enable,      _enableFoldout);

            EditorGUILayout.Space(6);
            DrawActions();

            serializedObject.ApplyModifiedProperties();
        }

        // ---- Helpers --------------------------------------------------------

        private static void DrawConfigHeader()
        {
            EditorGUILayout.Space(4);
            var style = new GUIStyle(EditorStyles.largeLabel)
            {
                fontStyle = FontStyle.Bold,
                fontSize  = 13
            };
            EditorGUILayout.LabelField("FastLogs Configuration", style);
            EditorGUILayout.Space(2);
        }

        private static void DrawValidationMessages(FastLogsConfig cfg)
        {
            string url = cfg.Server.EndpointUrl;

            if (string.IsNullOrWhiteSpace(url))
            {
                EditorGUILayout.HelpBox(
                    "Server.EndpointUrl is empty. FastLogs will not upload until it is set " +
                    "(e.g. https://logs.example.com/api/logs).",
                    MessageType.Warning);
            }
            else if (url.StartsWith("http://", System.StringComparison.OrdinalIgnoreCase))
            {
#if UNITY_IOS
                EditorGUILayout.HelpBox(
                    "Endpoint is HTTP, not HTTPS. iOS App Transport Security (ATS) blocks " +
                    "plain HTTP requests at runtime unless an NSException is configured in " +
                    "your Info.plist. Prefer https:// for iOS builds.",
                    MessageType.Warning);
#else
                EditorGUILayout.HelpBox(
                    "Endpoint is HTTP, not HTTPS. On iOS, ATS will block this at runtime. " +
                    "Use https:// to be safe across all platforms.",
                    MessageType.Info);
#endif
            }

            if (string.IsNullOrWhiteSpace(cfg.Server.AppId))
            {
                EditorGUILayout.HelpBox(
                    "Server.AppId is empty. The server requires a valid appId " +
                    "([a-z0-9_-]{2,32}) to catalog logs.",
                    MessageType.Warning);
            }
        }

        private static bool DrawGroup(string label, SerializedProperty groupProp, bool foldout)
        {
            foldout = EditorGUILayout.Foldout(foldout, label, true, EditorStyles.foldoutHeader);
            if (!foldout || groupProp == null) return foldout;

            EditorGUI.indentLevel++;
            SerializedProperty child = groupProp.Copy();
            SerializedProperty end   = groupProp.GetEndProperty();
            bool enterChildren = true;
            while (child.NextVisible(enterChildren) && !SerializedProperty.EqualContents(child, end))
            {
                enterChildren = false;
                EditorGUILayout.PropertyField(child, true);
            }
            EditorGUI.indentLevel--;
            EditorGUILayout.Space(2);
            return foldout;
        }

        private void DrawActions()
        {
            EditorGUILayout.LabelField("Actions", EditorStyles.boldLabel);

            EditorGUILayout.BeginHorizontal();

            if (GUILayout.Button("Ping this asset"))
            {
                EditorGUIUtility.PingObject(target);
            }

            if (GUILayout.Button("Open README"))
            {
                FastLogsMenu.OpenReadme();
            }

            EditorGUILayout.EndHorizontal();

            EditorGUILayout.BeginHorizontal();

            if (GUILayout.Button("Show Build Defines Helper"))
            {
                FastLogsBuildDefines.ShowWindow();
            }

            EditorGUILayout.EndHorizontal();
        }
    }
}
