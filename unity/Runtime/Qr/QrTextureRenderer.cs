// QrTextureRenderer - turns a short URL into a scannable QR Texture2D.
//
// The QR *encoder* (byte mode, Reed-Solomon ECC, masking, versions 1..10) already
// lives in the package as QrCode (Runtime/UI/QrCode.cs), authored for the overlay.
// To avoid a second, divergent encoder this renderer reuses it and is purely the
// "modules -> texture" step:
//   - QrCode.TryEncode(url, Ecc.M, out modules) gives a bool[size,size] grid.
//   - We draw it into a Texture2D with a configurable per-module pixel scale and a
//     4-module quiet zone (the spec-mandated light border), dark = foreground.
//   - FilterMode.Point + no mipmaps keep the modules crisp at any display size.
//
// ECC level M (the brief's request) balances capacity and error tolerance and is a
// good default for an on-screen code a phone camera reads. Returns null on failure
// (e.g. the url does not fit in versions 1..10), never throws.

#if UNITY_EDITOR || DEVELOPMENT_BUILD || (LOGSHARE_FORCE_ENABLED && !(UNITY_PS4 || UNITY_PS5 || UNITY_GAMECORE || UNITY_SWITCH))
#define FASTLOGS_ENABLED
#endif

#if FASTLOGS_ENABLED
using System;
using UnityEngine;

namespace PlayJoy.FastLogs
{
    /// <summary>
    /// Renders a string (typically a share URL) to a QR <see cref="Texture2D"/>.
    /// Reuses the package's <see cref="QrCode"/> encoder; this type only rasterizes
    /// the module grid. Returns null when the text cannot be encoded.
    /// </summary>
    internal static class QrTextureRenderer
    {
        /// <summary>Number of light modules around the code (ISO/IEC 18004 quiet zone).</summary>
        public const int DefaultQuietZone = 4;

        /// <summary>Default pixels per QR module.</summary>
        public const int DefaultModulePixels = 6;

        /// <summary>
        /// Encode and rasterize <paramref name="text"/> to a QR texture using ECC
        /// level M, a 4-module quiet zone and the default module scale. Returns null
        /// on failure.
        /// </summary>
        public static Texture2D Render(string text)
        {
            return Render(text, DefaultModulePixels, DefaultQuietZone, Color.black, Color.white);
        }

        /// <summary>
        /// Encode and rasterize with explicit options. <paramref name="modulePixels"/>
        /// is the pixel size of one module; <paramref name="quietZone"/> the light
        /// border in modules. Returns null on failure (does not throw).
        /// </summary>
        public static Texture2D Render(string text, int modulePixels, int quietZone, Color dark, Color light)
        {
            try
            {
                if (string.IsNullOrEmpty(text))
                {
                    return null;
                }

                modulePixels = Mathf.Max(1, modulePixels);
                quietZone = Mathf.Max(0, quietZone);

                bool[,] modules;
                if (!QrCode.TryEncode(text, QrCode.Ecc.M, out modules) || modules == null)
                {
                    FlogLog.Warn("QR encode failed (text too long for versions 1..10?).");
                    return null;
                }

                int count = modules.GetLength(0);             // modules per side
                int totalModules = count + quietZone * 2;     // include quiet border
                int sizePixels = totalModules * modulePixels;

                var tex = new Texture2D(sizePixels, sizePixels, TextureFormat.RGBA32, false)
                {
                    filterMode = FilterMode.Point,
                    wrapMode = TextureWrapMode.Clamp
                };

                var pixels = new Color32[sizePixels * sizePixels];
                Color32 darkC = dark;
                Color32 lightC = light;

                // Fill light first (covers the quiet zone and all light modules).
                for (int i = 0; i < pixels.Length; i++)
                {
                    pixels[i] = lightC;
                }

                // Paint dark modules. QR origin is top-left; texture origin is
                // bottom-left, so flip the row to keep the code upright.
                for (int my = 0; my < count; my++)
                {
                    for (int mx = 0; mx < count; mx++)
                    {
                        if (!modules[mx, my])
                        {
                            continue;
                        }

                        int px0 = (quietZone + mx) * modulePixels;
                        int pyTop = (quietZone + my) * modulePixels;

                        for (int dy = 0; dy < modulePixels; dy++)
                        {
                            int rowFromTop = pyTop + dy;
                            int texRow = sizePixels - 1 - rowFromTop; // vertical flip
                            int rowStart = texRow * sizePixels + px0;
                            for (int dx = 0; dx < modulePixels; dx++)
                            {
                                pixels[rowStart + dx] = darkC;
                            }
                        }
                    }
                }

                tex.SetPixels32(pixels);
                tex.Apply(false, false);
                return tex;
            }
            catch (Exception e)
            {
                FlogLog.Exception(e);
                return null;
            }
        }
    }
}
#endif
