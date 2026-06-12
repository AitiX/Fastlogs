// UnityWebRequestUploader - the default ILogUploader.
//
// Sends the serialized LogReportDto to the configured ingest endpoint via
// UnityWebRequest (POST, application/json), parses the {id,url,rawUrl,expiresAt}
// response, and returns an UploadResultDto. Modeled on SRDebugger's BugReportApi:
//   - UploadHandlerRaw { contentType = "application/json" } + DownloadHandlerBuffer
//   - optional "Authorization: Bearer <token>" header
//   - result / responseCode checked, with the 2018/2019 vs newer enum split
//
// Async surface: returns a FlogTask<UploadResultDto> completed from a coroutine on
// the main thread, so the whole path is coroutine-based and identical on WebGL
// (no threads). The interface contract forbids throwing - every failure becomes a
// non-success UploadResultDto.
//
// Retries: on a 5xx or a connection error we retry up to config.Net.MaxRetries with
// a simple exponential backoff. 4xx (client) responses are never retried.
//
// Gzip: off WebGL, when config.Net.GzipBody is on, the log text is gzip+base64'd and
// report.LogEncoding is switched to "gzip+base64" before serialization. On WebGL the
// body stays plain (the core already defaults LogEncoding to "plain").

#if UNITY_EDITOR || DEVELOPMENT_BUILD || (LOGSHARE_FORCE_ENABLED && !(UNITY_PS4 || UNITY_PS5 || UNITY_GAMECORE || UNITY_SWITCH))
#define FASTLOGS_ENABLED
#endif

#if FASTLOGS_ENABLED
using System;
using System.Collections;
using System.Text;
using UnityEngine;
using UnityEngine.Networking;

namespace PlayJoy.FastLogs
{
    /// <summary>
    /// Default uploader. Posts the report JSON to the configured endpoint and parses
    /// the server response. Never throws; surfaces failures as UploadResultDto.Fail.
    /// </summary>
    internal sealed class UnityWebRequestUploader : ILogUploader
    {
        private const string JsonContentType = "application/json";

        public FlogTask<UploadResultDto> UploadAsync(LogReportDto report, FastLogsConfig config)
        {
            var task = FlogTask.Create<UploadResultDto>();

            // Validate inputs up front so we never start a doomed request.
            if (report == null)
            {
                task.SetResult(UploadResultDto.Fail("No report to upload."));
                return task;
            }

            string endpoint = config != null ? config.Server.EndpointUrl : null;
            if (string.IsNullOrEmpty(endpoint))
            {
                task.SetResult(UploadResultDto.Fail("No endpoint URL is configured (Server.EndpointUrl is empty)."));
                return task;
            }

            try
            {
                FlogCoroutineHost.Run(UploadRoutine(report, config, task));
            }
            catch (Exception e)
            {
                FlogLog.Exception(e);
                task.SetResult(UploadResultDto.Fail("Failed to start upload: " + e.Message));
            }

            return task;
        }

        private IEnumerator UploadRoutine(LogReportDto report, FastLogsConfig config, FlogTask<UploadResultDto> task)
        {
            // --- Optional gzip of the log text (non-WebGL only) ---
            ApplyOptionalGzip(report, config);

            // --- Serialize once; the body does not change between retries ---
            byte[] bodyBytes;
            try
            {
                string json = MiniJson.SerializeReport(report);
                bodyBytes = Encoding.UTF8.GetBytes(json);
            }
            catch (Exception e)
            {
                FlogLog.Exception(e);
                task.SetResult(UploadResultDto.Fail("Failed to serialize report: " + e.Message));
                yield break;
            }

            string endpoint = config.Server.EndpointUrl;
            string token = config.Server != null ? config.Server.Token : null;
            int timeout = config.Net != null ? Mathf.Max(1, config.Net.TimeoutSeconds) : 20;
            int maxRetries = config.Net != null ? Mathf.Max(0, config.Net.MaxRetries) : 0;

            UploadResultDto result = UploadResultDto.Fail("Upload did not run.");

            for (int attempt = 0; attempt <= maxRetries; attempt++)
            {
                bool retryable;
                // SendOnce is its own iterator so a single attempt is fully scoped.
                var attemptResult = new AttemptOutcome();
                yield return SendOnce(endpoint, bodyBytes, token, timeout, attemptResult);

                result = attemptResult.Result;
                retryable = attemptResult.Retryable;

                if (result.Success || !retryable || attempt == maxRetries)
                {
                    break;
                }

                // Exponential backoff: 0.5s, 1s, 2s, ... capped at 5s.
                float delay = Mathf.Min(5f, 0.5f * (1 << attempt));
                FlogLog.Warn("Upload attempt " + (attempt + 1) + " failed (" + result.StatusCode + "), retrying in " + delay.ToString("0.0") + "s.");
                float until = Time.realtimeSinceStartup + delay;
                while (Time.realtimeSinceStartup < until)
                {
                    yield return null;
                }
            }

            task.SetResult(result);
        }

        // Carries one attempt's outcome out of the coroutine.
        private sealed class AttemptOutcome
        {
            public UploadResultDto Result;
            public bool Retryable;
        }

        private IEnumerator SendOnce(string endpoint, byte[] body, string token, int timeoutSeconds, AttemptOutcome outcome)
        {
            UnityWebRequest request = null;
            try
            {
                request = new UnityWebRequest(endpoint, UnityWebRequest.kHttpVerbPOST)
                {
                    uploadHandler = new UploadHandlerRaw(body) { contentType = JsonContentType },
                    downloadHandler = new DownloadHandlerBuffer(),
                    timeout = timeoutSeconds
                };
                request.SetRequestHeader("Content-Type", JsonContentType);
                request.SetRequestHeader("Accept", JsonContentType);
                if (!string.IsNullOrEmpty(token))
                {
                    request.SetRequestHeader("Authorization", "Bearer " + token);
                }
            }
            catch (Exception e)
            {
                FlogLog.Exception(e);
                if (request != null)
                {
                    request.Dispose();
                    request = null;
                }
                outcome.Result = UploadResultDto.Fail("Failed to build request: " + e.Message);
                outcome.Retryable = false;
                yield break;
            }

            yield return request.SendWebRequest();

            bool connectionError = IsConnectionError(request);
            long status = request.responseCode;
            string responseText = SafeDownloadText(request);
            string transportError = request.error;

            request.Dispose();

            if (connectionError)
            {
                outcome.Result = UploadResultDto.Fail("Connection error: " + (transportError ?? "unknown"), status);
                outcome.Retryable = true; // network blips are worth a retry
                yield break;
            }

            // HTTP-level outcome.
            if (status >= 200 && status < 300)
            {
                outcome.Result = ParseSuccess(responseText, status);
                outcome.Retryable = false;
                yield break;
            }

            // Non-2xx: 5xx is retryable, 4xx (and anything else) is not.
            outcome.Result = ParseError(responseText, status, transportError);
            outcome.Retryable = status >= 500 && status < 600;
        }

        // ---- Gzip ----

        private static void ApplyOptionalGzip(LogReportDto report, FastLogsConfig config)
        {
#if !UNITY_WEBGL
            bool wantGzip = config != null && config.Net != null && config.Net.GzipBody;
            if (!wantGzip || !GzipUtil.IsSupported)
            {
                return;
            }
            // Only gzip when the core left it plain (do not double-encode).
            if (!string.Equals(report.LogEncoding, "plain", StringComparison.OrdinalIgnoreCase))
            {
                return;
            }

            string encoded = GzipUtil.GzipToBase64(report.LogText ?? string.Empty);
            if (!string.IsNullOrEmpty(encoded))
            {
                report.LogText = encoded;
                report.LogEncoding = "gzip+base64";
            }
#else
            // WebGL: keep plain (no threads, avoid CORS preflight). Nothing to do.
            _ = report;
            _ = config;
#endif
        }

        // ---- Response parsing ----

        private static UploadResultDto ParseSuccess(string responseText, long status)
        {
            string id, url, rawUrl, expiresAt, error, message;
            bool parsed = MiniJson.TryParseUploadResponse(responseText, out id, out url, out rawUrl, out expiresAt, out error, out message);

            if (parsed && !string.IsNullOrEmpty(id))
            {
                return UploadResultDto.Ok(id, url, rawUrl, expiresAt, status);
            }

            // A 2xx without a usable body still counts as a soft failure (we have no link).
            string detail = !string.IsNullOrEmpty(message) ? message : "Server returned success but no id.";
            return UploadResultDto.Fail(detail, status);
        }

        private static UploadResultDto ParseError(string responseText, long status, string transportError)
        {
            string id, url, rawUrl, expiresAt, error, message;
            MiniJson.TryParseUploadResponse(responseText, out id, out url, out rawUrl, out expiresAt, out error, out message);

            string detail;
            if (!string.IsNullOrEmpty(message))
            {
                detail = message;
            }
            else if (!string.IsNullOrEmpty(error))
            {
                detail = error;
            }
            else if (!string.IsNullOrEmpty(transportError))
            {
                detail = transportError;
            }
            else
            {
                detail = "HTTP " + status;
            }

            return UploadResultDto.Fail(detail, status);
        }

        private static string SafeDownloadText(UnityWebRequest request)
        {
            try
            {
                return request.downloadHandler != null ? request.downloadHandler.text : null;
            }
            catch (Exception e)
            {
                FlogLog.Exception(e);
                return null;
            }
        }

        private static bool IsConnectionError(UnityWebRequest request)
        {
#if UNITY_2020_2_OR_NEWER
            return request.result == UnityWebRequest.Result.ConnectionError
                || request.result == UnityWebRequest.Result.DataProcessingError;
#else
            return request.isNetworkError;
#endif
        }
    }
}
#endif
