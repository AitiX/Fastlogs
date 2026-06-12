// RingLogBuffer - the in-memory ring used to feed the overlay and to build the
// "recent" log text when no disk store is available.
//
// Design notes:
//   - Fixed capacity ring (overwrites oldest when full).
//   - Consecutive-duplicate coalescing: if a new entry matches the LAST kept
//     entry by Message + StackTrace + Level, we bump its Count instead of adding
//     a row (classic Unity-console behaviour). This keeps spammy loops compact.
//   - A soft byte budget (MaxBytes): when building text or appending, the buffer
//     evicts oldest rows so the serialized footprint stays bounded. The byte
//     accounting is approximate (UTF-16 length based) and only used as a guard.
//   - Per-session Counts are tracked separately and are NEVER reduced by ring
//     eviction or Clear() - they reflect everything seen this session.
//
// This type is gated (only compiled where FastLogs is enabled) and has no Unity
// engine dependency beyond being part of the runtime assembly - it is pure C#,
// so it is safe on every platform including WebGL.

#if UNITY_EDITOR || DEVELOPMENT_BUILD || (LOGSHARE_FORCE_ENABLED && !(UNITY_PS4 || UNITY_PS5 || UNITY_GAMECORE || UNITY_SWITCH))
#define FASTLOGS_ENABLED
#endif

#if FASTLOGS_ENABLED
using System.Collections.Generic;
using System.Text;

namespace PlayJoy.FastLogs
{
    /// <summary>
    /// Fixed-capacity, duplicate-coalescing ring buffer of log entries. Holds the
    /// recent history shown in the overlay and (when no persistent store is used)
    /// the text that gets uploaded. Thread-affinity: all access is expected on the
    /// main thread; callers that ingest from worker threads must lock externally
    /// (UnityLogSource marshals threaded callbacks onto the main thread first).
    /// </summary>
    internal sealed class RingLogBuffer
    {
        // A single retained row: an entry plus how many identical lines collapsed.
        private struct Row
        {
            public LogEntry Entry;
            public int Count;
            public int ApproxBytes; // cached UTF-16 footprint (entry text * Count is not used; we store one copy)
        }

        private readonly Row[] _rows;
        private int _head;      // index of the oldest row
        private int _size;      // number of valid rows
        private readonly int _capacity;
        private readonly long _maxBytes;   // 0 = no byte cap
        private long _approxBytes;

        public RingLogBuffer(int capacity, long maxBytes)
        {
            _capacity = capacity > 0 ? capacity : 1;
            _maxBytes = maxBytes > 0 ? maxBytes : 0;
            _rows = new Row[_capacity];
            _head = 0;
            _size = 0;
            _approxBytes = 0;
        }

        public int Count
        {
            get { return _size; }
        }

        public int Capacity
        {
            get { return _capacity; }
        }

        /// <summary>
        /// Append an entry. If it matches the most recently kept row (same message,
        /// stack and level), the row's repeat Count is incremented instead of
        /// adding a new row. Returns true if a new row was added (false if coalesced).
        /// </summary>
        public bool Append(LogEntry entry)
        {
            if (_size > 0)
            {
                int lastIndex = (_head + _size - 1) % _capacity;
                if (IsSameAs(_rows[lastIndex].Entry, entry))
                {
                    _rows[lastIndex].Count++;
                    return false;
                }
            }

            int bytes = ApproxEntryBytes(entry);

            var row = new Row { Entry = entry, Count = 1, ApproxBytes = bytes };

            if (_size < _capacity)
            {
                int tail = (_head + _size) % _capacity;
                _rows[tail] = row;
                _size++;
                _approxBytes += bytes;
            }
            else
            {
                // Full: overwrite the oldest.
                _approxBytes -= _rows[_head].ApproxBytes;
                _rows[_head] = row;
                _head = (_head + 1) % _capacity;
                _approxBytes += bytes;
            }

            EvictToByteBudget();
            return true;
        }

        public void Clear()
        {
            _head = 0;
            _size = 0;
            _approxBytes = 0;
            // Don't bother zeroing _rows; _size guards reads.
        }

        /// <summary>
        /// Render the ring to a single text blob, newest content last (chronological).
        /// Truncates from the FRONT (oldest) so the most recent lines survive, to at
        /// most maxBytes UTF-8 bytes (0 = no client cap). A marker is prepended when
        /// content was dropped.
        /// </summary>
        public string BuildText(int maxBytes)
        {
            if (_size == 0)
            {
                return string.Empty;
            }

            var sb = new StringBuilder(EstimateCapacity());
            for (int i = 0; i < _size; i++)
            {
                int idx = (_head + i) % _capacity;
                LogFormat.AppendEntry(sb, _rows[idx].Entry, _rows[idx].Count);
            }

            string text = sb.ToString();
            return LogFormat.ClampUtf8FromFront(text, maxBytes);
        }

        // ---- helpers ----

        private static bool IsSameAs(LogEntry a, LogEntry b)
        {
            return a.Level == b.Level
                && string.Equals(a.Message, b.Message)
                && string.Equals(a.StackTrace, b.StackTrace);
        }

        private void EvictToByteBudget()
        {
            if (_maxBytes <= 0)
            {
                return;
            }
            // Evict oldest rows until we are within budget or only one row remains.
            while (_size > 1 && _approxBytes > _maxBytes)
            {
                _approxBytes -= _rows[_head].ApproxBytes;
                _head = (_head + 1) % _capacity;
                _size--;
            }
        }

        private int EstimateCapacity()
        {
            // Rough: keep the StringBuilder from reallocating too often.
            long est = _approxBytes + _size * 8L;
            if (est < 64) est = 64;
            if (est > int.MaxValue) est = int.MaxValue;
            return (int)est;
        }

        private static int ApproxEntryBytes(LogEntry e)
        {
            int len = 16; // level tag, separators, newline
            if (e.Message != null) len += e.Message.Length;
            if (e.StackTrace != null) len += e.StackTrace.Length;
            return len;
        }
    }
}
#endif
