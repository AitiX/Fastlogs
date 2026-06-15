/// @description scr_fastlogs_overlay
// FastLogs GameMaker client - ОВЕРЛЕЙ (рисование примитивами, без спрайтов).
// Рисует: счётчики E/W/L цветом, кнопку "Отправить", тоггл "Скриншот", область URL +
//   кнопку "Копировать", и НЕЗАВИСИМУЮ панель настроек (endpoint/appId показ, тоггл
//   скриншота, autosend, Start/Stop Recording с индикатором, Clear, ёмкость буфера).
// Раскладка масштабируется под display_get_gui_width/height. Крупные тап-зоны (hit-test).
// Настройки персистятся через ini_* (см. fastlogs_ui_settings_load/save).
//
// АРХИТЕКТУРА: всё UI-состояние держим в global.__fastlogs_ui (ленивая инициализация),
//   чтобы overlay/input были самодостаточны и безопасны к вызову до fastlogs_init
//   (инвариант PUBLIC-API). Публичные функции при !FASTLOGS_ENABLED делают no-op.
//
// Сверка GML-API: GM-NOTES.md. Рисование (draw_rectangle/draw_text/draw_set_*),
//   display_get_gui_* и ini_* - стандартные функции (подтверждены поиском, июнь 2026).

// =====================================================================================
// СОСТОЯНИЕ UI (ленивая инициализация). Хранит флаги оверлея, hover/нажатые зоны,
//   собранные на этот кадр прямоугольники-кнопки (hit-rects) и кэш ini-настроек.
// =====================================================================================
function fastlogs_ui_state() {
    if (!variable_global_exists("__fastlogs_ui")) {
        global.__fastlogs_ui = {
            open:            false,   // показан ли оверлей
            settings_open:   false,   // показана ли панель настроек
            // Зоны клика на ТЕКУЩИЙ кадр: массив структур {x1,y1,x2,y2,id}.
            //   Заполняется при отрисовке (Draw GUI), читается вводом (input) на след. опросе.
            hit:             [],
            // Указатель ввода в координатах GUI на этот кадр (input заполняет).
            px:              0,
            py:              0,
            pressed:         false,   // был ли pressed-тап в этом кадре
            hover_id:        "",      // id зоны под указателем (для подсветки)
            __prev_touches:  0,       // число касаний на прошлом кадре (для фронта жеста)
            // Тост (clipboard + STATUS, B): текст + таймер кадров до скрытия + тип/доп.поля.
            toast_text:      "",
            toast_frames:    0,       // кадров до скрытия (0 -> нет тоста). -1 -> держать (sending).
            toast_kind:      "info",  // "info" | "sending" | "ok" | "error"
            toast_url:       "",      // ссылка для тоста "ok" (показываем + клик копирует)
            toast_retry:     false,   // показывать ли подсказку/зону "Повторить" (тост "error")
            // Комментарий тестера (фича COMMENT). Накапливается inline через keyboard_string;
            //   уходит в opts.comment при отправке. Контракт: <=4000 символов.
            comment_text:    "",      // текущий введённый текст
            comment_editing: false,   // активен ли режим ввода (фокус на поле комментария)
            // Имя тестера (батч B - ОБЯЗАТЕЛЬНО на ручном overlay-send). Редактируемое inline-поле
            //   (тот же путь keyboard_string, что и комментарий). При входе в фокус засевается
            //   текущим эффективным именем (config/runtime-override) - чтобы тестер увидел и при
            //   желании поправил его, а не вводил с нуля. Введённое непустое имя применяется в
            //   runtime-конфиг (st.cfg.tester), откуда payload его и читает. Кнопка "Отправить"
            //   ЗАБЛОКИРОВАНА, пока имя (после trim) пустое. keyboard_string ОДИН на оба поля ->
            //   фокус взаимоисключающий (вход в одно поле снимает фокус с другого).
            tester_text:     "",      // текущий введённый текст имени тестера
            tester_editing:  false,   // активен ли режим ввода (фокус на поле имени тестера)
            tester_seeded:   false,   // засеяли ли tester_text эффективным именем из конфига (1 раз)
            // Настройки (персист ini). Значения подгружаются fastlogs_ui_settings_load().
            settings_loaded: false,
            cfg_screenshot:  FASTLOGS_SCREENSHOT_DEFAULT,
            cfg_autosend:    false,                       // авто-отправка по кнопке (UI-уровень)
            cfg_ring_size:   FASTLOGS_RING_SIZE,          // ёмкость буфера (показ/правка)
            cfg_scrub_pii:   FASTLOGS_SCRUB_PII,          // чистка PII (#3); ДЕФОЛТ приватно (true)
        };
    }
    return global.__fastlogs_ui;
}

// =====================================================================================
// ПУБЛИЧНОЕ API ОВЕРЛЕЯ (PUBLIC-API.md): open/close/toggle. no-op при !FASTLOGS_ENABLED.
// =====================================================================================
function fastlogs_open() {
    if (!FASTLOGS_ENABLED) return;
    var ui = fastlogs_ui_state();
    if (!ui.settings_loaded) fastlogs_ui_settings_load();
    ui.open = true;
}

function fastlogs_close() {
    if (!FASTLOGS_ENABLED) return;
    fastlogs_ui_state().open = false;
}

function fastlogs_toggle() {
    if (!FASTLOGS_ENABLED) return;
    var ui = fastlogs_ui_state();
    if (ui.open) fastlogs_close(); else fastlogs_open();
}

/// @returns {bool} открыт ли оверлей сейчас
function fastlogs_is_open() {
    if (!FASTLOGS_ENABLED) return false;
    return fastlogs_ui_state().open;
}

// =====================================================================================
// КОММЕНТАРИЙ ТЕСТЕРА (фича COMMENT). Многострочный inline-ввод через keyboard_string.
//   Путь keyboard_string выбран как надёжный для inline-накопления в оверлее (desktop/HTML5);
//   нативный get_string_async на части платформ однострочный/модальный - не подходит.
//   // TODO verify доступность keyboard_string на целевых консолях (там обычно экранная
//   клавиатура через get_string_async; для консолей COMMENT можно не предлагать).
// =====================================================================================

// Максимальная длина комментария (контракт: <=4000). Локальный макрос, чтобы не трогать config.
#macro FASTLOGS_COMMENT_MAX 4000

/// @returns {string} текущий введённый комментарий тестера ("" если пуст)
function fastlogs_comment_get() {
    if (!FASTLOGS_ENABLED) return "";
    return fastlogs_ui_state().comment_text;
}

/// Очистить комментарий и выйти из режима ввода (напр. после успешной отправки).
function fastlogs_comment_clear() {
    if (!FASTLOGS_ENABLED) return;
    var ui = fastlogs_ui_state();
    ui.comment_text    = "";
    ui.comment_editing = false;
}

/// Войти/выйти из режима ввода комментария. При входе синхронизируем keyboard_string
///   с текущим текстом, чтобы редактирование продолжалось с уже введённого.
/// @param {bool} on
function fastlogs_comment_set_editing(on) {
    if (!FASTLOGS_ENABLED) return;
    var ui = fastlogs_ui_state();
    var want = bool(on);
    if (want && variable_struct_exists(ui, "tester_editing") && ui.tester_editing) {
        // Взаимоисключающий фокус (батч B): keyboard_string один на оба поля - уходим из имени.
        ui.tester_editing = false;
    }
    ui.comment_editing = want;
    if (ui.comment_editing) {
        // keyboard_string - встроенная строка-аккумулятор ввода (учитывает backspace).
        //   Засеваем её текущим текстом, чтобы продолжить с места.
        keyboard_string = ui.comment_text;
    }
}

/// Опрос ввода комментария. Вызывать каждый Step ПОКА оверлей открыт и поле в фокусе.
///   Накапливает символы из keyboard_string; Enter добавляет перевод строки (многострочно);
///   обрезает до FASTLOGS_COMMENT_MAX. Вызывается из fastlogs_input_poll (input-скрипт).
function fastlogs_comment_poll_input() {
    if (!FASTLOGS_ENABLED) return;
    var ui = fastlogs_ui_state();
    if (!ui.open || !ui.comment_editing) return;

    // 1) Базовый текст = текущий keyboard_string (GM сам обрабатывает печать и backspace).
    //    На платформах без keyboard_string останется пустым - тогда поле просто не наполняется.
    var s = is_string(keyboard_string) ? keyboard_string : "";

    // 2) Многострочность: GM кладёт в keyboard_string печатные символы; Enter обычно НЕ
    //    попадает в keyboard_string. Ловим нажатие Enter отдельно и вставляем "\n".
    //    Делаем это, дописывая перевод строки прямо в аккумулятор keyboard_string, чтобы
    //    последующий backspace тоже корректно его удалял.
    //    // TODO verify: на части рантаймов keyboard_string может сам содержать \r/\n от Enter
    //    (тогда возможен двойной перевод) - проверить при импорте в IDE на целевой платформе.
    if (keyboard_check_pressed(vk_enter)) {
        keyboard_string += "\n";
        s = keyboard_string;
    }

    // 3) Лимит длины (контракт <=4000). Режем аккумулятор, чтобы UI и отправка совпадали.
    if (string_length(s) > FASTLOGS_COMMENT_MAX) {
        s = string_copy(s, 1, FASTLOGS_COMMENT_MAX);
        keyboard_string = s;
    }

    ui.comment_text = s;
}

// =====================================================================================
// ИМЯ ТЕСТЕРА (батч B). Редактируемое inline-поле имени тестера в оверлее. Обязательно для
//   РУЧНОЙ (overlay) отправки: кнопка "Отправить" заблокирована, пока имя после trim пусто.
//   Тот же inline-механизм keyboard_string, что и у комментария (надёжен для desktop/HTML5;
//   на консолях обычно экранная клавиатура через get_string_async - там фичу можно не предлагать,
//   // TODO verify keyboard_string на целевых консолях). keyboard_string ОДИН на оба поля ->
//   фокусы взаимоисключающие (см. fastlogs_tester_set_editing / fastlogs_comment_set_editing).
// =====================================================================================

// Максимальная длина имени тестера (контракт: <=120). Локальный макрос, чтобы не трогать config.
#macro FASTLOGS_TESTER_MAX 120

/// @returns {bool} символ - пробельный (space/tab/CR/LF)? Для trim имени тестера.
function fastlogs_char_is_ws(ch) {
    var c = ord(ch);
    return (c == 32 || c == 9 || c == 13 || c == 10);   // space, tab, CR, LF
}

/// Внутренний trim: срезать пробелы/табы/CR/LF по краям строки (string_trim есть не на всех
///   рантаймах - делаем переносимо вручную). Возвращает "" для не-строк.
function fastlogs_str_trim(str) {
    if (!is_string(str)) return "";
    var n = string_length(str);
    if (n == 0) return "";
    var a = 1;
    while (a <= n && fastlogs_char_is_ws(string_char_at(str, a))) a++;
    if (a > n) return "";                                   // строка из одних пробелов
    var b = n;
    while (b >= a && fastlogs_char_is_ws(string_char_at(str, b))) b--;
    return string_copy(str, a, b - a + 1);
}

/// @returns {string} эффективное имя тестера для ОТПРАВКИ (после trim): введённое в оверлее имя,
///   иначе - имя из конфига/override (fastlogs_init({tester}) / FASTLOGS_TESTER). "" если нигде нет.
function fastlogs_tester_effective() {
    if (!FASTLOGS_ENABLED) return "";
    var ui = fastlogs_ui_state();
    var t  = fastlogs_str_trim(ui.tester_text);
    if (t != "") return t;
    // Фолбэк на конфиг/override (тот же источник, что читает payload).
    return fastlogs_str_trim(fastlogs_ui_tester_safe());
}

/// @returns {bool} задано ли непустое (после trim) имя тестера. Гейтит ручной overlay-send (батч B).
function fastlogs_tester_is_set() {
    if (!FASTLOGS_ENABLED) return false;
    return (fastlogs_tester_effective() != "");
}

/// Войти/выйти из режима ввода имени тестера. При входе: снять фокус с комментария (keyboard_string
///   один на оба поля), засеять keyboard_string текущим текстом, чтобы продолжить с места.
/// @param {bool} on
function fastlogs_tester_set_editing(on) {
    if (!FASTLOGS_ENABLED) return;
    var ui = fastlogs_ui_state();
    var want = bool(on);
    if (want) {
        // Взаимоисключающий фокус: уходим из комментария, иначе keyboard_string «делят» оба поля.
        if (ui.comment_editing) ui.comment_editing = false;
        keyboard_string = ui.tester_text;   // продолжить редактирование с уже введённого
    }
    ui.tester_editing = want;
}

/// Опрос ввода имени тестера. Вызывать каждый Step ПОКА оверлей открыт и поле в фокусе.
///   Накапливает символы из keyboard_string (GM сам обрабатывает печать/backspace); Enter
///   ЗАВЕРШАЕТ ввод (имя однострочное, не как многострочный комментарий); обрезает до
///   FASTLOGS_TESTER_MAX. После каждого опроса синхронизирует runtime-конфиг (st.cfg.tester),
///   чтобы payload (fastlogs_build_payload) брал актуальное имя без отдельного «сохранить».
function fastlogs_tester_poll_input() {
    if (!FASTLOGS_ENABLED) return;
    var ui = fastlogs_ui_state();
    if (!ui.open || !ui.tester_editing) return;

    // Базовый текст = текущий keyboard_string (печать + backspace обрабатывает GM сам).
    var s = is_string(keyboard_string) ? keyboard_string : "";

    // Enter завершает ввод имени (однострочное поле). Не дописываем "\n" (в отличие от комментария).
    if (keyboard_check_pressed(vk_enter)) {
        fastlogs_tester_set_editing(false);
    }

    // Лимит длины (контракт <=120). Режем аккумулятор, чтобы UI и отправка совпадали.
    if (string_length(s) > FASTLOGS_TESTER_MAX) {
        s = string_copy(s, 1, FASTLOGS_TESTER_MAX);
        keyboard_string = s;
    }

    ui.tester_text = s;
    // Синхронизировать runtime-конфиг, откуда payload читает tester (__fastlogs_cfg("tester")).
    //   Пишем именно ВВЕДЁННОЕ имя (с trim): пустое -> в cfg не пишем, оставляя фолбэк на FASTLOGS_TESTER.
    fastlogs_tester_apply_to_cfg();
}

/// Применить введённое имя тестера к рантайм-конфигу (st.cfg.tester), откуда его читает payload.
///   Пишем только НЕПУСТОЕ (после trim) имя; пустое -> ключ не трогаем (фолбэк на конфиг/макрос).
function fastlogs_tester_apply_to_cfg() {
    if (!FASTLOGS_ENABLED) return;
    if (!script_exists(asset_get_index("__fastlogs_state"))) return;
    var ui = fastlogs_ui_state();
    var t  = fastlogs_str_trim(ui.tester_text);
    if (t == "") return;   // не перетираем конфиг/override пустым - пусть остаётся прежний источник
    var st = __fastlogs_state();
    if (!is_struct(st.cfg)) st.cfg = {};
    st.cfg.tester = t;
}

// =====================================================================================
// ПЕРСИСТ НАСТРОЕК (ini_*). Файл - в game_save_id (sandbox). Безопасно к платформам:
//   ini_* стандартны; на консолях/HTML5 при отсутствии записи просто откатываемся к дефолтам.
//   Ключи настроек храним в секции [fastlogs]. Применяем настройки к рантайму через
//   публичные сеттеры (fastlogs_set_screenshot), не трогая приватное состояние модулей.
// =====================================================================================
function fastlogs_ui_settings_load() {
    if (!FASTLOGS_ENABLED) return;
    var ui = fastlogs_ui_state();
    try {
        // FASTLOGS_PERSIST_FILE лежит в FASTLOGS_PERSIST_DIR; настройки кладём рядом в .ini.
        var fname = fastlogs_ui_ini_path();
        ini_open(fname);
        ui.cfg_screenshot = (ini_read_real("fastlogs", "screenshot", FASTLOGS_SCREENSHOT_DEFAULT ? 1 : 0) >= 1);
        ui.cfg_autosend   = (ini_read_real("fastlogs", "autosend",   0) >= 1);
        ui.cfg_ring_size  = ini_read_real("fastlogs", "ring_size",   FASTLOGS_RING_SIZE);
        // Чистка PII (#3): дефолт приватный (FASTLOGS_SCRUB_PII). Сохранённое значение перекрывает.
        ui.cfg_scrub_pii  = (ini_read_real("fastlogs", "scrub_pii",  FASTLOGS_SCRUB_PII ? 1 : 0) >= 1);
        ini_close();
    } catch (_e) {
        // На платформах без ini-записи - тихо остаёмся на дефолтах.
        ui.cfg_screenshot = FASTLOGS_SCREENSHOT_DEFAULT;
        ui.cfg_autosend   = false;
        ui.cfg_ring_size  = FASTLOGS_RING_SIZE;
        ui.cfg_scrub_pii  = FASTLOGS_SCRUB_PII;
    }
    ui.settings_loaded = true;
    // Применить подгруженный тоггл скриншота к рантайму через публичный сеттер.
    if (script_exists(asset_get_index("fastlogs_set_screenshot"))) {
        fastlogs_set_screenshot(ui.cfg_screenshot);
    }
    // Применить подгруженный тоггл чистки PII к рантайм-конфигу (#3), чтобы payload его читал.
    fastlogs_ui_apply_scrub_pii(ui.cfg_scrub_pii);
}

/// Применить тоггл чистки PII к рантайм-конфигу (st.cfg.scrubPii), чтобы fastlogs_redact его учёл.
///   Пишем напрямую в общий cfg через тот же механизм, что и fastlogs_init({scrubPii}).
/// @param {bool} on
function fastlogs_ui_apply_scrub_pii(on) {
    if (!FASTLOGS_ENABLED) return;
    if (!script_exists(asset_get_index("__fastlogs_state"))) return;
    var st = __fastlogs_state();
    if (!is_struct(st.cfg)) st.cfg = {};
    st.cfg.scrubPii = bool(on);
}

function fastlogs_ui_settings_save() {
    if (!FASTLOGS_ENABLED) return;
    var ui = fastlogs_ui_state();
    try {
        var fname = fastlogs_ui_ini_path();
        ini_open(fname);
        ini_write_real("fastlogs", "screenshot", ui.cfg_screenshot ? 1 : 0);
        ini_write_real("fastlogs", "autosend",   ui.cfg_autosend ? 1 : 0);
        ini_write_real("fastlogs", "ring_size",  ui.cfg_ring_size);
        ini_write_real("fastlogs", "scrub_pii",  ui.cfg_scrub_pii ? 1 : 0);   // чистка PII (#3)
        ini_close();
    } catch (_e) {
        // Запись недоступна (консоль/песочница) - игнорируем, настройки живут только в сессии.
    }
}

/// @returns {string} путь к ini-файлу настроек оверлея в game_save_id
function fastlogs_ui_ini_path() {
    // game_save_id уже содержит завершающий слеш (GM-NOTES 2.6).
    // Кладём в ту же папку, что и персист-лог, имя settings.ini.
    return game_save_id + FASTLOGS_PERSIST_DIR + "/settings.ini";
}

// =====================================================================================
// ТОСТ-СТАТУС (фича STATUS, B). Лёгкое уведомление поверх игры ДАЖЕ без открытого оверлея.
//   Рисуется только когда есть что показать (toast_frames != 0) - иначе ноль работы в Draw.
//   Типы: "info" (нейтральный), "sending" (держится, пока идёт отправка), "ok" (успех + ссылка),
//   "error" (причина + подсказка/зона "Повторить"). Длительности из FASTLOGS_TOAST_*.
// =====================================================================================

/// @returns {real} кадров для заданной длительности в секундах (по реальному game speed)
function fastlogs_ui_toast_frames_for(seconds) {
    // game_get_speed(gamespeed_fps) - целевой FPS логики; фолбэк 60 если недоступно/0.
    var fps = 60;
    try {
        var f = game_get_speed(gamespeed_fps);
        if (is_real(f) && f > 0) fps = f;
    } catch (_e) { fps = 60; }
    return max(1, round(seconds * fps));
}

/// Базовый тост (совместимость со старым API: clipboard зовёт fastlogs_ui_toast(text)).
///   Это короткий info-тост. no-op при !FASTLOGS_ENABLED / выключенном тосте.
function fastlogs_ui_toast(text) {
    if (!FASTLOGS_ENABLED) return;
    fastlogs_status_toast("info", string(text));
}

/// Статус-тост с типом. kind: "info"|"sending"|"ok"|"error". opt - struct { url, retry }.
///   "sending" держится до следующего статуса (таймер -1). Остальные гаснут по таймеру.
/// @param {string} kind
/// @param {string} text
/// @param {struct} [opt] { url:string, retry:bool }
function fastlogs_status_toast(kind, text, opt = undefined) {
    if (!FASTLOGS_ENABLED) return;
    if (!FASTLOGS_TOAST_ENABLED) return;
    var ui = fastlogs_ui_state();
    ui.toast_text  = string(text);
    ui.toast_kind  = is_string(kind) ? kind : "info";
    ui.toast_url   = (is_struct(opt) && variable_struct_exists(opt, "url")   && is_string(opt.url)) ? opt.url   : "";
    ui.toast_retry = (is_struct(opt) && variable_struct_exists(opt, "retry")) ? bool(opt.retry) : false;

    switch (ui.toast_kind) {
        case "sending":
            ui.toast_frames = -1;   // держать, пока идёт отправка (снимется следующим статусом)
            break;
        case "error":
            ui.toast_frames = fastlogs_ui_toast_frames_for(FASTLOGS_TOAST_ERROR_SECONDS);
            break;
        default: // info / ok
            ui.toast_frames = fastlogs_ui_toast_frames_for(FASTLOGS_TOAST_SECONDS);
            break;
    }
}

/// Скрыть тост немедленно (например, при ручном открытии оверлея).
function fastlogs_status_toast_clear() {
    if (!FASTLOGS_ENABLED) return;
    var ui = fastlogs_ui_state();
    ui.toast_frames = 0;
    ui.toast_text   = "";
    ui.toast_retry  = false;
    ui.toast_url    = "";
}

// =====================================================================================
// ОТРИСОВКА. Вызывается из Draw GUI (obj_fastlogs_controller -> Draw_64.gml).
//   Заполняет ui.hit зонами для последующего ввода. Применяет нажатия, накопленные
//   вводом на ЭТОТ кадр (ui.pressed/ui.px/ui.py), сразу здесь, чтобы клики реагировали
//   по тем же координатам/зонам, что и нарисованы (один источник истины - hit-rects).
// =====================================================================================
function fastlogs_ui_draw() {
    if (!FASTLOGS_ENABLED) return;
    var ui = fastlogs_ui_state();

    // Тост уменьшаем по кадрам даже когда оверлей закрыт. toast_frames == -1 -> держим (sending).
    if (ui.toast_frames > 0) ui.toast_frames -= 1;

    if (!ui.open) {
        // Оверлей закрыт: рисуем ТОЛЬКО тост и только если он активен (иначе полный ноль работы -
        //   ни сборки hit-rects, ни draw-стейта). Тост виден поверх игры (фича STATUS, B).
        if (ui.toast_frames != 0) {
            // Свежие зоны клика только для тоста (повтор/копирование ссылки).
            ui.hit = [];
            var old_col_t  = draw_get_colour();
            var old_alpha_t = draw_get_alpha();
            var old_hal_t  = draw_get_halign();
            var old_val_t  = draw_get_valign();
            fastlogs_ui_draw_toast(ui);
            // Потребить клик по зонам тоста (Повторить/Копировать), если был тап в этом кадре.
            if (ui.pressed) {
                var hid_t = fastlogs_ui_hit_test(ui, ui.px, ui.py);
                if (hid_t != "") fastlogs_ui_action(hid_t, ui);
                ui.pressed = false;
            }
            draw_set_colour(old_col_t);
            draw_set_alpha(old_alpha_t);
            draw_set_halign(old_hal_t);
            draw_set_valign(old_val_t);
        }
        return;
    }

    // Свежий список зон на этот кадр.
    ui.hit = [];

    var gw = display_get_gui_width();
    var gh = display_get_gui_height();

    // Масштаб элементов: базовый под ~1080p, не меньше минимального тач-размера.
    var ui_scale = max(1, min(gw, gh) / 720);
    var btn_h    = max(FASTLOGS_BTN_MIN_SIZE, round(56 * ui_scale));
    var pad      = max(8, round(12 * ui_scale));
    var fsize    = max(1, ui_scale);

    // Сохранить и задать draw-состояние (восстановим в конце, чтобы не ломать игру).
    var old_col   = draw_get_colour();
    var old_alpha = draw_get_alpha();
    var old_hal   = draw_get_halign();
    var old_val   = draw_get_valign();

    draw_set_halign(fa_left);
    draw_set_valign(fa_top);

    // --- Главная панель (слева сверху). Ширина ~ половина экрана, но в разумных пределах.
    var panel_w = clamp(round(gw * 0.42), 360, gw - pad * 2);
    var panel_x = pad;
    var panel_y = pad;
    var x1 = panel_x;
    var y  = panel_y;

    // Высоту панели посчитаем как сумму строк ниже; для простоты рисуем фон достаточной высоты.
    // Ряды: заголовок, счётчики, РЕДАКТИРУЕМОЕ поле "Тестер" (btn_h, батч B), подпись+поле
    //   комментария (line_h + comment_h), Отправить/Скриншот, URL/Копировать, REC/Clear.
    var line_h    = round(28 * ui_scale);          // высота однострочной подписи
    var comment_h = btn_h * 2;                      // высота многострочного поля комментария
    // 6 рядов высотой btn_h (счётчики + Тестер-поле + 4 ряда кнопок ниже) + поле комментария +
    //   подпись комментария (line_h) + вертикальные отступы. Запас по pad намеренный.
    var panel_h = btn_h * 6 + pad * 10 + line_h + comment_h;
    fastlogs_ui_panel_bg(x1, y, x1 + panel_w, y + panel_h);

    var inner_x = x1 + pad;
    var inner_w = panel_w - pad * 2;
    var cy = y + pad;

    // Заголовок.
    draw_set_alpha(1);
    draw_set_colour(FASTLOGS_COL_TEXT);
    fastlogs_ui_text(inner_x, cy, "FastLogs", fsize * 1.2);
    // Кнопка-настройки (шестерёнка) и кнопка-закрыть в правом верхнем углу панели.
    var gear_x2 = x1 + panel_w - pad;
    var gear_x1 = gear_x2 - btn_h;
    fastlogs_ui_button(gear_x1, cy - 4, gear_x2, cy - 4 + btn_h, "Настройки", "settings_toggle", fsize, ui);
    cy += btn_h + pad;

    // --- Счётчики E/W/L (цветом). Берём из публичного геттера; безопасно если ещё нет данных.
    var counts = fastlogs_ui_get_counts_safe();
    var third  = inner_w / 3;
    fastlogs_ui_counter(inner_x,             cy, third - pad, btn_h, "E", counts.error, FASTLOGS_COL_ERROR, fsize);
    fastlogs_ui_counter(inner_x + third,     cy, third - pad, btn_h, "W", counts.warn,  FASTLOGS_COL_WARN,  fsize);
    fastlogs_ui_counter(inner_x + third * 2, cy, third - pad, btn_h, "L", counts.log,   FASTLOGS_COL_LOG,   fsize);
    cy += btn_h + pad;

    // --- Имя тестера (батч B): РЕДАКТИРУЕМОЕ поле. ОБЯЗАТЕЛЬНО для ручной отправки - кнопка
    //   "Отправить" заблокирована, пока имя пустое. Клик по полю -> режим ввода (keyboard_string).
    //   Засев: при первом показе подставляем эффективное имя из конфига/override, чтобы тестер
    //   увидел/поправил, а не вводил заново. Введённое имя применяется в st.cfg.tester (poll),
    //   откуда payload его и берёт. Источник истины для гейта/отправки - fastlogs_tester_effective().
    if (!ui.tester_seeded) {
        // Один раз засеять поле эффективным именем из конфига (если оно там задано и поле пусто).
        var seed = fastlogs_str_trim(fastlogs_ui_tester_safe());
        if (seed != "" && fastlogs_str_trim(ui.tester_text) == "") {
            ui.tester_text = seed;
            keyboard_string = ui.tester_text;   // синхрон, чтобы правка началась с засеянного
        }
        ui.tester_seeded = true;
    }
    var tester_set = (fastlogs_tester_effective() != "");
    // Подпись: красным помечаем обязательность, если имя ещё не задано.
    draw_set_colour(tester_set ? FASTLOGS_COL_LOG : FASTLOGS_COL_ERROR);
    fastlogs_ui_text(inner_x, cy + btn_h * 0.5 - 8 * fsize, tester_set ? "Тестер:" : "Тестер (обязательно):", fsize);
    var tlabel_w = round(220 * ui_scale);
    var tfx1 = inner_x + tlabel_w;
    var tfy1 = cy;
    var tfy2 = cy + btn_h;
    // Фон поля имени.
    draw_set_colour(FASTLOGS_COL_BTN);
    draw_set_alpha(1);
    draw_rectangle(tfx1, tfy1, inner_x + inner_w, tfy2, false);
    // Рамка: акцент если редактируем; красная если имя пустое (визуальный сигнал обязательности);
    //   иначе обычная.
    draw_set_colour(ui.tester_editing ? FASTLOGS_COL_ACCENT : (tester_set ? FASTLOGS_COL_BTN_HOVER : FASTLOGS_COL_ERROR));
    draw_rectangle(tfx1, tfy1, inner_x + inner_w, tfy2, true);
    // Текст имени или подсказка.
    var tname = ui.tester_text;
    if (tname == "") {
        draw_set_colour(FASTLOGS_COL_LOG);
        fastlogs_ui_text_clipped(tfx1 + pad * 0.5, tfy1 + btn_h * 0.5 - 8 * fsize, ui.tester_editing ? "Печатайте имя... (Enter - готово)" : "Нажмите, чтобы ввести имя", fsize, inner_w - tlabel_w - pad);
    } else {
        draw_set_colour(FASTLOGS_COL_TEXT);
        var tcursor = (ui.tester_editing && ((current_time div 500) mod 2 == 0)) ? "_" : "";
        fastlogs_ui_text_clipped(tfx1 + pad * 0.5, tfy1 + btn_h * 0.5 - 8 * fsize, tname + tcursor, fsize, inner_w - tlabel_w - pad);
    }
    // Зона клика поля -> фокус ввода имени.
    fastlogs_ui_register_hit(ui, tfx1, tfy1, inner_x + inner_w, tfy2, "tester_focus");
    cy += btn_h + pad;

    // --- Поле комментария тестера (фича COMMENT). Клик по полю -> режим ввода (keyboard_string).
    //   Многострочный текст; уходит в opts.comment при отправке. Рамка акцентом, если в фокусе.
    draw_set_colour(FASTLOGS_COL_LOG);
    fastlogs_ui_text(inner_x, cy, "Комментарий (опишите проблему):", fsize);
    cy += line_h;
    var cmt_y1 = cy;
    var cmt_y2 = cy + comment_h;
    // Фон поля.
    draw_set_colour(FASTLOGS_COL_BTN);
    draw_set_alpha(1);
    draw_rectangle(inner_x, cmt_y1, inner_x + inner_w, cmt_y2, false);
    // Рамка: акцент если редактируем, иначе обычная.
    draw_set_colour(ui.comment_editing ? FASTLOGS_COL_ACCENT : FASTLOGS_COL_BTN_HOVER);
    draw_rectangle(inner_x, cmt_y1, inner_x + inner_w, cmt_y2, true);
    // Текст комментария или подсказка. Многострочно (draw_text переносит по "\n").
    var cmt = ui.comment_text;
    if (cmt == "") {
        draw_set_colour(FASTLOGS_COL_LOG);
        fastlogs_ui_text(inner_x + pad * 0.5, cmt_y1 + pad * 0.5, ui.comment_editing ? "Печатайте... (Enter - новая строка)" : "Нажмите, чтобы ввести", fsize);
    } else {
        draw_set_colour(FASTLOGS_COL_TEXT);
        // Курсор-индикатор в режиме ввода (мигание по таймеру кадров).
        var cursor = (ui.comment_editing && ((current_time div 500) mod 2 == 0)) ? "_" : "";
        // draw_text сам рисует многострочно по "\n"; масштаб - через transformed.
        draw_text_transformed(inner_x + pad * 0.5, cmt_y1 + pad * 0.5, cmt + cursor, fsize, fsize, 0);
    }
    // Зона клика всего поля -> фокус ввода.
    fastlogs_ui_register_hit(ui, inner_x, cmt_y1, inner_x + inner_w, cmt_y2, "comment_focus");
    cy = cmt_y2 + pad;

    // --- Кнопка "Отправить" + тоггл "Скриншот" (крупная зона).
    //   Батч B: пока имя тестера не задано (после trim), кнопка ЗАБЛОКИРОВАНА (серая, без зоны
    //   клика) - ручной overlay-send требует имени. Подсказка - под кнопкой. Код/крэш-send этим
    //   гейтом НЕ затронуты (они идут не через эту зону). "send" регистрируется в hit ТОЛЬКО когда
    //   разрешено -> даже при гонке клика действие не выполнится без имени.
    var half = inner_w / 2;
    var sending = fastlogs_ui_is_sending_safe();
    var send_allowed = fastlogs_tester_is_set();
    var send_label = sending ? "Отправка..." : (send_allowed ? "Отправить" : "Отправить (нужно имя)");
    if (send_allowed) {
        fastlogs_ui_button(inner_x, cy, inner_x + half - pad, cy + btn_h, send_label, "send", fsize, ui);
    } else {
        fastlogs_ui_button_disabled(inner_x, cy, inner_x + half - pad, cy + btn_h, send_label, fsize);
    }

    var shot_on = ui.cfg_screenshot;
    fastlogs_ui_toggle(inner_x + half, cy, inner_x + inner_w, cy + btn_h, "Скриншот", shot_on, "toggle_screenshot", fsize, ui);
    cy += btn_h + pad;

    // Подсказка под кнопкой, если отправка заблокирована из-за пустого имени тестера (батч B).
    if (!send_allowed) {
        draw_set_colour(FASTLOGS_COL_ERROR);
        fastlogs_ui_text(inner_x, cy - pad + 2, "Введите имя тестера, чтобы отправить", fsize);
    }

    // --- Область URL + кнопка "Копировать".
    var url = fastlogs_ui_last_url_safe();
    var copy_w = max(btn_h * 2, round(140 * ui_scale));
    var url_x2 = inner_x + inner_w - copy_w - pad;
    // Фон поля URL.
    draw_set_colour(FASTLOGS_COL_BTN);
    draw_set_alpha(1);
    draw_rectangle(inner_x, cy, url_x2, cy + btn_h, false);
    draw_set_colour(FASTLOGS_COL_TEXT);
    var url_shown = (url == "") ? "(ещё нет ссылки)" : url;
    fastlogs_ui_text_clipped(inner_x + pad * 0.5, cy + btn_h * 0.5 - 8 * fsize, url_shown, fsize, url_x2 - inner_x - pad);
    fastlogs_ui_button(url_x2 + pad, cy, inner_x + inner_w, cy + btn_h, "Копировать", "copy", fsize, ui);
    cy += btn_h + pad;

    // --- Нижняя строка: Recording индикатор + Start/Stop, Clear.
    var rec_on = fastlogs_ui_is_recording_safe();
    // Индикатор записи (кружок/квадрат) + подпись.
    var ind_size = round(btn_h * 0.4);
    draw_set_colour(rec_on ? FASTLOGS_COL_ERROR : FASTLOGS_COL_BTN);
    draw_set_alpha(1);
    draw_rectangle(inner_x, cy + (btn_h - ind_size) * 0.5, inner_x + ind_size, cy + (btn_h + ind_size) * 0.5, false);
    draw_set_colour(FASTLOGS_COL_TEXT);
    fastlogs_ui_text(inner_x + ind_size + pad * 0.5, cy + btn_h * 0.5 - 8 * fsize, rec_on ? "REC" : "off", fsize);

    var rec_btn_x1 = inner_x + ind_size + pad + round(70 * ui_scale);
    var rec_btn_x2 = rec_btn_x1 + round(160 * ui_scale);
    fastlogs_ui_button(rec_btn_x1, cy, rec_btn_x2, cy + btn_h, rec_on ? "Stop Rec" : "Start Rec", "toggle_record", fsize, ui);
    fastlogs_ui_button(rec_btn_x2 + pad, cy, inner_x + inner_w, cy + btn_h, "Clear", "clear", fsize, ui);
    cy += btn_h + pad;

    // --- Панель настроек (независимая, поверх). Рисуем, если открыта.
    if (ui.settings_open) {
        fastlogs_ui_draw_settings(gw, gh, ui_scale, btn_h, pad, fsize, ui);
    }

    // --- Тост (включая «держащийся» статус "Отправка..." с toast_frames == -1).
    if (ui.toast_frames != 0) fastlogs_ui_draw_toast(ui);

    // Применить накопленный ввод по зонам этого кадра (после того как все hit-rects собраны).
    if (ui.pressed) {
        var hid = fastlogs_ui_hit_test(ui, ui.px, ui.py);
        // Клик мимо поля комментария снимает фокус ввода (чтобы печать не уходила «в никуда»).
        if (ui.comment_editing && hid != "comment_focus") {
            fastlogs_comment_set_editing(false);
        }
        // Аналогично для поля имени тестера (батч B): клик мимо него снимает фокус.
        if (ui.tester_editing && hid != "tester_focus") {
            fastlogs_tester_set_editing(false);
        }
        if (hid != "") fastlogs_ui_action(hid, ui);
        ui.pressed = false; // потребили
    }

    // Восстановить draw-состояние.
    draw_set_colour(old_col);
    draw_set_alpha(old_alpha);
    draw_set_halign(old_hal);
    draw_set_valign(old_val);
}

// =====================================================================================
// ПАНЕЛЬ НАСТРОЕК (независимая). Показ endpoint/appId (read-only), тогглы и счётчик буфера.
// =====================================================================================
function fastlogs_ui_draw_settings(gw, gh, ui_scale, btn_h, pad, fsize, ui) {
    var panel_w = clamp(round(gw * 0.5), 420, gw - pad * 2);
    var panel_h = btn_h * 8 + pad * 10;     // +1 ряд под тоггл "Чистка PII" (#3)
    var x1 = gw - panel_w - pad;            // справа
    var y1 = pad;
    fastlogs_ui_panel_bg(x1, y1, x1 + panel_w, y1 + panel_h);

    var ix = x1 + pad;
    var iw = panel_w - pad * 2;
    var cy = y1 + pad;

    draw_set_colour(FASTLOGS_COL_TEXT);
    draw_set_alpha(1);
    fastlogs_ui_text(ix, cy, "Настройки FastLogs", fsize * 1.1);
    // Закрыть настройки.
    fastlogs_ui_button(x1 + panel_w - pad - btn_h * 2, cy - 4, x1 + panel_w - pad, cy - 4 + btn_h, "Закрыть", "settings_close", fsize, ui);
    cy += btn_h + pad;

    // Endpoint (read-only показ).
    draw_set_colour(FASTLOGS_COL_LOG);
    fastlogs_ui_text(ix, cy, "Endpoint:", fsize);
    draw_set_colour(FASTLOGS_COL_TEXT);
    var ep = (FASTLOGS_ENDPOINT == "") ? "(не задан)" : FASTLOGS_ENDPOINT;
    fastlogs_ui_text_clipped(ix + round(120 * ui_scale), cy, ep, fsize, iw - round(120 * ui_scale));
    cy += round(28 * ui_scale) + pad * 0.5;

    // AppId (read-only показ).
    draw_set_colour(FASTLOGS_COL_LOG);
    fastlogs_ui_text(ix, cy, "AppId:", fsize);
    draw_set_colour(FASTLOGS_COL_TEXT);
    var aid = (FASTLOGS_APP_ID == "") ? "(не задан)" : FASTLOGS_APP_ID;
    fastlogs_ui_text_clipped(ix + round(120 * ui_scale), cy, aid, fsize, iw - round(120 * ui_scale));
    cy += round(28 * ui_scale) + pad;

    // Тоггл "Скриншот".
    fastlogs_ui_toggle(ix, cy, ix + iw, cy + btn_h, "Скриншот в payload", ui.cfg_screenshot, "set_toggle_screenshot", fsize, ui);
    cy += btn_h + pad;

    // Тоггл "Autosend" (UI-уровень: разрешить авто-отправку - например при исключении).
    fastlogs_ui_toggle(ix, cy, ix + iw, cy + btn_h, "Autosend", ui.cfg_autosend, "set_toggle_autosend", fsize, ui);
    cy += btn_h + pad;

    // Тоггл "Чистка PII" (#3). ДЕФОЛТ приватно (ON). ON -> email/IP/токены/длинные цифры -> [redacted].
    fastlogs_ui_toggle(ix, cy, ix + iw, cy + btn_h, "Чистка PII (приватность)", ui.cfg_scrub_pii, "set_toggle_scrub_pii", fsize, ui);
    cy += btn_h + pad;

    // Start/Stop Recording с индикатором.
    var rec_on = fastlogs_ui_is_recording_safe();
    fastlogs_ui_toggle(ix, cy, ix + iw, cy + btn_h, rec_on ? "Recording: ON" : "Recording: OFF", rec_on, "toggle_record", fsize, ui);
    cy += btn_h + pad;

    // Ёмкость буфера (показ + кнопки -/+). Меняет только UI-кэш (ui.cfg_ring_size);
    //   фактическое применение размера кольца - на стороне core, если он его читает.
    draw_set_colour(FASTLOGS_COL_TEXT);
    fastlogs_ui_text(ix, cy + btn_h * 0.5 - 8 * fsize, "Буфер: " + string(ui.cfg_ring_size), fsize);
    var bx2 = ix + iw;
    fastlogs_ui_button(bx2 - btn_h, cy, bx2, cy + btn_h, "+", "ring_inc", fsize, ui);
    fastlogs_ui_button(bx2 - btn_h * 2 - pad, cy, bx2 - btn_h - pad, cy + btn_h, "-", "ring_dec", fsize, ui);
    // Clear прямо здесь тоже удобно.
    fastlogs_ui_button(ix, cy, ix + round(120 * ui_scale), cy + btn_h, "Clear", "clear", fsize, ui);
}

// =====================================================================================
// HIT-TEST и ОБРАБОТКА ДЕЙСТВИЙ
// =====================================================================================

/// @returns {string} id зоны под точкой (последняя добавленная, т.е. верхняя), либо ""
function fastlogs_ui_hit_test(ui, px, py) {
    // Идём с конца: позже нарисованные зоны (панель настроек/тост) перекрывают ранние.
    var n = array_length(ui.hit);
    for (var i = n - 1; i >= 0; i--) {
        var r = ui.hit[i];
        if (px >= r.x1 && px <= r.x2 && py >= r.y1 && py <= r.y2) return r.id;
    }
    return "";
}

/// Выполнить действие по id зоны. Использует ТОЛЬКО публичное API других модулей.
function fastlogs_ui_action(id, ui) {
    switch (id) {
        case "settings_toggle": ui.settings_open = !ui.settings_open; break;
        case "settings_close":  ui.settings_open = false; break;

        case "comment_focus":
            // Клик по полю комментария -> включить режим ввода (keyboard_string).
            //   set_editing комментария снимает фокус с поля имени (взаимоисключающий keyboard_string).
            fastlogs_comment_set_editing(true);
            break;

        case "tester_focus":
            // Клик по полю имени тестера -> включить режим ввода (батч B).
            //   set_editing имени снимает фокус с комментария (взаимоисключающий keyboard_string).
            if (script_exists(asset_get_index("fastlogs_tester_set_editing"))) {
                fastlogs_tester_set_editing(true);
            }
            break;

        case "send":
            // РУЧНОЙ overlay-send (батч B): ОБЯЗАТЕЛЬНО имя тестера. В норме кнопка без имени
            //   заблокирована (нет hit-rect "send"), но держим финальный guard на случай гонки.
            //   sentViaCode тут НЕ ставим - это ручная отправка из UI (payload опустит поле).
            //   Снимаем фокус полей ввода и применяем введённое имя в конфиг перед сборкой payload.
            fastlogs_comment_set_editing(false);
            if (script_exists(asset_get_index("fastlogs_tester_set_editing"))) {
                fastlogs_tester_set_editing(false);
            }
            if (script_exists(asset_get_index("fastlogs_tester_apply_to_cfg"))) {
                fastlogs_tester_apply_to_cfg();   // зафиксировать введённое имя в st.cfg.tester
            }
            if (!fastlogs_tester_is_set()) {
                // Имя так и не задано - не отправляем, подсказываем (на случай обхода блокировки кнопки).
                fastlogs_ui_toast("Введите имя тестера");
                break;
            }
            if (script_exists(asset_get_index("fastlogs_send"))) {
                var send_opts = {};
                var cmt_send = fastlogs_comment_get();
                if (is_string(cmt_send) && string_length(cmt_send) > 0) {
                    send_opts.comment = cmt_send;
                }
                fastlogs_send(send_opts);
            }
            break;

        case "copy":
            // Копирование URL делегируем clipboard-модулю (он же покажет тост).
            if (script_exists(asset_get_index("fastlogs_copy_url"))) fastlogs_copy_url();
            break;

        case "toast_copy_url":
            // Клик по тосту "Готово" со ссылкой -> скопировать её (фича STATUS, B).
            if (script_exists(asset_get_index("fastlogs_copy_url"))) fastlogs_copy_url();
            break;

        case "toast_retry":
            // Клик по тосту "Ошибка" -> повторить отправку с тем же телом (фича STATUS, B).
            //   Этот тост с кнопкой "Повторить" показывается только при ТЕРМИНАЛЬНОЙ ошибке
            //   (pending отложенного повтора нет) - значит fastlogs_send тут не заблокируется
            //   и соберёт свежий payload. Если в этот момент идёт отправка/pending - отобьётся.
            if (script_exists(asset_get_index("fastlogs_send"))) {
                fastlogs_send({ title: "Retry send" });
            }
            break;

        case "toggle_screenshot":
        case "set_toggle_screenshot":
            ui.cfg_screenshot = !ui.cfg_screenshot;
            if (script_exists(asset_get_index("fastlogs_set_screenshot"))) fastlogs_set_screenshot(ui.cfg_screenshot);
            fastlogs_ui_settings_save();
            break;

        case "set_toggle_autosend":
            ui.cfg_autosend = !ui.cfg_autosend;
            fastlogs_ui_settings_save();
            break;

        case "set_toggle_scrub_pii":
            // Чистка PII (#3): тоггл -> применяем к рантайм-конфигу + персист ini.
            ui.cfg_scrub_pii = !ui.cfg_scrub_pii;
            fastlogs_ui_apply_scrub_pii(ui.cfg_scrub_pii);
            fastlogs_ui_settings_save();
            break;

        case "toggle_record":
            if (script_exists(asset_get_index("fastlogs_is_recording")) &&
                script_exists(asset_get_index("fastlogs_record_set"))) {
                fastlogs_record_set(!fastlogs_is_recording());
            }
            break;

        case "clear":
            if (script_exists(asset_get_index("fastlogs_clear"))) fastlogs_clear();
            fastlogs_ui_toast("очищено");
            break;

        case "ring_inc":
            ui.cfg_ring_size = min(100000, ui.cfg_ring_size + 500);
            fastlogs_ui_settings_save();
            break;

        case "ring_dec":
            ui.cfg_ring_size = max(100, ui.cfg_ring_size - 500);
            fastlogs_ui_settings_save();
            break;
    }
}

// =====================================================================================
// ПРИМИТИВЫ ОТРИСОВКИ (хелперы). Все рисуют draw_rectangle/draw_text, регистрируют зоны.
// =====================================================================================

/// Фон панели с прозрачностью.
function fastlogs_ui_panel_bg(x1, y1, x2, y2) {
    draw_set_colour(FASTLOGS_COL_PANEL);
    draw_set_alpha(FASTLOGS_BG_ALPHA);
    draw_rectangle(x1, y1, x2, y2, false);
    // Рамка.
    draw_set_alpha(1);
    draw_set_colour(FASTLOGS_COL_BTN_HOVER);
    draw_rectangle(x1, y1, x2, y2, true);
}

/// Текст с масштабом (через draw_text_transformed для размера без зависимости от шрифта-ассета).
function fastlogs_ui_text(x, y, str, scale) {
    // draw_text_transformed(x,y,string,xscale,yscale,angle) - стандартная функция.
    draw_text_transformed(x, y, str, scale, scale, 0);
}

/// Текст с обрезкой по ширине (грубо по символам - чтобы длинный URL не вылезал).
function fastlogs_ui_text_clipped(x, y, str, scale, max_w) {
    var s = str;
    // Оценка ширины символа ~ string_width у текущего шрифта; защитимся от деления на 0.
    var sw = string_width(s) * scale;
    if (sw > max_w && string_length(s) > 0 && max_w > 0) {
        var keep = max(1, floor(string_length(s) * (max_w / sw)) - 1);
        s = string_copy(s, 1, keep) + "...";
    }
    fastlogs_ui_text(x, y, s, scale);
}

/// Кнопка с подсветкой hover и регистрацией зоны клика.
function fastlogs_ui_button(x1, y1, x2, y2, label, id, scale, ui) {
    var hot = (fastlogs_ui_hit_test_point(ui, x1, y1, x2, y2));
    draw_set_colour(hot ? FASTLOGS_COL_BTN_HOVER : FASTLOGS_COL_BTN);
    draw_set_alpha(1);
    draw_rectangle(x1, y1, x2, y2, false);
    draw_set_colour(FASTLOGS_COL_ACCENT);
    draw_rectangle(x1, y1, x2, y2, true);
    draw_set_colour(FASTLOGS_COL_TEXT);
    // Центрируем текст.
    draw_set_halign(fa_center);
    draw_set_valign(fa_middle);
    fastlogs_ui_text((x1 + x2) * 0.5, (y1 + y2) * 0.5, label, scale);
    draw_set_halign(fa_left);
    draw_set_valign(fa_top);
    fastlogs_ui_register_hit(ui, x1, y1, x2, y2, id);
}

/// Заблокированная (неактивная) кнопка: серый фон, приглушённый текст, БЕЗ регистрации зоны клика
///   (батч B). Не передаёт id и ui - так клик по ней не вызывает действия (нет hit-rect), даже
///   если указатель попал в её прямоугольник в этом кадре.
function fastlogs_ui_button_disabled(x1, y1, x2, y2, label, scale) {
    draw_set_colour(FASTLOGS_COL_BTN);
    draw_set_alpha(0.5);
    draw_rectangle(x1, y1, x2, y2, false);
    draw_set_alpha(1);
    draw_set_colour(FASTLOGS_COL_BTN_HOVER);
    draw_rectangle(x1, y1, x2, y2, true);
    draw_set_colour(FASTLOGS_COL_LOG);   // приглушённый текст
    draw_set_halign(fa_center);
    draw_set_valign(fa_middle);
    fastlogs_ui_text((x1 + x2) * 0.5, (y1 + y2) * 0.5, label, scale);
    draw_set_halign(fa_left);
    draw_set_valign(fa_top);
}

/// Тоггл (вкл/выкл) с цветовой индикацией состояния.
function fastlogs_ui_toggle(x1, y1, x2, y2, label, is_on, id, scale, ui) {
    draw_set_colour(is_on ? FASTLOGS_COL_ACCENT : FASTLOGS_COL_BTN);
    draw_set_alpha(is_on ? 0.85 : 1);
    draw_rectangle(x1, y1, x2, y2, false);
    draw_set_alpha(1);
    draw_set_colour(FASTLOGS_COL_TEXT);
    draw_rectangle(x1, y1, x2, y2, true);
    draw_set_halign(fa_center);
    draw_set_valign(fa_middle);
    fastlogs_ui_text((x1 + x2) * 0.5, (y1 + y2) * 0.5, label + (is_on ? "  [ON]" : "  [off]"), scale);
    draw_set_halign(fa_left);
    draw_set_valign(fa_top);
    fastlogs_ui_register_hit(ui, x1, y1, x2, y2, id);
}

/// Счётчик уровня (цветной блок с буквой и числом).
function fastlogs_ui_counter(x1, y1, w, h, letter, value, col, scale) {
    draw_set_colour(FASTLOGS_COL_BTN);
    draw_set_alpha(1);
    draw_rectangle(x1, y1, x1 + w, y1 + h, false);
    draw_set_colour(col);
    draw_set_halign(fa_center);
    draw_set_valign(fa_middle);
    fastlogs_ui_text((x1 + x1 + w) * 0.5, (y1 + y1 + h) * 0.5, letter + ": " + string(value), scale);
    draw_set_halign(fa_left);
    draw_set_valign(fa_top);
}

/// Тост-уведомление по центру внизу (фича STATUS, B). Цвет рамки по типу; для "ok" показывает
///   ссылку и кликабельную зону копирования, для "error" - зону "Повторить".
///   Регистрирует зоны клика в ui.hit (их потребляет fastlogs_ui_draw в обеих ветках).
function fastlogs_ui_draw_toast(ui) {
    if (ui.toast_text == "") return;
    var gw = display_get_gui_width();
    var gh = display_get_gui_height();

    var kind = variable_struct_exists(ui, "toast_kind") ? ui.toast_kind : "info";
    // Цвет рамки/акцента по типу статуса.
    var accent = FASTLOGS_COL_ACCENT;
    switch (kind) {
        case "sending": accent = FASTLOGS_COL_WARN;   break;   // "Отправка..."
        case "ok":      accent = FASTLOGS_COL_ACCENT; break;   // успех (зелёный)
        case "error":   accent = FASTLOGS_COL_ERROR;  break;   // ошибка (красный)
        default:        accent = FASTLOGS_COL_BTN_HOVER; break; // info (нейтральный)
    }

    // Доп.строка под основным текстом: ссылка (ok) или подсказка повтора (error).
    var url   = variable_struct_exists(ui, "toast_url")   ? ui.toast_url   : "";
    var retry = variable_struct_exists(ui, "toast_retry") ? ui.toast_retry : false;
    var has_url   = (kind == "ok")    && is_string(url) && string_length(url) > 0;
    var has_retry = (kind == "error") && retry;

    var main_w = string_width(ui.toast_text);
    var sub_text = "";
    if (has_url)   sub_text = url + "   (нажмите - копировать)";
    if (has_retry) sub_text = "Нажмите, чтобы повторить отправку";
    var sub_w = (sub_text != "") ? string_width(sub_text) : 0;

    var tw = max(main_w, sub_w) + 40;
    var th = (sub_text != "") ? 74 : 48;
    var tx = (gw - tw) * 0.5;
    var ty = gh - th - 40;

    draw_set_colour(FASTLOGS_COL_PANEL);
    draw_set_alpha(0.9);
    draw_rectangle(tx, ty, tx + tw, ty + th, false);
    draw_set_alpha(1);
    draw_set_colour(accent);
    draw_rectangle(tx, ty, tx + tw, ty + th, true);

    // Основной текст статуса.
    draw_set_colour(FASTLOGS_COL_TEXT);
    draw_set_halign(fa_center);
    draw_set_valign(fa_middle);
    var main_cy = (sub_text != "") ? (ty + 18) : ((ty + ty + th) * 0.5);
    draw_text((tx + tx + tw) * 0.5, main_cy, ui.toast_text);

    // Доп.строка + кликабельная зона (копирование ссылки / повтор).
    if (sub_text != "") {
        draw_set_colour(has_retry ? FASTLOGS_COL_ERROR : FASTLOGS_COL_ACCENT);
        draw_text((tx + tx + tw) * 0.5, ty + th - 20, sub_text);
        // Вся плашка тоста кликабельна для соответствующего действия.
        if (has_url)   fastlogs_ui_register_hit(ui, tx, ty, tx + tw, ty + th, "toast_copy_url");
        if (has_retry) fastlogs_ui_register_hit(ui, tx, ty, tx + tw, ty + th, "toast_retry");
    }

    draw_set_halign(fa_left);
    draw_set_valign(fa_top);
}

/// Регистрирует зону клика (для последующего/текущего hit-test).
function fastlogs_ui_register_hit(ui, x1, y1, x2, y2, id) {
    array_push(ui.hit, { x1: x1, y1: y1, x2: x2, y2: y2, id: id });
}

/// Подсветка hover: указатель ввода (ui.px/py) внутри прямоугольника?
function fastlogs_ui_hit_test_point(ui, x1, y1, x2, y2) {
    return (ui.px >= x1 && ui.px <= x2 && ui.py >= y1 && ui.py <= y2);
}

// =====================================================================================
// БЕЗОПАСНЫЕ ГЕТТЕРЫ (не падать, если соответствующий модуль ещё не наполнен билдером).
//   Используем script_exists(asset_get_index(...)) перед вызовом чужих публичных функций.
// =====================================================================================
function fastlogs_ui_get_counts_safe() {
    if (script_exists(asset_get_index("fastlogs_get_counts"))) {
        var c = fastlogs_get_counts();
        // Защита от неполного struct.
        return {
            error: variable_struct_exists(c, "error") ? c.error : 0,
            warn:  variable_struct_exists(c, "warn")  ? c.warn  : 0,
            log:   variable_struct_exists(c, "log")   ? c.log   : 0,
        };
    }
    return { error: 0, warn: 0, log: 0 };
}

function fastlogs_ui_is_sending_safe() {
    if (script_exists(asset_get_index("fastlogs_is_sending"))) return fastlogs_is_sending();
    return false;
}

function fastlogs_ui_last_url_safe() {
    if (script_exists(asset_get_index("fastlogs_last_url"))) return fastlogs_last_url();
    return "";
}

function fastlogs_ui_is_recording_safe() {
    if (script_exists(asset_get_index("fastlogs_is_recording"))) return fastlogs_is_recording();
    return false;
}

/// @returns {string} имя тестера с учётом runtime-override (fastlogs_init({tester})), иначе макрос
function fastlogs_ui_tester_safe() {
    // __fastlogs_cfg (core) учитывает override из fastlogs_init; если core ещё не подключён -
    //   падаем на сам макрос FASTLOGS_TESTER.
    var t = FASTLOGS_TESTER;
    if (script_exists(asset_get_index("__fastlogs_cfg"))) {
        t = __fastlogs_cfg("tester", FASTLOGS_TESTER);
    }
    return is_string(t) ? t : "";
}
