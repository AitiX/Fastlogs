/// @description scr_fastlogs_input
// FastLogs GameMaker client - ЕДИНЫЙ ВВОД.
// Опрашивает: тач (device_mouse_*_to_gui / device_mouse_check_button_pressed),
//   мышь (mouse_check_button_pressed + mouse-в-GUI через device 0), клавиатуру
//   (keyboard_check_pressed FASTLOGS_HOTKEY_TOGGLE), геймпад (gamepad_button_check_pressed
//   FASTLOGS_GP_TOGGLE - консоли). Открытие/закрытие оверлея по хоткею/жесту.
//   Заполняет ui.px/ui.py/ui.pressed (координаты GUI) - их потребляет overlay в Draw GUI
//   (порядок Step -> Draw гарантирует, что hit-rects уже не от прошлого кадра, а текущие).
//
// Жест открытия (без клавиатуры): мультитач-тап тремя пальцами ИЛИ долгий тап в углу
//   (см. FASTLOGS_GESTURE_*). Чтобы не мешать игре, жест активен всегда, но открывает
//   оверлей только при FASTLOGS_ENABLED.
//
// Вызывается из obj_fastlogs_controller -> Step_0.gml: fastlogs_input_poll().
// Сверка GML-API: GM-NOTES.md (input-функции подтверждены поиском, июнь 2026).

// Кол-во слотов тача для опроса (палец 0..N-1). // TODO verify max touches по платформам.
#macro FASTLOGS_TOUCH_SLOTS    5
// Жест открытия: число одновременных касаний-«тапов» для тоггла оверлея.
#macro FASTLOGS_GESTURE_TOUCHES 3
// Геймпад-слот для опроса хоткея на консолях.
#macro FASTLOGS_GP_SLOT        0

/// Главный опрос ввода (вызывать каждый Step). no-op при !FASTLOGS_ENABLED.
function fastlogs_input_poll() {
    if (!FASTLOGS_ENABLED) return;
    var ui = fastlogs_ui_state();

    // --- 0) Ввод комментария тестера (фича COMMENT): когда поле в фокусе, клавиатура
    //   принадлежит полю. Накапливаем символы и НЕ даём хоткею-тогглу/жестам перехватить ввод
    //   (иначе печать буквы хоткея закрыла бы оверлей). Esc - выйти из режима ввода.
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
        // В режиме ввода обрабатываем только указатель (клики по кнопкам), без хоткея/жестов.
        var ptr_e = fastlogs_input_pointer();
        ui.px      = ptr_e.x;
        ui.py      = ptr_e.y;
        ui.pressed = ptr_e.pressed;
        return;
    }

    // --- 1) Хоткей клавиатуры: тоггл оверлея.
    // keyboard_check_pressed безопасен и на платформах без клавиатуры (просто не срабатывает).
    if (keyboard_check_pressed(FASTLOGS_HOTKEY_TOGGLE)) {
        fastlogs_toggle();
    }

    // --- 2) Геймпад (консоли): тоггл оверлея по FASTLOGS_GP_TOGGLE.
    // gamepad_is_connected защищает от опроса несуществующего устройства.
    if (gamepad_is_connected(FASTLOGS_GP_SLOT)) {
        if (gamepad_button_check_pressed(FASTLOGS_GP_SLOT, FASTLOGS_GP_TOGGLE)) {
            fastlogs_toggle();
        }
    }

    // --- 3) Жест мультитача: одновременные касания => тоггл (для устройств без клавиатуры).
    var active_touches = fastlogs_input_count_touches();
    // Реагируем на ВОЗРАСТАНИЕ числа касаний до порога (фронт), чтобы не повторять каждый кадр.
    if (active_touches >= FASTLOGS_GESTURE_TOUCHES && ui.__prev_touches < FASTLOGS_GESTURE_TOUCHES) {
        fastlogs_toggle();
    }
    ui.__prev_touches = active_touches;

    // --- 4) Указатель + pressed для кликов по оверлею.
    // Собираем в координатах GUI. Приоритет: первый активный тач, иначе мышь.
    var ptr = fastlogs_input_pointer();
    ui.px      = ptr.x;
    ui.py      = ptr.y;
    ui.pressed = ptr.pressed;

    // Сбрасывать pressed здесь НЕ нужно: overlay потребит его в Draw этого же кадра и
    // сам сбросит. Но если оверлей закрыт - потребителя нет, поэтому гасим, чтобы не «висел».
    if (!ui.open) ui.pressed = false;
}

/// @returns {real} число активных касаний (нажатых пальцев) в этом кадре
function fastlogs_input_count_touches() {
    var n = 0;
    for (var d = 0; d < FASTLOGS_TOUCH_SLOTS; d++) {
        // device_mouse_check_button(device, mb_left) - удержание касания пальцем d.
        if (device_mouse_check_button(d, mb_left)) n++;
    }
    return n;
}

/// @returns {struct} {x, y, pressed} - позиция указателя в GUI-координатах и факт «нажат в этом кадре»
function fastlogs_input_pointer() {
    // 1) Тач: ищем первый палец, который ИМЕННО нажат в этом кадре (pressed) - это «клик».
    for (var d = 0; d < FASTLOGS_TOUCH_SLOTS; d++) {
        if (device_mouse_check_button_pressed(d, mb_left)) {
            return {
                x: device_mouse_x_to_gui(d),
                y: device_mouse_y_to_gui(d),
                pressed: true,
            };
        }
    }
    // 2) Мышь как устройство 0: pressed левой кнопки.
    if (device_mouse_check_button_pressed(0, mb_left) || mouse_check_button_pressed(mb_left)) {
        return {
            x: device_mouse_x_to_gui(0),
            y: device_mouse_y_to_gui(0),
            pressed: true,
        };
    }
    // 3) Иначе - просто текущая позиция указателя для hover-подсветки, без клика.
    return {
        x: device_mouse_x_to_gui(0),
        y: device_mouse_y_to_gui(0),
        pressed: false,
    };
}
