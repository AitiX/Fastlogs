// UnityLogSource - the low-level capture seam that listens to Unity's log stream.
//
// Responsibilities (kept narrow on purpose):
//   - Subscribe to Application.logMessageReceived[Threaded] ONLY while active
//     (Start installs the hook, Stop removes it). Nothing is captured when stopped.
//   - Normalize each Unity message into a LogEntry and hand it to a callback.
//   - Be thread-safe: on platforms with threads we use the *Threaded* event, which
//     can fire off the main thread, so incoming entries are queued under a lock and
//     drained on the main thread via Pump(). On WebGL (no threads) we use the plain
//     event and deliver inline.
//
// This type does NOT keep history itself - it only delivers entries. The owning
// CapturingLogSource decides where they go (ring + recorder). That separation is
// what lets the same hook feed both the overlay ring and the disk recorder.
//
// Gated; the whole file is removed in retail/console builds.

#if UNITY_EDITOR || DEVELOPMENT_BUILD || (LOGSHARE_FORCE_ENABLED && !(UNITY_PS4 || UNITY_PS5 || UNITY_GAMECORE || UNITY_SWITCH))
#define FASTLOGS_ENABLED
#endif

#if FASTLOGS_ENABLED
using System;
using System.Collections.Generic;
using UnityEngine;

namespace PlayJoy.FastLogs
{
    /// <summary>
    /// Listens to UnityEngine.Application log callbacks while active and forwards
    /// normalized <see cref="LogEntry"/> values to a sink. The hook is present only
    /// between <see cref="Start"/> and <see cref="Stop"/>.
    /// </summary>
    internal sealed class UnityLogSource : IDisposable
    {
        private readonly Action<LogEntry> _onEntry;

        private bool _active;
        private bool _disposed;

        // On WebGL there are no threads, so the non-threaded event is delivered on
        // the main thread and we can forward inline. Elsewhere we use the threaded
        // event and queue, draining on Pump() (called from the runtime's Update).
#if !UNITY_WEBGL || UNITY_EDITOR
        private readonly object _gate = new object();
        private readonly List<LogEntry> _pending = new List<LogEntry>(64);
        private const bool Threaded = true;
#else
        private const bool Threaded = false;
#endif

        public UnityLogSource(Action<LogEntry> onEntry)
        {
            _onEntry = onEntry;
        }

        public bool IsActive
        {
            get { return _active; }
        }

        /// <summary>Install the log hook (idempotent). Captures from now on.</summary>
        public void Start()
        {
            if (_disposed || _active)
            {
                return;
            }
            _active = true;
#if !UNITY_WEBGL || UNITY_EDITOR
            Application.logMessageReceivedThreaded += HandleThreaded;
#else
            Application.logMessageReceived += HandleMain;
#endif
        }

        /// <summary>Remove the log hook (idempotent). Nothing captured afterwards.</summary>
        public void Stop()
        {
            if (!_active)
            {
                return;
            }
            _active = false;
#if !UNITY_WEBGL || UNITY_EDITOR
            Application.logMessageReceivedThreaded -= HandleThreaded;
            // Flush whatever was queued so no entry is silently lost on stop.
            Pump();
#else
            Application.logMessageReceived -= HandleMain;
#endif
        }

        /// <summary>
        /// Drain any entries captured from worker threads onto the main thread.
        /// Called by the runtime pump each frame. No-op on WebGL.
        /// </summary>
        public void Pump()
        {
#if !UNITY_WEBGL || UNITY_EDITOR
            // Swap the pending list under lock, then deliver outside the lock so a
            // re-entrant log call from a handler cannot deadlock.
            List<LogEntry> batch = null;
            lock (_gate)
            {
                if (_pending.Count > 0)
                {
                    batch = new List<LogEntry>(_pending);
                    _pending.Clear();
                }
            }

            if (batch != null)
            {
                for (int i = 0; i < batch.Count; i++)
                {
                    Deliver(batch[i]);
                }
            }
#endif
        }

        public void Dispose()
        {
            if (_disposed)
            {
                return;
            }
            _disposed = true;
            Stop();
        }

        // ---- callbacks ----

#if !UNITY_WEBGL || UNITY_EDITOR
        // May arrive on a worker thread: only touch the locked queue here.
        private void HandleThreaded(string condition, string stackTrace, LogType type)
        {
            var entry = Normalize(condition, stackTrace, type);
            lock (_gate)
            {
                _pending.Add(entry);
            }
        }
#else
        // WebGL: always main thread; forward inline.
        private void HandleMain(string condition, string stackTrace, LogType type)
        {
            Deliver(Normalize(condition, stackTrace, type));
        }
#endif

        private void Deliver(LogEntry entry)
        {
            var cb = _onEntry;
            if (cb == null)
            {
                return;
            }
            try { cb(entry); }
            catch (Exception e) { FlogLog.Exception(e); }
        }

        private static LogEntry Normalize(string condition, string stackTrace, LogType type)
        {
            // Time.realtimeSinceStartup is only valid on the main thread; on the
            // threaded path we still read it best-effort (Unity tolerates it here),
            // but guard against any exception so capture never throws.
            double t = 0;
            try { t = Time.realtimeSinceStartupAsDouble; }
            catch { /* off-thread or pre-init: leave 0 */ }

            return new LogEntry(condition, stackTrace, MapLevel(type), t);
        }

        private static FastLogLevel MapLevel(LogType type)
        {
            switch (type)
            {
                case LogType.Warning:
                    return FastLogLevel.Warning;
                case LogType.Error:
                case LogType.Exception:
                case LogType.Assert:
                    return FastLogLevel.Error;
                default:
                    return FastLogLevel.Log;
            }
        }
    }
}
#endif
