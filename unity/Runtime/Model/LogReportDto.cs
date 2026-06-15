// Top-level FastLogs upload payload, mapped to the wire contract body.

using System.Collections.Generic;

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

        /// <summary>screenshotPng - pure base64 PNG WITHOUT a "data:" prefix (legacy single).</summary>
        public string ScreenshotPngBase64;

        /// <summary>
        /// screenshotsPng - several base64 PNGs (no "data:" prefix), for a report that
        /// carries more than one screenshot (FastLogs.CaptureScreenshot queue + the live
        /// one). Server caps the count. Omitted when null/empty.
        /// </summary>
        public List<string> ScreenshotsPngBase64;

        /// <summary>retentionDays - per-request override (server clamps).</summary>
        public int? RetentionDays;

        /// <summary>title - record title, <=120 chars.</summary>
        public string Title;

        /// <summary>comment - free-form tester problem description, <=4000 chars.</summary>
        public string Comment;

        /// <summary>tester - tester name from client settings, <=120 chars.</summary>
        public string Tester;

        /// <summary>
        /// context - free-form string->string map riding with the report (e.g. level,
        /// playerId). Server caps total ~4KB, key &lt;=64, value &lt;=512. Omitted when
        /// null/empty.
        /// </summary>
        public Dictionary<string, string> Context;

        /// <summary>
        /// breadcrumbs - rolling list of recent app events, oldest first. Server caps
        /// 100 items and ~16KB. Omitted when null/empty.
        /// </summary>
        public List<BreadcrumbDto> Breadcrumbs;

        /// <summary>
        /// sceneContext - compact JSON STRING capturing the runtime scene hierarchy
        /// (loaded scenes + DontDestroyOnLoad -&gt; objects -&gt; components -&gt; fields),
        /// built by SceneContextCapturer. The server stores it opaquely; the viewer parses
        /// and renders it as a collapsible tree. Omitted when empty.
        /// </summary>
        public string SceneContextJson;

        /// <summary>
        /// correlationCode - optional short debug/await code (&lt;=64 chars) used to wait for
        /// and grab this exact log on the server. Omitted when empty.
        /// </summary>
        public string CorrelationCode;
    }

    /// <summary>
    /// One breadcrumb entry. Maps to the contract object { t, m, lvl }.
    /// </summary>
    public struct BreadcrumbDto
    {
        /// <summary>t - ISO-8601 UTC timestamp of the event.</summary>
        public string TimeUtc;

        /// <summary>m - short human message describing the event.</summary>
        public string Message;

        /// <summary>lvl - optional severity: "info" | "warn" | "error". Omitted when empty.</summary>
        public string Level;
    }
}
