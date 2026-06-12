// MultiTapCornerTrigger - opens the overlay when the user taps/clicks a screen
// corner N times in quick succession.
//
// Design notes:
//   - Polled from the runtime's Update() (no EventSystem / no UI raycaster needed),
//     so it works in any scene, even one without a Canvas. Logic mirrors
//     SRDebugger's MultiTapButton (tap count + window reset) but reads raw input.
//   - The hot zone is anchored to a screen corner, inset by the device safe area,
//     and is at least 44 points (Apple HIG minimum touch target) on a side. Point
//     size is derived from screen DPI so the zone is physically consistent across
//     densities.
//   - Edge-triggered: Poll() returns true exactly once when the tap count reaches
//     the threshold; the caller toggles the overlay without debouncing itself.
//   - Touch and mouse are both accepted (mouse for in-Editor testing).
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
    /// <summary>Which screen corner hosts the multi-tap hot zone.</summary>
    public enum ScreenCorner
    {
        TopLeft = 0,
        TopRight = 1,
        BottomLeft = 2,
        BottomRight = 3
    }

    /// <summary>
    /// Detects a multi-tap gesture inside a safe-area-aware corner zone. Designed
    /// to be polled once per frame from a MonoBehaviour Update; it does not need an
    /// EventSystem or any UI objects.
    /// </summary>
    public sealed class MultiTapCornerTrigger : ITriggerSource
    {
        // Minimum touch target per Apple HIG / Material guidelines (points).
        private const float MinZonePoints = 44f;
        // Reference DPI used when the platform does not report one.
        private const float FallbackDpi = 160f;

        private readonly ScreenCorner _corner;
        private int _requiredTaps;
        private float _tapWindowSeconds;
        private float _zonePoints;

        private int _tapCount;
        private float _lastTapTime;
        private bool _pointerWasDown;
        private bool _fired;

        /// <param name="corner">Corner that hosts the hot zone.</param>
        /// <param name="requiredTaps">Taps needed to fire (clamped to >= 1).</param>
        /// <param name="tapWindowSeconds">Max seconds allowed between consecutive taps.</param>
        /// <param name="zonePoints">Side of the square hot zone in points (clamped to >= 44).</param>
        public MultiTapCornerTrigger(
            ScreenCorner corner = ScreenCorner.TopLeft,
            int requiredTaps = 3,
            float tapWindowSeconds = 0.6f,
            float zonePoints = 64f)
        {
            _corner = corner;
            _requiredTaps = Mathf.Max(1, requiredTaps);
            _tapWindowSeconds = Mathf.Max(0.1f, tapWindowSeconds);
            _zonePoints = Mathf.Max(MinZonePoints, zonePoints);
        }

        /// <summary>
        /// Pulls touch-relevant values from the shared TriggerConfig. The corner
        /// multitap is mainly a mobile affordance, so a non-zero
        /// MultiTouchFingerCount is treated as "use that as the required tap count"
        /// to avoid adding another config field; otherwise defaults are kept.
        /// </summary>
        public void Configure(TriggerConfig config)
        {
            if (config == null)
            {
                return;
            }

            if (config.MultiTouchFingerCount > 0)
            {
                _requiredTaps = config.MultiTouchFingerCount;
            }

            // Reset gesture state on (re)configure.
            _tapCount = 0;
            _fired = false;
            _pointerWasDown = false;
        }

        public bool Poll()
        {
            // Expire a partial tap sequence once the window lapses.
            if (_tapCount > 0 && (Time.unscaledTime - _lastTapTime) > _tapWindowSeconds)
            {
                _tapCount = 0;
            }

            bool down;
            Vector2 pos;
            if (!TryGetPointerDown(out down, out pos))
            {
                _pointerWasDown = false;
                return false;
            }

            // Edge: count a tap only on the down transition.
            if (down && !_pointerWasDown)
            {
                if (IsInsideHotZone(pos))
                {
                    RegisterTap();
                }
                else
                {
                    // A press outside the zone aborts the sequence.
                    _tapCount = 0;
                }
            }
            _pointerWasDown = down;

            if (_fired)
            {
                _fired = false;
                _tapCount = 0;
                return true;
            }
            return false;
        }

        private void RegisterTap()
        {
            float now = Time.unscaledTime;
            if (_tapCount > 0 && (now - _lastTapTime) > _tapWindowSeconds)
            {
                _tapCount = 0;
            }
            _tapCount++;
            _lastTapTime = now;

            if (_tapCount >= _requiredTaps)
            {
                _fired = true;
            }
        }

        // Returns the current primary pointer state (touch preferred, mouse fallback).
        private static bool TryGetPointerDown(out bool isDown, out Vector2 position)
        {
            isDown = false;
            position = default;

            if (Input.touchSupported && Input.touchCount > 0)
            {
                Touch t = Input.GetTouch(0);
                position = t.position;
                isDown = t.phase != TouchPhase.Ended && t.phase != TouchPhase.Canceled;
                return true;
            }

            // Mouse fallback (Editor / standalone). mousePresent guards consoles.
            if (Input.mousePresent)
            {
                position = Input.mousePosition;
                isDown = Input.GetMouseButton(0);
                return true;
            }

            return false;
        }

        private bool IsInsideHotZone(Vector2 pixelPos)
        {
            Rect zone = ComputeZonePixels();
            return zone.Contains(pixelPos);
        }

        // Builds the corner hot zone in screen pixels, inset by the safe area and
        // sized so its side is at least the configured point size.
        private Rect ComputeZonePixels()
        {
            Rect safe = Screen.safeArea;
            // Defensive: some platforms can report an empty safe area early on.
            if (safe.width <= 1f || safe.height <= 1f)
            {
                safe = new Rect(0f, 0f, Screen.width, Screen.height);
            }

            float dpi = Screen.dpi;
            if (dpi <= 1f)
            {
                dpi = FallbackDpi;
            }
            float pointsToPixels = dpi / FallbackDpi;
            float sidePixels = _zonePoints * pointsToPixels;
            sidePixels = Mathf.Clamp(sidePixels, MinZonePoints, Mathf.Min(safe.width, safe.height));

            float x, y;
            switch (_corner)
            {
                case ScreenCorner.TopLeft:
                    x = safe.xMin;
                    y = safe.yMax - sidePixels;
                    break;
                case ScreenCorner.TopRight:
                    x = safe.xMax - sidePixels;
                    y = safe.yMax - sidePixels;
                    break;
                case ScreenCorner.BottomLeft:
                    x = safe.xMin;
                    y = safe.yMin;
                    break;
                default: // BottomRight
                    x = safe.xMax - sidePixels;
                    y = safe.yMin;
                    break;
            }

            return new Rect(x, y, sidePixels, sidePixels);
        }

        public void Dispose()
        {
            _tapCount = 0;
            _fired = false;
        }
    }
}
#endif
