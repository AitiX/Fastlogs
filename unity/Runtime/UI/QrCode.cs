// QrCode - a tiny, dependency-free QR Code (Model 2) encoder.
//
// Purpose: render a short shareable URL as a scannable QR so a tester can grab
// the link with a phone camera, without pulling in any NuGet / third-party
// package. Byte (8-bit) mode only, error-correction level chosen for capacity;
// versions 1..10 are supported, which comfortably covers our URLs (a v10-L code
// holds 271 bytes). If the text does not fit, Encode returns false.
//
// The implementation follows ISO/IEC 18004: data encoding -> Reed-Solomon ECC
// over GF(256) -> block interleaving -> matrix placement (finders, timing,
// alignment, format/version info) -> the 8 data masks with the standard penalty
// scoring. It is intentionally compact and self-contained.
//
// Output is a bool[size, size] (true = dark module). The overlay turns that into
// a Texture2D. Gated with the rest of the UI.

#if UNITY_EDITOR || DEVELOPMENT_BUILD || (LOGSHARE_FORCE_ENABLED && !(UNITY_PS4 || UNITY_PS5 || UNITY_GAMECORE || UNITY_SWITCH))
#define FASTLOGS_ENABLED
#endif

#if FASTLOGS_ENABLED
using System;
using System.Collections.Generic;
using System.Text;

namespace PlayJoy.FastLogs
{
    /// <summary>
    /// Minimal QR Code encoder (byte mode, versions 1..10). Produces a square
    /// module matrix; not a general-purpose library, just enough to render a link.
    /// </summary>
    internal static class QrCode
    {
        /// <summary>Error-correction level. We default to L for maximum capacity.</summary>
        public enum Ecc { L = 0, M = 1, Q = 2, H = 3 }

        private const int MaxVersion = 10;

        /// <summary>
        /// Encode <paramref name="text"/> as a QR matrix. Returns false if the
        /// text does not fit within versions 1..10 at the requested ECC level, or
        /// on any failure. On success <paramref name="modules"/> is a [size,size]
        /// grid (true = dark).
        /// </summary>
        public static bool TryEncode(string text, Ecc ecc, out bool[,] modules)
        {
            modules = null;
            try
            {
                if (string.IsNullOrEmpty(text))
                {
                    return false;
                }

                byte[] data = Encoding.UTF8.GetBytes(text);

                int version;
                if (!ChooseVersion(data.Length, ecc, out version))
                {
                    return false;
                }

                int eccLevel = (int)ecc;
                int totalCodewords = NumRawDataModules(version) / 8;
                int eccPerBlock = EccCodewordsPerBlock[eccLevel][version];
                int numBlocks = NumErrorCorrectionBlocks[eccLevel][version];
                int eccTotal = eccPerBlock * numBlocks;
                int dataCapacity = totalCodewords - eccTotal;

                // ---- 1) Build the data bit stream (byte mode) ----
                var bits = new BitBuffer();
                bits.AppendBits(0x4, 4);                       // byte mode indicator
                int countBits = version < 10 ? 8 : 16;         // versions 1..9 use 8, 10+ use 16
                bits.AppendBits((uint)data.Length, countBits);
                for (int i = 0; i < data.Length; i++)
                {
                    bits.AppendBits(data[i], 8);
                }

                int capacityBits = dataCapacity * 8;
                if (bits.Length > capacityBits)
                {
                    return false; // should not happen after ChooseVersion, but guard
                }

                // Terminator (up to 4 zero bits) and pad to a byte boundary.
                int terminator = Math.Min(4, capacityBits - bits.Length);
                bits.AppendBits(0, terminator);
                int padToByte = (8 - (bits.Length % 8)) % 8;
                bits.AppendBits(0, padToByte);

                // Pad bytes 0xEC, 0x11 alternating until full.
                bool alt = false;
                while (bits.Length < capacityBits)
                {
                    bits.AppendBits(alt ? 0x11u : 0xECu, 8);
                    alt = !alt;
                }

                byte[] dataCodewords = bits.ToBytes();

                // ---- 2) Reed-Solomon ECC + interleave into the final codeword stream ----
                byte[] allCodewords = AddEccAndInterleave(dataCodewords, version, eccLevel, numBlocks, eccPerBlock, dataCapacity);

                // ---- 3) Place modules into the matrix and pick the best mask ----
                int size = version * 4 + 17;
                var grid = new bool[size, size];
                var reserved = new bool[size, size];

                DrawFunctionPatterns(grid, reserved, version);
                DrawCodewords(grid, reserved, allCodewords, size);

                int bestMask = SelectMask(grid, reserved, version, eccLevel);
                ApplyMask(grid, reserved, bestMask);
                DrawFormatBits(grid, eccLevel, bestMask, size);

                modules = grid;
                return true;
            }
            catch (Exception)
            {
                modules = null;
                return false;
            }
        }

        // ---- Version selection ----

        private static bool ChooseVersion(int dataLen, Ecc ecc, out int version)
        {
            int eccLevel = (int)ecc;
            for (int v = 1; v <= MaxVersion; v++)
            {
                int totalCodewords = NumRawDataModules(v) / 8;
                int eccPerBlock = EccCodewordsPerBlock[eccLevel][v];
                int numBlocks = NumErrorCorrectionBlocks[eccLevel][v];
                int dataCapacity = totalCodewords - eccPerBlock * numBlocks;

                int countBits = v < 10 ? 8 : 16;
                // header = mode(4) + count + terminator handled separately; required
                // data bits for byte mode:
                int requiredBits = 4 + countBits + dataLen * 8;
                if (requiredBits <= dataCapacity * 8)
                {
                    version = v;
                    return true;
                }
            }
            version = 0;
            return false;
        }

        // Number of data modules (before ECC) available in a version, excluding
        // function patterns and format/version info.
        private static int NumRawDataModules(int version)
        {
            int size = version * 4 + 17;
            int result = size * size;
            result -= 8 * 8 * 3;                  // three finder + separator areas
            result -= 15 * 2 + 1;                 // format info + dark module
            result -= (size - 16) * 2;            // timing patterns
            // alignment patterns (none in version 1)
            if (version >= 2)
            {
                int numAlign = version / 7 + 2;
                result -= (numAlign - 1) * (numAlign - 1) * 25;
                result -= (numAlign - 2) * 2 * 20;
                // version info (versions >= 7)
                if (version >= 7)
                {
                    result -= 6 * 3 * 2;
                }
            }
            return result;
        }

        // ---- Reed-Solomon ----

        private static byte[] AddEccAndInterleave(byte[] data, int version, int eccLevel,
            int numBlocks, int eccLen, int dataCapacity)
        {
            // Split data into blocks. The spec gives some blocks one extra data
            // codeword (the "short" vs "long" blocks).
            int shortBlockLen = dataCapacity / numBlocks;
            int numLongBlocks = dataCapacity % numBlocks; // these get +1 data codeword

            byte[] rsDiv = ReedSolomonComputeDivisor(eccLen);

            var blocks = new List<byte[]>(numBlocks);
            var eccBlocks = new List<byte[]>(numBlocks);
            int offset = 0;
            for (int b = 0; b < numBlocks; b++)
            {
                int dataLen = shortBlockLen + (b >= numBlocks - numLongBlocks ? 1 : 0);
                var blockData = new byte[dataLen];
                Array.Copy(data, offset, blockData, 0, dataLen);
                offset += dataLen;

                byte[] ecc = ReedSolomonComputeRemainder(blockData, rsDiv);
                blocks.Add(blockData);
                eccBlocks.Add(ecc);
            }

            // Interleave data codewords, then ECC codewords.
            int totalCodewords = NumRawDataModules(version) / 8;
            var result = new byte[totalCodewords];
            int idx = 0;

            int maxDataLen = shortBlockLen + (numLongBlocks > 0 ? 1 : 0);
            for (int i = 0; i < maxDataLen; i++)
            {
                for (int b = 0; b < numBlocks; b++)
                {
                    if (i < blocks[b].Length)
                    {
                        result[idx++] = blocks[b][i];
                    }
                }
            }
            for (int i = 0; i < eccLen; i++)
            {
                for (int b = 0; b < numBlocks; b++)
                {
                    result[idx++] = eccBlocks[b][i];
                }
            }

            return result;
        }

        private static byte[] ReedSolomonComputeDivisor(int degree)
        {
            var result = new byte[degree];
            result[degree - 1] = 1; // monic: coefficient of x^0 starts at 1

            int root = 1;
            for (int i = 0; i < degree; i++)
            {
                for (int j = 0; j < degree; j++)
                {
                    result[j] = (byte)GfMultiply(result[j], (byte)root);
                    if (j + 1 < degree)
                    {
                        result[j] ^= result[j + 1];
                    }
                }
                root = GfMultiply((byte)root, 0x02);
            }
            return result;
        }

        private static byte[] ReedSolomonComputeRemainder(byte[] data, byte[] divisor)
        {
            var result = new byte[divisor.Length];
            for (int i = 0; i < data.Length; i++)
            {
                byte factor = (byte)(data[i] ^ result[0]);
                Array.Copy(result, 1, result, 0, result.Length - 1);
                result[result.Length - 1] = 0;
                for (int j = 0; j < result.Length; j++)
                {
                    result[j] ^= (byte)GfMultiply(divisor[j], factor);
                }
            }
            return result;
        }

        // GF(256) multiply with the QR primitive polynomial 0x11D.
        private static int GfMultiply(byte x, byte y)
        {
            int z = 0;
            for (int i = 7; i >= 0; i--)
            {
                z = (z << 1) ^ ((z >> 7) * 0x11D);
                z ^= ((y >> i) & 1) * x;
            }
            return z & 0xFF;
        }

        // ---- Matrix drawing ----

        private static void DrawFunctionPatterns(bool[,] grid, bool[,] reserved, int version)
        {
            int size = grid.GetLength(0);

            // Timing patterns.
            for (int i = 0; i < size; i++)
            {
                SetFunction(grid, reserved, 6, i, i % 2 == 0);
                SetFunction(grid, reserved, i, 6, i % 2 == 0);
            }

            // Finder patterns (and separators) in three corners.
            DrawFinder(grid, reserved, 3, 3);
            DrawFinder(grid, reserved, size - 4, 3);
            DrawFinder(grid, reserved, 3, size - 4);

            // Alignment patterns.
            int[] alignPos = AlignmentPatternPositions(version);
            int n = alignPos.Length;
            for (int i = 0; i < n; i++)
            {
                for (int j = 0; j < n; j++)
                {
                    // Skip the three that overlap finder patterns.
                    if ((i == 0 && j == 0) || (i == 0 && j == n - 1) || (i == n - 1 && j == 0))
                    {
                        continue;
                    }
                    DrawAlignment(grid, reserved, alignPos[i], alignPos[j]);
                }
            }

            // Reserve format-info areas (filled later) so codewords skip them.
            ReserveFormatInfo(reserved, size);

            // Dark module.
            SetFunction(grid, reserved, 8, size - 8, true);

            // Version info (versions >= 7).
            if (version >= 7)
            {
                DrawVersionInfo(grid, reserved, version, size);
            }
        }

        private static void DrawFinder(bool[,] grid, bool[,] reserved, int cx, int cy)
        {
            for (int dy = -4; dy <= 4; dy++)
            {
                for (int dx = -4; dx <= 4; dx++)
                {
                    int x = cx + dx;
                    int y = cy + dy;
                    if (x < 0 || y < 0 || x >= grid.GetLength(0) || y >= grid.GetLength(1))
                    {
                        continue;
                    }
                    int dist = Math.Max(Math.Abs(dx), Math.Abs(dy));
                    bool dark = dist != 2 && dist <= 3; // 7x7 finder ring/center, 1px separator off
                    SetFunction(grid, reserved, x, y, dark);
                }
            }
        }

        private static void DrawAlignment(bool[,] grid, bool[,] reserved, int cx, int cy)
        {
            for (int dy = -2; dy <= 2; dy++)
            {
                for (int dx = -2; dx <= 2; dx++)
                {
                    int dist = Math.Max(Math.Abs(dx), Math.Abs(dy));
                    bool dark = dist != 1;
                    SetFunction(grid, reserved, cx + dx, cy + dy, dark);
                }
            }
        }

        private static void ReserveFormatInfo(bool[,] reserved, int size)
        {
            for (int i = 0; i < 9; i++)
            {
                reserved[8, i] = true;
                reserved[i, 8] = true;
            }
            for (int i = 0; i < 8; i++)
            {
                reserved[8, size - 1 - i] = true;
                reserved[size - 1 - i, 8] = true;
            }
        }

        private static void DrawVersionInfo(bool[,] grid, bool[,] reserved, int version, int size)
        {
            int rem = version;
            for (int i = 0; i < 12; i++)
            {
                rem = (rem << 1) ^ ((rem >> 11) * 0x1F25);
            }
            int bitsValue = (version << 12) | rem;

            for (int i = 0; i < 18; i++)
            {
                bool bit = ((bitsValue >> i) & 1) != 0;
                int a = size - 11 + i % 3;
                int b = i / 3;
                SetFunction(grid, reserved, a, b, bit);
                SetFunction(grid, reserved, b, a, bit);
            }
        }

        private static void SetFunction(bool[,] grid, bool[,] reserved, int x, int y, bool dark)
        {
            if (x < 0 || y < 0 || x >= grid.GetLength(0) || y >= grid.GetLength(1))
            {
                return;
            }
            grid[x, y] = dark;
            reserved[x, y] = true;
        }

        // Zig-zag placement of the codeword bit stream into the unreserved modules.
        private static void DrawCodewords(bool[,] grid, bool[,] reserved, byte[] codewords, int size)
        {
            int bitIndex = 0;
            int totalBits = codewords.Length * 8;

            for (int right = size - 1; right >= 1; right -= 2)
            {
                if (right == 6)
                {
                    right = 5; // skip the vertical timing column
                }
                for (int vert = 0; vert < size; vert++)
                {
                    for (int j = 0; j < 2; j++)
                    {
                        int x = right - j;
                        bool upward = ((right + 1) & 2) == 0;
                        int y = upward ? size - 1 - vert : vert;
                        if (!reserved[x, y] && bitIndex < totalBits)
                        {
                            bool bit = ((codewords[bitIndex >> 3] >> (7 - (bitIndex & 7))) & 1) != 0;
                            grid[x, y] = bit;
                            bitIndex++;
                        }
                    }
                }
            }
        }

        // ---- Masking ----

        private static int SelectMask(bool[,] grid, bool[,] reserved, int version, int eccLevel)
        {
            int bestMask = 0;
            int minPenalty = int.MaxValue;
            int size = grid.GetLength(0);

            for (int mask = 0; mask < 8; mask++)
            {
                ApplyMask(grid, reserved, mask);
                DrawFormatBits(grid, eccLevel, mask, size);
                int penalty = ComputePenalty(grid);
                if (penalty < minPenalty)
                {
                    minPenalty = penalty;
                    bestMask = mask;
                }
                ApplyMask(grid, reserved, mask); // toggle back (XOR is its own inverse)
            }
            return bestMask;
        }

        private static void ApplyMask(bool[,] grid, bool[,] reserved, int mask)
        {
            int size = grid.GetLength(0);
            for (int y = 0; y < size; y++)
            {
                for (int x = 0; x < size; x++)
                {
                    if (reserved[x, y])
                    {
                        continue;
                    }
                    bool invert;
                    switch (mask)
                    {
                        case 0: invert = (x + y) % 2 == 0; break;
                        case 1: invert = y % 2 == 0; break;
                        case 2: invert = x % 3 == 0; break;
                        case 3: invert = (x + y) % 3 == 0; break;
                        case 4: invert = (y / 2 + x / 3) % 2 == 0; break;
                        case 5: invert = (x * y) % 2 + (x * y) % 3 == 0; break;
                        case 6: invert = ((x * y) % 2 + (x * y) % 3) % 2 == 0; break;
                        default: invert = ((x + y) % 2 + (x * y) % 3) % 2 == 0; break;
                    }
                    if (invert)
                    {
                        grid[x, y] = !grid[x, y];
                    }
                }
            }
        }

        private static void DrawFormatBits(bool[,] grid, int eccLevel, int mask, int size)
        {
            // ECC level bits: M=0, L=1, H=2, Q=3 in the format spec.
            int eccFormat;
            switch (eccLevel)
            {
                case 0: eccFormat = 1; break; // L
                case 1: eccFormat = 0; break; // M
                case 2: eccFormat = 3; break; // Q
                default: eccFormat = 2; break; // H
            }

            int dataBits = (eccFormat << 3) | mask;
            int rem = dataBits;
            for (int i = 0; i < 10; i++)
            {
                rem = (rem << 1) ^ ((rem >> 9) * 0x537);
            }
            int bitsValue = ((dataBits << 10) | rem) ^ 0x5412;

            // First copy near the top-left finder.
            for (int i = 0; i <= 5; i++)
            {
                SetGrid(grid, 8, i, GetBit(bitsValue, i));
            }
            SetGrid(grid, 8, 7, GetBit(bitsValue, 6));
            SetGrid(grid, 8, 8, GetBit(bitsValue, 7));
            SetGrid(grid, 7, 8, GetBit(bitsValue, 8));
            for (int i = 9; i < 15; i++)
            {
                SetGrid(grid, 14 - i, 8, GetBit(bitsValue, i));
            }

            // Second copy split across the other two finders.
            for (int i = 0; i < 8; i++)
            {
                SetGrid(grid, size - 1 - i, 8, GetBit(bitsValue, i));
            }
            for (int i = 8; i < 15; i++)
            {
                SetGrid(grid, 8, size - 15 + i, GetBit(bitsValue, i));
            }
        }

        private static bool GetBit(int value, int index)
        {
            return ((value >> index) & 1) != 0;
        }

        private static void SetGrid(bool[,] grid, int x, int y, bool dark)
        {
            if (x >= 0 && y >= 0 && x < grid.GetLength(0) && y < grid.GetLength(1))
            {
                grid[x, y] = dark;
            }
        }

        // ---- Penalty scoring (standard four rules) ----

        private static int ComputePenalty(bool[,] grid)
        {
            int size = grid.GetLength(0);
            int penalty = 0;

            // Rule 1: runs of 5+ same-colour in rows and columns.
            for (int y = 0; y < size; y++)
            {
                bool runColor = grid[0, y];
                int runLen = 1;
                for (int x = 1; x < size; x++)
                {
                    if (grid[x, y] == runColor)
                    {
                        runLen++;
                        if (runLen == 5) penalty += 3;
                        else if (runLen > 5) penalty++;
                    }
                    else { runColor = grid[x, y]; runLen = 1; }
                }
            }
            for (int x = 0; x < size; x++)
            {
                bool runColor = grid[x, 0];
                int runLen = 1;
                for (int y = 1; y < size; y++)
                {
                    if (grid[x, y] == runColor)
                    {
                        runLen++;
                        if (runLen == 5) penalty += 3;
                        else if (runLen > 5) penalty++;
                    }
                    else { runColor = grid[x, y]; runLen = 1; }
                }
            }

            // Rule 2: 2x2 same-colour blocks.
            for (int y = 0; y < size - 1; y++)
            {
                for (int x = 0; x < size - 1; x++)
                {
                    bool c = grid[x, y];
                    if (c == grid[x + 1, y] && c == grid[x, y + 1] && c == grid[x + 1, y + 1])
                    {
                        penalty += 3;
                    }
                }
            }

            // Rule 3: finder-like 1:1:3:1:1 patterns (with 4-light run) in both axes.
            penalty += FinderLikePenalty(grid, true);
            penalty += FinderLikePenalty(grid, false);

            // Rule 4: dark-module proportion deviation from 50%.
            int dark = 0;
            for (int y = 0; y < size; y++)
            {
                for (int x = 0; x < size; x++)
                {
                    if (grid[x, y]) dark++;
                }
            }
            int total = size * size;
            int percent = dark * 100 / total;
            int dev = Math.Abs(percent - 50);
            penalty += (dev / 5) * 10;

            return penalty;
        }

        private static int FinderLikePenalty(bool[,] grid, bool horizontal)
        {
            int size = grid.GetLength(0);
            int penalty = 0;
            // Two patterns: dark/light/dark*3/light/dark + 4-light on either side.
            for (int a = 0; a < size; a++)
            {
                for (int b = 0; b <= size - 11; b++)
                {
                    if (MatchesFinderRun(grid, a, b, horizontal))
                    {
                        penalty += 40;
                    }
                }
            }
            return penalty;
        }

        private static bool MatchesFinderRun(bool[,] grid, int line, int start, bool horizontal)
        {
            // 11-module window: 0000 1 0 111 0 1  OR  1 0 111 0 1 0000
            bool[] window = new bool[11];
            for (int i = 0; i < 11; i++)
            {
                window[i] = horizontal ? grid[start + i, line] : grid[line, start + i];
            }

            bool[] patA = { false, false, false, false, true, false, true, true, true, false, true };
            bool[] patB = { true, false, true, true, true, false, true, false, false, false, false };
            return ArrayEquals(window, patA) || ArrayEquals(window, patB);
        }

        private static bool ArrayEquals(bool[] a, bool[] b)
        {
            for (int i = 0; i < a.Length; i++)
            {
                if (a[i] != b[i]) return false;
            }
            return true;
        }

        // ---- Tables ----

        private static int[] AlignmentPatternPositions(int version)
        {
            if (version == 1)
            {
                return new int[0];
            }
            int numAlign = version / 7 + 2;
            int step = (version * 4 + 4) / (numAlign * 2 - 2) * 2; // even step
            // Spec algorithm: first at 6, rest spaced toward size-7.
            var result = new int[numAlign];
            result[0] = 6;
            int size = version * 4 + 17;
            int pos = size - 7;
            for (int i = numAlign - 1; i >= 1; i--)
            {
                result[i] = pos;
                pos -= step;
            }
            return result;
        }

        // Indexed [eccLevel][version]; index 0 unused. eccLevel: L=0,M=1,Q=2,H=3.
        private static readonly int[][] EccCodewordsPerBlock =
        {
            // L
            new[] { -1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18 },
            // M
            new[] { -1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26 },
            // Q
            new[] { -1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24 },
            // H
            new[] { -1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28 }
        };

        private static readonly int[][] NumErrorCorrectionBlocks =
        {
            // L
            new[] { -1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4 },
            // M
            new[] { -1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5 },
            // Q
            new[] { -1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8 },
            // H
            new[] { -1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8 }
        };

        // ---- Bit buffer ----

        private sealed class BitBuffer
        {
            private readonly List<byte> _bytes = new List<byte>();
            private int _bitLength;

            public int Length { get { return _bitLength; } }

            public void AppendBits(uint value, int count)
            {
                for (int i = count - 1; i >= 0; i--)
                {
                    int bit = (int)((value >> i) & 1);
                    int byteIndex = _bitLength >> 3;
                    if (byteIndex >= _bytes.Count)
                    {
                        _bytes.Add(0);
                    }
                    if (bit != 0)
                    {
                        _bytes[byteIndex] |= (byte)(1 << (7 - (_bitLength & 7)));
                    }
                    _bitLength++;
                }
            }

            public byte[] ToBytes()
            {
                return _bytes.ToArray();
            }
        }
    }
}
#endif
