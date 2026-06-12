// LogRecorder - persistent, cross-session log recording to disk.
//
// What it is:
//   - A rolling, byte-capped text store under Application.persistentDataPath/FastLogs/.
//   - OFF by default (RecordingSection.Enabled / driven by StartRecording).
//   - Each session that records prepends a session marker (guid + UTC + a short
//     device line) so the uploaded history is segmented by run.
//   - PERSISTS ACROSS SESSIONS: when PersistAcrossSessions is true, a new session
//     keeps the previous file content and appends to it; the byte cap trims the
//     OLDEST content (front) so the most recent history always survives.
//   - At send time the WHOLE store (all retained sessions) is the logText source;
//     the in-memory ring is only for the live overlay.
//
// Threading: all public methods are expected on the main thread (the owning
// CapturingLogSource pumps threaded entries onto the main thread before calling
// Append). On WebGL there is no persistentDataPath durability guarantee across
// reloads, but the IndexedDB-backed FS still works within a session; the same code
// path is used (no threads).
//
// Gated; removed entirely in retail/console builds.

#if UNITY_EDITOR || DEVELOPMENT_BUILD || (LOGSHARE_FORCE_ENABLED && !(UNITY_PS4 || UNITY_PS5 || UNITY_GAMECORE || UNITY_SWITCH))
#define FASTLOGS_ENABLED
#endif

#if FASTLOGS_ENABLED
using System;
using System.Globalization;
using System.IO;
using System.Text;
using UnityEngine;

namespace PlayJoy.FastLogs
{
    /// <summary>
    /// Disk-backed recorder. Holds the persistent log store, appends entries while
    /// recording, enforces a byte cap by trimming the oldest content, and exposes
    /// the full retained history as text for upload.
    /// </summary>
    internal sealed class LogRecorder : IDisposable
    {
        private const string FolderName = "FastLogs";
        private const string FileName = "record.log";
        private const string TrimMarker = "[FastLogs] ...older recorded history trimmed...\n";

        private readonly bool _persistAcrossSessions;
        private readonly long _maxStoreBytes; // 0 = unlimited
        private readonly string _dir;
        private readonly string _path;

        private StreamWriter _writer;
        private bool _recording;
        private bool _sessionMarkerWritten;
        private bool _disposed;

        // Approximate current store size in bytes (UTF-8), kept incrementally so we
        // can decide when to compact without statting the file each append.
        private long _storeBytes;

        public LogRecorder(bool persistAcrossSessions, int maxStoreBytes)
        {
            _persistAcrossSessions = persistAcrossSessions;
            _maxStoreBytes = maxStoreBytes > 0 ? maxStoreBytes : 0;

            string root;
            try { root = Application.persistentDataPath; }
            catch { root = string.Empty; }

            _dir = string.IsNullOrEmpty(root) ? FolderName : Path.Combine(root, FolderName);
            _path = Path.Combine(_dir, FileName);
        }

        public bool IsRecording
        {
            get { return _recording; }
        }

        /// <summary>True if there is any persisted history on disk for this store.</summary>
        public bool HasStoredData
        {
            get { return _storeBytes > 0 || SafeFileLength() > 0; }
        }

        // ---- lifecycle ----

        /// <summary>
        /// Begin recording for this session. Opens the store for append (creating it
        /// or wiping it depending on PersistAcrossSessions) and writes a session
        /// marker the first time it is called in this process. Idempotent.
        /// </summary>
        public void StartRecording()
        {
            if (_disposed || _recording)
            {
                return;
            }

            try
            {
                EnsureDirectory();

                if (!_persistAcrossSessions && !_sessionMarkerWritten && File.Exists(_path))
                {
                    // Fresh store each run: discard previous sessions.
                    File.Delete(_path);
                }

                // Track current size before we open for append.
                _storeBytes = SafeFileLength();

                _writer = new StreamWriter(new FileStream(
                    _path, FileMode.Append, FileAccess.Write, FileShare.Read), new UTF8Encoding(false));
                _writer.AutoFlush = false;

                _recording = true;

                if (!_sessionMarkerWritten)
                {
                    WriteRaw(BuildSessionMarker());
                    _sessionMarkerWritten = true;
                }

                EnforceCap();
                Flush();
            }
            catch (Exception e)
            {
                FlogLog.Exception(e);
                CloseWriter();
                _recording = false;
            }
        }

        /// <summary>Stop recording and flush. The store stays on disk for next time.</summary>
        public void StopRecording()
        {
            if (!_recording)
            {
                return;
            }
            _recording = false;
            Flush();
            CloseWriter();
        }

        /// <summary>
        /// Clear ALL recorded history (current and past sessions) from disk. After a
        /// Clear while recording, a new session marker is written so the active run
        /// is still labelled.
        /// </summary>
        public void ClearRecording()
        {
            try
            {
                bool wasRecording = _recording;
                CloseWriter();
                _recording = false;

                if (File.Exists(_path))
                {
                    File.Delete(_path);
                }
                _storeBytes = 0;
                _sessionMarkerWritten = false;

                if (wasRecording)
                {
                    // Re-open and re-label the active session.
                    StartRecording();
                }
            }
            catch (Exception e)
            {
                FlogLog.Exception(e);
            }
        }

        // ---- ingest ----

        /// <summary>
        /// Persist one entry (and its repeat count) if recording. No-op when not
        /// recording. Enforces the byte cap after writing.
        /// </summary>
        public void Append(LogEntry entry, int repeatCount)
        {
            if (!_recording || _writer == null)
            {
                return;
            }

            try
            {
                var sb = new StringBuilder(64);
                LogFormat.AppendEntry(sb, entry, repeatCount);
                WriteRaw(sb.ToString());
                EnforceCap();
            }
            catch (Exception e)
            {
                FlogLog.Exception(e);
            }
        }

        // ---- read-out for upload ----

        /// <summary>
        /// Return the entire retained store as text, clamped to maxBytes UTF-8 bytes
        /// from the front (0 = no client cap). This is the upload source: the full
        /// cross-session history, not just the live ring.
        /// </summary>
        public string ReadAll(int maxBytes)
        {
            try
            {
                Flush();

                if (!File.Exists(_path))
                {
                    return string.Empty;
                }

                string text;
                using (var fs = new FileStream(_path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite))
                using (var sr = new StreamReader(fs, new UTF8Encoding(false)))
                {
                    text = sr.ReadToEnd();
                }

                return LogFormat.ClampUtf8FromFront(text, maxBytes);
            }
            catch (Exception e)
            {
                FlogLog.Exception(e);
                return string.Empty;
            }
        }

        public void Dispose()
        {
            if (_disposed)
            {
                return;
            }
            _disposed = true;
            StopRecording();
        }

        // ---- internals ----

        private void EnsureDirectory()
        {
            if (!string.IsNullOrEmpty(_dir) && !Directory.Exists(_dir))
            {
                Directory.CreateDirectory(_dir);
            }
        }

        private void WriteRaw(string text)
        {
            if (string.IsNullOrEmpty(text) || _writer == null)
            {
                return;
            }
            _writer.Write(text);
            _storeBytes += Encoding.UTF8.GetByteCount(text);
        }

        private void Flush()
        {
            try { _writer?.Flush(); }
            catch (Exception e) { FlogLog.Exception(e); }
        }

        private void CloseWriter()
        {
            if (_writer == null)
            {
                return;
            }
            try { _writer.Flush(); _writer.Dispose(); }
            catch (Exception e) { FlogLog.Exception(e); }
            _writer = null;
        }

        /// <summary>
        /// If the store exceeds the byte cap, rewrite the file keeping only the most
        /// recent bytes (front-trimmed), with a trim marker prepended. Trimming snaps
        /// to a line boundary so we never cut an entry mid-line.
        /// </summary>
        private void EnforceCap()
        {
            if (_maxStoreBytes <= 0 || _storeBytes <= _maxStoreBytes)
            {
                return;
            }

            try
            {
                CloseWriter();

                string full;
                using (var fs = new FileStream(_path, FileMode.Open, FileAccess.Read, FileShare.None))
                using (var sr = new StreamReader(fs, new UTF8Encoding(false)))
                {
                    full = sr.ReadToEnd();
                }

                // Reserve room for the trim marker within the cap.
                int markerBytes = Encoding.UTF8.GetByteCount(TrimMarker);
                int budget = (int)Math.Min(int.MaxValue, _maxStoreBytes) - markerBytes;
                if (budget < 0) budget = 0;

                string tail = budget <= 0
                    ? string.Empty
                    : KeepTail(full, budget);

                string compacted = TrimMarker + tail;

                using (var fs = new FileStream(_path, FileMode.Create, FileAccess.Write, FileShare.None))
                using (var sw = new StreamWriter(fs, new UTF8Encoding(false)))
                {
                    sw.Write(compacted);
                }

                _storeBytes = Encoding.UTF8.GetByteCount(compacted);

                // Re-open for append if we were recording.
                if (_recording)
                {
                    _writer = new StreamWriter(new FileStream(
                        _path, FileMode.Append, FileAccess.Write, FileShare.Read), new UTF8Encoding(false));
                    _writer.AutoFlush = false;
                }
            }
            catch (Exception e)
            {
                FlogLog.Exception(e);
            }
        }

        // Keep the largest tail of `text` that fits in `budget` UTF-8 bytes, snapped
        // forward to a newline boundary so the first kept line is whole.
        private static string KeepTail(string text, int budget)
        {
            // Reuse the front-clamp logic, then strip its marker (we add our own).
            string clamped = LogFormat.ClampUtf8FromFront(text, budget);
            if (clamped.StartsWith(LogFormat.TruncationMarker, StringComparison.Ordinal))
            {
                clamped = clamped.Substring(LogFormat.TruncationMarker.Length);
            }
            return clamped;
        }

        private long SafeFileLength()
        {
            try
            {
                var fi = new FileInfo(_path);
                return fi.Exists ? fi.Length : 0;
            }
            catch
            {
                return 0;
            }
        }

        private string BuildSessionMarker()
        {
            string guid = Guid.NewGuid().ToString("N");
            string utc = DateTime.UtcNow.ToString("yyyy-MM-ddTHH:mm:ssZ", CultureInfo.InvariantCulture);
            string device = ShortDevice();
            return "==== FastLogs session " + guid + " | " + utc + " | " + device + " ====\n";
        }

        private static string ShortDevice()
        {
            try
            {
                // Short, non-sensitive device line: platform / OS family / model name
                // is intentionally avoided here (model is sensitive); we use coarse info.
                string platform = Application.platform.ToString();
                string os = SystemInfo.operatingSystemFamily.ToString();
                string ver = Application.version;
                string unity = Application.unityVersion;
                return platform + " / " + os + " / app " + ver + " / unity " + unity;
            }
            catch
            {
                return "unknown-device";
            }
        }
    }
}
#endif
