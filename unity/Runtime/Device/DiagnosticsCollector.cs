// DiagnosticsCollector - builds the grouped DeviceInfoDto for a report.
//
// Goal: the most complete platform-portable snapshot allowed by the contract.
// Only assigns fields that are actually available (leaves the rest null so the
// serializer omits them). Web fields are filled later by an IWebDeviceInfoProvider.
//
// Sensitive fields (deviceName/identifiers/urls) are only populated when
// includeSensitive is true (DiagnosticsSection.IncludeSensitive).
//
// Gated: only compiled where FastLogs is enabled. All Unity APIs used here exist
// on both Unity 6000.1 and 2022.3; version-specific ones are wrapped in #if.

#if UNITY_EDITOR || DEVELOPMENT_BUILD || (LOGSHARE_FORCE_ENABLED && !(UNITY_PS4 || UNITY_PS5 || UNITY_GAMECORE || UNITY_SWITCH))
#define FASTLOGS_ENABLED
#endif

#if FASTLOGS_ENABLED
using System;
using System.Collections.Generic;
using System.Globalization;
using UnityEngine;
using UnityEngine.SceneManagement;

namespace PlayJoy.FastLogs
{
    internal static class DiagnosticsCollector
    {
        public static DeviceInfoDto Collect(bool includeSensitive)
        {
            var d = new DeviceInfoDto();

            CollectSystem(d.System, includeSensitive);
            CollectGraphics(d.Graphics);
            CollectDisplay(d.Display);
            CollectApplication(d.Application, includeSensitive);
            CollectRuntime(d.Runtime);
            CollectMemory(d.Memory);
            CollectNetwork(d.Network);
            CollectBuild(d.Build);
            // d.Web is filled by IWebDeviceInfoProvider (WebGL only).

            return d;
        }

        private static void CollectSystem(DeviceInfoDto.SystemGroup g, bool includeSensitive)
        {
            g.Os = NullIfEmpty(SystemInfo.operatingSystem);
            g.OsFamily = SystemInfo.operatingSystemFamily.ToString();
            g.Cpu = NullIfEmpty(SystemInfo.processorType);
            g.Cores = Positive(SystemInfo.processorCount);
            g.CpuFreqMHz = Positive(SystemInfo.processorFrequency);
            g.MemoryMB = Positive(SystemInfo.systemMemorySize);
            g.DeviceType = SystemInfo.deviceType.ToString();

            // deviceModel can embed identifying info on some platforms -> sensitive.
            if (includeSensitive)
            {
                g.Model = NullIfEmpty(SystemInfo.deviceModel);
            }

            if (SystemInfo.batteryStatus != BatteryStatus.Unknown)
            {
                float level = SystemInfo.batteryLevel;
                if (level >= 0f)
                {
                    g.Battery = level;
                }
                g.BatteryStatus = SystemInfo.batteryStatus.ToString();
            }

            g.Locale = Application.systemLanguage.ToString();

            try
            {
                g.Timezone = NullIfEmpty(TimeZoneInfo.Local.Id);
            }
            catch (Exception e)
            {
                FlogLog.Exception(e);
            }
        }

        private static void CollectGraphics(DeviceInfoDto.GraphicsGroup g)
        {
            g.Gpu = NullIfEmpty(SystemInfo.graphicsDeviceName);
            g.Vendor = NullIfEmpty(SystemInfo.graphicsDeviceVendor);
            g.ApiVersion = NullIfEmpty(SystemInfo.graphicsDeviceVersion);
            g.DeviceType = SystemInfo.graphicsDeviceType.ToString();
            g.VramMB = Positive(SystemInfo.graphicsMemorySize);
            g.ShaderLevel = Positive(SystemInfo.graphicsShaderLevel);
            g.MaxTextureSize = Positive(SystemInfo.maxTextureSize);

            g.Supports = new Dictionary<string, object>
            {
                { "computeShaders", SystemInfo.supportsComputeShaders },
                { "instancing", SystemInfo.supportsInstancing },
                { "shadows", SystemInfo.supportsShadows },
                { "multithreaded", SystemInfo.graphicsMultiThreaded },
            };
        }

        private static void CollectDisplay(DeviceInfoDto.DisplayGroup g)
        {
            g.Screen = Screen.width + "x" + Screen.height;

            int dpi = Mathf.RoundToInt(Screen.dpi);
            if (dpi > 0)
            {
                g.Dpi = dpi;
            }

            g.Orientation = Screen.orientation.ToString();

            Rect safe = Screen.safeArea;
            g.SafeArea = FormatRect(safe);

            g.FullScreen = Screen.fullScreen;

            int refreshHz = CurrentRefreshHz();
            if (refreshHz > 0)
            {
                g.RefreshHz = refreshHz;
            }

            int displays = Display.displays != null ? Display.displays.Length : 0;
            if (displays > 0)
            {
                g.Displays = displays;
            }
        }

        private static void CollectApplication(DeviceInfoDto.ApplicationGroup g, bool includeSensitive)
        {
            g.EngineVersion = NullIfEmpty(Application.unityVersion);
            g.Platform = Application.platform.ToString();
            g.InstallMode = Application.installMode.ToString();
            g.SandboxType = Application.sandboxType.ToString();

            int target = Application.targetFrameRate;
            if (target > 0)
            {
                g.TargetFrameRate = target;
            }

            try
            {
                int qi = QualitySettings.GetQualityLevel();
                string[] names = QualitySettings.names;
                if (names != null && qi >= 0 && qi < names.Length)
                {
                    g.QualityLevel = names[qi];
                }
            }
            catch (Exception e)
            {
                FlogLog.Exception(e);
            }

            if (Application.genuineCheckAvailable)
            {
                g.Genuine = Application.genuine;
            }

            // Application id can identify the build/user context -> sensitive.
            if (includeSensitive)
            {
                g.Identifier = NullIfEmpty(Application.identifier);
            }
        }

        private static void CollectRuntime(DeviceInfoDto.RuntimeGroup g)
        {
            try
            {
                Scene active = SceneManager.GetActiveScene();
                g.Scene = NullIfEmpty(active.name);

                int count = SceneManager.sceneCount;
                if (count > 0)
                {
                    var loaded = new List<string>(count);
                    for (int i = 0; i < count; i++)
                    {
                        Scene s = SceneManager.GetSceneAt(i);
                        if (!string.IsNullOrEmpty(s.name))
                        {
                            loaded.Add(s.name);
                        }
                    }
                    if (loaded.Count > 0)
                    {
                        g.LoadedScenes = loaded;
                    }
                }
            }
            catch (Exception e)
            {
                FlogLog.Exception(e);
            }

            g.TimeScale = Time.timeScale;
            g.UptimeSec = Time.realtimeSinceStartup;
            g.FrameCount = Time.frameCount;

            float dt = Time.unscaledDeltaTime;
            if (dt > 0f)
            {
                g.Fps = Mathf.RoundToInt(1f / dt);
            }
        }

        private static void CollectMemory(DeviceInfoDto.MemoryGroup g)
        {
            const float ToMb = 1f / (1024f * 1024f);

            try
            {
                g.GcMB = GC.GetTotalMemory(false) * ToMb;
            }
            catch (Exception e)
            {
                FlogLog.Exception(e);
            }

            try
            {
                long mono = UnityEngine.Profiling.Profiler.GetMonoUsedSizeLong();
                if (mono > 0)
                {
                    g.ManagedMB = mono * ToMb;
                }

                long total = UnityEngine.Profiling.Profiler.GetTotalAllocatedMemoryLong();
                if (total > 0)
                {
                    g.TotalAllocatedMB = total * ToMb;
                }
            }
            catch (Exception e)
            {
                FlogLog.Exception(e);
            }
        }

        private static void CollectNetwork(DeviceInfoDto.NetworkGroup g)
        {
            g.Reachability = Application.internetReachability.ToString();
        }

        private static void CollectBuild(DeviceInfoDto.BuildGroup g)
        {
            try
            {
                var manifestAsset = Resources.Load<TextAsset>("UnityCloudBuildManifest.json");
                if (manifestAsset == null || string.IsNullOrEmpty(manifestAsset.text))
                {
                    return;
                }

                var parsed = MiniJson.Parse(manifestAsset.text) as Dictionary<string, object>;
                if (parsed == null)
                {
                    return;
                }

                g.Commit = NullIfEmpty(GetManifestString(parsed, "scmCommitId"));
                g.Branch = NullIfEmpty(GetManifestString(parsed, "scmBranch"));
                g.BuildNumber = NullIfEmpty(GetManifestString(parsed, "buildNumber"));
                g.BuildDate = NullIfEmpty(GetManifestString(parsed, "buildStartTime"));
            }
            catch (Exception e)
            {
                FlogLog.Exception(e);
            }
        }

        // ---- helpers ----

        private static string GetManifestString(Dictionary<string, object> map, string key)
        {
            if (map.TryGetValue(key, out var v) && v != null)
            {
                return v.ToString();
            }
            return null;
        }

        private static int CurrentRefreshHz()
        {
            try
            {
#if UNITY_2022_2_OR_NEWER
                // RefreshRate (rational) replaced the deprecated int refreshRate.
                double value = Screen.currentResolution.refreshRateRatio.value;
                return value > 0 ? Mathf.RoundToInt((float)value) : 0;
#else
                int hz = Screen.currentResolution.refreshRate;
                return hz > 0 ? hz : 0;
#endif
            }
            catch
            {
                return 0;
            }
        }

        private static string FormatRect(Rect r)
        {
            return string.Format(
                CultureInfo.InvariantCulture,
                "{0},{1},{2},{3}",
                Mathf.RoundToInt(r.x),
                Mathf.RoundToInt(r.y),
                Mathf.RoundToInt(r.width),
                Mathf.RoundToInt(r.height));
        }

        private static string NullIfEmpty(string s)
        {
            return string.IsNullOrEmpty(s) ? null : s;
        }

        private static int? Positive(int value)
        {
            return value > 0 ? (int?)value : null;
        }
    }
}
#endif
