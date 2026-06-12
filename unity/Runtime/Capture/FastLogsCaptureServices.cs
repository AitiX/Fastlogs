// FastLogsCaptureServices - a minimal IFastLogsServices that supplies the capture
// subsystem (the log source) and leaves the other seams (trigger, uploader,
// screenshot, clipboard, overlay, web info) to other builders.
//
// This is what connects the CAPTURE + RECORDER subsystem to the facade: register
// it once before Init and FastLogs.Log / StartRecording / SendAsync's BuildLogText
// all route through CapturingLogSource (and therefore LogRecorder).
//
//   FastLogs.SetServicesProvider(new FastLogsCaptureServices());
//   FastLogs.Init();
//
// A fuller builder (with uploader/overlay/etc.) can either subclass this and
// override the other Create* members, or compose: call CreateLogSource from its
// own services. Every member may return null - the core stays functional and just
// treats that feature as absent.
//
// Gated; removed in retail/console builds.

#if UNITY_EDITOR || DEVELOPMENT_BUILD || (LOGSHARE_FORCE_ENABLED && !(UNITY_PS4 || UNITY_PS5 || UNITY_GAMECORE || UNITY_SWITCH))
#define FASTLOGS_ENABLED
#endif

#if FASTLOGS_ENABLED
namespace PlayJoy.FastLogs
{
    /// <summary>
    /// Services provider that wires only the capture/record log source. Intended to
    /// be combined with (or subclassed by) a builder that adds uploader/overlay/etc.
    /// </summary>
    public class FastLogsCaptureServices : IFastLogsServices
    {
        /// <summary>
        /// Create the capturing log source (ring + optional persistent recorder).
        /// This is the one seam this provider fills.
        /// </summary>
        public virtual ILogSource CreateLogSource(FastLogsConfig config)
        {
            return new CapturingLogSource(config);
        }

        // The remaining seams are owned by other builders; default to null so the
        // core treats them as absent and stays functional.
        public virtual ITriggerSource CreateTriggerSource(FastLogsConfig config) { return null; }
        public virtual ILogUploader CreateUploader(FastLogsConfig config) { return null; }
        public virtual IScreenshotCapturer CreateScreenshotCapturer(FastLogsConfig config) { return null; }
        public virtual IClipboard CreateClipboard(FastLogsConfig config) { return null; }
        public virtual ILogShareOverlay CreateOverlay(FastLogsConfig config) { return null; }
        public virtual IWebDeviceInfoProvider CreateWebDeviceInfoProvider(FastLogsConfig config) { return null; }
    }
}
#endif
