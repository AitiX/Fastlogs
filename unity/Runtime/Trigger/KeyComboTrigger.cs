// KeyComboTrigger - opens the overlay on a keyboard shortcut (key + optional
// modifier), e.g. Ctrl+F8.
//
// Input backend selection:
//   - ENABLE_LEGACY_INPUT_MANAGER -> UnityEngine.Input (GetKeyDown / GetKey).
//   - ENABLE_INPUT_SYSTEM (and NOT legacy) -> UnityEngine.InputSystem.Keyboard.
//   - If neither is available (no input at all) the trigger is inert.
// Both can be on at once ("Both" in Player Settings); legacy takes priority so we
// never reference a package that might not be installed.
//
// Edge-triggered: Poll() returns true only on the frame the key transitions down
// while the required modifier is held.
//
// Gated: the whole file compiles only where FastLogs is enabled.

#if UNITY_EDITOR || DEVELOPMENT_BUILD || (LOGSHARE_FORCE_ENABLED && !(UNITY_PS4 || UNITY_PS5 || UNITY_GAMECORE || UNITY_SWITCH))
#define FASTLOGS_ENABLED
#endif

#if FASTLOGS_ENABLED
using System;
using UnityEngine;

namespace PlayJoy.FastLogs
{
    /// <summary>
    /// A keyboard combo trigger driven from Update. Reads the legacy Input manager
    /// when available, otherwise the new Input System keyboard. Inert if keyboard
    /// input is disabled in the trigger config or unavailable on the platform.
    /// </summary>
    public sealed class KeyComboTrigger : ITriggerSource
    {
        private bool _enabled;
        private KeyCode _key = KeyCode.F8;
        private TriggerConfig.TriggerModifier _modifier = TriggerConfig.TriggerModifier.None;

        public void Configure(TriggerConfig config)
        {
            if (config == null)
            {
                _enabled = false;
                return;
            }

            _enabled = config.EnableKeyboard;
            _key = config.ToggleKey;
            _modifier = config.Modifier;
        }

        public bool Poll()
        {
            if (!_enabled || _key == KeyCode.None)
            {
                return false;
            }

            if (!ModifierHeld(_modifier))
            {
                return false;
            }

            return KeyWentDown(_key);
        }

        // ---- Backend-specific helpers ----

#if ENABLE_LEGACY_INPUT_MANAGER
        private static bool KeyWentDown(KeyCode key)
        {
            return Input.GetKeyDown(key);
        }

        private static bool ModifierHeld(TriggerConfig.TriggerModifier modifier)
        {
            switch (modifier)
            {
                case TriggerConfig.TriggerModifier.None:
                    return true;
                case TriggerConfig.TriggerModifier.Ctrl:
                    return Input.GetKey(KeyCode.LeftControl) || Input.GetKey(KeyCode.RightControl);
                case TriggerConfig.TriggerModifier.Alt:
                    return Input.GetKey(KeyCode.LeftAlt) || Input.GetKey(KeyCode.RightAlt);
                case TriggerConfig.TriggerModifier.Shift:
                    return Input.GetKey(KeyCode.LeftShift) || Input.GetKey(KeyCode.RightShift);
                case TriggerConfig.TriggerModifier.Cmd:
                    return Input.GetKey(KeyCode.LeftCommand) || Input.GetKey(KeyCode.RightCommand)
                        || Input.GetKey(KeyCode.LeftWindows) || Input.GetKey(KeyCode.RightWindows);
                default:
                    return true;
            }
        }
#elif ENABLE_INPUT_SYSTEM
        private static bool KeyWentDown(KeyCode key)
        {
            var keyboard = UnityEngine.InputSystem.Keyboard.current;
            if (keyboard == null)
            {
                return false;
            }
            UnityEngine.InputSystem.Key mapped = MapKey(key);
            if (mapped == UnityEngine.InputSystem.Key.None)
            {
                return false;
            }
            var control = keyboard[mapped];
            return control != null && control.wasPressedThisFrame;
        }

        private static bool ModifierHeld(TriggerConfig.TriggerModifier modifier)
        {
            var keyboard = UnityEngine.InputSystem.Keyboard.current;
            if (keyboard == null)
            {
                return modifier == TriggerConfig.TriggerModifier.None;
            }

            switch (modifier)
            {
                case TriggerConfig.TriggerModifier.None:
                    return true;
                case TriggerConfig.TriggerModifier.Ctrl:
                    return keyboard.leftCtrlKey.isPressed || keyboard.rightCtrlKey.isPressed;
                case TriggerConfig.TriggerModifier.Alt:
                    return keyboard.leftAltKey.isPressed || keyboard.rightAltKey.isPressed;
                case TriggerConfig.TriggerModifier.Shift:
                    return keyboard.leftShiftKey.isPressed || keyboard.rightShiftKey.isPressed;
                case TriggerConfig.TriggerModifier.Cmd:
                    return keyboard.leftMetaKey.isPressed || keyboard.rightMetaKey.isPressed;
                default:
                    return true;
            }
        }

        // Maps the small set of toggle keys we expect (function keys, letters,
        // digits) from KeyCode to the Input System's Key enum. Unmapped keys
        // return Key.None so the trigger stays inert rather than misfiring.
        private static UnityEngine.InputSystem.Key MapKey(KeyCode key)
        {
            switch (key)
            {
                case KeyCode.F1: return UnityEngine.InputSystem.Key.F1;
                case KeyCode.F2: return UnityEngine.InputSystem.Key.F2;
                case KeyCode.F3: return UnityEngine.InputSystem.Key.F3;
                case KeyCode.F4: return UnityEngine.InputSystem.Key.F4;
                case KeyCode.F5: return UnityEngine.InputSystem.Key.F5;
                case KeyCode.F6: return UnityEngine.InputSystem.Key.F6;
                case KeyCode.F7: return UnityEngine.InputSystem.Key.F7;
                case KeyCode.F8: return UnityEngine.InputSystem.Key.F8;
                case KeyCode.F9: return UnityEngine.InputSystem.Key.F9;
                case KeyCode.F10: return UnityEngine.InputSystem.Key.F10;
                case KeyCode.F11: return UnityEngine.InputSystem.Key.F11;
                case KeyCode.F12: return UnityEngine.InputSystem.Key.F12;
                case KeyCode.BackQuote: return UnityEngine.InputSystem.Key.Backquote;
                case KeyCode.Tab: return UnityEngine.InputSystem.Key.Tab;
                case KeyCode.Return: return UnityEngine.InputSystem.Key.Enter;
                case KeyCode.Space: return UnityEngine.InputSystem.Key.Space;
                case KeyCode.Escape: return UnityEngine.InputSystem.Key.Escape;
                case KeyCode.Alpha0: return UnityEngine.InputSystem.Key.Digit0;
                case KeyCode.Alpha1: return UnityEngine.InputSystem.Key.Digit1;
                case KeyCode.Alpha2: return UnityEngine.InputSystem.Key.Digit2;
                case KeyCode.Alpha3: return UnityEngine.InputSystem.Key.Digit3;
                case KeyCode.Alpha4: return UnityEngine.InputSystem.Key.Digit4;
                case KeyCode.Alpha5: return UnityEngine.InputSystem.Key.Digit5;
                case KeyCode.Alpha6: return UnityEngine.InputSystem.Key.Digit6;
                case KeyCode.Alpha7: return UnityEngine.InputSystem.Key.Digit7;
                case KeyCode.Alpha8: return UnityEngine.InputSystem.Key.Digit8;
                case KeyCode.Alpha9: return UnityEngine.InputSystem.Key.Digit9;
                default:
                    break;
            }

            // Letters A-Z map contiguously in both enums.
            if (key >= KeyCode.A && key <= KeyCode.Z)
            {
                int offset = (int)key - (int)KeyCode.A;
                return UnityEngine.InputSystem.Key.A + offset;
            }

            return UnityEngine.InputSystem.Key.None;
        }
#else
        // No input backend compiled in: trigger is inert.
        private static bool KeyWentDown(KeyCode key)
        {
            return false;
        }

        private static bool ModifierHeld(TriggerConfig.TriggerModifier modifier)
        {
            return false;
        }
#endif

        public void Dispose()
        {
            _enabled = false;
        }
    }
}
#endif
