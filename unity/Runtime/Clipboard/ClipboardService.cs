// ClipboardService - the default IClipboard, plus a synchronous OpenUrl helper.
//
// Copy / open must be SYNCHRONOUS on WebGL: browsers only honour clipboard writes
// and window.open from inside a user-gesture handler (the click that triggered the
// call). So these methods do the work inline - no coroutine, no FlogTask - and the
// overlay must call them directly from its button handler.
//
// Platform behaviour:
//   - Standalone / mobile / editor: GUIUtility.systemCopyBuffer for copy,
//     Application.OpenURL for open.
//   - WebGL: a jslib bridge (FastLogsWeb.jslib) - navigator.clipboard.writeText
//     (with a textarea/execCommand fallback) and window.open.
//
// Gated like the rest of the package.

#if UNITY_EDITOR || DEVELOPMENT_BUILD || (LOGSHARE_FORCE_ENABLED && !(UNITY_PS4 || UNITY_PS5 || UNITY_GAMECORE || UNITY_SWITCH))
#define FASTLOGS_ENABLED
#endif

#if FASTLOGS_ENABLED
using System;
using UnityEngine;

#if UNITY_WEBGL && !UNITY_EDITOR
using System.Runtime.InteropServices;
#endif

namespace PlayJoy.FastLogs
{
    /// <summary>
    /// Default clipboard + url-opener. All operations are synchronous so they work
    /// from a WebGL user-gesture handler. CopyToClipboard / OpenUrl return true when
    /// the action was issued (best-effort; the browser may still block it).
    /// </summary>
    internal sealed class ClipboardService : IClipboard
    {
        public bool CopyToClipboard(string text)
        {
            if (text == null)
            {
                text = string.Empty;
            }

            try
            {
#if UNITY_WEBGL && !UNITY_EDITOR
                FastLogsWeb_CopyToClipboard(text);
                return true;
#else
                GUIUtility.systemCopyBuffer = text;
                return true;
#endif
            }
            catch (Exception e)
            {
                FlogLog.Exception(e);
                return false;
            }
        }

        /// <summary>
        /// Open a url in the browser / system handler. Synchronous so it works from a
        /// WebGL user gesture. Returns true if the open was issued.
        /// </summary>
        public bool OpenUrl(string url)
        {
            if (string.IsNullOrEmpty(url))
            {
                return false;
            }

            try
            {
#if UNITY_WEBGL && !UNITY_EDITOR
                FastLogsWeb_OpenUrl(url);
                return true;
#else
                Application.OpenURL(url);
                return true;
#endif
            }
            catch (Exception e)
            {
                FlogLog.Exception(e);
                return false;
            }
        }

#if UNITY_WEBGL && !UNITY_EDITOR
        [DllImport("__Internal")]
        private static extern void FastLogsWeb_CopyToClipboard(string text);

        [DllImport("__Internal")]
        private static extern void FastLogsWeb_OpenUrl(string url);
#endif
    }
}
#endif
