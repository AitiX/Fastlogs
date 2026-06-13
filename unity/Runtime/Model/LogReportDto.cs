// Top-level FastLogs upload payload, mapped to the wire contract body.

namespace PlayJoy.FastLogs
{
    /// <summary>
    /// The full ingest payload sent to `POST /api/logs`. Required fields are
    /// always serialized; optional fields (ScreenshotPngBase64, RetentionDays,
    /// Title, Comment, Tester) are omitted when empty per the contract.
    /// </summary>
    public sealed class LogReportDto
    {
        // ---- Required ----

        /// <summary>appId - [a-z0-9_-]{2,32} game identifier.</summary>
        public string AppId;

        /// <summary>platform enum: WebGL|Android|iOS|Windows|macOS|Linux|GameMaker|PS4|PS5|Switch|Xbox|Other.</summary>
        public string Platform;

        /// <summary>appVersion - version string.</summary>
        public string AppVersion;

        /// <summary>timestampUtc - ISO-8601 UTC (client formation moment).</summary>
        public string TimestampUtc;

        /// <summary>counts - per-session counters.</summary>
        public CountsDto Counts;

        /// <summary>logText - log body, encoded per LogEncoding.</summary>
        public string LogText;

        /// <summary>logEncoding - "plain" or "gzip+base64". On WebGL always "plain".</summary>
        public string LogEncoding;

        /// <summary>device - grouped snapshot.</summary>
        public DeviceInfoDto Device;

        // ---- Optional (omitted when empty) ----

        /// <summary>screenshotPng - pure base64 PNG WITHOUT a "data:" prefix.</summary>
        public string ScreenshotPngBase64;

        /// <summary>retentionDays - per-request override (server clamps).</summary>
        public int? RetentionDays;

        /// <summary>title - record title, <=120 chars.</summary>
        public string Title;

        /// <summary>comment - free-form tester problem description, <=4000 chars.</summary>
        public string Comment;

        /// <summary>tester - tester name from client settings, <=120 chars.</summary>
        public string Tester;
    }
}
