// Result of a FastLogs file/folder upload, parsed from the server 201 response of
// POST /api/files. Mirrors UploadResultDto (the log-report result) but carries a
// DownloadUrl (GET /files/<id>/download) instead of a raw-log url, matching the
// {id, url, downloadUrl, expiresAt} files contract.
//
// Always compiles on every platform/flavour: the value-returning Send*Async facade
// members return a FlogTask<FileUploadResultDto> on all builds (a "disabled" result
// in stripped builds), so this type must exist everywhere, exactly like
// UploadResultDto.

namespace PlayJoy.FastLogs
{
    /// <summary>
    /// Outcome of <see cref="FastLogs.SendFileAsync(string, string, string, int)"/> and the
    /// folder/files overloads. On success carries the short id and the viewer + download
    /// urls returned by the server; on failure carries an error message and (when
    /// available) the HTTP status code.
    /// </summary>
    public struct FileUploadResultDto
    {
        /// <summary>Whether the upload completed with a success status.</summary>
        public bool Success;

        /// <summary>Short record id (e.g. "a7Bk9Q"). Empty on failure.</summary>
        public string Id;

        /// <summary>Human-facing viewer url (e.g. "http://host/files/a7Bk9Q"). Empty on failure.</summary>
        public string Url;

        /// <summary>Direct download url (e.g. "http://host/files/a7Bk9Q/download"). May be empty.</summary>
        public string DownloadUrl;

        /// <summary>ISO-8601 expiry timestamp returned by the server. May be empty.</summary>
        public string ExpiresAt;

        /// <summary>HTTP status code, when a response was received (0 otherwise).</summary>
        public long StatusCode;

        /// <summary>
        /// Whether the failure is transient and worth re-sending the SAME file. Set by the
        /// uploader's own classification (network/transport or 5xx = true; 4xx and other
        /// client/permanent rejections = false). Always false on success.
        /// </summary>
        public bool Retryable;

        /// <summary>Error description when <see cref="Success"/> is false.</summary>
        public string Error;

        public static FileUploadResultDto Ok(string id, string url, string downloadUrl, string expiresAt, long statusCode)
        {
            return new FileUploadResultDto
            {
                Success = true,
                Id = id ?? string.Empty,
                Url = url ?? string.Empty,
                DownloadUrl = downloadUrl ?? string.Empty,
                ExpiresAt = expiresAt ?? string.Empty,
                StatusCode = statusCode,
                Error = string.Empty
            };
        }

        public static FileUploadResultDto Fail(string error, long statusCode = 0, bool retryable = false)
        {
            return new FileUploadResultDto
            {
                Success = false,
                Id = string.Empty,
                Url = string.Empty,
                DownloadUrl = string.Empty,
                ExpiresAt = string.Empty,
                StatusCode = statusCode,
                Retryable = retryable,
                Error = error ?? "Unknown error"
            };
        }

        /// <summary>A neutral disabled/no-op result for stripped or dormant builds.</summary>
        public static FileUploadResultDto Disabled
        {
            get { return Fail("FastLogs is disabled or not available in this build."); }
        }

        public override string ToString()
        {
            return Success
                ? ("FastLogs file upload ok: " + Url)
                : ("FastLogs file upload failed: " + Error);
        }
    }
}
