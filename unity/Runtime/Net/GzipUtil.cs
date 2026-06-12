// GzipUtil - optional gzip compression for the request body / log text.
//
// Used by the uploader on non-WebGL platforms when FastLogsConfig.Net.GzipBody is
// on: the log text (or whole body) is gzipped and base64-encoded so the server can
// receive a "gzip+base64" logEncoding (see the wire contract). On WebGL this path
// is never taken (no threads, and a Content-Encoding/encoded body risks a CORS
// preflight), so the compression code is compiled out there entirely.
//
// Gated like the rest of the package; pure BCL (System.IO.Compression) on the
// platforms that support it.

#if UNITY_EDITOR || DEVELOPMENT_BUILD || (LOGSHARE_FORCE_ENABLED && !(UNITY_PS4 || UNITY_PS5 || UNITY_GAMECORE || UNITY_SWITCH))
#define FASTLOGS_ENABLED
#endif

#if FASTLOGS_ENABLED
using System;
using System.Text;

#if !UNITY_WEBGL
using System.IO;
using System.IO.Compression;
#endif

namespace PlayJoy.FastLogs
{
    /// <summary>
    /// Helper for gzip-compressing text. Available only off WebGL; callers on WebGL
    /// should never invoke it (the contract keeps WebGL logEncoding = "plain").
    /// </summary>
    internal static class GzipUtil
    {
        /// <summary>
        /// True when gzip is actually available on this build target. False on WebGL,
        /// where the compression APIs are intentionally compiled out.
        /// </summary>
        public static bool IsSupported
        {
            get
            {
#if UNITY_WEBGL
                return false;
#else
                return true;
#endif
            }
        }

        /// <summary>
        /// Gzip the UTF-8 bytes of <paramref name="text"/> and return the result as a
        /// base64 string. Returns null on WebGL or on any failure (caller falls back
        /// to plain).
        /// </summary>
        public static string GzipToBase64(string text)
        {
            if (text == null)
            {
                text = string.Empty;
            }

#if UNITY_WEBGL
            return null;
#else
            try
            {
                byte[] raw = Encoding.UTF8.GetBytes(text);
                byte[] compressed = GzipBytes(raw);
                return compressed != null ? Convert.ToBase64String(compressed) : null;
            }
            catch (Exception e)
            {
                FlogLog.Exception(e);
                return null;
            }
#endif
        }

        /// <summary>
        /// Gzip a raw byte buffer. Returns null on WebGL or on failure.
        /// </summary>
        public static byte[] GzipBytes(byte[] data)
        {
            if (data == null)
            {
                data = Array.Empty<byte>();
            }

#if UNITY_WEBGL
            return null;
#else
            try
            {
                using (var output = new MemoryStream())
                {
                    using (var gzip = new GZipStream(output, CompressionMode.Compress, leaveOpen: true))
                    {
                        gzip.Write(data, 0, data.Length);
                    }
                    return output.ToArray();
                }
            }
            catch (Exception e)
            {
                FlogLog.Exception(e);
                return null;
            }
#endif
        }
    }
}
#endif
