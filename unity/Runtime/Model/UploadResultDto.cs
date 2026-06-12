// Result of a FastLogs upload, parsed from the server 201 response.

namespace PlayJoy.FastLogs
{
    /// <summary>
    /// Outcome of <see cref="FastLogs.SendAsync"/>. On success carries the short
    /// id and shareable urls returned by the server; on failure carries an error
    /// message and (when available) the HTTP status code.
    /// </summary>
    public struct UploadResultDto
    {
        /// <summary>Whether the upload completed with a success status.</summary>
        public bool Success;

        /// <summary>Short record id (e.g. "a7Bk9Q"). Empty on failure.</summary>
        public string Id;

        /// <summary>Human-facing viewer url (e.g. "http://host/a7Bk9Q"). Empty on failure.</summary>
        public string Url;

        /// <summary>Raw log url (e.g. "http://host/a7Bk9Q/raw"). May be empty.</summary>
        public string RawUrl;

        /// <summary>ISO-8601 expiry timestamp returned by the server. May be empty.</summary>
        public string ExpiresAt;

        /// <summary>HTTP status code, when a response was received (0 otherwise).</summary>
        public long StatusCode;

        /// <summary>Error description when <see cref="Success"/> is false.</summary>
        public string Error;

        public static UploadResultDto Ok(string id, string url, string rawUrl, string expiresAt, long statusCode)
        {
            return new UploadResultDto
            {
                Success = true,
                Id = id ?? string.Empty,
                Url = url ?? string.Empty,
                RawUrl = rawUrl ?? string.Empty,
                ExpiresAt = expiresAt ?? string.Empty,
                StatusCode = statusCode,
                Error = string.Empty
            };
        }

        public static UploadResultDto Fail(string error, long statusCode = 0)
        {
            return new UploadResultDto
            {
                Success = false,
                Id = string.Empty,
                Url = string.Empty,
                RawUrl = string.Empty,
                ExpiresAt = string.Empty,
                StatusCode = statusCode,
                Error = error ?? "Unknown error"
            };
        }

        /// <summary>A neutral disabled/no-op result for stripped or dormant builds.</summary>
        public static UploadResultDto Disabled
        {
            get { return Fail("FastLogs is disabled or not available in this build."); }
        }

        public override string ToString()
        {
            return Success
                ? ("FastLogs upload ok: " + Url)
                : ("FastLogs upload failed: " + Error);
        }
    }
}
