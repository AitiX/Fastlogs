// FastLogs enablement gate.
//
// Two independent layers decide whether FastLogs actually does anything:
//
//  1) Compile-time (build safety): the FASTLOGS_ENABLED symbol below. It is
//     defined only in Editor, Development builds, or when LOGSHARE_FORCE_ENABLED
//     is set on a non-console target. On retail / console targets the symbol is
//     undefined, so all networking / overlay / screenshot / hook code is removed.
//
//  2) Run-time (user opt-in): the Enable* flags on FastLogsConfig, checked by
//     IsEnabled(config). Even in a Development build a project can keep FastLogs
//     dormant via config.
//
// The FASTLOGS_ENABLED define is declared identically at the top of every gated
// FastLogs file; keep them in sync.

#if UNITY_EDITOR || DEVELOPMENT_BUILD || (LOGSHARE_FORCE_ENABLED && !(UNITY_PS4 || UNITY_PS5 || UNITY_GAMECORE || UNITY_SWITCH))
#define FASTLOGS_ENABLED
#endif

namespace PlayJoy.FastLogs
{
    /// <summary>
    /// Central enable/disable decision for FastLogs. Compiles on all platforms;
    /// returns false everywhere the package is compiled out.
    /// </summary>
    internal static class FastLogsGate
    {
        /// <summary>
        /// True only on targets where FastLogs functionality is compiled in
        /// (Editor / Development build / forced non-console). Cheap compile-time
        /// constant - the JIT/AOT folds it.
        /// </summary>
        public static bool IsCompiledIn
        {
#if FASTLOGS_ENABLED
            get { return true; }
#else
            get { return false; }
#endif
        }

        /// <summary>
        /// Final runtime decision: the package must be compiled in AND the active
        /// config must opt in for the current build flavour.
        /// </summary>
        public static bool IsEnabled(FastLogsConfig config)
        {
#if FASTLOGS_ENABLED
            if (config == null)
            {
                return false;
            }

            // Editor takes priority: if you are in the Editor, the Editor flag wins.
#if UNITY_EDITOR
            return config.EnableInEditor;
#elif DEVELOPMENT_BUILD
            return config.EnableInDevelopment;
#else
            // Reached only when LOGSHARE_FORCE_ENABLED forced a non-development
            // player build. Treat that as an explicit "release" opt-in.
            return config.EnableInRelease;
#endif
#else
            // Compiled out entirely.
            return false;
#endif
        }
    }
}
