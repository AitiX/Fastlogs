/// @description scr_fastlogs_input
// FastLogs GameMaker client - UNIFIED INPUT.
// Polls: touch (device_mouse_*_to_gui / device_mouse_check_button_pressed),
//   mouse (mouse_check_button_pressed + mouse-in-GUI via device 0), keyboard
//   (keyboard_check_pressed FASTLOGS_HOTKEY_TOGGLE), gamepad (gamepad_button_check_pressed
//   FASTLOGS_GP_TOGGLE - consoles). Opens/closes the overlay via hotkey/gesture.
//   Fills ui.px/ui.py/ui.pressed (GUI coordinates) - consumed by overlay in Draw GUI
//   (Step -> Draw order guarantees hit-rects are current-frame, not from the previous frame).
//
// Open gesture (no keyboard): multi-touch tap with three fingers OR long tap in the corner
//   (see FASTLOGS_GESTURE_*). To avoid interfering with the game, the gesture is always active
//   but only opens the overlay when FASTLOGS_ENABLED.
//
// Called from obj_fastlogs_controller -> Step_0.gml: fastlogs_input_poll().
// GML-API reference: GM-NOTES.md (input functions confirmed by search, June 2026).

// Number of touch slots to poll (finger 0..N-1). // TODO verify max touches per platform.
#macro FASTLOGS_TOUCH_SLOTS    5
// Open gesture: number of simultaneous tap-touches required to toggle the overlay.
#macro FASTLOGS_GESTURE_TOUCHES 3
// Gamepad slot to poll for the hotkey on consoles.
#macro FASTLOGS_GP_SLOT        0

/// Main input poll (call every Step). No-op when !FASTLOGS_ENABLED.
function fastlogs_input_poll() {
    if (!FASTLOGS_ENABLED) return;
    var ui = fastlogs_ui_state();

    // --- 0) Tester comment input (COMMENT feature): when the field is focused, the keyboard
    //   belongs to the field. We accumulate characters and do NOT let the toggle hotkey/gestures
    //   intercept input (otherwise typing the hotkey letter would close the overlay). Esc exits
    //   input mode.
    var editing = variable_struct_exists(ui, "comment_editing") ? ui.comment_editing : false;
    if (editing) {
        if (script_exists(asset_get_index("fastlogs_comment_poll_input"))) {
            fastlogs_comment_poll_input();
        }
        if (keyboard_check_pressed(vk_escape)) {
            if (script_exists(asset_get_index("fastlogs_comment_set_editing"))) {
                fastlogs_comment_set_editing(false);
            }
        }
        // In input mode, process only the pointer (button clicks), no hotkey/gestures.
        // PERF (D): write directly into ui.px/py/pressed (no struct allocation per frame).
        fastlogs_input_collect_pointer(ui);
        return;
    }

    // --- 1) Keyboard hotkey: toggle overlay.
    // keyboard_check_pressed is safe even on platforms without a keyboard (simply never fires).
    if (keyboard_check_pressed(FASTLOGS_HOTKEY_TOGGLE)) {
        fastlogs_toggle();
    }

    // --- 1b) SEPARATE QUICK-SEND hotkey (QUICK-SEND feature, A): sends immediately WITHOUT
    //   opening the overlay. Different from the toggle. Guard against collision with toggle
    //   (if integrator assigned identical keys - toggle takes priority, quick-send is skipped
    //   so both actions do not fire).
    if (FASTLOGS_HOTKEY_QUICK_SEND != FASTLOGS_HOTKEY_TOGGLE
        && keyboard_check_pressed(FASTLOGS_HOTKEY_QUICK_SEND)) {
        fastlogs_quick_send();
    }

    // --- 2) Gamepad (consoles): toggle overlay via FASTLOGS_GP_TOGGLE.
    // gamepad_is_connected guards against polling a non-existent device.
    if (gamepad_is_connected(FASTLOGS_GP_SLOT)) {
        if (gamepad_button_check_pressed(FASTLOGS_GP_SLOT, FASTLOGS_GP_TOGGLE)) {
            fastlogs_toggle();
        }
        // --- 2b) Gamepad: quick send via FASTLOGS_GP_QUICK_SEND (distinct from toggle).
        if (FASTLOGS_GP_QUICK_SEND != FASTLOGS_GP_TOGGLE
            && gamepad_button_check_pressed(FASTLOGS_GP_SLOT, FASTLOGS_GP_QUICK_SEND)) {
            fastlogs_quick_send();
        }
    }

    // --- 3) Multi-touch gesture: simultaneous touches => toggle (for devices without a keyboard).
    var active_touches = fastlogs_input_count_touches();
    // React to the RISING EDGE of touch count reaching the threshold, to avoid repeating every frame.
    if (active_touches >= FASTLOGS_GESTURE_TOUCHES && ui.__prev_touches < FASTLOGS_GESTURE_TOUCHES) {
        fastlogs_toggle();
    }
    ui.__prev_touches = active_touches;

    // --- 4) Pointer + pressed for clicks on the overlay/toast.
    // PERF (D): collect pointer ONLY when there is a clickable consumer - open overlay
    //   OR active toast with hit zones (retry/copy). Otherwise zero input work:
    //   clear pressed and skip touch/mouse polling.
    var toast_active = variable_struct_exists(ui, "toast_frames") && (ui.toast_frames != 0);
    if (ui.open || toast_active) {
        // Write directly into ui.px/py/pressed (no struct allocation per frame).
        fastlogs_input_collect_pointer(ui);
    } else {
        ui.pressed = false;
    }
}

/// @returns {real} number of active touches (pressed fingers) in this frame
function fastlogs_input_count_touches() {
    var n = 0;
    for (var d = 0; d < FASTLOGS_TOUCH_SLOTS; d++) {
        // device_mouse_check_button(device, mb_left) - held touch of finger d.
        if (device_mouse_check_button(d, mb_left)) n++;
    }
    return n;
}

/// Collect pointer DIRECTLY into ui.px/py/pressed (no struct allocation per frame - PERF D).
///   GUI coordinates. Priority: first finger pressed this frame, otherwise mouse.
/// @param {struct} ui - UI state (fastlogs_ui_state)
function fastlogs_input_collect_pointer(ui) {
    // 1) Touch: find the first finger that was pressed exactly this frame (pressed) - that is a "click".
    for (var d = 0; d < FASTLOGS_TOUCH_SLOTS; d++) {
        if (device_mouse_check_button_pressed(d, mb_left)) {
            ui.px      = device_mouse_x_to_gui(d);
            ui.py      = device_mouse_y_to_gui(d);
            ui.pressed = true;
            return;
        }
    }
    // 2) Mouse as device 0: left button pressed.
    if (device_mouse_check_button_pressed(0, mb_left) || mouse_check_button_pressed(mb_left)) {
        ui.px      = device_mouse_x_to_gui(0);
        ui.py      = device_mouse_y_to_gui(0);
        ui.pressed = true;
        return;
    }
    // 3) Otherwise - just the current pointer position for hover highlighting, no click.
    ui.px      = device_mouse_x_to_gui(0);
    ui.py      = device_mouse_y_to_gui(0);
    ui.pressed = false;
}
