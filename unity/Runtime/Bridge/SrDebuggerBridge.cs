// SrDebuggerBridge - OPTIONAL integration with StompyRobot SRDebugger.
//
// Goal: if SRDebugger is present in the project, expose FastLogs from its debug
// panel (open the panel, and register an "action"/option that triggers a send),
// WITHOUT a hard dependency. If SRDebugger is absent, this type is inert and the
// FastLogs overlay works fully on its own.
//
// How the soft dependency is kept soft:
//   - The asmdef declares a versionDefine SRDEBUGGER (com.stompyrobot.srdebugger).
//     We only touch SRDebugger under #if SRDEBUGGER.
//   - Even under #if SRDEBUGGER we go through REFLECTION rather than compiling
//     against SRDebugger types directly. SRDebugger's IDebugService surface has
//     varied across versions (ShowDebugPanel overloads, the Actions API, etc.);
//     reflection means a minor API change degrades to a no-op instead of breaking
//     compilation of the whole package. It also means the package still compiles
//     in a project that defines SRDEBUGGER through an unexpected path.
//
// Public surface is intentionally tiny: IsAvailable, ShowPanel(), and
// RegisterSendAction(label, action). The builder/overlay can call these; nothing
// here is required for FastLogs to function.
//
// Gated: the whole file compiles only where FastLogs is enabled.

#if UNITY_EDITOR || DEVELOPMENT_BUILD || (LOGSHARE_FORCE_ENABLED && !(UNITY_PS4 || UNITY_PS5 || UNITY_GAMECORE || UNITY_SWITCH))
#define FASTLOGS_ENABLED
#endif

#if FASTLOGS_ENABLED
using System;
using System.Reflection;

namespace PlayJoy.FastLogs
{
    /// <summary>
    /// Soft, reflection-based bridge to SRDebugger. All members are safe to call
    /// when SRDebugger is not installed (they become no-ops and IsAvailable is
    /// false).
    /// </summary>
    public sealed class SrDebuggerBridge
    {
        private readonly bool _available;

#if SRDEBUGGER
        // Cached reflection handles for the SRDebug.Instance service.
        private readonly object _service;
        private readonly MethodInfo _showPanel0;     // ShowDebugPanel()
        private readonly MethodInfo _showPanel1;     // ShowDebugPanel(bool)
        private readonly MethodInfo _hidePanel;      // HideDebugPanel()
        private readonly MethodInfo _addOption;      // Actions.Add(...) - resolved lazily
        private readonly object _actions;            // IDebugService.Actions, if present
#endif

        public SrDebuggerBridge()
        {
#if SRDEBUGGER
            try
            {
                // SRDebugger.SRDebug.Instance (static property) -> IDebugService.
                Type srDebugType = FindType("SRDebugger.SRDebug") ?? FindType("SRDebug");
                if (srDebugType != null)
                {
                    PropertyInfo instanceProp = srDebugType.GetProperty("Instance",
                        BindingFlags.Public | BindingFlags.Static);
                    _service = instanceProp != null ? instanceProp.GetValue(null, null) : null;
                }

                if (_service != null)
                {
                    Type svcType = _service.GetType();

                    _showPanel0 = svcType.GetMethod("ShowDebugPanel", new Type[0]);
                    _showPanel1 = svcType.GetMethod("ShowDebugPanel", new[] { typeof(bool) });
                    _hidePanel = svcType.GetMethod("HideDebugPanel", new Type[0]);

                    // Optional Actions service (newer SRDebugger versions).
                    PropertyInfo actionsProp = svcType.GetProperty("Actions");
                    _actions = actionsProp != null ? actionsProp.GetValue(_service, null) : null;
                    if (_actions != null)
                    {
                        // Add(string category, string name, Action action) (signature
                        // varies); resolved by name + parameter count at call time.
                        _addOption = FindAddMethod(_actions.GetType());
                    }

                    _available = _service != null;
                }
            }
            catch (Exception e)
            {
                FlogLog.Exception(e);
                _available = false;
            }
#else
            _available = false;
#endif
        }

        /// <summary>True only when SRDebugger is installed and its service resolved.</summary>
        public bool IsAvailable
        {
            get { return _available; }
        }

        /// <summary>Open the SRDebugger panel, if available. No-op otherwise.</summary>
        public void ShowPanel()
        {
#if SRDEBUGGER
            if (!_available)
            {
                return;
            }
            try
            {
                if (_showPanel1 != null)
                {
                    // ShowDebugPanel(false) -> do not require an entry code.
                    _showPanel1.Invoke(_service, new object[] { false });
                }
                else if (_showPanel0 != null)
                {
                    _showPanel0.Invoke(_service, null);
                }
            }
            catch (Exception e)
            {
                FlogLog.Exception(e);
            }
#endif
        }

        /// <summary>Hide the SRDebugger panel, if available. No-op otherwise.</summary>
        public void HidePanel()
        {
#if SRDEBUGGER
            if (!_available)
            {
                return;
            }
            try
            {
                if (_hidePanel != null)
                {
                    _hidePanel.Invoke(_service, null);
                }
            }
            catch (Exception e)
            {
                FlogLog.Exception(e);
            }
#endif
        }

        /// <summary>
        /// Register an action button inside SRDebugger's Actions panel. When the
        /// tester clicks it, <paramref name="action"/> runs (e.g. a FastLogs send).
        /// No-op if SRDebugger or its Actions API is unavailable. Returns true if
        /// the action was registered.
        /// </summary>
        public bool RegisterSendAction(string category, string label, Action action)
        {
#if SRDEBUGGER
            if (!_available || _actions == null || _addOption == null || action == null)
            {
                return false;
            }

            try
            {
                ParameterInfo[] ps = _addOption.GetParameters();
                object[] args = BuildAddArgs(ps, category, label, action);
                if (args == null)
                {
                    return false;
                }
                _addOption.Invoke(_actions, args);
                return true;
            }
            catch (Exception e)
            {
                FlogLog.Exception(e);
                return false;
            }
#else
            return false;
#endif
        }

#if SRDEBUGGER
        // Finds a method named "Add" that takes an Action somewhere in its params.
        private static MethodInfo FindAddMethod(Type actionsType)
        {
            MethodInfo[] methods = actionsType.GetMethods(BindingFlags.Public | BindingFlags.Instance);
            for (int i = 0; i < methods.Length; i++)
            {
                if (methods[i].Name != "Add")
                {
                    continue;
                }
                ParameterInfo[] ps = methods[i].GetParameters();
                for (int p = 0; p < ps.Length; p++)
                {
                    if (ps[p].ParameterType == typeof(Action))
                    {
                        return methods[i];
                    }
                }
            }
            return null;
        }

        // Best-effort argument assembly for the resolved Add overload:
        // fills string parameters with category/label (in order) and the Action.
        private static object[] BuildAddArgs(ParameterInfo[] ps, string category, string label, Action action)
        {
            var args = new object[ps.Length];
            int stringSlot = 0;
            string[] strings = { category ?? "FastLogs", label ?? "Send Log" };

            for (int i = 0; i < ps.Length; i++)
            {
                Type t = ps[i].ParameterType;
                if (t == typeof(Action))
                {
                    args[i] = action;
                }
                else if (t == typeof(string))
                {
                    args[i] = stringSlot < strings.Length ? strings[stringSlot] : label;
                    stringSlot++;
                }
                else if (ps[i].HasDefaultValue)
                {
                    args[i] = ps[i].DefaultValue;
                }
                else if (t.IsValueType)
                {
                    args[i] = Activator.CreateInstance(t);
                }
                else
                {
                    args[i] = null;
                }
            }
            return args;
        }

        private static Type FindType(string fullName)
        {
            Type t = Type.GetType(fullName);
            if (t != null)
            {
                return t;
            }
            Assembly[] assemblies = AppDomain.CurrentDomain.GetAssemblies();
            for (int i = 0; i < assemblies.Length; i++)
            {
                try
                {
                    t = assemblies[i].GetType(fullName);
                    if (t != null)
                    {
                        return t;
                    }
                }
                catch (Exception)
                {
                    // Some dynamic assemblies throw on GetType; ignore.
                }
            }
            return null;
        }
#endif
    }
}
#endif
