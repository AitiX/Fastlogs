// PiiScrubber - best-effort redaction of personally identifiable information from
// outgoing report text.
//
// Privacy-by-default: FastLogs runs this over the log text, every context value and
// every breadcrumb message right before a report is serialized for upload (or
// persisted to the crash queue). It is OFF only if DiagnosticsSection.ScrubPii is
// turned off in settings.
//
// What it redacts (replaced with "[redacted]"):
//   - email addresses
//   - IPv4 addresses
//   - IPv6 addresses
//   - Bearer / Authorization tokens (the value after "Bearer "/"Authorization:")
//   - long digit sequences (>= 9 digits: card/phone/account-like runs)
//
// The pattern set is EXTENSIBLE: call PiiScrubber.AddPattern(...) to add more before
// the first scrub, or edit the default list here.
//
// Performance: this is a one-shot pass run only at send/crash time (never per frame
// and never on the logging hot path). Regexes are compiled lazily once and cached.
// On a typical report the input is the (already byte-capped) log text plus a handful
// of small strings, so the cost is negligible and incurred at most once per report.
//
// Gated; pure BCL (System.Text.RegularExpressions) so it is WebGL-safe (regex runs
// interpreted on WebGL, which is fine for a one-shot pass).

#if UNITY_EDITOR || DEVELOPMENT_BUILD || (LOGSHARE_FORCE_ENABLED && !(UNITY_PS4 || UNITY_PS5 || UNITY_GAMECORE || UNITY_SWITCH))
#define FASTLOGS_ENABLED
#endif

#if FASTLOGS_ENABLED
using System;
using System.Collections.Generic;
using System.Text.RegularExpressions;

namespace PlayJoy.FastLogs
{
    /// <summary>
    /// Redacts PII from outgoing text. One-shot, run at send/crash time only.
    /// </summary>
    internal static class PiiScrubber
    {
        private const string Replacement = "[redacted]";

        // RegexOptions kept simple and culture-invariant; CultureInvariant avoids
        // locale-specific casing surprises. Not Compiled: on WebGL/IL2CPP Compiled is
        // unsupported and this is a one-shot pass where interpreted is fine.
        private const RegexOptions Opts = RegexOptions.CultureInvariant | RegexOptions.IgnoreCase;

        // The default, extensible pattern list. Order matters: the more specific
        // token/email/IP patterns run before the generic long-digit run so they win
        // on overlapping matches.
        private static readonly List<Regex> _patterns = BuildDefaultPatterns();

        private static List<Regex> BuildDefaultPatterns()
        {
            var list = new List<Regex>(8);

            // Bearer / Authorization token: redact the token value, keep the keyword so
            // the log still reads "Authorization: [redacted]".
            list.Add(new Regex(@"(?i)\b(bearer)\s+[A-Za-z0-9\-._~+/]+=*", Opts));
            list.Add(new Regex(@"(?i)\bauthorization\s*[:=]\s*\S+", Opts));

            // Email.
            list.Add(new Regex(@"\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b", Opts));

            // IPv6 (run before IPv4 / digit-run so colons-and-hex form wins). Matches
            // common full/compressed forms; conservative but covers typical addresses.
            list.Add(new Regex(
                @"\b(?:[A-Fa-f0-9]{1,4}:){2,7}[A-Fa-f0-9]{1,4}\b|\b(?:[A-Fa-f0-9]{1,4}:){1,7}:(?:[A-Fa-f0-9]{1,4})?\b",
                Opts));

            // IPv4.
            list.Add(new Regex(
                @"\b(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}\b",
                Opts));

            // Long digit runs (cards / phones / account ids): 9+ consecutive digits.
            list.Add(new Regex(@"\b\d{9,}\b", Opts));

            return list;
        }

        /// <summary>
        /// Add an extra redaction pattern. Patterns added here are applied after the
        /// built-in set. Call before scrubbing (e.g. from game init).
        /// </summary>
        public static void AddPattern(string pattern)
        {
            if (string.IsNullOrEmpty(pattern))
            {
                return;
            }
            try { _patterns.Add(new Regex(pattern, Opts)); }
            catch (Exception e) { FlogLog.Exception(e); }
        }

        /// <summary>
        /// Run all patterns over <paramref name="input"/>, replacing matches with
        /// "[redacted]". Returns the input unchanged when null/empty or on any error
        /// (fails safe by not corrupting the report, but note a regex error means that
        /// pattern simply does not redact - callers keep ScrubPii on for safety).
        /// </summary>
        public static string Scrub(string input)
        {
            if (string.IsNullOrEmpty(input))
            {
                return input;
            }

            string s = input;
            try
            {
                for (int i = 0; i < _patterns.Count; i++)
                {
                    s = _patterns[i].Replace(s, Replacement);
                }
            }
            catch (Exception e)
            {
                FlogLog.Exception(e);
                // Return what we have so far; a single failing pattern must not throw
                // out of the send path.
            }
            return s;
        }
    }
}
#endif
