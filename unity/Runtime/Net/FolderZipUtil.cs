// FolderZipUtil - zips a folder (recursively) or an explicit list of files into a
// single .zip blob held in a MemoryStream, for SendFolder / SendFiles.
//
// IL2CPP / stripping safety (see ledger risk J): we deliberately use ONLY
// System.IO.Compression.ZipArchive + CreateEntry/Open in a MemoryStream. We do NOT
// use ZipFile.CreateFromDirectory / ZipFileExtensions, which live in the separate
// System.IO.Compression.FileSystem assembly that may not be referenced under
// IL2CPP. ZipArchive itself is part of the System.IO.Compression assembly that the
// default reference set (overrideReferences=false) and GzipUtil already rely on.
//
// Never throws out: every public entry returns null on any failure and logs it via
// FlogLog. The whole file is gated and compiled out in retail/console builds.

#if UNITY_EDITOR || DEVELOPMENT_BUILD || (LOGSHARE_FORCE_ENABLED && !(UNITY_PS4 || UNITY_PS5 || UNITY_GAMECORE || UNITY_SWITCH))
#define FASTLOGS_ENABLED
#endif

#if FASTLOGS_ENABLED
using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Compression;

namespace PlayJoy.FastLogs
{
    /// <summary>
    /// Client-side zipping for folder / multi-file uploads. Produces a single .zip
    /// byte[] using ZipArchive + CreateEntry (no FileSystem-assembly helpers). Returns
    /// null on failure; never throws.
    /// </summary>
    internal static class FolderZipUtil
    {
        /// <summary>
        /// Zip every file under <paramref name="folderPath"/> (recursively), storing each
        /// entry with a path relative to the folder so the archive unpacks to the same
        /// tree. Returns the zip bytes, or null if the folder is missing/empty or zipping
        /// failed. Empty folder (no files) returns null (nothing to send).
        /// </summary>
        public static byte[] ZipFolder(string folderPath)
        {
            if (string.IsNullOrEmpty(folderPath))
            {
                FlogLog.Warn("ZipFolder: empty path.");
                return null;
            }

            string full;
            try
            {
                full = Path.GetFullPath(folderPath);
            }
            catch (Exception e)
            {
                FlogLog.Exception(e);
                return null;
            }

            if (!Directory.Exists(full))
            {
                FlogLog.Warn("ZipFolder: directory does not exist: " + full);
                return null;
            }

            string[] files;
            try
            {
                files = Directory.GetFiles(full, "*", SearchOption.AllDirectories);
            }
            catch (Exception e)
            {
                FlogLog.Exception(e);
                return null;
            }

            if (files == null || files.Length == 0)
            {
                FlogLog.Warn("ZipFolder: directory is empty: " + full);
                return null;
            }

            // Base used to compute each entry's relative path (so the zip keeps the tree).
            string baseDir = full.EndsWith(Path.DirectorySeparatorChar.ToString(), StringComparison.Ordinal)
                ? full
                : full + Path.DirectorySeparatorChar;

            return BuildZip(files, path => RelativeEntryName(baseDir, path));
        }

        /// <summary>
        /// Zip an explicit list of files into one archive, each entry named by its file
        /// name (de-duplicated when several inputs share a name). Returns the zip bytes,
        /// or null when the list is empty / no readable file was found / zipping failed.
        /// </summary>
        public static byte[] ZipFiles(IReadOnlyList<string> filePaths)
        {
            if (filePaths == null || filePaths.Count == 0)
            {
                FlogLog.Warn("ZipFiles: no paths.");
                return null;
            }

            // Collect existing files first; bail if none are readable.
            var existing = new List<string>(filePaths.Count);
            for (int i = 0; i < filePaths.Count; i++)
            {
                string p = filePaths[i];
                if (string.IsNullOrEmpty(p))
                {
                    continue;
                }
                try
                {
                    if (File.Exists(p)) existing.Add(p);
                    else FlogLog.Warn("ZipFiles: file does not exist, skipped: " + p);
                }
                catch (Exception e) { FlogLog.Exception(e); }
            }

            if (existing.Count == 0)
            {
                FlogLog.Warn("ZipFiles: none of the given files exist.");
                return null;
            }

            // De-duplicate entry names (Path.GetFileName collisions get a numeric suffix).
            var used = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            return BuildZip(existing, path => UniqueEntryName(used, SafeFileName(path)));
        }

        // Shared zip builder: streams each source file into a fresh entry inside a single
        // MemoryStream-backed ZipArchive, then returns the resulting bytes. nameFor maps a
        // source path to its in-archive entry name. Returns null on any failure or if no
        // entry could be written.
        private static byte[] BuildZip(IList<string> files, Func<string, string> nameFor)
        {
            try
            {
                using (var ms = new MemoryStream())
                {
                    int written = 0;
                    // leaveOpen so we can read ms.ToArray() after the archive is flushed
                    // by its Dispose (the using on `archive` flushes the central directory).
                    using (var archive = new ZipArchive(ms, ZipArchiveMode.Create, leaveOpen: true))
                    {
                        for (int i = 0; i < files.Count; i++)
                        {
                            string path = files[i];
                            string entryName = nameFor(path);
                            if (string.IsNullOrEmpty(entryName))
                            {
                                continue;
                            }

                            try
                            {
                                // Optimal compression; a folder may hold many small text
                                // files where this saves a lot, and a folder upload is rare.
                                ZipArchiveEntry entry = archive.CreateEntry(entryName, CompressionLevel.Optimal);
                                using (Stream dst = entry.Open())
                                using (FileStream src = File.OpenRead(path))
                                {
                                    src.CopyTo(dst);
                                }
                                written++;
                            }
                            catch (Exception e)
                            {
                                // Skip an unreadable file rather than failing the whole zip.
                                FlogLog.Exception(e);
                            }
                        }
                    }

                    if (written == 0)
                    {
                        FlogLog.Warn("BuildZip: no entries were written.");
                        return null;
                    }

                    return ms.ToArray();
                }
            }
            catch (Exception e)
            {
                FlogLog.Exception(e);
                return null;
            }
        }

        // Forward-slash relative path inside the archive (zip entries use '/').
        private static string RelativeEntryName(string baseDir, string fullPath)
        {
            string rel = fullPath;
            if (fullPath.StartsWith(baseDir, StringComparison.OrdinalIgnoreCase))
            {
                rel = fullPath.Substring(baseDir.Length);
            }
            else
            {
                rel = SafeFileName(fullPath);
            }
            return rel.Replace('\\', '/');
        }

        private static string SafeFileName(string path)
        {
            try
            {
                string name = Path.GetFileName(path);
                return string.IsNullOrEmpty(name) ? "file" : name;
            }
            catch
            {
                return "file";
            }
        }

        // Ensure each entry name is unique within the archive: "save.dat", "save (1).dat", ...
        private static string UniqueEntryName(HashSet<string> used, string name)
        {
            if (used.Add(name))
            {
                return name;
            }

            string stem;
            string ext;
            int dot = name.LastIndexOf('.');
            if (dot > 0)
            {
                stem = name.Substring(0, dot);
                ext = name.Substring(dot);
            }
            else
            {
                stem = name;
                ext = string.Empty;
            }

            for (int n = 1; n < 10000; n++)
            {
                string candidate = stem + " (" + n + ")" + ext;
                if (used.Add(candidate))
                {
                    return candidate;
                }
            }
            return name; // pathological; fall back (archive will just hold a duplicate name)
        }
    }
}
#endif
