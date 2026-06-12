// FastLogsDefaultServices - the default IFastLogsServices used by FastLogs.Init
// when no provider was registered via SetServicesProvider. Wires the bundled
// concrete implementations on top of the capture log source so the package works
// out of the box: corner/keyboard trigger, UnityWebRequest uploader, screenshot,
// clipboard and the self-hosted IMGUI overlay.
//
// Gated; removed in retail/console builds.

#if UNITY_EDITOR || DEVELOPMENT_BUILD || (LOGSHARE_FORCE_ENABLED && !(UNITY_PS4 || UNITY_PS5 || UNITY_GAMECORE || UNITY_SWITCH))
#define FASTLOGS_ENABLED
#endif

#if FASTLOGS_ENABLED
namespace PlayJoy.FastLogs
{
    internal sealed class FastLogsDefaultServices : FastLogsCaptureServices
    {
        public override ITriggerSource CreateTriggerSource(FastLogsConfig config)
        {
            return new CompositeTrigger(new KeyComboTrigger(), new MultiTapCornerTrigger(ScreenCorner.TopRight));
        }

        public override ILogUploader CreateUploader(FastLogsConfig config)
        {
            return new UnityWebRequestUploader();
        }

        public override IScreenshotCapturer CreateScreenshotCapturer(FastLogsConfig config)
        {
            return new ScreenshotCapturer();
        }

        public override IClipboard CreateClipboard(FastLogsConfig config)
        {
            return new ClipboardService();
        }

        public override ILogShareOverlay CreateOverlay(FastLogsConfig config)
        {
            bool captureByDefault = config != null && config.Screenshot.CaptureByDefault;
            return new ImguiOverlay(new ClipboardService(), new SettingsPanel(config), captureByDefault);
        }
    }
}
#endif
