// LogFormat - one place that decides how a LogEntry becomes text, and how text
// is clamped to a UTF-8 byte budget. Shared by the ring buffer and the on-disk
// recorder so the overlay preview and the uploaded log read identically.
//
// Line shape (one logical entry, may span lines via the stack trace):
//   [E] +12.345 message text
//       stack line 1
//       stack line 2
//   (xN)                       <- only when the entry coalesced N>1 duplicates
//
// Gated; pure C# (StringBuilder + Encoding) so it is WebGL-safe.

#if UNITY_EDITOR || DEVELOPMENT_BUILD || (LOGSHARE_FORCE_ENABLED && !(UNITY_PS4 || UNITY_PS5 || UNITY_GAMECORE || UNITY_SWITCH))
#define FASTLOGS_ENABLED
#endif

#if FASTLOGS_ENABLED
using System.Globalization;
using System.Text;

namespace PlayJoy.FastLogs
{
    internal static class LogFormat
    {
        public const string TruncationMarker = "[FastLogs] ...log truncated to fit size limit...\n";

        /// <summary>Single-character tag for a level: L / W / E.</summary>
        public static char LevelTag(FastLogLevel level)
        {
            switch (level)
            {
                case FastLogLevel.Warning: return 'W';
                case FastLogLevel.Error: return 'E';
                default: return 'L';
            }
        }

        /// <summary>
        /// Append one entry (plus its repeat count) to the builder, terminated by a
        /// newline. Used by both the ring (in-memory) and the recorder (disk) so
        /// the formats match exactly.
        /// </summary>
        public static void AppendEntry(StringBuilder sb, LogEntry entry, int repeatCount)
        {
            sb.Append('[').Append(LevelTag(entry.Level)).Append("] ");
            sb.Append('+').Append(entry.TimeSinceStartup.ToString("0.000", CultureInfo.InvariantCulture)).Append(' ');
            sb.Append(entry.Message ?? string.Empty);
            sb.Append('\n');

            if (!string.IsNullOrEmpty(entry.StackTrace))
            {
                // Keep the stack trace as-is; the viewer collapses it.
                sb.Append(entry.StackTrace);
                if (entry.StackTrace[entry.StackTrace.Length - 1] != '\n')
                {
                    sb.Append('\n');
                }
            }

            if (repeatCount > 1)
            {
                sb.Append("(x").Append(repeatCount.ToString(CultureInfo.InvariantCulture)).Append(")\n");
            }
        }

        /// <summary>
        /// Clamp text to maxBytes UTF-8 bytes, dropping from the FRONT (oldest) so
        /// the most recent log survives. Prepends a truncation marker when cut.
        /// maxBytes &lt;= 0 means no cap (returns the text unchanged).
        /// </summary>
        public static string ClampUtf8FromFront(string text, int maxBytes)
        {
            if (maxBytes <= 0 || string.IsNullOrEmpty(text))
            {
                return text ?? string.Empty;
            }

            var utf8 = Encoding.UTF8;
            int byteCount = utf8.GetByteCount(text);
            if (byteCount <= maxBytes)
            {
                return text;
            }

            int markerBytes = utf8.GetByteCount(TruncationMarker);
            int budget = maxBytes - markerBytes;
            if (budget <= 0)
            {
                // Even the marker does not fit; return a hard-truncated marker.
                return ClampHard(TruncationMarker, maxBytes, utf8);
            }

            // Find the largest tail of the string that fits in `budget` bytes.
            // Walk back from the end accumulating byte cost; stop at a char boundary.
            int startChar = FindTailStart(text, budget, utf8);
            // Snap to the next newline so we don't cut a line in half (best effort).
            int nl = text.IndexOf('\n', startChar);
            if (nl >= 0 && nl + 1 < text.Length)
            {
                startChar = nl + 1;
            }

            return TruncationMarker + text.Substring(startChar);
        }

        // Largest start index such that text[start..] fits in budget UTF-8 bytes.
        private static int FindTailStart(string text, int budget, Encoding utf8)
        {
            int acc = 0;
            int i = text.Length;
            while (i > 0)
            {
                int prev = i - 1;
                // Handle a surrogate pair as one unit.
                if (prev > 0 && char.IsLowSurrogate(text[prev]) && char.IsHighSurrogate(text[prev - 1]))
                {
                    int pairBytes = utf8.GetByteCount(text, prev - 1, 2);
                    if (acc + pairBytes > budget) break;
                    acc += pairBytes;
                    i -= 2;
                }
                else
                {
                    int chBytes = utf8.GetByteCount(text, prev, 1);
                    if (acc + chBytes > budget) break;
                    acc += chBytes;
                    i -= 1;
                }
            }
            return i;
        }

        private static string ClampHard(string s, int maxBytes, Encoding utf8)
        {
            // Truncate from the end of `s` to fit maxBytes (used only for the marker
            // when even it overflows an absurdly small cap).
            int end = 0, acc = 0;
            while (end < s.Length)
            {
                int chBytes = utf8.GetByteCount(s, end, 1);
                if (acc + chBytes > maxBytes) break;
                acc += chBytes;
                end++;
            }
            return s.Substring(0, end);
        }
    }
}
#endif
