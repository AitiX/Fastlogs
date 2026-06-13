// CapturingLogSource - the ILogSource the core actually drives. It wires the raw
// capture seam (Unity hook, or SRDebugger console) to:
//   - the in-memory RingLogBuffer (drives the overlay / "recent" view), and
//   - the persistent LogRecorder (the cross-session disk history, source of the
//     uploaded logText when recording is enabled).
//
// Start/Stop semantics (must match how FastLogsRuntime calls ILogSource):
//   - FastLogsRuntime.Initialize -> Start()  : begin capture (hook installed only
//     now, "only while active"); if Recording.Enabled, also open the disk store.
//   - SetRecording(true)  -> Start()         : idempotent; ensures capture + store.
//   - SetRecording(false) -> Stop()          : stop capture, flush & close store.
//   - ClearRecording()    -> Clear()         : clear ring AND disk history (session
//                                              Counts are NOT reset, per contract).
//
// logText for upload:
//   - If Recording.Enabled and there is disk history -> the FULL store (all retained
//     sessions) via LogRecorder.ReadAll. The live ring is only for the overlay.
//   - Otherwise -> the ring buffer text (recent only).
//
// Threading: the Unity threaded hook queues entries off-thread; a tiny private
// MonoBehaviour pumps them onto the main thread every frame (the core's ILogSource
// surface has no Pump, so the source owns its own pump). The SRDebugger path is
// poll-based and is also pumped here. All ring/recorder mutation happens on the
// main thread inside the pump or Append().
//
// Gated; removed in retail/console builds.

#if UNITY_EDITOR || DEVELOPMENT_BUILD || (LOGSHARE_FORCE_ENABLED && !(UNITY_PS4 || UNITY_PS5 || UNITY_GAMECORE || UNITY_SWITCH))
#define FASTLOGS_ENABLED
#endif

#if FASTLOGS_ENABLED
using System;
using UnityEngine;

namespace PlayJoy.FastLogs
{
    /// <summary>
    /// Concrete <see cref="ILogSource"/>: captures logs into a ring (overlay) and an
    /// optional persistent recorder (upload history), tracking per-session counts.
    /// </summary>
    internal sealed class CapturingLogSource : ILogSource
    {
        private readonly FastLogsConfig _config;

        private readonly RingLogBuffer _ring;
        private readonly LogRecorder _recorder;
        private readonly bool _recordingEnabled;

        // Exactly one raw capture backend is used: SRDebugger console if present and
        // allowed, otherwise our own Unity hook.
        private readonly UnityLogSource _unityHook;
        private readonly SrDebuggerLogSource _srSource;
        private readonly bool _usingSr;

        private CapturePump _pump;

        // Per-session counts (never reduced by ring eviction or Clear()).
        private int _countError;
        private int _countWarn;
        private int _countLog;

        private bool _captureStarted;
        private bool _disposed;

        public CapturingLogSource(FastLogsConfig config)
        {
            _config = config;

            int ringCapacity = config != null ? config.Capture.RingCapacity : 1000;
            // Bound the ring's byte footprint by the upload cap when one is set, so
            // the overlay/recent view can't grow without limit. 0 -> a sane default.
            long ringBytes = config != null && config.Capture.MaxLogTextBytes > 0
                ? config.Capture.MaxLogTextBytes
                : 0;
            _ring = new RingLogBuffer(ringCapacity, ringBytes);

            _recordingEnabled = config != null && config.Recording.Enabled;
            if (_recordingEnabled)
            {
                bool persist = config.Recording.PersistAcrossSessions;
                int maxStore = config.Recording.MaxStoreBytes;
                _recorder = new LogRecorder(persist, maxStore);
            }

            // Pick the capture backend.
            bool preferSr = config != null && config.Capture.UseSrDebuggerConsoleIfPresent;
            if (preferSr)
            {
                _srSource = new SrDebuggerLogSource(OnEntry);
                _usingSr = _srSource.TryBind();
                if (!_usingSr)
                {
                    _srSource.Dispose();
                    _srSource = null;
                }
            }

            if (!_usingSr)
            {
                _unityHook = new UnityLogSource(OnEntry);
            }
        }

        // ============================================================
        // ILogSource
        // ============================================================

        // The core calls Start() twice for two different purposes:
        //   (1) once from FastLogsRuntime.Initialize  -> "begin live capture";
        //   (2) again from SetRecording(true)/StartRecording -> "begin recording".
        // It calls Stop() only from SetRecording(false)/Shutdown -> "stop recording".
        // We separate the two concerns: the capture hook starts on the FIRST Start()
        // and stays installed for the whole session (so the overlay/counts keep
        // filling); Start()/Stop() after init only drive the persistent recorder.
        // This way recording is OFF until explicitly started, unless AutoStart asked
        // for it, while the live ring is always populated.

        public void Start()
        {
            if (_disposed)
            {
                return;
            }

            EnsurePump();

            if (!_captureStarted)
            {
                // (1) First call: begin live capture. Open the recorder now only if
                //     AutoStartRecording was requested.
                _captureStarted = true;
                if (_usingSr) _srSource.Start();
                else _unityHook.Start();

                bool autoStart = _config != null && _config.Recording.AutoStartRecording;
                if (_recordingEnabled && autoStart && _recorder != null)
                {
                    _recorder.StartRecording();
                }
            }
            else
            {
                // (2) Subsequent call: an explicit recording start.
                if (_recordingEnabled && _recorder != null)
                {
                    _recorder.StartRecording();
                }
            }
        }

        public void Stop()
        {
            // Stop only the persistent recorder; live capture stays on so the overlay
            // and per-session counts keep working after recording is turned off.
            if (_recorder != null)
            {
                _recorder.StopRecording();
            }
        }

        public void Append(string message, FastLogLevel level, string stackTrace = null)
        {
            double t = 0;
            try { t = Time.realtimeSinceStartupAsDouble; } catch { }
            OnEntry(new LogEntry(message, stackTrace, level, t));
        }

        public void Clear()
        {
            // Clears the ring AND the persistent history (this backs the public
            // ClearRecording). Per the ILogSource contract, session Counts are NOT
            // reset here.
            _ring.Clear();
            if (_recorder != null)
            {
                _recorder.ClearRecording();
            }
        }

        public CountsDto Counts
        {
            get { return new CountsDto(_countError, _countWarn, _countLog); }
        }

        public string BuildLogText(int maxBytes)
        {
            // Upload source: full disk history when recording is on and has data;
            // otherwise the recent ring.
            if (_recordingEnabled && _recorder != null && _recorder.HasStoredData)
            {
                string disk = _recorder.ReadAll(maxBytes);
                if (!string.IsNullOrEmpty(disk))
                {
                    return disk;
                }
            }
            return _ring.BuildText(maxBytes);
        }

        public int EntryCount
        {
            get { return _ring.Count; }
        }

        public void Dispose()
        {
            if (_disposed)
            {
                return;
            }
            _disposed = true;

            // Stop the recorder, then tear down the capture hook + pump.
            try { Stop(); } catch (Exception e) { FlogLog.Exception(e); }

            if (_pump != null)
            {
                _pump.Detach();
                _pump = null;
            }

            _unityHook?.Dispose();
            _srSource?.Dispose();
            _recorder?.Dispose();
        }

        // ============================================================
        // Internals
        // ============================================================

        // Single ingestion point for every entry (manual Append, Unity hook drain,
        // SRDebugger poll). Runs on the main thread.
        private void OnEntry(LogEntry entry)
        {
            // Count per session BEFORE ring de-dup so spammy duplicates still count.
            switch (entry.Level)
            {
                case FastLogLevel.Error: _countError++; break;
                case FastLogLevel.Warning: _countWarn++; break;
                default: _countLog++; break;
            }

            bool added = _ring.Append(entry);

            // Mirror to disk while recording. We pass repeatCount=1: each raw entry is
            // recorded once (coalescing is a ring/overlay concern; the disk keeps the
            // full stream so counts and history stay faithful).
            if (_recorder != null && _recorder.IsRecording)
            {
                _recorder.Append(entry, 1);
            }

            // 'added' is intentionally unused beyond ring internals; kept for clarity.
            _ = added;
        }

        // Drain off-thread Unity entries / poll SRDebugger each frame, then run the
        // recorder's time-based batched flush (no per-line fsync).
        private void PumpOnce()
        {
            if (_disposed)
            {
                return;
            }
            if (_usingSr)
            {
                _srSource.Poll();
            }
            else
            {
                _unityHook.Pump();
            }

            if (_recorder != null && _recorder.IsRecording)
            {
                double now = 0;
                try { now = Time.realtimeSinceStartupAsDouble; } catch { }
                _recorder.PumpFlush(now);
            }
        }

        private void EnsurePump()
        {
            if (_pump != null)
            {
                return;
            }
            _pump = CapturePump.Attach(PumpOnce);
        }

        // Tiny hidden MonoBehaviour that calls back every frame. Owned by this source
        // so capture works regardless of the core's Update (the ILogSource surface
        // has no Pump hook).
        private sealed class CapturePump : MonoBehaviour
        {
            private Action _onUpdate;

            public static CapturePump Attach(Action onUpdate)
            {
                var go = new GameObject("FastLogsCapturePump");
                go.hideFlags = HideFlags.HideAndDontSave;
                DontDestroyOnLoad(go);
                var pump = go.AddComponent<CapturePump>();
                pump._onUpdate = onUpdate;
                return pump;
            }

            public void Detach()
            {
                _onUpdate = null;
                if (this != null)
                {
                    Destroy(gameObject);
                }
            }

            private void Update()
            {
                var cb = _onUpdate;
                if (cb == null)
                {
                    return;
                }
                try { cb(); }
                catch (Exception e) { FlogLog.Exception(e); }
            }
        }
    }
}
#endif
