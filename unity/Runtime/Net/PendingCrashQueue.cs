// PendingCrashQueue - durable, crash-safe outbox for auto-sent crash reports
// (feature #1).
//
// Why: a hard crash (or an unhandled exception that kills the process) can die
// before the upload HTTP round-trip finishes. To make crash reports survive that,
// the runtime - when it auto-sends on an unhandled exception - FIRST writes the
// report payload synchronously to disk here, THEN attempts the normal upload. On a
// successful upload the file is removed. On the NEXT app start, FastLogs.Init scans
// this queue and re-sends anything still pending, so even a report whose process
// died mid-upload eventually arrives.
//
// Storage: Application.persistentDataPath/FastLogs/pending/<id>.json . Each file is
// the contract-shaped JSON body (already PII-scrubbed, logEncoding = "plain", and
// WITHOUT a screenshot - screenshots are heavy and a crashed frame is rarely useful,
// per the AutoSend default). The newest files are kept up to a small cap; older
// files beyond the cap are trimmed so the outbox never grows without bound.
//
// Resend path: parses the persisted JSON back into a LogReportDto (via the generic
// MiniJson parser) and re-sends it through the SAME ILogUploader the runtime uses,
// honoring any custom uploader / gzip / token settings. Resend runs as a coroutine
// on the shared FlogCoroutineHost so Init is never blocked.
//
// Gated; removed in retail/console builds.

#if UNITY_EDITOR || DEVELOPMENT_BUILD || (LOGSHARE_FORCE_ENABLED && !(UNITY_PS4 || UNITY_PS5 || UNITY_GAMECORE || UNITY_SWITCH))
#define FASTLOGS_ENABLED
#endif

#if FASTLOGS_ENABLED
using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Text;
using UnityEngine;

namespace PlayJoy.FastLogs
{
    /// <summary>
    /// Disk-backed outbox for crash reports. Write before send, delete on success,
    /// resend leftovers on next start.
    /// </summary>
    internal sealed class PendingCrashQueue
    {
        private const string FolderName = "FastLogs";
        private const string SubFolder = "pending";
        private const string Extension = ".json";

        private readonly int _maxFiles; // hard cap on retained pending files
        private readonly string _dir;

        // True while a ResendRoutine is in flight. Guards against overlapping drains:
        // ResendAll is now called both on start AND on every idle Complete, and two
        // concurrent passes would each snapshot the same files and double-send / race on
        // delete. Single-threaded (main-thread coroutine), so a plain bool is enough.
        private bool _resendInProgress;

        public PendingCrashQueue(int maxFiles)
        {
            _maxFiles = maxFiles > 0 ? maxFiles : 5;

            string root;
            try { root = Application.persistentDataPath; }
            catch { root = string.Empty; }

            string baseDir = string.IsNullOrEmpty(root) ? FolderName : Path.Combine(root, FolderName);
            _dir = Path.Combine(baseDir, SubFolder);
        }

        // ============================================================
        // Persist (synchronous, called on the crash path BEFORE upload)
        // ============================================================

        /// <summary>
        /// Synchronously serialize and write the report to the pending queue, returning
        /// the file path (or null on failure). The report must already be scrubbed and
        /// carry logEncoding = "plain" with no screenshot. Fast and best-effort: any IO
        /// error is swallowed (logged) so the crash path is never blocked or thrown out
        /// of.
        /// </summary>
        public string Persist(LogReportDto report)
        {
            if (report == null)
            {
                return null;
            }

            try
            {
                EnsureDirectory();

                string id = NewId();
                string path = Path.Combine(_dir, id + Extension);

                // Persist the contract-shaped JSON (no screenshot - the caller strips it).
                string json = MiniJson.SerializeReport(report);

                // Write atomically-ish: temp file then move, so a crash mid-write can
                // never leave a half-written file that the resend scan would choke on.
                string tmp = path + ".tmp";
                File.WriteAllText(tmp, json, new UTF8Encoding(false));
                if (File.Exists(path))
                {
                    File.Delete(path);
                }
                File.Move(tmp, path);

                TrimToCap();
                return path;
            }
            catch (Exception e)
            {
                FlogLog.Exception(e);
                return null;
            }
        }

        /// <summary>Delete a specific pending file (after its upload succeeded).</summary>
        public void Remove(string path)
        {
            if (string.IsNullOrEmpty(path))
            {
                return;
            }
            try
            {
                if (File.Exists(path))
                {
                    File.Delete(path);
                }
            }
            catch (Exception e)
            {
                FlogLog.Exception(e);
            }
        }

        // ============================================================
        // Resend (coroutine, called from Init - never blocks startup)
        // ============================================================

        /// <summary>
        /// Scan the queue and resend each pending report through the given uploader.
        /// Successful sends delete their file; failures are left for a future start.
        /// Runs as a coroutine on the shared host so Init returns immediately.
        /// </summary>
        public void ResendAll(ILogUploader uploader, FastLogsConfig config)
        {
            if (uploader == null)
            {
                return;
            }
            // Idempotent: if a drain is already running, do nothing. The running pass
            // will pick up anything currently on disk; a new file added afterwards is
            // caught by the next idle drain or the next start.
            if (_resendInProgress)
            {
                return;
            }
            try
            {
                _resendInProgress = true;
                FlogCoroutineHost.Run(ResendRoutine(uploader, config));
            }
            catch (Exception e)
            {
                // Failed to even start the coroutine: clear the flag so a later call can
                // retry (the routine's finally never runs if Run threw).
                _resendInProgress = false;
                FlogLog.Exception(e);
            }
        }

        private IEnumerator ResendRoutine(ILogUploader uploader, FastLogsConfig config)
        {
            // Gather the pending files first (no yield inside a try/catch - the C#
            // iterator rules forbid that, so the IO is fully scoped in a helper).
            string[] files = ListPendingFiles();
            if (files == null || files.Length == 0)
            {
                _resendInProgress = false;
                yield break;
            }

            // From here on, guarantee the in-progress flag is cleared on every exit path
            // (normal end or StopCoroutine on host teardown). try/finally WITH a yield in
            // the try is legal in a C# iterator (only try/CATCH with a yield is not).
            try
            {
                // Oldest first so reports arrive roughly in the order they occurred.
                Array.Sort(files, CompareByWriteTime);

                for (int i = 0; i < files.Length; i++)
                {
                    string path = files[i];

                    LogReportDto report = ReadReport(path);

                    if (report == null)
                    {
                        // Unparseable (corrupt/half-written): drop it so it does not linger.
                        Remove(path);
                        continue;
                    }

                    FlogTask<UploadResultDto> task = null;
                    try { task = uploader.UploadAsync(report, config); }
                    catch (Exception e) { FlogLog.Exception(e); }

                    if (task == null)
                    {
                        continue; // leave the file; try again next start
                    }

                    while (!task.IsCompleted)
                    {
                        yield return null;
                    }

                    bool success = !task.IsFaulted && task.Result.Success;
                    if (success)
                    {
                        Remove(path);
                        FlogLog.Info("Resent a pending crash report from a previous session.");
                    }
                    else if (!task.IsFaulted && !task.Result.Retryable)
                    {
                        // POISON PILL: the server rejected this report with a permanent,
                        // non-transient error (4xx: 400/401/403/413/415 - Retryable == false).
                        // Re-sending it can never succeed, so drop it from the outbox instead
                        // of retrying it forever on every idle drain / next start. We only
                        // delete on a definite permanent rejection: a faulted task (transport
                        // blew up) or a Retryable failure (network / statusCode 0 / 5xx) is
                        // kept on disk for a future attempt.
                        Remove(path);
                        FlogLog.Info("Dropped a pending crash report rejected permanently by the server (status "
                            + task.Result.StatusCode + ").");
                    }
                    // On a transient failure (faulted, network, statusCode 0, or 5xx), keep
                    // the file for a future drain/start (do not delete).

                    // Be gentle: one frame between sends so a backlog does not hammer the
                    // network on startup.
                    yield return null;
                }
            }
            finally
            {
                _resendInProgress = false;
            }
        }

        // ============================================================
        // Internals
        // ============================================================

        // Snapshot the pending files (IO scoped here so the coroutine can yield freely).
        private string[] ListPendingFiles()
        {
            try
            {
                if (!Directory.Exists(_dir))
                {
                    return null;
                }
                return Directory.GetFiles(_dir, "*" + Extension);
            }
            catch (Exception e)
            {
                FlogLog.Exception(e);
                return null;
            }
        }

        // Read + parse one pending file. Null on missing/corrupt (caller drops it).
        private LogReportDto ReadReport(string path)
        {
            try
            {
                string json = File.ReadAllText(path, new UTF8Encoding(false));
                return TryDeserialize(json);
            }
            catch (Exception e)
            {
                FlogLog.Exception(e);
                return null;
            }
        }

        private void EnsureDirectory()
        {
            if (!string.IsNullOrEmpty(_dir) && !Directory.Exists(_dir))
            {
                Directory.CreateDirectory(_dir);
            }
        }

        // Keep only the newest _maxFiles pending files; delete the rest.
        private void TrimToCap()
        {
            try
            {
                if (!Directory.Exists(_dir))
                {
                    return;
                }
                string[] files = Directory.GetFiles(_dir, "*" + Extension);
                if (files.Length <= _maxFiles)
                {
                    return;
                }

                // Newest last -> delete from the front (oldest) until within cap.
                Array.Sort(files, CompareByWriteTime);
                int toDelete = files.Length - _maxFiles;
                for (int i = 0; i < toDelete; i++)
                {
                    Remove(files[i]);
                }
            }
            catch (Exception e)
            {
                FlogLog.Exception(e);
            }
        }

        private static int CompareByWriteTime(string a, string b)
        {
            DateTime ta = SafeWriteTime(a);
            DateTime tb = SafeWriteTime(b);
            return ta.CompareTo(tb);
        }

        private static DateTime SafeWriteTime(string path)
        {
            try { return File.GetLastWriteTimeUtc(path); }
            catch { return DateTime.MinValue; }
        }

        private static string NewId()
        {
            // Sortable-ish + unique: UTC tick prefix then a short guid chunk.
            string ticks = DateTime.UtcNow.Ticks.ToString("D19", CultureInfo.InvariantCulture);
            string guid = Guid.NewGuid().ToString("N").Substring(0, 8);
            return ticks + "_" + guid;
        }

        // ---- JSON -> LogReportDto (only the fields we persist) ----

        // Rebuilds a report from the persisted contract JSON using the tolerant generic
        // parser. We only persist what we control, so this maps a fixed, known shape.
        private static LogReportDto TryDeserialize(string json)
        {
            object parsed = MiniJson.Parse(json);
            if (!(parsed is Dictionary<string, object> obj))
            {
                return null;
            }

            var report = new LogReportDto
            {
                AppId = Str(obj, "appId"),
                Platform = Str(obj, "platform"),
                AppVersion = Str(obj, "appVersion"),
                TimestampUtc = Str(obj, "timestampUtc"),
                LogText = Str(obj, "logText"),
                LogEncoding = Str(obj, "logEncoding"),
                Title = Str(obj, "title"),
                Comment = Str(obj, "comment"),
                Tester = Str(obj, "tester"),
                // Restore the ORIGINAL session's id so a drained crash report stays
                // grouped with the run it was captured in (not the new run draining it).
                SessionId = Str(obj, "sessionId")
            };

            // counts
            if (obj.TryGetValue("counts", out var cv) && cv is Dictionary<string, object> counts)
            {
                report.Counts = new CountsDto(
                    Int(counts, "error"),
                    Int(counts, "warn"),
                    Int(counts, "log"));
            }

            // retentionDays
            if (obj.TryGetValue("retentionDays", out var rv) && rv is double rd)
            {
                report.RetentionDays = (int)rd;
            }

            // device (generic -> DeviceInfoDto). We rebuild the grouped DTO from the
            // parsed object so the uploader re-serializes it identically.
            if (obj.TryGetValue("device", out var dv) && dv is Dictionary<string, object> dev)
            {
                report.Device = DeviceFromParsed(dev);
            }

            // context (string -> string)
            if (obj.TryGetValue("context", out var ctxv) && ctxv is Dictionary<string, object> ctx && ctx.Count > 0)
            {
                var map = new Dictionary<string, string>(ctx.Count, StringComparer.Ordinal);
                foreach (var kv in ctx)
                {
                    if (!string.IsNullOrEmpty(kv.Key))
                    {
                        map[kv.Key] = kv.Value as string ?? (kv.Value != null ? kv.Value.ToString() : string.Empty);
                    }
                }
                if (map.Count > 0)
                {
                    report.Context = map;
                }
            }

            // breadcrumbs (array of { t, m, lvl })
            if (obj.TryGetValue("breadcrumbs", out var bcv) && bcv is List<object> crumbs && crumbs.Count > 0)
            {
                var list = new List<BreadcrumbDto>(crumbs.Count);
                for (int i = 0; i < crumbs.Count; i++)
                {
                    if (crumbs[i] is Dictionary<string, object> c)
                    {
                        list.Add(new BreadcrumbDto
                        {
                            TimeUtc = Str(c, "t"),
                            Message = Str(c, "m"),
                            Level = Str(c, "lvl")
                        });
                    }
                }
                if (list.Count > 0)
                {
                    report.Breadcrumbs = list;
                }
            }

            return report;
        }

        // Reconstruct the grouped device DTO from the parsed generic object. Only the
        // group keys we serialize are mapped; unknown keys are ignored. Each group is
        // only created when present in the JSON.
        private static DeviceInfoDto DeviceFromParsed(Dictionary<string, object> dev)
        {
            var d = new DeviceInfoDto();

            if (Group(dev, "system", out var sys))
            {
                d.System.Model = Str(sys, "model");
                d.System.Os = Str(sys, "os");
                d.System.OsFamily = Str(sys, "osFamily");
                d.System.Cpu = Str(sys, "cpu");
                d.System.Cores = NInt(sys, "cores");
                d.System.CpuFreqMHz = NInt(sys, "cpuFreqMHz");
                d.System.MemoryMB = NInt(sys, "memoryMB");
                d.System.DeviceType = Str(sys, "deviceType");
                d.System.Battery = NFloat(sys, "battery");
                d.System.BatteryStatus = Str(sys, "batteryStatus");
                d.System.Locale = Str(sys, "locale");
                d.System.Timezone = Str(sys, "timezone");
            }

            if (Group(dev, "graphics", out var gfx))
            {
                d.Graphics.Gpu = Str(gfx, "gpu");
                d.Graphics.Vendor = Str(gfx, "vendor");
                d.Graphics.ApiVersion = Str(gfx, "apiVersion");
                d.Graphics.DeviceType = Str(gfx, "deviceType");
                d.Graphics.VramMB = NInt(gfx, "vramMB");
                d.Graphics.ShaderLevel = NInt(gfx, "shaderLevel");
                d.Graphics.MaxTextureSize = NInt(gfx, "maxTextureSize");
                if (gfx.TryGetValue("supports", out var sup) && sup is Dictionary<string, object> supMap && supMap.Count > 0)
                {
                    d.Graphics.Supports = supMap;
                }
            }

            if (Group(dev, "display", out var disp))
            {
                d.Display.Screen = Str(disp, "screen");
                d.Display.Dpi = NInt(disp, "dpi");
                d.Display.Orientation = Str(disp, "orientation");
                d.Display.SafeArea = Str(disp, "safeArea");
                d.Display.FullScreen = NBool(disp, "fullScreen");
                d.Display.RefreshHz = NInt(disp, "refreshHz");
                d.Display.Displays = NInt(disp, "displays");
            }

            if (Group(dev, "application", out var app))
            {
                d.Application.EngineVersion = Str(app, "engineVersion");
                d.Application.Platform = Str(app, "platform");
                d.Application.Identifier = Str(app, "identifier");
                d.Application.InstallMode = Str(app, "installMode");
                d.Application.SandboxType = Str(app, "sandboxType");
                d.Application.TargetFrameRate = NInt(app, "targetFrameRate");
                d.Application.QualityLevel = Str(app, "qualityLevel");
                d.Application.Genuine = NBool(app, "genuine");
            }

            if (Group(dev, "runtime", out var rt))
            {
                d.Runtime.Scene = Str(rt, "scene");
                if (rt.TryGetValue("loadedScenes", out var ls) && ls is List<object> scenes && scenes.Count > 0)
                {
                    var names = new List<string>(scenes.Count);
                    for (int i = 0; i < scenes.Count; i++)
                    {
                        if (scenes[i] is string sn && !string.IsNullOrEmpty(sn))
                        {
                            names.Add(sn);
                        }
                    }
                    if (names.Count > 0)
                    {
                        d.Runtime.LoadedScenes = names;
                    }
                }
                d.Runtime.TimeScale = NFloat(rt, "timeScale");
                d.Runtime.UptimeSec = NFloat(rt, "uptimeSec");
                d.Runtime.Fps = NInt(rt, "fps");
                d.Runtime.FrameCount = NInt(rt, "frameCount");
            }

            if (Group(dev, "memory", out var mem))
            {
                d.Memory.ManagedMB = NFloat(mem, "managedMB");
                d.Memory.TotalAllocatedMB = NFloat(mem, "totalAllocatedMB");
                d.Memory.GcMB = NFloat(mem, "gcMB");
            }

            if (Group(dev, "network", out var net))
            {
                d.Network.Reachability = Str(net, "reachability");
            }

            if (Group(dev, "build", out var bld))
            {
                d.Build.Commit = Str(bld, "commit");
                d.Build.Branch = Str(bld, "branch");
                d.Build.BuildNumber = Str(bld, "buildNumber");
                d.Build.BuildDate = Str(bld, "buildDate");
            }

            if (Group(dev, "web", out var web))
            {
                d.Web.UserAgent = Str(web, "userAgent");
                d.Web.Url = Str(web, "url");
                d.Web.Referrer = Str(web, "referrer");
                d.Web.Language = Str(web, "language");
                d.Web.HardwareConcurrency = NInt(web, "hardwareConcurrency");
                d.Web.DeviceMemoryGB = NFloat(web, "deviceMemoryGB");
                d.Web.Connection = Str(web, "connection");
            }

            return d;
        }

        private static bool Group(Dictionary<string, object> parent, string key, out Dictionary<string, object> group)
        {
            if (parent.TryGetValue(key, out var v) && v is Dictionary<string, object> g)
            {
                group = g;
                return true;
            }
            group = null;
            return false;
        }

        private static string Str(Dictionary<string, object> obj, string key)
        {
            return obj.TryGetValue(key, out var v) && v is string s ? s : null;
        }

        private static int Int(Dictionary<string, object> obj, string key)
        {
            return obj.TryGetValue(key, out var v) && v is double d ? (int)d : 0;
        }

        private static int? NInt(Dictionary<string, object> obj, string key)
        {
            return obj.TryGetValue(key, out var v) && v is double d ? (int?)(int)d : null;
        }

        private static float? NFloat(Dictionary<string, object> obj, string key)
        {
            return obj.TryGetValue(key, out var v) && v is double d ? (float?)(float)d : null;
        }

        private static bool? NBool(Dictionary<string, object> obj, string key)
        {
            return obj.TryGetValue(key, out var v) && v is bool b ? (bool?)b : null;
        }
    }
}
#endif
