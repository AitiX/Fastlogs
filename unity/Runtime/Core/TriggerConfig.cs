// TriggerConfig - serializable settings describing how the FastLogs overlay is
// summoned at runtime. The actual ITriggerSource implementations (provided by a
// builder) read these values. Neutral defaults: nothing forced on.

using System;
using UnityEngine;

namespace PlayJoy.FastLogs
{
    /// <summary>
    /// Describes the input gestures that open the FastLogs overlay. Consumed by
    /// ITriggerSource implementations. All defaults are conservative.
    /// </summary>
    [Serializable]
    public sealed class TriggerConfig
    {
        [Header("Keyboard (Editor / Standalone)")]
        [Tooltip("Enable a keyboard shortcut to toggle the overlay.")]
        public bool EnableKeyboard = true;

        [Tooltip("Primary key for the overlay shortcut.")]
        public KeyCode ToggleKey = KeyCode.F8;

        [Tooltip("Require this modifier alongside ToggleKey (None = no modifier).")]
        public TriggerModifier Modifier = TriggerModifier.None;

        [Header("Quick-send (no overlay)")]
        [Tooltip("Enable a keyboard shortcut that sends the current recording immediately, WITHOUT opening the overlay. Off by default; distinct from the overlay shortcut.")]
        public bool EnableQuickSendKeyboard = false;

        [Tooltip("Key for the quick-send shortcut. Pick one different from ToggleKey.")]
        public KeyCode QuickSendKey = KeyCode.F9;

        [Tooltip("Require this modifier alongside QuickSendKey (None = no modifier).")]
        public TriggerModifier QuickSendModifier = TriggerModifier.None;

        [Tooltip("On mobile, quick-send when this many fingers touch a corner that many times. 0 = disabled. Distinct from the overlay corner gesture.")]
        [Range(0, 5)]
        public int QuickSendCornerTaps = 0;

        [Header("Touch (Mobile)")]
        [Tooltip("Open the overlay when this many fingers touch the screen at once. 0 = disabled.")]
        [Range(0, 5)]
        public int MultiTouchFingerCount = 0;

        [Header("Shake (Mobile)")]
        [Tooltip("Open the overlay on a device shake (accelerometer).")]
        public bool EnableShake = false;

        [Tooltip("Acceleration magnitude (in g) above which a shake is registered.")]
        [Min(0.1f)]
        public float ShakeThreshold = 2.5f;

        [Tooltip("Minimum seconds between two shake triggers.")]
        [Min(0f)]
        public float ShakeCooldownSeconds = 1.0f;

        /// <summary>Modifier keys for the keyboard trigger.</summary>
        public enum TriggerModifier
        {
            None = 0,
            Ctrl = 1,
            Alt = 2,
            Shift = 3,
            Cmd = 4
        }
    }
}
