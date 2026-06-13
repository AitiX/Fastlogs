// MiniJson - a tiny, dependency-free JSON writer/reader for FastLogs.
//
// Writer: serializes a LogReportDto to a contract-compliant JSON string.
//   - Empty / null string fields are OMITTED (never emitted as null/"").
//   - Null Nullable<T> numeric/bool fields are OMITTED.
//   - device groups with no populated fields are OMITTED entirely.
//   - Proper RFC 8259 string escaping; numbers use invariant culture.
//
// Reader: a small tolerant parser (object graph of Dictionary/List/string/
//   double/bool/null) used only to read the server's `{id,url,rawUrl,expiresAt}`
//   response. Not a general-purpose deserializer.
//
// No third-party dependencies, no reflection, allocation-conscious enough for
// occasional report uploads.

using System.Collections.Generic;
using System.Globalization;
using System.Text;

namespace PlayJoy.FastLogs
{
    internal static class MiniJson
    {
        // ============================================================
        // Writer
        // ============================================================

        /// <summary>Serialize a full report payload to a JSON string per the contract.</summary>
        public static string SerializeReport(LogReportDto report)
        {
            var sb = new StringBuilder(1024);
            var w = new Writer(sb);

            w.BeginObject();

            // Required fields. These are always written (the caller guarantees them).
            w.Raw("appId", report.AppId);
            w.Raw("platform", report.Platform);
            w.Raw("appVersion", report.AppVersion);
            w.Raw("timestampUtc", report.TimestampUtc);

            // counts (required object, always written)
            w.Key("counts");
            sb.Append('{');
            AppendIntField(sb, "error", report.Counts.Error, true);
            AppendIntField(sb, "warn", report.Counts.Warn, false);
            AppendIntField(sb, "log", report.Counts.Log, false);
            sb.Append('}');
            w.MarkWritten();

            w.Raw("logText", report.LogText ?? string.Empty, forceWrite: true);
            w.Raw("logEncoding", report.LogEncoding);

            // device (required object)
            w.Key("device");
            WriteDevice(sb, report.Device);
            w.MarkWritten();

            // Optional fields - omitted when empty.
            w.Field("screenshotPng", report.ScreenshotPngBase64);
            w.Field("retentionDays", report.RetentionDays);
            w.Field("title", report.Title);
            w.Field("comment", report.Comment);
            w.Field("tester", report.Tester);

            w.EndObject();
            return sb.ToString();
        }

        private static void WriteDevice(StringBuilder sb, DeviceInfoDto d)
        {
            sb.Append('{');
            bool first = true;

            if (d != null)
            {
                first = WriteSystem(sb, d.System, first);
                first = WriteGraphics(sb, d.Graphics, first);
                first = WriteDisplay(sb, d.Display, first);
                first = WriteApplication(sb, d.Application, first);
                first = WriteRuntime(sb, d.Runtime, first);
                first = WriteMemory(sb, d.Memory, first);
                first = WriteNetwork(sb, d.Network, first);
                first = WriteBuild(sb, d.Build, first);
                first = WriteWeb(sb, d.Web, first);
            }

            sb.Append('}');
        }

        // Each group writer returns the updated "first" flag and emits the group
        // object only if at least one of its fields is populated.

        private static bool WriteSystem(StringBuilder sb, DeviceInfoDto.SystemGroup g, bool first)
        {
            if (g == null) return first;
            var go = new GroupObject(sb, "system", first);
            go.Str("model", g.Model);
            go.Str("os", g.Os);
            go.Str("osFamily", g.OsFamily);
            go.Str("cpu", g.Cpu);
            go.Int("cores", g.Cores);
            go.Int("cpuFreqMHz", g.CpuFreqMHz);
            go.Int("memoryMB", g.MemoryMB);
            go.Str("deviceType", g.DeviceType);
            go.Float("battery", g.Battery);
            go.Str("batteryStatus", g.BatteryStatus);
            go.Str("locale", g.Locale);
            go.Str("timezone", g.Timezone);
            return go.Close();
        }

        private static bool WriteGraphics(StringBuilder sb, DeviceInfoDto.GraphicsGroup g, bool first)
        {
            if (g == null) return first;
            var go = new GroupObject(sb, "graphics", first);
            go.Str("gpu", g.Gpu);
            go.Str("vendor", g.Vendor);
            go.Str("apiVersion", g.ApiVersion);
            go.Str("deviceType", g.DeviceType);
            go.Int("vramMB", g.VramMB);
            go.Int("shaderLevel", g.ShaderLevel);
            go.Int("maxTextureSize", g.MaxTextureSize);
            go.Object("supports", g.Supports);
            return go.Close();
        }

        private static bool WriteDisplay(StringBuilder sb, DeviceInfoDto.DisplayGroup g, bool first)
        {
            if (g == null) return first;
            var go = new GroupObject(sb, "display", first);
            go.Str("screen", g.Screen);
            go.Int("dpi", g.Dpi);
            go.Str("orientation", g.Orientation);
            go.Str("safeArea", g.SafeArea);
            go.Bool("fullScreen", g.FullScreen);
            go.Int("refreshHz", g.RefreshHz);
            go.Int("displays", g.Displays);
            return go.Close();
        }

        private static bool WriteApplication(StringBuilder sb, DeviceInfoDto.ApplicationGroup g, bool first)
        {
            if (g == null) return first;
            var go = new GroupObject(sb, "application", first);
            go.Str("engineVersion", g.EngineVersion);
            go.Str("platform", g.Platform);
            go.Str("identifier", g.Identifier);
            go.Str("installMode", g.InstallMode);
            go.Str("sandboxType", g.SandboxType);
            go.Int("targetFrameRate", g.TargetFrameRate);
            go.Str("qualityLevel", g.QualityLevel);
            go.Bool("genuine", g.Genuine);
            return go.Close();
        }

        private static bool WriteRuntime(StringBuilder sb, DeviceInfoDto.RuntimeGroup g, bool first)
        {
            if (g == null) return first;
            var go = new GroupObject(sb, "runtime", first);
            go.Str("scene", g.Scene);
            go.StrArray("loadedScenes", g.LoadedScenes);
            go.Float("timeScale", g.TimeScale);
            go.Float("uptimeSec", g.UptimeSec);
            go.Int("fps", g.Fps);
            go.Int("frameCount", g.FrameCount);
            return go.Close();
        }

        private static bool WriteMemory(StringBuilder sb, DeviceInfoDto.MemoryGroup g, bool first)
        {
            if (g == null) return first;
            var go = new GroupObject(sb, "memory", first);
            go.Float("managedMB", g.ManagedMB);
            go.Float("totalAllocatedMB", g.TotalAllocatedMB);
            go.Float("gcMB", g.GcMB);
            return go.Close();
        }

        private static bool WriteNetwork(StringBuilder sb, DeviceInfoDto.NetworkGroup g, bool first)
        {
            if (g == null) return first;
            var go = new GroupObject(sb, "network", first);
            go.Str("reachability", g.Reachability);
            return go.Close();
        }

        private static bool WriteBuild(StringBuilder sb, DeviceInfoDto.BuildGroup g, bool first)
        {
            if (g == null) return first;
            var go = new GroupObject(sb, "build", first);
            go.Str("commit", g.Commit);
            go.Str("branch", g.Branch);
            go.Str("buildNumber", g.BuildNumber);
            go.Str("buildDate", g.BuildDate);
            return go.Close();
        }

        private static bool WriteWeb(StringBuilder sb, DeviceInfoDto.WebGroup g, bool first)
        {
            if (g == null) return first;
            var go = new GroupObject(sb, "web", first);
            go.Str("userAgent", g.UserAgent);
            go.Str("url", g.Url);
            go.Str("referrer", g.Referrer);
            go.Str("language", g.Language);
            go.Int("hardwareConcurrency", g.HardwareConcurrency);
            go.Float("deviceMemoryGB", g.DeviceMemoryGB);
            go.Str("connection", g.Connection);
            return go.Close();
        }

        // Helper that buffers a group object and only commits it to the parent
        // StringBuilder if at least one field was written.
        private struct GroupObject
        {
            private readonly StringBuilder _parent;
            private readonly string _name;
            private readonly bool _firstInParent;
            private readonly StringBuilder _body;
            private bool _hasContent;

            public GroupObject(StringBuilder parent, string name, bool firstInParent)
            {
                _parent = parent;
                _name = name;
                _firstInParent = firstInParent;
                _body = new StringBuilder(128);
                _hasContent = false;
            }

            private void Sep()
            {
                if (_hasContent) _body.Append(',');
            }

            public void Str(string key, string value)
            {
                if (string.IsNullOrEmpty(value)) return;
                Sep();
                AppendKey(_body, key);
                AppendString(_body, value);
                _hasContent = true;
            }

            public void Int(string key, int? value)
            {
                if (!value.HasValue) return;
                Sep();
                AppendKey(_body, key);
                _body.Append(value.Value.ToString(CultureInfo.InvariantCulture));
                _hasContent = true;
            }

            public void Float(string key, float? value)
            {
                if (!value.HasValue) return;
                Sep();
                AppendKey(_body, key);
                AppendFloat(_body, value.Value);
                _hasContent = true;
            }

            public void Bool(string key, bool? value)
            {
                if (!value.HasValue) return;
                Sep();
                AppendKey(_body, key);
                _body.Append(value.Value ? "true" : "false");
                _hasContent = true;
            }

            public void StrArray(string key, List<string> values)
            {
                if (values == null || values.Count == 0) return;
                Sep();
                AppendKey(_body, key);
                _body.Append('[');
                for (int i = 0; i < values.Count; i++)
                {
                    if (i > 0) _body.Append(',');
                    AppendString(_body, values[i] ?? string.Empty);
                }
                _body.Append(']');
                _hasContent = true;
            }

            public void Object(string key, Dictionary<string, object> map)
            {
                if (map == null || map.Count == 0) return;
                Sep();
                AppendKey(_body, key);
                AppendValue(_body, map);
                _hasContent = true;
            }

            /// <summary>Commit the group if it has content. Returns updated "first" flag.</summary>
            public bool Close()
            {
                if (!_hasContent) return _firstInParent;
                if (!_firstInParent) _parent.Append(',');
                AppendKey(_parent, _name);
                _parent.Append('{');
                _parent.Append(_body);
                _parent.Append('}');
                return false;
            }
        }

        // Thin writer over the top-level object - tracks comma placement.
        private struct Writer
        {
            private readonly StringBuilder _sb;
            private bool _first;

            public Writer(StringBuilder sb)
            {
                _sb = sb;
                _first = true;
            }

            public void BeginObject() { _sb.Append('{'); _first = true; }
            public void EndObject() { _sb.Append('}'); }

            private void Sep()
            {
                if (!_first) _sb.Append(',');
                _first = false;
            }

            // Write a key and leave the value to be appended by caller.
            public void Key(string key)
            {
                Sep();
                AppendKey(_sb, key);
            }

            // Called after manually appending a value following Key().
            public void MarkWritten() { /* _first already cleared by Key/Sep */ }

            // Write a required-or-optional string field. forceWrite emits even
            // when empty (for required fields like logText).
            public void Raw(string key, string value, bool forceWrite = true)
            {
                if (!forceWrite && string.IsNullOrEmpty(value)) return;
                Sep();
                AppendKey(_sb, key);
                AppendString(_sb, value ?? string.Empty);
            }

            // Optional string - omitted when empty.
            public void Field(string key, string value)
            {
                if (string.IsNullOrEmpty(value)) return;
                Sep();
                AppendKey(_sb, key);
                AppendString(_sb, value);
            }

            // Optional int - omitted when null.
            public void Field(string key, int? value)
            {
                if (!value.HasValue) return;
                Sep();
                AppendKey(_sb, key);
                _sb.Append(value.Value.ToString(CultureInfo.InvariantCulture));
            }
        }

        private static void AppendIntField(StringBuilder sb, string key, int value, bool first)
        {
            if (!first) sb.Append(',');
            AppendKey(sb, key);
            sb.Append(value.ToString(CultureInfo.InvariantCulture));
        }

        private static void AppendKey(StringBuilder sb, string key)
        {
            AppendString(sb, key);
            sb.Append(':');
        }

        private static void AppendFloat(StringBuilder sb, float value)
        {
            // "R" round-trip; guard non-finite to keep JSON valid.
            if (float.IsNaN(value) || float.IsInfinity(value))
            {
                sb.Append('0');
                return;
            }
            sb.Append(value.ToString("R", CultureInfo.InvariantCulture));
        }

        // Generic value appender used for the free-form `supports` object.
        private static void AppendValue(StringBuilder sb, object value)
        {
            switch (value)
            {
                case null:
                    sb.Append("null");
                    break;
                case string s:
                    AppendString(sb, s);
                    break;
                case bool b:
                    sb.Append(b ? "true" : "false");
                    break;
                case float f:
                    AppendFloat(sb, f);
                    break;
                case double d:
                    if (double.IsNaN(d) || double.IsInfinity(d)) sb.Append('0');
                    else sb.Append(d.ToString("R", CultureInfo.InvariantCulture));
                    break;
                case int i:
                    sb.Append(i.ToString(CultureInfo.InvariantCulture));
                    break;
                case long l:
                    sb.Append(l.ToString(CultureInfo.InvariantCulture));
                    break;
                case IDictionary<string, object> map:
                {
                    sb.Append('{');
                    bool first = true;
                    foreach (var kv in map)
                    {
                        if (!first) sb.Append(',');
                        first = false;
                        AppendKey(sb, kv.Key);
                        AppendValue(sb, kv.Value);
                    }
                    sb.Append('}');
                    break;
                }
                case IEnumerable<object> list:
                {
                    sb.Append('[');
                    bool first = true;
                    foreach (var item in list)
                    {
                        if (!first) sb.Append(',');
                        first = false;
                        AppendValue(sb, item);
                    }
                    sb.Append(']');
                    break;
                }
                default:
                    // Fallback: stringify unknown types.
                    AppendString(sb, value.ToString());
                    break;
            }
        }

        private static void AppendString(StringBuilder sb, string s)
        {
            sb.Append('"');
            if (s != null)
            {
                int len = s.Length;
                for (int i = 0; i < len; i++)
                {
                    char c = s[i];
                    switch (c)
                    {
                        case '"': sb.Append("\\\""); break;
                        case '\\': sb.Append("\\\\"); break;
                        case '\b': sb.Append("\\b"); break;
                        case '\f': sb.Append("\\f"); break;
                        case '\n': sb.Append("\\n"); break;
                        case '\r': sb.Append("\\r"); break;
                        case '\t': sb.Append("\\t"); break;
                        default:
                            if (c < ' ')
                            {
                                sb.Append("\\u");
                                sb.Append(((int)c).ToString("x4", CultureInfo.InvariantCulture));
                            }
                            else
                            {
                                sb.Append(c);
                            }
                            break;
                    }
                }
            }
            sb.Append('"');
        }

        // ============================================================
        // Reader (minimal, tolerant)
        // ============================================================

        /// <summary>
        /// Parse the server upload response and extract the contract fields.
        /// Returns true on a structurally valid object response.
        /// </summary>
        public static bool TryParseUploadResponse(string json, out string id, out string url, out string rawUrl, out string expiresAt, out string error, out string message)
        {
            id = url = rawUrl = expiresAt = error = message = null;

            object parsed = Parse(json);
            if (!(parsed is Dictionary<string, object> obj))
            {
                return false;
            }

            id = GetString(obj, "id");
            url = GetString(obj, "url");
            rawUrl = GetString(obj, "rawUrl");
            expiresAt = GetString(obj, "expiresAt");
            error = GetString(obj, "error");
            message = GetString(obj, "message");
            return true;
        }

        private static string GetString(Dictionary<string, object> obj, string key)
        {
            if (obj.TryGetValue(key, out var v) && v is string s)
            {
                return s;
            }
            return null;
        }

        /// <summary>Parse arbitrary JSON into Dictionary/List/string/double/bool/null. Null on error.</summary>
        public static object Parse(string json)
        {
            if (string.IsNullOrEmpty(json))
            {
                return null;
            }

            int index = 0;
            try
            {
                object value = ParseValue(json, ref index);
                return value;
            }
            catch
            {
                return null;
            }
        }

        private static object ParseValue(string s, ref int i)
        {
            SkipWhitespace(s, ref i);
            if (i >= s.Length) return null;
            char c = s[i];
            switch (c)
            {
                case '{': return ParseObject(s, ref i);
                case '[': return ParseArray(s, ref i);
                case '"': return ParseString(s, ref i);
                case 't':
                case 'f': return ParseBool(s, ref i);
                case 'n': ParseLiteral(s, ref i, "null"); return null;
                default: return ParseNumber(s, ref i);
            }
        }

        private static Dictionary<string, object> ParseObject(string s, ref int i)
        {
            var result = new Dictionary<string, object>();
            i++; // '{'
            while (true)
            {
                SkipWhitespace(s, ref i);
                if (i >= s.Length) break;
                if (s[i] == '}') { i++; break; }
                if (s[i] == ',') { i++; continue; }

                string key = ParseString(s, ref i);
                SkipWhitespace(s, ref i);
                if (i < s.Length && s[i] == ':') i++;
                object value = ParseValue(s, ref i);
                result[key] = value;
            }
            return result;
        }

        private static List<object> ParseArray(string s, ref int i)
        {
            var result = new List<object>();
            i++; // '['
            while (true)
            {
                SkipWhitespace(s, ref i);
                if (i >= s.Length) break;
                if (s[i] == ']') { i++; break; }
                if (s[i] == ',') { i++; continue; }
                result.Add(ParseValue(s, ref i));
            }
            return result;
        }

        private static string ParseString(string s, ref int i)
        {
            var sb = new StringBuilder();
            i++; // opening quote
            while (i < s.Length)
            {
                char c = s[i++];
                if (c == '"') break;
                if (c == '\\' && i < s.Length)
                {
                    char e = s[i++];
                    switch (e)
                    {
                        case '"': sb.Append('"'); break;
                        case '\\': sb.Append('\\'); break;
                        case '/': sb.Append('/'); break;
                        case 'b': sb.Append('\b'); break;
                        case 'f': sb.Append('\f'); break;
                        case 'n': sb.Append('\n'); break;
                        case 'r': sb.Append('\r'); break;
                        case 't': sb.Append('\t'); break;
                        case 'u':
                            if (i + 4 <= s.Length)
                            {
                                var hex = s.Substring(i, 4);
                                if (int.TryParse(hex, NumberStyles.HexNumber, CultureInfo.InvariantCulture, out int code))
                                {
                                    sb.Append((char)code);
                                }
                                i += 4;
                            }
                            break;
                        default: sb.Append(e); break;
                    }
                }
                else
                {
                    sb.Append(c);
                }
            }
            return sb.ToString();
        }

        private static object ParseBool(string s, ref int i)
        {
            if (s[i] == 't')
            {
                ParseLiteral(s, ref i, "true");
                return true;
            }
            ParseLiteral(s, ref i, "false");
            return false;
        }

        private static void ParseLiteral(string s, ref int i, string literal)
        {
            i += literal.Length;
        }

        private static object ParseNumber(string s, ref int i)
        {
            int start = i;
            while (i < s.Length)
            {
                char c = s[i];
                if (c == '-' || c == '+' || c == '.' || c == 'e' || c == 'E' || (c >= '0' && c <= '9'))
                {
                    i++;
                }
                else
                {
                    break;
                }
            }
            string num = s.Substring(start, i - start);
            if (double.TryParse(num, NumberStyles.Any, CultureInfo.InvariantCulture, out double d))
            {
                return d;
            }
            return 0d;
        }

        private static void SkipWhitespace(string s, ref int i)
        {
            while (i < s.Length && char.IsWhiteSpace(s[i]))
            {
                i++;
            }
        }
    }
}
