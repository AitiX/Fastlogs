// FastLogsBuildDefines - Editor window that explains the build-gating model and
// helps developers add or remove the LOGSHARE_FORCE_ENABLED scripting define
// for mobile / standalone targets (never for consoles).

using System;
using System.Collections.Generic;
using System.Linq;
using UnityEditor;
using UnityEngine;

namespace PlayJoy.FastLogs.Editor
{
    internal sealed class FastLogsBuildDefines : EditorWindow
    {
        // Platforms on which LOGSHARE_FORCE_ENABLED is meaningful.
        // Consoles are deliberately excluded: the gate already hard-blocks them.
        private static readonly BuildTargetGroup[] AllowedGroups =
        {
            BuildTargetGroup.Android,
            BuildTargetGroup.iOS,
            BuildTargetGroup.Standalone,
            BuildTargetGroup.WebGL,
        };

        private const string Define = "LOGSHARE_FORCE_ENABLED";

        private Vector2 _scroll;

        internal static void ShowWindow()
        {
            var win = GetWindow<FastLogsBuildDefines>(
                utility: true,
                title:   "FastLogs - Build Defines");
            win.minSize = new Vector2(460, 400);
        }

        private void OnGUI()
        {
            _scroll = EditorGUILayout.BeginScrollView(_scroll);

            // ---- Title ----
            EditorGUILayout.Space(6);
            GUILayout.Label("FastLogs - Build Gating & " + Define, EditorStyles.boldLabel);
            EditorGUILayout.Space(4);

            // ---- Explanation ----
            EditorGUILayout.HelpBox(
                "FastLogs is active only in Editor and Development Builds by default.\n\n" +
                "To enable it in a non-console RELEASE build (Android, iOS, Standalone, WebGL), " +
                "add the scripting define \"" + Define + "\" to the desired platform group.\n\n" +
                "Consoles (PS4, PS5, GameCore, Switch) are always hard-blocked regardless " +
                "of this define - no HTTP, no screenshot, no overlay will be compiled in.",
                MessageType.Info);

            EditorGUILayout.Space(6);
            GUILayout.Label("Platform Status", EditorStyles.boldLabel);
            EditorGUILayout.Space(2);

            // ---- Per-platform status table ----
            foreach (BuildTargetGroup group in AllowedGroups)
            {
                bool hasDefine = HasDefine(group, Define);

                EditorGUILayout.BeginHorizontal();

                GUILayout.Label(group.ToString(), GUILayout.Width(120));

                GUIStyle tagStyle = new GUIStyle(EditorStyles.miniLabel)
                {
                    normal = { textColor = hasDefine ? new Color(0.2f, 0.7f, 0.2f) : new Color(0.5f, 0.5f, 0.5f) }
                };
                GUILayout.Label(hasDefine ? "FORCE ENABLED" : "default (Editor+Dev only)", tagStyle, GUILayout.Width(200));

                if (hasDefine)
                {
                    if (GUILayout.Button("Remove", GUILayout.Width(80)))
                    {
                        RemoveDefine(group, Define);
                    }
                }
                else
                {
                    if (GUILayout.Button("Add", GUILayout.Width(80)))
                    {
                        AddDefine(group, Define);
                    }
                }

                EditorGUILayout.EndHorizontal();
            }

            // ---- Console note ----
            EditorGUILayout.Space(8);
            var consoleStyle = new GUIStyle(EditorStyles.miniLabel)
            {
                wordWrap = true,
                normal   = { textColor = new Color(0.6f, 0.6f, 0.6f) }
            };
            GUILayout.Label(
                "PS4 / PS5 / GameCore / Switch: these are always excluded even when " +
                Define + " is defined. Editing their defines here is intentionally " +
                "not offered.",
                consoleStyle);

            // ---- Retail warning ----
            EditorGUILayout.Space(6);
            EditorGUILayout.HelpBox(
                "Warning: enabling FastLogs in a retail build means HTTP traffic " +
                "and (optional) screenshots will run in production. Only do this " +
                "if you have a deliberate reason and have scoped access via your " +
                "ingest token and endpoint.",
                MessageType.Warning);

            EditorGUILayout.EndScrollView();
        }

        // ---- Define helpers -------------------------------------------------

        private static bool HasDefine(BuildTargetGroup group, string define)
        {
#if UNITY_2023_1_OR_NEWER
            UnityEditor.Build.NamedBuildTarget nbt = UnityEditor.Build.NamedBuildTarget.FromBuildTargetGroup(group);
            PlayerSettings.GetScriptingDefineSymbols(nbt, out string[] symbols);
            return symbols != null && System.Array.IndexOf(symbols, define) >= 0;
#else
            string raw = PlayerSettings.GetScriptingDefineSymbolsForGroup(group);
            return raw != null && Array.Exists(raw.Split(';'), s => s.Trim() == define);
#endif
        }

        private static void AddDefine(BuildTargetGroup group, string define)
        {
            if (HasDefine(group, define)) return;

#if UNITY_2023_1_OR_NEWER
            UnityEditor.Build.NamedBuildTarget nbt = UnityEditor.Build.NamedBuildTarget.FromBuildTargetGroup(group);
            PlayerSettings.GetScriptingDefineSymbols(nbt, out string[] existing);
            var list = new List<string>(existing ?? Array.Empty<string>()) { define };
            PlayerSettings.SetScriptingDefineSymbols(nbt, list.ToArray());
#else
            string raw  = PlayerSettings.GetScriptingDefineSymbolsForGroup(group);
            string next = string.IsNullOrEmpty(raw) ? define : raw + ";" + define;
            PlayerSettings.SetScriptingDefineSymbolsForGroup(group, next);
#endif
            Debug.Log("[FastLogs] Added " + define + " to " + group);
        }

        private static void RemoveDefine(BuildTargetGroup group, string define)
        {
            if (!HasDefine(group, define)) return;

#if UNITY_2023_1_OR_NEWER
            UnityEditor.Build.NamedBuildTarget nbt = UnityEditor.Build.NamedBuildTarget.FromBuildTargetGroup(group);
            PlayerSettings.GetScriptingDefineSymbols(nbt, out string[] existing);
            string[] filtered = existing == null
                ? Array.Empty<string>()
                : existing.Where(s => s != define).ToArray();
            PlayerSettings.SetScriptingDefineSymbols(nbt, filtered);
#else
            string raw = PlayerSettings.GetScriptingDefineSymbolsForGroup(group);
            var parts = raw.Split(';').Select(s => s.Trim())
                           .Where(s => !string.IsNullOrEmpty(s) && s != define);
            PlayerSettings.SetScriptingDefineSymbolsForGroup(group, string.Join(";", parts));
#endif
            Debug.Log("[FastLogs] Removed " + define + " from " + group);
        }
    }
}
