// FastLogsMenu - top-level Editor menu entries for FastLogs.
// Tools/PlayJoy/FastLogs/...

using System.IO;
using UnityEditor;
using UnityEngine;

namespace PlayJoy.FastLogs.Editor
{
    internal static class FastLogsMenu
    {
        private const string MenuRoot   = "Tools/PlayJoy/FastLogs/";
        private const string DefaultRes = "Assets/Resources";
        private const string AssetName  = "FastLogsConfig.asset";

        // ---- Create / select config -----------------------------------------

        [MenuItem(MenuRoot + "Create Config Asset", false, 0)]
        private static void CreateConfig()
        {
            string existingGuid = FindFirstConfigGuid();
            if (!string.IsNullOrEmpty(existingGuid))
            {
                PingAsset(existingGuid);
                Debug.Log("[FastLogs] Config already exists at: " +
                          AssetDatabase.GUIDToAssetPath(existingGuid));
                return;
            }

            if (!AssetDatabase.IsValidFolder(DefaultRes))
            {
                Directory.CreateDirectory(DefaultRes);
                AssetDatabase.Refresh();
            }

            var config = ScriptableObject.CreateInstance<FastLogsConfig>();
            string path = AssetDatabase.GenerateUniqueAssetPath(DefaultRes + "/" + AssetName);
            AssetDatabase.CreateAsset(config, path);
            AssetDatabase.SaveAssets();

            Selection.activeObject = config;
            EditorGUIUtility.PingObject(config);
            Debug.Log("[FastLogs] Created config at: " + path);
        }

        [MenuItem(MenuRoot + "Select Config Asset", false, 1)]
        private static void SelectConfig()
        {
            string guid = FindFirstConfigGuid();
            if (string.IsNullOrEmpty(guid))
            {
                Debug.LogWarning("[FastLogs] No FastLogsConfig asset found. " +
                                 "Use 'Create Config Asset' first.");
                return;
            }
            PingAsset(guid);
        }

        // ---- README ---------------------------------------------------------

        [MenuItem(MenuRoot + "Open README", false, 20)]
        public static void OpenReadme()
        {
            // Locate the README.md that ships with the package.
            // Works both from the Packages/ cache and when the package is
            // embedded / imported as a local folder.
            string[] guids = AssetDatabase.FindAssets("FastLogs README");
            foreach (string guid in guids)
            {
                string p = AssetDatabase.GUIDToAssetPath(guid);
                if (p.EndsWith("README.md", System.StringComparison.OrdinalIgnoreCase))
                {
                    var asset = AssetDatabase.LoadAssetAtPath<TextAsset>(p);
                    if (asset != null)
                    {
                        Selection.activeObject = asset;
                        EditorGUIUtility.PingObject(asset);
                        return;
                    }
                }
            }

            // Fallback: open in the system text editor via the file system.
            string packageDir = FindPackageDirectory();
            if (!string.IsNullOrEmpty(packageDir))
            {
                string readmePath = Path.Combine(packageDir, "README.md");
                if (File.Exists(readmePath))
                {
                    EditorUtility.OpenWithDefaultApp(readmePath);
                    return;
                }
            }

            Debug.LogWarning("[FastLogs] README.md not found. " +
                             "It should be at the root of the FastLogs package.");
        }

        // ---- Build defines helper -------------------------------------------

        [MenuItem(MenuRoot + "Build Defines Helper", false, 40)]
        private static void OpenBuildDefines()
        {
            FastLogsBuildDefines.ShowWindow();
        }

        // ---- Internals ------------------------------------------------------

        private static string FindFirstConfigGuid()
        {
            string[] guids = AssetDatabase.FindAssets("t:" + nameof(FastLogsConfig));
            return guids != null && guids.Length > 0 ? guids[0] : null;
        }

        private static void PingAsset(string guid)
        {
            string path  = AssetDatabase.GUIDToAssetPath(guid);
            var    asset = AssetDatabase.LoadAssetAtPath<FastLogsConfig>(path);
            Selection.activeObject = asset;
            EditorGUIUtility.PingObject(asset);
        }

        /// <summary>
        /// Tries to locate the FastLogs package directory on disk.
        /// Works for git-URL packages (Library/PackageCache) and embedded packages.
        /// </summary>
        internal static string FindPackageDirectory()
        {
            // Attempt 1: find via package.json guid.
            string[] jsGuids = AssetDatabase.FindAssets("FastLogs package");
            foreach (string g in jsGuids)
            {
                string p = AssetDatabase.GUIDToAssetPath(g);
                if (p.EndsWith("package.json", System.StringComparison.OrdinalIgnoreCase))
                {
                    string dir = Path.GetDirectoryName(p);
                    if (!string.IsNullOrEmpty(dir)) return dir;
                }
            }

            // Attempt 2: walk up from this script's compiled location.
            // Editor assembly DLL is usually in Library/ScriptAssemblies or
            // Temp; not reliable. Just return null - callers fall back gracefully.
            return null;
        }
    }
}
