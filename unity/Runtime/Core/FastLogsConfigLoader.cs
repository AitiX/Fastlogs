// FastLogsConfigLoader - resolves the active FastLogsConfig.
//
// Resolution order:
//   1) An explicit config passed to FastLogs.Init (handled by the facade).
//   2) Resources/FastLogsConfig (any Resources folder).
//   3) An in-memory default (CreateDefault) - so FastLogs never hard-fails just
//      because a project hasn't authored an asset yet.

using UnityEngine;

namespace PlayJoy.FastLogs
{
    internal static class FastLogsConfigLoader
    {
        /// <summary>The resource name looked up under Resources/.</summary>
        public const string ResourceName = "FastLogsConfig";

        /// <summary>
        /// Load the config from Resources, or fall back to an in-memory default.
        /// Never returns null.
        /// </summary>
        public static FastLogsConfig LoadOrDefault()
        {
            FastLogsConfig config = null;

            try
            {
                config = Resources.Load<FastLogsConfig>(ResourceName);
            }
            catch (System.Exception e)
            {
                FlogLog.Exception(e);
            }

            if (config == null)
            {
                FlogLog.Info("No Resources/" + ResourceName + " found - using in-memory default config.");
                config = FastLogsConfig.CreateDefault();
            }

            return config;
        }
    }
}
