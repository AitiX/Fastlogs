// FlogCoroutineHost - a tiny shared MonoBehaviour used to run coroutines for
// components that are not themselves MonoBehaviours (the uploader, the screenshot
// capturer). Several FastLogs services need to drive a coroutine (yield until a
// UnityWebRequest finishes, yield WaitForEndOfFrame) but are plain C# objects so
// they can be unit-constructed and stay engine-light.
//
// One hidden, DontDestroyOnLoad host is lazily created and shared. It is created
// only inside enabled builds (the whole file is gated), so retail/console never
// spawns it.

#if UNITY_EDITOR || DEVELOPMENT_BUILD || (LOGSHARE_FORCE_ENABLED && !(UNITY_PS4 || UNITY_PS5 || UNITY_GAMECORE || UNITY_SWITCH))
#define FASTLOGS_ENABLED
#endif

#if FASTLOGS_ENABLED
using System.Collections;
using UnityEngine;

namespace PlayJoy.FastLogs
{
    /// <summary>
    /// Shared hidden MonoBehaviour that runs coroutines on behalf of non-MonoBehaviour
    /// FastLogs services. Lazily created, persistent, hidden in the hierarchy.
    /// </summary>
    internal sealed class FlogCoroutineHost : MonoBehaviour
    {
        private static FlogCoroutineHost _instance;

        /// <summary>Get (or lazily create) the shared coroutine host.</summary>
        public static FlogCoroutineHost Instance
        {
            get
            {
                if (_instance == null)
                {
                    var go = new GameObject("FastLogsCoroutineHost");
                    go.hideFlags = HideFlags.HideAndDontSave;
                    DontDestroyOnLoad(go);
                    _instance = go.AddComponent<FlogCoroutineHost>();
                }
                return _instance;
            }
        }

        /// <summary>Start a coroutine on the shared host.</summary>
        public static Coroutine Run(IEnumerator routine)
        {
            return Instance.StartCoroutine(routine);
        }

        private void OnDestroy()
        {
            if (_instance == this)
            {
                _instance = null;
            }
        }
    }
}
#endif
