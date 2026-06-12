// FastLogs - Basic Usage sample.
//
// Drop this on a GameObject in a scene (or import the sample from the Package
// Manager). It initializes FastLogs, records logs, and sends a shareable report
// on a key press. Everything here compiles in retail/console too - the void
// FastLogs.* calls simply strip out.

using UnityEngine;
using PlayJoy.FastLogs;

namespace PlayJoy.FastLogs.Samples
{
    public sealed class FastLogsBasicUsage : MonoBehaviour
    {
        [Tooltip("Optional explicit config. Leave empty to load Resources/FastLogsConfig.")]
        [SerializeField] private FastLogsConfig _config;

        [Tooltip("Press to send a report.")]
        [SerializeField] private KeyCode _sendKey = KeyCode.F9;

        [Tooltip("Include a screenshot with the report.")]
        [SerializeField] private bool _includeScreenshot = true;

        private void Awake()
        {
            // Init is idempotent and safe to call early.
            FastLogs.Init(_config);

            // OnUploaded fires for both success and failure.
            FastLogs.OnUploaded += HandleUploaded;

            // Start capturing into the recording buffer.
            FastLogs.StartRecording();

            FastLogs.Log("FastLogs basic usage sample started.");
        }

        private void OnDestroy()
        {
            FastLogs.OnUploaded -= HandleUploaded;
        }

        private void Update()
        {
            if (Input.GetKeyDown(_sendKey))
            {
                Send();
            }
        }

        private async void Send()
        {
            FastLogs.Warn("Manual report requested.");

            // Awaitable on every Unity version (FlogTask, coroutine-driven).
            var result = await FastLogs.SendAsync(_includeScreenshot, "Manual report from sample");

            if (result.Success)
            {
                Debug.Log("[FastLogs sample] Uploaded: " + result.Url);
            }
            else
            {
                Debug.LogWarning("[FastLogs sample] Upload failed: " + result.Error);
            }
        }

        private void HandleUploaded(UploadResultDto result)
        {
            Debug.Log("[FastLogs sample] OnUploaded -> " + result);
        }
    }
}
