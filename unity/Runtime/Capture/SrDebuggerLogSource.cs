// SrDebuggerLogSource - OPTIONAL log source that reads SRDebugger's own console
// instead of installing our Application.logMessageReceived hook.
//
// Why: if a project already ships SRDebugger, its console already buffers every
// log line (with de-dup). Reading it avoids a second hook and matches what the
// developer sees in the SRDebugger console.
//
// Dependency policy (per RULES): SRDebugger is NEVER a hard dependency.
//   - When the SRDEBUGGER versionDefine is present, we take a direct, reflection-
//     free path against SRDebugger's public API.
//   - Otherwise we resolve the same API entirely via reflection at runtime. If
//     SRDebugger is not actually present, IsAvailable returns false and the caller
//     falls back to UnityLogSource.
//
// This type only READS new entries (incrementally, by index) and forwards them as
// LogEntry to a callback - it does not own history. The owning CapturingLogSource
// decides where they go (ring + recorder).
//
// Gated; removed in retail/console builds.

#if UNITY_EDITOR || DEVELOPMENT_BUILD || (LOGSHARE_FORCE_ENABLED && !(UNITY_PS4 || UNITY_PS5 || UNITY_GAMECORE || UNITY_SWITCH))
#define FASTLOGS_ENABLED
#endif

#if FASTLOGS_ENABLED
using System;
using System.Collections;
using System.Reflection;
using UnityEngine;

namespace PlayJoy.FastLogs
{
    /// <summary>
    /// Reads SRDebugger's console (directly under SRDEBUGGER, via reflection
    /// otherwise) and forwards new entries to a callback. Poll-based: the owner
    /// calls <see cref="Poll"/> each frame to drain entries appended since last time.
    /// </summary>
    internal sealed class SrDebuggerLogSource : IDisposable
    {
        private readonly Action<LogEntry> _onEntry;

        private bool _active;
        private bool _disposed;
        private int _lastIndex; // how many entries we have already forwarded

        // Reflection handles (used only when SRDEBUGGER is not defined).
        private object _consoleService;
        private PropertyInfo _allEntriesProp;
        private PropertyInfo _entryMessageProp;
        private PropertyInfo _entryStackProp;
        private PropertyInfo _entryTypeProp;

        public SrDebuggerLogSource(Action<LogEntry> onEntry)
        {
            _onEntry = onEntry;
        }

        /// <summary>
        /// True if an SRDebugger console service was resolved and can be read.
        /// Construct, then check this before using; if false, use UnityLogSource.
        /// </summary>
        public bool IsAvailable { get; private set; }

        public bool IsActive
        {
            get { return _active; }
        }

        /// <summary>
        /// Attempt to bind to SRDebugger's console service. Safe to call once; sets
        /// <see cref="IsAvailable"/>. Never throws.
        /// </summary>
        public bool TryBind()
        {
            try
            {
#if SRDEBUGGER
                IsAvailable = TryBindDirect();
#else
                IsAvailable = TryBindReflection();
#endif
            }
            catch (Exception e)
            {
                FlogLog.Exception(e);
                IsAvailable = false;
            }
            return IsAvailable;
        }

        public void Start()
        {
            if (_disposed || _active || !IsAvailable)
            {
                return;
            }
            _active = true;
            // Start from the current tail so we don't replay the whole pre-existing
            // console on enable; from here we only forward newly appended entries.
            _lastIndex = CurrentCount();
        }

        public void Stop()
        {
            _active = false;
        }

        /// <summary>
        /// Drain entries appended to the SRDebugger console since the last poll.
        /// Called each frame by the owner while active. No-op when inactive.
        /// </summary>
        public void Poll()
        {
            if (!_active || !IsAvailable)
            {
                return;
            }

            try
            {
                int count = CurrentCount();
                if (count < _lastIndex)
                {
                    // The console was cleared underneath us; resync to its tail.
                    _lastIndex = count;
                    return;
                }

                for (int i = _lastIndex; i < count; i++)
                {
                    if (TryReadEntry(i, out LogEntry entry))
                    {
                        Deliver(entry);
                    }
                }
                _lastIndex = count;
            }
            catch (Exception e)
            {
                FlogLog.Exception(e);
            }
        }

        public void Dispose()
        {
            _disposed = true;
            _active = false;
        }

        // ---- delivery ----

        private void Deliver(LogEntry entry)
        {
            var cb = _onEntry;
            if (cb == null) return;
            try { cb(entry); }
            catch (Exception e) { FlogLog.Exception(e); }
        }

        private static FastLogLevel MapLevel(LogType type)
        {
            switch (type)
            {
                case LogType.Warning: return FastLogLevel.Warning;
                case LogType.Error:
                case LogType.Exception:
                case LogType.Assert: return FastLogLevel.Error;
                default: return FastLogLevel.Log;
            }
        }

#if SRDEBUGGER
        // ---- direct path (SRDebugger present) ----
        //
        // SRDebugger exposes its console via its SRDebug facade and a console
        // service. The facade type name has differed across releases (global
        // "SRDebug" vs "SRDebugger.SRDebug"), so even under the SRDEBUGGER
        // versionDefine we resolve the facade, its Instance and the service entirely
        // by reflection to avoid a hard type reference that may not compile against a
        // given SRDebugger version. Entries are then read through the shared helpers,
        // giving tolerance across the whole surface that has shifted between releases.

        private bool TryBindDirect()
        {
            // Resolve the SRDebug facade type by name (handles both the global and
            // namespaced spellings) rather than referencing it directly.
            Type srDebugType = FindType("SRDebug") ?? FindType("SRDebugger.SRDebug");
            if (srDebugType == null)
            {
                return false;
            }

            PropertyInfo instanceProp = srDebugType.GetProperty(
                "Instance", BindingFlags.Public | BindingFlags.Static);
            object instance = instanceProp != null ? instanceProp.GetValue(null, null) : null;
            if (instance == null)
            {
                return false;
            }

            // GetService<IConsoleService>() exists across versions; fetch it
            // reflectively to avoid a hard type reference that may move namespaces.
            object svc = InvokeGetConsoleService(instance);
            if (svc == null)
            {
                return false;
            }

            _consoleService = svc;
            return BindEntryAccessors(svc);
        }

        private static object InvokeGetConsoleService(object srDebugInstance)
        {
            try
            {
                // Prefer a generic GetService<IConsoleService>() if available.
                var consoleIface = FindType("SRDebugger.Services.IConsoleService")
                                   ?? FindType("SRDebugger.IConsoleService");
                var mi = srDebugInstance.GetType().GetMethod("GetService", Type.EmptyTypes);
                if (mi != null && mi.IsGenericMethodDefinition && consoleIface != null)
                {
                    return mi.MakeGenericMethod(consoleIface).Invoke(srDebugInstance, null);
                }
            }
            catch (Exception e)
            {
                FlogLog.Exception(e);
            }
            return null;
        }
#endif

#if !SRDEBUGGER
        // ---- reflection path (SRDebugger may or may not be installed) ----

        private bool TryBindReflection()
        {
            // SRDebug is the public facade type. If the assembly isn't loaded, this
            // returns null and we report unavailable.
            Type srDebugType = FindType("SRDebug") ?? FindType("SRDebugger.SRDebug");
            if (srDebugType == null)
            {
                return false;
            }

            PropertyInfo instanceProp = srDebugType.GetProperty(
                "Instance", BindingFlags.Public | BindingFlags.Static);
            object instance = instanceProp != null ? instanceProp.GetValue(null, null) : null;
            if (instance == null)
            {
                return false;
            }

            Type consoleIface = FindType("SRDebugger.Services.IConsoleService")
                                ?? FindType("SRDebugger.IConsoleService");
            if (consoleIface == null)
            {
                return false;
            }

            MethodInfo getService = FindGetService(instance.GetType(), consoleIface);
            if (getService == null)
            {
                return false;
            }

            object svc = getService.IsGenericMethodDefinition
                ? getService.MakeGenericMethod(consoleIface).Invoke(instance, null)
                : getService.Invoke(instance, null);
            if (svc == null)
            {
                return false;
            }

            _consoleService = svc;
            return BindEntryAccessors(svc);
        }

        private static MethodInfo FindGetService(Type instanceType, Type consoleIface)
        {
            // Try generic GetService<T>() first.
            foreach (var m in instanceType.GetMethods(BindingFlags.Public | BindingFlags.Instance))
            {
                if (m.Name == "GetService" && m.IsGenericMethodDefinition &&
                    m.GetParameters().Length == 0)
                {
                    return m;
                }
            }
            // Fallback: a non-generic GetService returning the console interface.
            foreach (var m in instanceType.GetMethods(BindingFlags.Public | BindingFlags.Instance))
            {
                if (m.Name == "GetService" && m.GetParameters().Length == 0 &&
                    consoleIface.IsAssignableFrom(m.ReturnType))
                {
                    return m;
                }
            }
            return null;
        }
#endif

        // ---- shared entry accessors (used by both paths) ----

        private bool BindEntryAccessors(object consoleService)
        {
            // The service exposes the buffered entries as an IEnumerable property,
            // commonly named "AllEntries". We read it generically as IEnumerable and
            // pull Message / StackTrace / LogType off each entry by property name.
            _allEntriesProp = FindEnumerableProperty(consoleService.GetType());
            if (_allEntriesProp == null)
            {
                return false;
            }

            Type entryType = ResolveEntryElementType();
            if (entryType == null)
            {
                // We can still enumerate object-typed entries and bind lazily on the
                // first element; defer accessor binding to TryReadEntry.
                return true;
            }

            BindEntryMembers(entryType);
            return true;
        }

        private static PropertyInfo FindEnumerableProperty(Type serviceType)
        {
            // Prefer a property literally named AllEntries.
            PropertyInfo named = serviceType.GetProperty("AllEntries",
                BindingFlags.Public | BindingFlags.Instance);
            if (named != null && typeof(IEnumerable).IsAssignableFrom(named.PropertyType))
            {
                return named;
            }

            // Otherwise the first IEnumerable (non-string) property.
            foreach (var p in serviceType.GetProperties(BindingFlags.Public | BindingFlags.Instance))
            {
                if (p.PropertyType != typeof(string) &&
                    typeof(IEnumerable).IsAssignableFrom(p.PropertyType))
                {
                    return p;
                }
            }
            return null;
        }

        private Type ResolveEntryElementType()
        {
            try
            {
                Type t = _allEntriesProp.PropertyType;
                if (t.IsGenericType)
                {
                    Type[] args = t.GetGenericArguments();
                    if (args.Length == 1)
                    {
                        return args[0];
                    }
                }
            }
            catch (Exception e)
            {
                FlogLog.Exception(e);
            }
            return null;
        }

        private void BindEntryMembers(Type entryType)
        {
            _entryMessageProp = entryType.GetProperty("Message", BindingFlags.Public | BindingFlags.Instance);
            _entryStackProp = entryType.GetProperty("StackTrace", BindingFlags.Public | BindingFlags.Instance);
            _entryTypeProp = entryType.GetProperty("LogType", BindingFlags.Public | BindingFlags.Instance);
        }

        private int CurrentCount()
        {
            try
            {
                IEnumerable seq = _allEntriesProp.GetValue(_consoleService, null) as IEnumerable;
                if (seq == null)
                {
                    return 0;
                }

                // Prefer a Count property if the collection exposes one (cheap).
                PropertyInfo countProp = seq.GetType().GetProperty("Count");
                if (countProp != null && countProp.PropertyType == typeof(int))
                {
                    return (int)countProp.GetValue(seq, null);
                }

                int n = 0;
                foreach (var _ in seq) n++;
                return n;
            }
            catch (Exception e)
            {
                FlogLog.Exception(e);
                return 0;
            }
        }

        private bool TryReadEntry(int index, out LogEntry entry)
        {
            entry = default;
            try
            {
                IEnumerable seq = _allEntriesProp.GetValue(_consoleService, null) as IEnumerable;
                if (seq == null)
                {
                    return false;
                }

                int i = 0;
                foreach (var item in seq)
                {
                    if (i == index)
                    {
                        if (item == null) return false;

                        if (_entryMessageProp == null)
                        {
                            BindEntryMembers(item.GetType());
                        }

                        string message = ReadString(_entryMessageProp, item);
                        string stack = ReadString(_entryStackProp, item);
                        LogType lt = ReadLogType(_entryTypeProp, item);

                        double t = 0;
                        try { t = Time.realtimeSinceStartupAsDouble; } catch { }

                        entry = new LogEntry(message, stack, MapLevel(lt), t);
                        return true;
                    }
                    i++;
                }
            }
            catch (Exception e)
            {
                FlogLog.Exception(e);
            }
            return false;
        }

        private static string ReadString(PropertyInfo prop, object obj)
        {
            if (prop == null) return null;
            try
            {
                object v = prop.GetValue(obj, null);
                return v as string;
            }
            catch { return null; }
        }

        private static LogType ReadLogType(PropertyInfo prop, object obj)
        {
            if (prop == null) return LogType.Log;
            try
            {
                object v = prop.GetValue(obj, null);
                if (v is LogType lt) return lt;
                if (v != null) return (LogType)Enum.ToObject(typeof(LogType), v);
            }
            catch { }
            return LogType.Log;
        }

        private static Type FindType(string fullName)
        {
            Type t = Type.GetType(fullName, false);
            if (t != null) return t;

            var assemblies = AppDomain.CurrentDomain.GetAssemblies();
            for (int i = 0; i < assemblies.Length; i++)
            {
                try
                {
                    t = assemblies[i].GetType(fullName, false);
                    if (t != null) return t;
                }
                catch { }
            }
            return null;
        }
    }
}
#endif
