// FastLogs internal logger.
//
// All methods are [Conditional] on the FastLogs enablement symbols, so every
// internal diagnostic call site is stripped from retail / console builds.
// This type is the single place FastLogs talks to UnityEngine.Debug, so the
// package never spams the player console in release.

using System.Diagnostics;

namespace PlayJoy.FastLogs
{
    /// <summary>
    /// Internal, strippable logger used by FastLogs runtime code. Never use
    /// UnityEngine.Debug directly inside the package - route through here so
    /// the calls disappear in non-development builds.
    /// </summary>
    internal static class FlogLog
    {
        // Exposed within the assembly so the auto-send path can recognize (and skip)
        // FastLogs' own diagnostic lines and avoid a pattern-match feedback loop.
        internal const string Prefix = "[FastLogs] ";

        // Conditional on the same symbols that gate the rest of the package.
        // In retail / console builds none of these calls are compiled in.
        [Conditional("UNITY_EDITOR"), Conditional("DEVELOPMENT_BUILD"), Conditional("LOGSHARE_FORCE_ENABLED")]
        public static void Info(string message)
        {
            UnityEngine.Debug.Log(Prefix + message);
        }

        [Conditional("UNITY_EDITOR"), Conditional("DEVELOPMENT_BUILD"), Conditional("LOGSHARE_FORCE_ENABLED")]
        public static void Warn(string message)
        {
            UnityEngine.Debug.LogWarning(Prefix + message);
        }

        [Conditional("UNITY_EDITOR"), Conditional("DEVELOPMENT_BUILD"), Conditional("LOGSHARE_FORCE_ENABLED")]
        public static void Error(string message)
        {
            UnityEngine.Debug.LogError(Prefix + message);
        }

        // Exceptions are logged via LogException to preserve the stack trace.
        [Conditional("UNITY_EDITOR"), Conditional("DEVELOPMENT_BUILD"), Conditional("LOGSHARE_FORCE_ENABLED")]
        public static void Exception(System.Exception exception)
        {
            if (exception == null)
            {
                return;
            }

            UnityEngine.Debug.LogException(exception);
        }
    }
}
