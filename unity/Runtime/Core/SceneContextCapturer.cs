// SceneContextCapturer - builds a compact JSON snapshot of the runtime scene hierarchy
// (all loaded scenes + DontDestroyOnLoad -> GameObjects -> components -> serialized fields).
// Used by the scene-context FastLogs feature. Reflection-heavy and bounded by the
// SceneContextSection limits; intended for manual/one-shot use, NEVER per-frame.
//
// Output shape (a JSON string, stored opaquely server-side, rendered as a tree by the viewer):
//   { "scenes":[ {"name":str,"ddol":bool,"roots":[GO]} ],
//     "stats":{"scenes":int,"objects":int,"components":int}, "truncated":bool }
//   GO   = {"n":name,"a":active,"tag":str,"layer":int,"comp":[COMP],"kids":[GO]}
//   COMP = {"t":typeName,"en":(bool|null),"f":{field:value,...}}

#if UNITY_EDITOR || DEVELOPMENT_BUILD || (LOGSHARE_FORCE_ENABLED && !(UNITY_PS4 || UNITY_PS5 || UNITY_GAMECORE || UNITY_SWITCH))
#define FASTLOGS_ENABLED
#endif

#if FASTLOGS_ENABLED
using System;
using System.Collections;
using System.Globalization;
using System.Reflection;
using System.Text;
using UnityEngine;
using UnityEngine.SceneManagement;

namespace PlayJoy.FastLogs
{
    internal static class SceneContextCapturer
    {
        public static string Capture(FastLogsConfig.SceneContextSection limits)
        {
            try
            {
                return new Walker(limits ?? new FastLogsConfig.SceneContextSection()).Run();
            }
            catch (Exception e)
            {
                var sb = new StringBuilder(128);
                sb.Append("{\"scenes\":[],\"stats\":{\"scenes\":0,\"objects\":0,\"components\":0},\"truncated\":true,\"error\":");
                AppendJsonString(sb, e.GetType().Name + ": " + e.Message);
                sb.Append('}');
                return sb.ToString();
            }
        }

        private sealed class Walker
        {
            private const BindingFlags FieldFlags = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance;
            private const int EnumerableHardCap = 10000;

            private readonly FastLogsConfig.SceneContextSection _l;
            private readonly StringBuilder _sb = new StringBuilder(16 * 1024);
            private int _objects;
            private int _components;
            private int _scenes;
            private bool _truncated;

            public Walker(FastLogsConfig.SceneContextSection limits) { _l = limits; }

            private bool BudgetHit => _truncated || _objects >= _l.MaxObjects || _sb.Length >= _l.MaxBytes;

            public string Run()
            {
                _sb.Append("{\"scenes\":[");
                bool first = true;

                int count = SceneManager.sceneCount;
                for (int i = 0; i < count; i++)
                {
                    Scene s = SceneManager.GetSceneAt(i);
                    if (!s.IsValid() || !s.isLoaded) continue;
                    if (BudgetHit) { _truncated = true; break; }
                    if (!first) _sb.Append(',');
                    first = false;
                    WriteScene(s, false);
                }

                if (!BudgetHit)
                {
                    Scene ddol = TryGetDdolScene();
                    if (ddol.IsValid() && ddol.isLoaded)
                    {
                        if (!first) _sb.Append(',');
                        WriteScene(ddol, true);
                    }
                }

                _sb.Append(']');
                _sb.Append(",\"stats\":{\"scenes\":").Append(_scenes)
                   .Append(",\"objects\":").Append(_objects)
                   .Append(",\"components\":").Append(_components).Append('}');
                _sb.Append(",\"truncated\":").Append(_truncated ? "true" : "false");
                _sb.Append('}');
                return _sb.ToString();
            }

            private static Scene TryGetDdolScene()
            {
                try
                {
                    var probe = new GameObject("FastLogsDdolProbe");
                    UnityEngine.Object.DontDestroyOnLoad(probe);
                    Scene s = probe.scene;
                    UnityEngine.Object.DestroyImmediate(probe);
                    return s;
                }
                catch { return default; }
            }

            private void WriteScene(Scene scene, bool ddol)
            {
                _scenes++;
                _sb.Append("{\"name\":");
                AppendStr(scene.name);
                _sb.Append(",\"ddol\":").Append(ddol ? "true" : "false");
                _sb.Append(",\"roots\":[");

                GameObject[] roots;
                try { roots = scene.GetRootGameObjects(); }
                catch { roots = Array.Empty<GameObject>(); }

                bool first = true;
                for (int i = 0; i < roots.Length; i++)
                {
                    if (BudgetHit) { _truncated = true; break; }
                    if (!first) _sb.Append(',');
                    first = false;
                    WriteGo(roots[i], 0);
                }
                _sb.Append("]}");
            }

            private void WriteGo(GameObject go, int depth)
            {
                _objects++;
                _sb.Append("{\"n\":");
                AppendStr(go.name);
                _sb.Append(",\"a\":").Append(go.activeSelf ? "true" : "false");
                _sb.Append(",\"tag\":");
                AppendStr(SafeTag(go));
                _sb.Append(",\"layer\":").Append(go.layer);

                _sb.Append(",\"comp\":[");
                Component[] comps;
                try { comps = go.GetComponents<Component>(); }
                catch { comps = Array.Empty<Component>(); }
                int cMax = Math.Min(comps.Length, _l.MaxComponentsPerObject);
                if (comps.Length > cMax) _truncated = true;
                bool firstC = true;
                for (int i = 0; i < cMax; i++)
                {
                    if (!firstC) _sb.Append(',');
                    firstC = false;
                    WriteComp(comps[i]);
                }
                _sb.Append(']');

                _sb.Append(",\"kids\":[");
                int childCount = go.transform.childCount;
                if (depth + 1 <= _l.MaxDepth)
                {
                    Transform t = go.transform;
                    bool firstK = true;
                    for (int i = 0; i < childCount; i++)
                    {
                        if (BudgetHit) { _truncated = true; break; }
                        if (!firstK) _sb.Append(',');
                        firstK = false;
                        WriteGo(t.GetChild(i).gameObject, depth + 1);
                    }
                }
                else if (childCount > 0)
                {
                    _truncated = true;
                }
                _sb.Append("]}");
            }

            private void WriteComp(Component c)
            {
                _components++;
                if (c == null)
                {
                    _sb.Append("{\"t\":\"<missing script>\",\"en\":null,\"f\":{}}");
                    return;
                }
                Type type = c.GetType();
                _sb.Append("{\"t\":");
                AppendStr(type.Name);
                var beh = c as Behaviour;
                _sb.Append(",\"en\":").Append(beh != null ? (beh.enabled ? "true" : "false") : "null");
                _sb.Append(",\"f\":{");
                WriteFields(c, type);
                _sb.Append("}}");
            }

            private void WriteFields(object obj, Type type)
            {
                FieldInfo[] fields;
                try { fields = type.GetFields(FieldFlags); }
                catch { return; }

                bool first = true;
                int written = 0;
                for (int i = 0; i < fields.Length && written < _l.MaxFieldsPerComponent; i++)
                {
                    FieldInfo f = fields[i];
                    if (!IsSerializedField(f)) continue;

                    string val;
                    try { val = FormatValue(f.GetValue(obj)); }
                    catch (Exception e) { val = "<err: " + e.GetType().Name + ">"; }

                    if (!first) _sb.Append(',');
                    first = false;
                    AppendStr(f.Name);
                    _sb.Append(':');
                    AppendStr(val);
                    written++;
                }
            }

            private static bool IsSerializedField(FieldInfo f)
            {
                if (f.IsStatic || f.IsLiteral) return false;
                if (f.IsPublic) return !f.IsNotSerialized;
                return f.IsDefined(typeof(SerializeField), false);
            }

            private string FormatValue(object v)
            {
                if (v == null) return "null";
                if (v is string str) return Cap(str);

                var uo = v as UnityEngine.Object;
                if (!ReferenceEquals(uo, null)) return Cap(uo.name + " (" + v.GetType().Name + ")");

                Type t = v.GetType();
                if (t.IsPrimitive) return Cap(Convert.ToString(v, CultureInfo.InvariantCulture));
                if (t.IsEnum || v is decimal) return Cap(v.ToString());
                if (v is IEnumerable en) return Cap(FormatEnumerable(en));
                return Cap(v.ToString());
            }

            private string FormatEnumerable(IEnumerable en)
            {
                var sb = new StringBuilder(64);
                sb.Append('[');
                int total = 0;
                int shown = 0;
                foreach (var item in en)
                {
                    total++;
                    if (shown < _l.MaxCollectionElements)
                    {
                        if (shown > 0) sb.Append(", ");
                        sb.Append(item == null ? "null" : item.ToString());
                        shown++;
                    }
                    if (total >= EnumerableHardCap) break;
                }
                if (total > shown) sb.Append(", +").Append(total - shown).Append(" more");
                sb.Append(']');
                return sb.ToString();
            }

            private string Cap(string s)
            {
                if (s == null) return "null";
                int max = _l.MaxStringLength;
                if (max > 0 && s.Length > max) return s.Substring(0, max) + "...";
                return s;
            }

            private static string SafeTag(GameObject go)
            {
                try { return go.tag; }
                catch { return "?"; }
            }

            private void AppendStr(string s) { AppendJsonString(_sb, s); }
        }

        private static void AppendJsonString(StringBuilder sb, string s)
        {
            sb.Append('"');
            if (s != null)
            {
                for (int i = 0; i < s.Length; i++)
                {
                    char c = s[i];
                    switch (c)
                    {
                        case '"': sb.Append("\\\""); break;
                        case '\\': sb.Append("\\\\"); break;
                        case '\n': sb.Append("\\n"); break;
                        case '\r': sb.Append("\\r"); break;
                        case '\t': sb.Append("\\t"); break;
                        default:
                            if (c < ' ') sb.Append("\\u").Append(((int)c).ToString("x4"));
                            else sb.Append(c);
                            break;
                    }
                }
            }
            sb.Append('"');
        }
    }
}
#endif
