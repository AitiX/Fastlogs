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

    // --- 0) Ввод текстовых полей оверлея (комментарий тестера - фича COMMENT; имя тестера -
    //   батч B): когда любое поле в фокусе, клавиатура принадлежит полю. Накапливаем символы и
    //   НЕ даём хоткею-тогглу/жестам перехватить ввод (иначе печать буквы хоткея закрыла бы
    //   оверлей). Esc - выйти из режима ввода. keyboard_string ОДИН на оба поля, но фокусы
    //   взаимоисключающие (set_editing одного снимает другое) -> опрашиваем то, что в фокусе.
    var editing_comment = variable_struct_exists(ui, "comment_editing") ? ui.comment_editing : false;
    var editing_tester  = variable_struct_exists(ui, "tester_editing")  ? ui.tester_editing  : false;
    if (editing_comment || editing_tester) {
        if (editing_tester) {
            if (script_exists(asset_get_index("fastlogs_tester_poll_input"))) {
                fastlogs_tester_poll_input();
            }
        } else {
            if (script_exists(asset_get_index("fastlogs_comment_poll_input"))) {
                fastlogs_comment_poll_input();
            }
        }
        if (keyboard_check_pressed(vk_escape)) {
            // Снять фокус с того поля, что было активно.
            if (editing_tester && script_exists(asset_get_index("fastlogs_tester_set_editing"))) {
                fastlogs_tester_set_editing(false);
            } else if (script_exists(asset_get_index("fastlogs_comment_set_editing"))) {
                fastlogs_comment_set_editing(false);
            }
        }
        // В режиме ввода обрабатываем только указатель (клики по кнопкам), без хоткея/жестов.
        // ПЕРФ (D): пишем прямо в ui.px/py/pressed (без аллокации struct на кадр).
        fastlogs_input_collect_pointer(ui);
        return;
    }

    // --- 1) Хоткей клавиатуры: тоггл оверлея.
    // keyboard_check_pressed безопасен и на платформах без клавиатуры (просто не срабатывает).
    if (keyboard_check_pressed(FASTLOGS_HOTKEY_TOGGLE)) {
        fastlogs_toggle();
    }

    // --- 1b) ОТДЕЛЬНЫЙ хоткей БЫСТРОЙ ОТПРАВКИ (фича QUICK-SEND, A): шлёт сразу, НЕ открывая
    //   оверлей. Отличается от тоггла. Защита от совпадения с тогглом (если интегратор задал
    //   одинаковые клавиши - приоритет у тоггла, quick-send пропускаем, чтобы не делать оба).
    if (FASTLOGS_HOTKEY_QUICK_SEND != FASTLOGS_HOTKEY_TOGGLE
        && keyboard_check_pressed(FASTLOGS_HOTKEY_QUICK_SEND)) {
        fastlogs_quick_send();
    }

    // --- 2) Геймпад (консоли): тоггл оверлея по FASTLOGS_GP_TOGGLE.
    // gamepad_is_connected защищает от опроса несуществующего устройства.
    if (gamepad_is_connected(FASTLOGS_GP_SLOT)) {
        if (gamepad_button_check_pressed(FASTLOGS_GP_SLOT, FASTLOGS_GP_TOGGLE)) {
            fastlogs_toggle();
        }
        // --- 2b) Геймпад: быстрая отправка по FASTLOGS_GP_QUICK_SEND (отлична от тоггла).
        if (FASTLOGS_GP_QUICK_SEND != FASTLOGS_GP_TOGGLE
            && gamepad_button_check_pressed(FASTLOGS_GP_SLOT, FASTLOGS_GP_QUICK_SEND)) {
            fastlogs_quick_send();
        }
    }

    // --- 3) Жест мультитача: одновременные касания => тоггл (для устройств без клавиатуры).
    var active_touches = fastlogs_input_count_touches();
    // Реагируем на ВОЗРАСТАНИЕ числа касаний до порога (фронт), чтобы не повторять каждый кадр.
    if (active_touches >= FASTLOGS_GESTURE_TOUCHES && ui.__prev_touches < FASTLOGS_GESTURE_TOUCHES) {
        fastlogs_toggle();
    }
    ui.__prev_touches = active_touches;

    // --- 4) Указатель + pressed для кликов по оверлею/тосту.
    // ПЕРФ (D): собираем указатель ТОЛЬКО когда есть кликабельный потребитель - открытый
    //   оверлей ИЛИ активный тост с зонами (повтор/копирование). Иначе ноль работы по вводу:
    //   гасим pressed и пропускаем опрос тача/мыши.
    var toast_active = variable_struct_exists(ui, "toast_frames") && (ui.toast_frames != 0);
    if (ui.open || toast_active) {
        // Пишем прямо в ui.px/py/pressed (без аллокации struct на кадр).
        fastlogs_input_collect_pointer(ui);
    } else {
        ui.pressed = false;
    }
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

/// Собрать указатель ПРЯМО в ui.px/py/pressed (без аллокации struct на кадр - ПЕРФ D).
///   GUI-координаты. Приоритет: первый палец, нажатый в этом кадре, иначе мышь.
/// @param {struct} ui - состояние UI (fastlogs_ui_state)
function fastlogs_input_collect_pointer(ui) {
    // 1) Тач: ищем первый палец, который ИМЕННО нажат в этом кадре (pressed) - это «клик».
    for (var d = 0; d < FASTLOGS_TOUCH_SLOTS; d++) {
        if (device_mouse_check_button_pressed(d, mb_left)) {
            ui.px      = device_mouse_x_to_gui(d);
            ui.py      = device_mouse_y_to_gui(d);
            ui.pressed = true;
            return;
        }
    }
    // 2) Мышь как устройство 0: pressed левой кнопки.
    if (device_mouse_check_button_pressed(0, mb_left) || mouse_check_button_pressed(mb_left)) {
        ui.px      = device_mouse_x_to_gui(0);
        ui.py      = device_mouse_y_to_gui(0);
        ui.pressed = true;
        return;
    }
    // 3) Иначе - просто текущая позиция указателя для hover-подсветки, без клика.
    ui.px      = device_mouse_x_to_gui(0);
    ui.py      = device_mouse_y_to_gui(0);
    ui.pressed = false;
}
