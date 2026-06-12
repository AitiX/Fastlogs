// Grouped device snapshot, mapped 1:1 to the `device` object in the wire contract.
//
// Contract rule: empty / unavailable fields are OMITTED (never sent as null or 0).
// To honour that with a dependency-free serializer, every optional field is a
// reference type or a Nullable<T>. MiniJson skips null values automatically, so
// the collector only needs to assign the fields it can actually read on the
// current platform.
//
// Groups are intentionally extensible: keys are platform-dependent and new groups
// can be added without breaking the contract.

using System.Collections.Generic;

namespace PlayJoy.FastLogs
{
    /// <summary>
    /// Full device snapshot. Each group corresponds to a contract `device.*` object.
    /// Null fields are omitted on serialization (per contract invariant #3).
    /// </summary>
    public sealed class DeviceInfoDto
    {
        public SystemGroup System = new SystemGroup();
        public GraphicsGroup Graphics = new GraphicsGroup();
        public DisplayGroup Display = new DisplayGroup();
        public ApplicationGroup Application = new ApplicationGroup();
        public RuntimeGroup Runtime = new RuntimeGroup();
        public MemoryGroup Memory = new MemoryGroup();
        public NetworkGroup Network = new NetworkGroup();
        public BuildGroup Build = new BuildGroup();
        public WebGroup Web = new WebGroup();

        /// <summary>device.system</summary>
        public sealed class SystemGroup
        {
            public string Model;
            public string Os;
            public string OsFamily;
            public string Cpu;
            public int? Cores;
            public int? CpuFreqMHz;
            public int? MemoryMB;
            public string DeviceType;
            public float? Battery;
            public string BatteryStatus;
            public string Locale;
            public string Timezone;
        }

        /// <summary>device.graphics</summary>
        public sealed class GraphicsGroup
        {
            public string Gpu;
            public string Vendor;
            public string ApiVersion;
            public string DeviceType;
            public int? VramMB;
            public int? ShaderLevel;
            public int? MaxTextureSize;

            // Free-form capability flags (e.g. compute shaders, instancing).
            // Serialized as a nested object; omitted entirely when empty.
            public Dictionary<string, object> Supports;
        }

        /// <summary>device.display</summary>
        public sealed class DisplayGroup
        {
            public string Screen;     // "1080x2400"
            public int? Dpi;
            public string Orientation;
            public string SafeArea;   // "x,y,w,h"
            public bool? FullScreen;
            public int? RefreshHz;
            public int? Displays;
        }

        /// <summary>device.application</summary>
        public sealed class ApplicationGroup
        {
            public string EngineVersion;
            public string Platform;
            public string Identifier;   // sensitive-gated
            public string InstallMode;
            public string SandboxType;
            public int? TargetFrameRate;
            public string QualityLevel;
            public bool? Genuine;
        }

        /// <summary>device.runtime</summary>
        public sealed class RuntimeGroup
        {
            public string Scene;
            public List<string> LoadedScenes;
            public float? TimeScale;
            public float? UptimeSec;
            public int? Fps;
            public int? FrameCount;
        }

        /// <summary>device.memory</summary>
        public sealed class MemoryGroup
        {
            public float? ManagedMB;
            public float? TotalAllocatedMB;
            public float? GcMB;
        }

        /// <summary>device.network</summary>
        public sealed class NetworkGroup
        {
            public string Reachability;
        }

        /// <summary>device.build (cloud build manifest / SCM)</summary>
        public sealed class BuildGroup
        {
            public string Commit;
            public string Branch;
            public string BuildNumber;
            public string BuildDate;
        }

        /// <summary>device.web (WebGL-only; filled from the jslib bridge)</summary>
        public sealed class WebGroup
        {
            public string UserAgent;
            public string Url;        // sensitive-gated
            public string Referrer;   // sensitive-gated
            public string Language;
            public int? HardwareConcurrency;
            public float? DeviceMemoryGB;
            public string Connection;
        }
    }
}
