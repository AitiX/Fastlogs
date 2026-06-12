// ScreenshotCapturer - the default IScreenshotCapturer.
//
// Captures the current frame as a PNG, downscaled so the longest edge is at most
// maxDimension, and returns the raw PNG bytes (the core base64-encodes them and the
// contract carries them WITHOUT a "data:" prefix).
//
// Flow (all on the main thread via a coroutine, so it is WebGL-safe):
//   1) yield WaitForEndOfFrame so the back buffer is fully rendered.
//   2) ScreenCapture.CaptureScreenshotAsTexture() -> a Texture2D of the screen.
//   3) If larger than maxDimension, blit-downscale through a temporary RenderTexture.
//   4) EncodeToPNG() -> bytes.
// AsyncGPUReadback is used opportunistically (when SystemInfo.supportsAsyncGPUReadback)
// to pull the downscaled pixels off the GPU without a blocking ReadPixels stall;
// otherwise we fall back to a synchronous ReadPixels.
//
// Returns null (never throws) on any failure - the interface contract requires it.
// Off by default in config; only invoked when a send opts into a screenshot.

#if UNITY_EDITOR || DEVELOPMENT_BUILD || (LOGSHARE_FORCE_ENABLED && !(UNITY_PS4 || UNITY_PS5 || UNITY_GAMECORE || UNITY_SWITCH))
#define FASTLOGS_ENABLED
#endif

#if FASTLOGS_ENABLED
using System;
using System.Collections;
using UnityEngine;
using UnityEngine.Rendering;

namespace PlayJoy.FastLogs
{
    /// <summary>
    /// Default screenshot capturer. Grabs the end-of-frame screen, downscales to the
    /// configured max edge, encodes PNG. Returns null on failure.
    /// </summary>
    internal sealed class ScreenshotCapturer : IScreenshotCapturer
    {
        public FlogTask<byte[]> CaptureAsync(int maxDimension)
        {
            var task = FlogTask.Create<byte[]>();
            try
            {
                FlogCoroutineHost.Run(CaptureRoutine(maxDimension, task));
            }
            catch (Exception e)
            {
                FlogLog.Exception(e);
                task.SetResult(null);
            }
            return task;
        }

        private IEnumerator CaptureRoutine(int maxDimension, FlogTask<byte[]> task)
        {
            // Must run after the frame is rendered to grab the final image.
            yield return new WaitForEndOfFrame();

            Texture2D shot = null;
            byte[] png = null;

            // 1) Capture the full-resolution screen.
            try
            {
                shot = ScreenCapture.CaptureScreenshotAsTexture();
            }
            catch (Exception e)
            {
                FlogLog.Exception(e);
                shot = null;
            }

            if (shot == null)
            {
                task.SetResult(null);
                yield break;
            }

            // 2) Downscale if needed (returns a NEW texture or the same one).
            Texture2D scaled = shot;
            bool scaledIsNew = false;
            try
            {
                scaled = Downscale(shot, maxDimension, out scaledIsNew);
            }
            catch (Exception e)
            {
                FlogLog.Exception(e);
                scaled = shot;
                scaledIsNew = false;
            }

            // 3) Encode PNG. EncodeToPNG must run on the main thread (it is here).
            try
            {
                png = scaled != null ? scaled.EncodeToPNG() : null;
            }
            catch (Exception e)
            {
                FlogLog.Exception(e);
                png = null;
            }

            // 4) Cleanup textures we created.
            if (scaledIsNew && scaled != null)
            {
                UnityEngine.Object.Destroy(scaled);
            }
            UnityEngine.Object.Destroy(shot);

            task.SetResult(png != null && png.Length > 0 ? png : null);
        }

        /// <summary>
        /// Downscale <paramref name="source"/> so its longest edge is at most
        /// <paramref name="maxDimension"/>. Returns the source unchanged when it
        /// already fits (newTexture=false), or a freshly allocated texture otherwise
        /// (newTexture=true, caller destroys it).
        /// </summary>
        private static Texture2D Downscale(Texture2D source, int maxDimension, out bool newTexture)
        {
            newTexture = false;
            if (source == null)
            {
                return null;
            }

            int w = source.width;
            int h = source.height;
            int longest = Mathf.Max(w, h);

            if (maxDimension <= 0 || longest <= maxDimension)
            {
                return source; // already within budget
            }

            float scale = (float)maxDimension / longest;
            int targetW = Mathf.Max(1, Mathf.RoundToInt(w * scale));
            int targetH = Mathf.Max(1, Mathf.RoundToInt(h * scale));

            RenderTexture rt = RenderTexture.GetTemporary(targetW, targetH, 0, RenderTextureFormat.ARGB32, RenderTextureReadWrite.Default);
            RenderTexture previous = RenderTexture.active;
            Texture2D result = null;
            try
            {
                // Blit performs the GPU-side bilinear downscale.
                Graphics.Blit(source, rt);
                RenderTexture.active = rt;

                result = new Texture2D(targetW, targetH, TextureFormat.RGBA32, false);

                if (TryAsyncReadback(rt, result))
                {
                    // pixels already populated by the readback path
                }
                else
                {
                    result.ReadPixels(new Rect(0, 0, targetW, targetH), 0, 0);
                    result.Apply(false);
                }

                newTexture = true;
                return result;
            }
            catch (Exception e)
            {
                FlogLog.Exception(e);
                if (result != null)
                {
                    UnityEngine.Object.Destroy(result);
                }
                newTexture = false;
                return source;
            }
            finally
            {
                RenderTexture.active = previous;
                RenderTexture.ReleaseTemporary(rt);
            }
        }

        /// <summary>
        /// Try to fill <paramref name="dest"/> from <paramref name="rt"/> via a
        /// synchronous-wait AsyncGPUReadback when supported. Returns false if the
        /// platform does not support it (caller uses ReadPixels instead).
        /// </summary>
        private static bool TryAsyncReadback(RenderTexture rt, Texture2D dest)
        {
            if (!SystemInfo.supportsAsyncGPUReadback)
            {
                return false;
            }

            try
            {
                var req = AsyncGPUReadback.Request(rt, 0, TextureFormat.RGBA32);
                req.WaitForCompletion(); // we are already inside a coroutine at end-of-frame
                if (req.hasError)
                {
                    return false;
                }

                var data = req.GetData<byte>();
                dest.LoadRawTextureData(data);
                dest.Apply(false);
                return true;
            }
            catch (Exception e)
            {
                FlogLog.Exception(e);
                return false;
            }
        }
    }
}
#endif
