// ImguiOverlay - a self-contained OnGUI overlay for FastLogs.
//
// It implements ILogShareOverlay and is driven entirely from IMGUI (no Canvas,
// no EventSystem), so it works in any scene and survives scene loads. Layout:
//   - A compact bar with E/W/L counters, a "Send" button and a "Screenshot"
//     toggle (a >=44pt touch target).
//   - While a send is in flight it shows a busy state.
//   - After a response it shows the link in a selectable field, a "Copy" button,
//     an "Open" button, and a QR of the URL (GUI.DrawTexture).
//   - DPI scaling (Screen.dpi) and safe-area insets so it is usable on phones.
//
// The overlay does NOT call FastLogs.SendAsync itself. It raises SendRequested
// (includeScreenshot, title, comment); the FastLogsRuntime host subscribes to that and
// runs the send pipeline (screenshot -> report -> upload -> OnUploaded), then
// pushes results back via Refresh(counts, isBusy, lastResult). This matches how
// the core wires overlays (see FastLogsRuntime.OnOverlaySendRequested / Update).
//
// Copy/open go through an IClipboard and Application.OpenURL respectively, called
// synchronously from the click handler so WebGL's user-gesture requirement holds.
//
// Gated: the whole file compiles only where FastLogs is enabled.

#if UNITY_EDITOR || DEVELOPMENT_BUILD || (LOGSHARE_FORCE_ENABLED && !(UNITY_PS4 || UNITY_PS5 || UNITY_GAMECORE || UNITY_SWITCH))
#define FASTLOGS_ENABLED
#endif

#if FASTLOGS_ENABLED
using System;
using UnityEngine;

namespace PlayJoy.FastLogs
{
    /// <summary>
    /// IMGUI implementation of the FastLogs share overlay. Stateless with respect
    /// to the send pipeline: it just renders the latest data pushed by Refresh and
    /// raises SendRequested when the user taps Send.
    /// </summary>
    public sealed class ImguiOverlay : ILogShareOverlay
    {
        // Logical (point) sizes; multiplied by the DPI scale at draw time.
        private const float MinTouch = 44f;
        private const float BasePadding = 8f;
        private const float QrLogicalSize = 160f;
        private const float CommentLogicalHeight = 72f; // multi-line comment input height (~3 lines)

        private readonly IClipboard _clipboard;
        private readonly SettingsPanel _settings; // optional embedded settings tab
        private readonly FastLogsConfig _config;  // read-only access (tester name, etc.); may be null

        // Hidden MonoBehaviour that routes Unity's OnGUI callback into this object,
        // so the overlay is fully self-contained (the runtime host does not pump GUI).
        private GuiDriver _driver;

        private bool _visible;
        private bool _includeScreenshot;

        // User-entered fields attached to the next report.
        private string _titleInput = string.Empty;    // single-line title (<=120 on the server side)
        private string _comment = string.Empty;       // multi-line free-form problem description

        private CountsDto _counts;
        private bool _isBusy;
        private UploadResultDto _lastResult = UploadResultDto.Disabled;

        // Cached QR texture for the current result URL.
        private string _qrForUrl;
        private Texture2D _qrTexture;

        // Lazily built GUI styles (created inside OnGUI where GUI.skin is valid).
        private bool _stylesBuilt;
        private GUIStyle _label;
        private GUIStyle _button;
        private GUIStyle _toggle;
        private GUIStyle _link;
        private GUIStyle _title;
        private GUIStyle _field;     // single-line input
        private GUIStyle _textArea;  // multi-line input (wraps)
        private Texture2D _panelTex;
        private Texture2D _accentTex;

        // Settings tab toggle.
        private bool _showSettings;

        public event Action<bool, string, string> SendRequested; // (includeScreenshot, title, comment)

        public bool IsVisible { get { return _visible; } }

        /// <param name="clipboard">Clipboard abstraction (may be null).</param>
        /// <param name="settings">Optional settings panel rendered under a tab (may be null).</param>
        /// <param name="config">Live config for read-only display (tester name); may be null.</param>
        /// <param name="captureScreenshotByDefault">Initial state of the screenshot toggle.</param>
        public ImguiOverlay(IClipboard clipboard, SettingsPanel settings, FastLogsConfig config, bool captureScreenshotByDefault)
        {
            _clipboard = clipboard;
            _settings = settings;
            _config = config;
            _includeScreenshot = captureScreenshotByDefault;
            _driver = GuiDriver.Create(this);
        }

        public void Show() { _visible = true; }
        public void Hide() { _visible = false; }
        public void Toggle() { _visible = !_visible; }

        // Hidden MonoBehaviour that forwards OnGUI to the overlay.
        private sealed class GuiDriver : MonoBehaviour
        {
            private ImguiOverlay _owner;

            public static GuiDriver Create(ImguiOverlay owner)
            {
                var go = new GameObject("FastLogsOverlayGUI");
                go.hideFlags = HideFlags.HideAndDontSave;
                DontDestroyOnLoad(go);
                var d = go.AddComponent<GuiDriver>();
                d._owner = owner;
                return d;
            }

            private void OnGUI()
            {
                if (_owner != null)
                {
                    _owner.OnGUI();
                }
            }
        }

        public void Refresh(CountsDto counts, bool isBusy, UploadResultDto lastResult)
        {
            _counts = counts;
            _isBusy = isBusy;
            _lastResult = lastResult;
        }

        // ---- Rendering (called by a host GUI pump) ----

        /// <summary>
        /// Draw the overlay. Must be called from OnGUI. The runtime host should call
        /// this only when IsVisible is true. A dedicated GUI driver MonoBehaviour
        /// (or the host) routes OnGUI here.
        /// </summary>
        public void OnGUI()
        {
            if (!_visible)
            {
                return;
            }

            EnsureStyles();

            float scale = DpiScale();
            Rect safe = SafeAreaPixels();

            float pad = BasePadding * scale;
            float panelWidth = Mathf.Min(safe.width - pad * 2f, 420f * scale);
            float x = safe.xMin + pad;
            float y = safe.yMin + pad;

            // Build the panel rect; height grows when a result/QR is shown.
            bool hasResult = _lastResult.Success && !string.IsNullOrEmpty(_lastResult.Url);
            float lineH = Mathf.Max(MinTouch * scale, 28f * scale);
            float commentH = CommentLogicalHeight * scale;
            bool hasTester = _config != null && !string.IsNullOrEmpty(_config.UI.TesterName);

            // header + (title label+field) + (comment label+area) + [tester] + action
            float panelHeight = pad * 2f + lineH;                 // header
            panelHeight += lineH * 2f + pad;                      // title: label + field
            panelHeight += lineH + commentH + pad;               // comment: label + text area
            if (hasTester)
            {
                panelHeight += lineH;                            // tester (read-only) row
            }
            panelHeight += lineH + pad;                          // action row
            if (hasResult)
            {
                panelHeight += lineH + (QrLogicalSize * scale) + pad * 2f;
            }
            if (_showSettings && _settings != null)
            {
                panelHeight += _settings.EstimateHeight(scale) + pad;
            }

            var panel = new Rect(x, y, panelWidth, panelHeight);
            GUI.DrawTexture(panel, _panelTex, ScaleMode.StretchToFill);

            GUILayout.BeginArea(new Rect(panel.x + pad, panel.y + pad, panel.width - pad * 2f, panel.height - pad * 2f));

            DrawHeaderRow(scale, lineH);
            DrawInputRows(scale, lineH, commentH, hasTester);
            DrawActionRow(scale, lineH);

            if (hasResult)
            {
                DrawResultRow(scale, lineH, panelWidth - pad * 2f);
            }
            else if (!_lastResult.Success && !string.IsNullOrEmpty(_lastResult.Error) && _lastResult.StatusCode != 0)
            {
                GUILayout.Space(pad * 0.5f);
                GUILayout.Label("Send failed: " + _lastResult.Error, _label);
            }

            if (_settings != null && _showSettings)
            {
                GUILayout.Space(pad);
                _settings.OnGUILayout(scale);
            }

            GUILayout.EndArea();
        }

        private void DrawHeaderRow(float scale, float lineH)
        {
            GUILayout.BeginHorizontal();

            GUILayout.Label("FastLogs", _title, GUILayout.Height(lineH));
            GUILayout.FlexibleSpace();

            string countsText = "E:" + _counts.Error + "  W:" + _counts.Warn + "  L:" + _counts.Log;
            GUILayout.Label(countsText, _label, GUILayout.Height(lineH));

            // Close button (>= 44pt).
            if (GUILayout.Button("X", _button, GUILayout.Width(lineH), GUILayout.Height(lineH)))
            {
                Hide();
            }

            GUILayout.EndHorizontal();
        }

        private void DrawInputRows(float scale, float lineH, float commentH, bool hasTester)
        {
            GUI.enabled = !_isBusy;

            // Title (single line).
            GUILayout.Label("Title", _label);
            _titleInput = GUILayout.TextField(_titleInput ?? string.Empty, _field, GUILayout.Height(lineH));

            // Comment (multi-line, free-form problem description).
            GUILayout.Label("Comment", _label);
            _comment = GUILayout.TextArea(_comment ?? string.Empty, _textArea, GUILayout.Height(commentH));

            GUI.enabled = true;

            // Tester name (read-only here; edited in Settings).
            if (hasTester)
            {
                GUILayout.Label("Tester: " + _config.UI.TesterName, _label, GUILayout.Height(lineH));
            }
        }

        private void DrawActionRow(float scale, float lineH)
        {
            GUILayout.BeginHorizontal();

            GUI.enabled = !_isBusy;

            string sendLabel = _isBusy ? "Sending..." : (_includeScreenshot ? "Send + Shot" : "Send");
            if (GUILayout.Button(sendLabel, _button, GUILayout.Height(lineH)))
            {
                RaiseSend();
            }

            // Screenshot toggle as a >= 44pt button so it is a valid touch target.
            string shotLabel = _includeScreenshot ? "[x] Shot" : "[ ] Shot";
            if (GUILayout.Button(shotLabel, _toggle, GUILayout.Width(Mathf.Max(MinTouch * scale * 2.2f, 96f * scale)), GUILayout.Height(lineH)))
            {
                _includeScreenshot = !_includeScreenshot;
            }

            GUI.enabled = true;

            if (_settings != null)
            {
                if (GUILayout.Button(_showSettings ? "Settings v" : "Settings >", _toggle, GUILayout.Height(lineH)))
                {
                    _showSettings = !_showSettings;
                }
            }

            GUILayout.EndHorizontal();
        }

        private void DrawResultRow(float scale, float lineH, float innerWidth)
        {
            GUILayout.Space(BasePadding * scale * 0.5f);

            string url = _lastResult.Url;

            GUILayout.BeginHorizontal();
            // Selectable URL field (read-only-ish; user can select/copy manually too).
            GUILayout.TextField(url, _link, GUILayout.Height(lineH));
            GUILayout.EndHorizontal();

            GUILayout.BeginHorizontal();
            if (GUILayout.Button("Copy", _button, GUILayout.Height(lineH)))
            {
                CopyUrl(url);
            }
            if (GUILayout.Button("Open", _button, GUILayout.Height(lineH)))
            {
                OpenUrl(url);
            }
            GUILayout.EndHorizontal();

            // QR of the URL.
            EnsureQr(url);
            if (_qrTexture != null)
            {
                float qrSize = QrLogicalSize * scale;
                Rect r = GUILayoutUtility.GetRect(qrSize, qrSize, GUILayout.ExpandWidth(false));
                // Centre the QR within the available row.
                r.x += Mathf.Max(0f, (innerWidth - qrSize) * 0.5f);
                GUI.DrawTexture(new Rect(r.x, r.y, qrSize, qrSize), _qrTexture, ScaleMode.ScaleToFit);
            }
        }

        // ---- Actions ----

        private void RaiseSend()
        {
            if (_isBusy)
            {
                return;
            }
            var handler = SendRequested;
            if (handler != null)
            {
                // Pass empty inputs as null so optional fields are omitted downstream.
                string title = string.IsNullOrEmpty(_titleInput) ? null : _titleInput;
                string comment = string.IsNullOrEmpty(_comment) ? null : _comment;
                try { handler(_includeScreenshot, title, comment); }
                catch (Exception e) { FlogLog.Exception(e); }
            }
        }

        private void CopyUrl(string url)
        {
            if (string.IsNullOrEmpty(url))
            {
                return;
            }
            // Called synchronously from the click handler -> valid WebGL user gesture.
            bool ok = false;
            if (_clipboard != null)
            {
                try { ok = _clipboard.CopyToClipboard(url); }
                catch (Exception e) { FlogLog.Exception(e); }
            }
            if (!ok)
            {
                // Fallback to Unity's system copy buffer (works in Editor/standalone).
                try { GUIUtility.systemCopyBuffer = url; }
                catch (Exception e) { FlogLog.Exception(e); }
            }
        }

        private static void OpenUrl(string url)
        {
            if (string.IsNullOrEmpty(url))
            {
                return;
            }
            try { Application.OpenURL(url); }
            catch (Exception e) { FlogLog.Exception(e); }
        }

        // ---- QR ----

        private void EnsureQr(string url)
        {
            if (string.Equals(url, _qrForUrl, StringComparison.Ordinal) && _qrTexture != null)
            {
                return;
            }

            DestroyQr();
            _qrForUrl = url;

            bool[,] modules;
            if (!QrCode.TryEncode(url, QrCode.Ecc.L, out modules) || modules == null)
            {
                _qrTexture = null;
                return;
            }

            _qrTexture = BuildQrTexture(modules);
        }

        private static Texture2D BuildQrTexture(bool[,] modules)
        {
            int n = modules.GetLength(0);
            const int quiet = 4;           // quiet zone (spec minimum)
            int dim = n + quiet * 2;

            var tex = new Texture2D(dim, dim, TextureFormat.RGBA32, false);
            tex.filterMode = FilterMode.Point;
            tex.wrapMode = TextureWrapMode.Clamp;
            tex.hideFlags = HideFlags.HideAndDontSave;

            var pixels = new Color32[dim * dim];
            Color32 light = new Color32(255, 255, 255, 255);
            Color32 dark = new Color32(0, 0, 0, 255);
            for (int i = 0; i < pixels.Length; i++)
            {
                pixels[i] = light;
            }

            for (int y = 0; y < n; y++)
            {
                for (int x = 0; x < n; x++)
                {
                    if (modules[x, y])
                    {
                        // Texture origin is bottom-left; flip Y so the QR is upright
                        // (GUI.DrawTexture already flips, ScaleToFit keeps aspect).
                        int px = x + quiet;
                        int py = (n - 1 - y) + quiet;
                        pixels[py * dim + px] = dark;
                    }
                }
            }

            tex.SetPixels32(pixels);
            tex.Apply(false, false);
            return tex;
        }

        private void DestroyQr()
        {
            if (_qrTexture != null)
            {
                UnityEngine.Object.Destroy(_qrTexture);
                _qrTexture = null;
            }
        }

        // ---- Styling / DPI / safe area ----

        private static float DpiScale()
        {
            float dpi = Screen.dpi;
            if (dpi <= 1f)
            {
                return 1f;
            }
            // 160 dpi = 1x. Clamp so the overlay stays usable but never huge.
            return Mathf.Clamp(dpi / 160f, 1f, 3f);
        }

        private static Rect SafeAreaPixels()
        {
            Rect safe = Screen.safeArea;
            if (safe.width <= 1f || safe.height <= 1f)
            {
                return new Rect(0f, 0f, Screen.width, Screen.height);
            }
            return safe;
        }

        private void EnsureStyles()
        {
            if (_stylesBuilt)
            {
                return;
            }
            _stylesBuilt = true;

            _panelTex = SolidTexture(new Color(0.08f, 0.09f, 0.11f, 0.92f));
            _accentTex = SolidTexture(new Color(0.20f, 0.45f, 0.85f, 1f));

            int fontSize = Mathf.RoundToInt(14f * DpiScale());

            _label = new GUIStyle(GUI.skin.label) { fontSize = fontSize };
            _label.normal.textColor = Color.white;

            _title = new GUIStyle(_label) { fontStyle = FontStyle.Bold };

            _button = new GUIStyle(GUI.skin.button) { fontSize = fontSize };
            _toggle = new GUIStyle(GUI.skin.button) { fontSize = fontSize };

            _link = new GUIStyle(GUI.skin.textField) { fontSize = fontSize };
            _link.normal.textColor = new Color(0.6f, 0.8f, 1f, 1f);

            _field = new GUIStyle(GUI.skin.textField) { fontSize = fontSize };
            _field.normal.textColor = Color.white;

            _textArea = new GUIStyle(GUI.skin.textArea) { fontSize = fontSize, wordWrap = true };
            _textArea.normal.textColor = Color.white;
        }

        private static Texture2D SolidTexture(Color color)
        {
            var t = new Texture2D(1, 1, TextureFormat.RGBA32, false);
            t.hideFlags = HideFlags.HideAndDontSave;
            t.SetPixel(0, 0, color);
            t.Apply(false, false);
            return t;
        }

        // ---- Dispose ----

        public void Dispose()
        {
            if (_driver != null)
            {
                UnityEngine.Object.Destroy(_driver.gameObject);
                _driver = null;
            }
            DestroyQr();
            DestroySolid(ref _panelTex);
            DestroySolid(ref _accentTex);
            SendRequested = null;
        }

        private static void DestroySolid(ref Texture2D tex)
        {
            if (tex != null)
            {
                UnityEngine.Object.Destroy(tex);
                tex = null;
            }
        }
    }
}
#endif
