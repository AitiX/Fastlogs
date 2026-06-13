// FastLogsCrumbStore - the in-memory context map and breadcrumb ring backing the
// FastLogs.SetContext / ClearContext / Breadcrumb API (feature #2).
//
// Two stores:
//   - Context: a small string->string dictionary. Set/clear is rare (game state
//     changes), not a per-frame path. Keys/values are clamped to the server caps
//     (key <= 64, value <= 512) so we never ship something the server will reject.
//   - Breadcrumbs: a fixed-capacity ring of structs (default cap 100). Adding a
//     crumb writes into a preallocated slot and bumps indices - NO per-add heap
//     allocation (the only string allocations are the caller's own message + the
//     timestamp, formatted lazily; see note below).
//
// Snapshotting (at send time only) materializes a Dictionary copy and a List of
// BreadcrumbDto in chronological order. That allocation is one-shot per report, off
// the hot path.
//
// Threading: SetContext/Breadcrumb are expected on the main thread (the public API
// is [Conditional] and called from game code). The runtime snapshots on the main
// thread during BuildReport. No locking is taken; this matches the rest of the
// package's main-thread affinity.
//
// Gated; pure C# so WebGL-safe.

#if UNITY_EDITOR || DEVELOPMENT_BUILD || (LOGSHARE_FORCE_ENABLED && !(UNITY_PS4 || UNITY_PS5 || UNITY_GAMECORE || UNITY_SWITCH))
#define FASTLOGS_ENABLED
#endif

#if FASTLOGS_ENABLED
using System;
using System.Collections.Generic;
using System.Globalization;

namespace PlayJoy.FastLogs
{
    /// <summary>
    /// Holds the rolling breadcrumb ring and the context key/value map. Snapshotted
    /// into the report DTO at send time.
    /// </summary>
    internal sealed class FastLogsCrumbStore
    {
        // Server-side caps mirrored on the client so we never ship rejected data.
        private const int MaxKeyLen = 64;
        private const int MaxValueLen = 512;
        private const int MaxContextEntries = 64;  // generous; the ~4KB server cap dominates
        private const int MaxCrumbMessageLen = 512;

        // Context map. Small; allocated once.
        private readonly Dictionary<string, string> _context = new Dictionary<string, string>(16, StringComparer.Ordinal);

        // Breadcrumb ring of preallocated structs (no per-add allocation).
        private struct Crumb
        {
            public double TimeRealtime; // unscaled seconds since startup (cheap to read)
            public DateTime TimeUtc;    // captured wall-clock UTC (struct, no heap)
            public string Message;
            public FastLogLevel Level;
            public bool HasLevel;       // whether to emit lvl (always true here; future-proof)
        }

        private readonly Crumb[] _crumbs;
        private int _head;  // index of the oldest crumb
        private int _size;  // number of valid crumbs
        private readonly int _capacity;

        public FastLogsCrumbStore(int breadcrumbCapacity)
        {
            _capacity = breadcrumbCapacity > 0 ? breadcrumbCapacity : 100;
            _crumbs = new Crumb[_capacity];
            _head = 0;
            _size = 0;
        }

        public int BreadcrumbCount { get { return _size; } }
        public int ContextCount { get { return _context.Count; } }

        // ---- Context ----

        /// <summary>
        /// Set or replace a context entry. Null/empty key is ignored. A null value
        /// removes the key. Key/value are clamped to the server caps. When the entry
        /// cap is reached and a brand-new key is added, the add is dropped (we never
        /// silently evict an existing, possibly important, key).
        /// </summary>
        public void SetContext(string key, string value)
        {
            if (string.IsNullOrEmpty(key))
            {
                return;
            }

            key = Clamp(key, MaxKeyLen);

            if (value == null)
            {
                _context.Remove(key);
                return;
            }

            if (!_context.ContainsKey(key) && _context.Count >= MaxContextEntries)
            {
                FlogLog.Warn("Context entry cap reached (" + MaxContextEntries + "); dropping key '" + key + "'.");
                return;
            }

            _context[key] = Clamp(value, MaxValueLen);
        }

        /// <summary>Remove all context entries.</summary>
        public void ClearContext()
        {
            _context.Clear();
        }

        // ---- Breadcrumbs ----

        /// <summary>
        /// Add a breadcrumb. O(1), no heap allocation beyond the caller's message
        /// (the timestamp is captured as a DateTime struct and formatted only at
        /// snapshot time). Overwrites the oldest crumb when the ring is full.
        /// </summary>
        public void AddBreadcrumb(string message, FastLogLevel level, double nowRealtime)
        {
            int slot;
            if (_size < _capacity)
            {
                slot = (_head + _size) % _capacity;
                _size++;
            }
            else
            {
                // Full: overwrite oldest, advance head.
                slot = _head;
                _head = (_head + 1) % _capacity;
            }

            _crumbs[slot].TimeRealtime = nowRealtime;
            _crumbs[slot].TimeUtc = DateTime.UtcNow;
            _crumbs[slot].Message = ClampMessage(message);
            _crumbs[slot].Level = level;
            _crumbs[slot].HasLevel = true;
        }

        // ---- Snapshot (send time only) ----

        /// <summary>
        /// Materialize the current context as a fresh map, or null when empty (so the
        /// serializer omits the field). One-shot allocation, off the hot path.
        /// </summary>
        public Dictionary<string, string> SnapshotContext()
        {
            if (_context.Count == 0)
            {
                return null;
            }
            return new Dictionary<string, string>(_context, StringComparer.Ordinal);
        }

        /// <summary>
        /// Materialize the breadcrumbs in chronological order (oldest first) as a list
        /// of DTOs, or null when empty. One-shot allocation, off the hot path.
        /// </summary>
        public List<BreadcrumbDto> SnapshotBreadcrumbs()
        {
            if (_size == 0)
            {
                return null;
            }

            var list = new List<BreadcrumbDto>(_size);
            for (int i = 0; i < _size; i++)
            {
                int idx = (_head + i) % _capacity;
                Crumb c = _crumbs[idx];
                list.Add(new BreadcrumbDto
                {
                    TimeUtc = c.TimeUtc.ToString("yyyy-MM-ddTHH:mm:ssZ", CultureInfo.InvariantCulture),
                    Message = c.Message ?? string.Empty,
                    Level = c.HasLevel ? LevelString(c.Level) : null
                });
            }
            return list;
        }

        // ---- helpers ----

        private static string LevelString(FastLogLevel level)
        {
            switch (level)
            {
                case FastLogLevel.Warning: return "warn";
                case FastLogLevel.Error: return "error";
                default: return "info";
            }
        }

        private static string ClampMessage(string s)
        {
            return Clamp(s ?? string.Empty, MaxCrumbMessageLen);
        }

        private static string Clamp(string s, int max)
        {
            if (string.IsNullOrEmpty(s) || s.Length <= max)
            {
                return s;
            }
            return s.Substring(0, max);
        }
    }
}
#endif
