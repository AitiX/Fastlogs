// SettingsPanel - an independent runtime settings UI for FastLogs.
//
// This is NOT tied to SRDebugger; it renders with IMGUI and is meant to be shown
// as a tab inside the ImguiOverlay (or standalone). It exposes the runtime-tunable
// knobs:
//   - endpoint URL (read-only) with a masked token preview,
//   - appId (editable),
//   - capture-screenshot-by-default toggle,
//   - include-sensitive-diagnostics toggle,
//   - trigger selection (which gesture opens the overlay),
//   - retention-days override,
//   - ring-buffer capacity,
//   - Start / Stop recording (reflecting FastLogs.IsRecording) and Clear,
//   - a button to open the persistent data directory (where recordings live).
//
// Runtime edits PERSIST to PlayerPrefs (namespaced keys) so they survive a
// restart without touching the asset. The panel applies values back onto the live
// FastLogsConfig instance so the rest of the system picks them up immediately.
//
// Available by default in Editor / Development (config.UI.EnableUI). The whole
// file is gated, so it is stripped together with the package in retail/console.

#if UNITY_EDITOR || DEVELOPMENT_BUILD || (LOGSHARE_FORCE_ENABLED && !(UNITY_PS4 || UNITY_PS5 || UNITY_GAMECORE || UNITY_SWITCH))
#define FASTLOGS_ENABLED
#endif

#if FASTLOGS_ENABLED
using System;
using UnityEngine;

namespace PlayJoy.FastLogs
{
    /// <summary>
    /// Trigger kinds the settings panel can select between. Maps onto TriggerConfig
    /// fields when applied.
    /// </summary>
    public enum TriggerKind
    {
        KeyCombo = 0,
        CornerMultiTap = 1,
        Both = 2
    }

    /// <summary>
    /// Runtime settings UI. Reads/writes a live FastLogsConfig and persists overrides
    /// in PlayerPrefs. Rendered via OnGUILayout from a host (the overlay) inside an
    /// already-open GUILayout area.
    /// </summary>
    public sealed class SettingsPanel
    {
        // PlayerPrefs key namespace so we never collide with the game's prefs.
        private const string Prefix = "FastLogs.";
        private const string KeyAppId = Prefix + "appId";
        private const string KeyCaptureShot = Prefix + "captureScreenshot";
        private const string KeyIncludeSensitive = Prefix + "includeSensitive";
        private const string KeyTriggerKind = Prefix + "triggerKind";
        private const string KeyRetention = Prefix + "retentionDays";
        private const string KeyRingCapacity = Prefix + "ringCapacity";
        private const string KeyTesterName = Prefix + "testerName";
        private const string KeyCopyLinkOnSend = Prefix + "copyLinkOnSend";

        private readonly FastLogsConfig _config;

        private string _appId = string.Empty;
        private bool _captureShot;
        private bool _includeSensitive;
        private TriggerKind _triggerKind = TriggerKind.KeyCombo;
        private string _retentionText = "0";
        private string _ringCapacityText = "1000";
        private string _testerName = string.Empty;
        private bool _copyLinkOnSend = true;

        // Built lazily inside OnGUILayout.
        private bool _stylesBuilt;
        private GUIStyle _label;
        private GUIStyle _field;
        private GUIStyle _button;
        private GUIStyle _section;

        public SettingsPanel(FastLogsConfig config)
        {
            _config = config;
            LoadFromPrefsAndConfig();
        }

        // ---- Persistence ----

        private void LoadFromPrefsAndConfig()
        {
            // Seed from the config, then let any saved PlayerPrefs override.
            if (_config != null)
            {
                _appId = _config.Server.AppId ?? string.Empty;
                _captureShot = _config.Screenshot.CaptureByDefault;
                _includeSensitive = _config.Diagnostics.IncludeSensitive;
                _retentionText = _config.Server.RetentionDaysOverride.ToString();
                _ringCapacityText = _config.Capture.RingCapacity.ToString();
                _testerName = _config.UI.TesterName ?? string.Empty;
                _copyLinkOnSend = _config.UI.CopyLinkOnSend;
            }

            _appId = PlayerPrefs.GetString(KeyAppId, _appId);
            _captureShot = PlayerPrefs.GetInt(KeyCaptureShot, _captureShot ? 1 : 0) != 0;
            _includeSensitive = PlayerPrefs.GetInt(KeyIncludeSensitive, _includeSensitive ? 1 : 0) != 0;
            _triggerKind = (TriggerKind)PlayerPrefs.GetInt(KeyTriggerKind, (int)_triggerKind);
            _retentionText = PlayerPrefs.GetInt(KeyRetention, ParseIntOr(_retentionText, 0)).ToString();
            _ringCapacityText = PlayerPrefs.GetInt(KeyRingCapacity, ParseIntOr(_ringCapacityText, 1000)).ToString();
            _testerName = PlayerPrefs.GetString(KeyTesterName, _testerName);
            _copyLinkOnSend = PlayerPrefs.GetInt(KeyCopyLinkOnSend, _copyLinkOnSend ? 1 : 0) != 0;

            ApplyToConfig();
        }

        // Push current panel values onto the live config so the rest of the system
        // (uploader, trigger, capture) picks them up immediately.
        private void ApplyToConfig()
        {
            if (_config == null)
            {
                return;
            }

            _config.Server.AppId = _appId ?? string.Empty;
            _config.Screenshot.CaptureByDefault = _captureShot;
            _config.Diagnostics.IncludeSensitive = _includeSensitive;
            _config.Server.RetentionDaysOverride = Mathf.Max(0, ParseIntOr(_retentionText, 0));
            _config.Capture.RingCapacity = Mathf.Max(1, ParseIntOr(_ringCapacityText, 1000));
            _config.UI.TesterName = _testerName ?? string.Empty;
            _config.UI.CopyLinkOnSend = _copyLinkOnSend;
            ApplyTriggerKind(_triggerKind, _config.Trigger);
        }

        private void SaveToPrefs()
        {
            PlayerPrefs.SetString(KeyAppId, _appId ?? string.Empty);
            PlayerPrefs.SetInt(KeyCaptureShot, _captureShot ? 1 : 0);
            PlayerPrefs.SetInt(KeyIncludeSensitive, _includeSensitive ? 1 : 0);
            PlayerPrefs.SetInt(KeyTriggerKind, (int)_triggerKind);
            PlayerPrefs.SetInt(KeyRetention, Mathf.Max(0, ParseIntOr(_retentionText, 0)));
            PlayerPrefs.SetInt(KeyRingCapacity, Mathf.Max(1, ParseIntOr(_ringCapacityText, 1000)));
            PlayerPrefs.SetString(KeyTesterName, _testerName ?? string.Empty);
            PlayerPrefs.SetInt(KeyCopyLinkOnSend, _copyLinkOnSend ? 1 : 0);
            PlayerPrefs.Save();
        }

        private static void ApplyTriggerKind(TriggerKind kind, TriggerConfig trigger)
        {
            if (trigger == null)
            {
                return;
            }
            // KeyCombo uses the keyboard path; CornerMultiTap uses a non-zero finger
            // count as the "corner multitap enabled" signal (the builder maps it).
            switch (kind)
            {
                case TriggerKind.KeyCombo:
                    trigger.EnableKeyboard = true;
                    if (trigger.MultiTouchFingerCount <= 0) trigger.MultiTouchFingerCount = 0;
                    break;
                case TriggerKind.CornerMultiTap:
                    trigger.EnableKeyboard = false;
                    if (trigger.MultiTouchFingerCount <= 0) trigger.MultiTouchFingerCount = 3;
                    break;
                default: // Both
                    trigger.EnableKeyboard = true;
                    if (trigger.MultiTouchFingerCount <= 0) trigger.MultiTouchFingerCount = 3;
                    break;
            }
        }

        // ---- Layout helpers used by the overlay ----

        /// <summary>Rough pixel height the panel needs (so the overlay can size itself).</summary>
        public float EstimateHeight(float scale)
        {
            // ~14 rows of controls at ~30pt each, plus section labels (added the
            // Tester Name label+field and the Copy-link-on-send toggle).
            return 450f * scale;
        }

        // ---- Rendering ----

        /// <summary>
        /// Draw the panel inside the caller's existing GUILayout context. The caller
        /// (overlay) supplies the active DPI scale so sizes match the rest of the UI.
        /// </summary>
        public void OnGUILayout(float scale)
        {
            EnsureStyles(scale);

            float lineH = Mathf.Max(44f, 30f * scale);
            bool changed = false;

            GUILayout.Label("Settings", _section);

            // Endpoint (read-only) + masked token.
            GUILayout.Label("Endpoint (read-only):", _label);
            GUILayout.Label(EndpointDisplay(), _field, GUILayout.Height(lineH));

            // App id (editable).
            GUILayout.Label("App Id:", _label);
            string newAppId = GUILayout.TextField(_appId, _field, GUILayout.Height(lineH));
            if (!string.Equals(newAppId, _appId, StringComparison.Ordinal))
            {
                _appId = newAppId;
                changed = true;
            }

            // Tester name (editable) - attached to every report's "tester" field.
            GUILayout.Label("Tester Name:", _label);
            string newTester = GUILayout.TextField(_testerName, _field, GUILayout.Height(lineH));
            if (!string.Equals(newTester, _testerName, StringComparison.Ordinal))
            {
                _testerName = newTester;
                changed = true;
            }

            // Toggles.
            bool newShot = GUILayout.Toggle(_captureShot, " Capture screenshot by default", GUILayout.Height(lineH));
            if (newShot != _captureShot) { _captureShot = newShot; changed = true; }

            bool newSensitive = GUILayout.Toggle(_includeSensitive, " Include sensitive device info", GUILayout.Height(lineH));
            if (newSensitive != _includeSensitive) { _includeSensitive = newSensitive; changed = true; }

            bool newCopyOnSend = GUILayout.Toggle(_copyLinkOnSend, " Copy link on send", GUILayout.Height(lineH));
            if (newCopyOnSend != _copyLinkOnSend) { _copyLinkOnSend = newCopyOnSend; changed = true; }

            // Trigger selection.
            GUILayout.Label("Open overlay with:", _label);
            GUILayout.BeginHorizontal();
            if (TriggerButton("Key", TriggerKind.KeyCombo, lineH)) { _triggerKind = TriggerKind.KeyCombo; changed = true; }
            if (TriggerButton("Tap corner", TriggerKind.CornerMultiTap, lineH)) { _triggerKind = TriggerKind.CornerMultiTap; changed = true; }
            if (TriggerButton("Both", TriggerKind.Both, lineH)) { _triggerKind = TriggerKind.Both; changed = true; }
            GUILayout.EndHorizontal();

            // Retention override.
            GUILayout.BeginHorizontal();
            GUILayout.Label("Retention (days, 0=server):", _label, GUILayout.Height(lineH));
            string newRet = GUILayout.TextField(_retentionText, _field, GUILayout.Width(80f * scale), GUILayout.Height(lineH));
            if (!string.Equals(newRet, _retentionText, StringComparison.Ordinal)) { _retentionText = DigitsOnly(newRet); changed = true; }
            GUILayout.EndHorizontal();

            // Ring capacity.
            GUILayout.BeginHorizontal();
            GUILayout.Label("Buffer capacity (lines):", _label, GUILayout.Height(lineH));
            string newCap = GUILayout.TextField(_ringCapacityText, _field, GUILayout.Width(100f * scale), GUILayout.Height(lineH));
            if (!string.Equals(newCap, _ringCapacityText, StringComparison.Ordinal)) { _ringCapacityText = DigitsOnly(newCap); changed = true; }
            GUILayout.EndHorizontal();

            // Recording controls (via the facade, so no runtime reference needed).
            GUILayout.Label("Recording: " + (FastLogs.IsRecording ? "ON" : "off"), _label);
            GUILayout.BeginHorizontal();
            if (GUILayout.Button(FastLogs.IsRecording ? "Stop" : "Start", _button, GUILayout.Height(lineH)))
            {
                FastLogs.SetRecording(!FastLogs.IsRecording);
            }
            if (GUILayout.Button("Clear", _button, GUILayout.Height(lineH)))
            {
                FastLogs.ClearRecording();
            }
            GUILayout.EndHorizontal();

            // Open the persistent data directory (where recordings are stored).
            if (GUILayout.Button("Open data folder", _button, GUILayout.Height(lineH)))
            {
                OpenDataFolder();
            }

            if (changed)
            {
                ApplyToConfig();
                SaveToPrefs();
            }
        }

        private bool TriggerButton(string label, TriggerKind kind, float lineH)
        {
            bool selected = _triggerKind == kind;
            var prev = GUI.backgroundColor;
            if (selected)
            {
                GUI.backgroundColor = new Color(0.20f, 0.45f, 0.85f, 1f);
            }
            bool clicked = GUILayout.Button(label, _button, GUILayout.Height(lineH));
            GUI.backgroundColor = prev;
            return clicked && !selected;
        }

        private string EndpointDisplay()
        {
            if (_config == null)
            {
                return "(no config)";
            }
            string url = _config.Server.EndpointUrl;
            if (string.IsNullOrEmpty(url))
            {
                url = "(not set)";
            }
            string token = _config.Server.Token;
            if (!string.IsNullOrEmpty(token))
            {
                url += "  [token: " + MaskToken(token) + "]";
            }
            return url;
        }

        private static string MaskToken(string token)
        {
            if (string.IsNullOrEmpty(token))
            {
                return string.Empty;
            }
            if (token.Length <= 4)
            {
                return new string('*', token.Length);
            }
            // Show first 2 and last 2, mask the middle.
            int hidden = token.Length - 4;
            return token.Substring(0, 2) + new string('*', Math.Min(hidden, 8)) + token.Substring(token.Length - 2);
        }

        private static void OpenDataFolder()
        {
            try
            {
                string path = Application.persistentDataPath;
#if UNITY_EDITOR || UNITY_STANDALONE
                Application.OpenURL("file://" + path);
#else
                FlogLog.Info("Data folder: " + path);
#endif
            }
            catch (Exception e)
            {
                FlogLog.Exception(e);
            }
        }

        // ---- Utils ----

        private static int ParseIntOr(string s, int fallback)
        {
            int v;
            return int.TryParse(s, out v) ? v : fallback;
        }

        private static string DigitsOnly(string s)
        {
            if (string.IsNullOrEmpty(s))
            {
                return "0";
            }
            var sb = new System.Text.StringBuilder(s.Length);
            for (int i = 0; i < s.Length; i++)
            {
                if (char.IsDigit(s[i]))
                {
                    sb.Append(s[i]);
                }
            }
            return sb.Length == 0 ? "0" : sb.ToString();
        }

        private void EnsureStyles(float scale)
        {
            if (_stylesBuilt)
            {
                return;
            }
            _stylesBuilt = true;

            int fontSize = Mathf.RoundToInt(13f * scale);

            _label = new GUIStyle(GUI.skin.label) { fontSize = fontSize, wordWrap = true };
            _label.normal.textColor = Color.white;

            _section = new GUIStyle(_label) { fontStyle = FontStyle.Bold, fontSize = Mathf.RoundToInt(15f * scale) };

            _field = new GUIStyle(GUI.skin.textField) { fontSize = fontSize };
            _button = new GUIStyle(GUI.skin.button) { fontSize = fontSize };
        }
    }
}
#endif
