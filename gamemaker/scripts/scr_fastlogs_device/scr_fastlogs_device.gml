/// @description scr_fastlogs_device
// FastLogs GameMaker client - УСТРОЙСТВО (сбор device{} по контракту).
// Назначение: максимально полный срез железа/ОС/дисплея/рантайма в struct,
//   сгруппированный по группам контракта (system/graphics/display/application/
//   runtime/web). Пустые/недоступные поля ОПУСКАЕМ (см. CONTRACT.md инвариант 3).
// Гейтинг: при !FASTLOGS_ENABLED возвращаем пустой struct {}.
// Сверка GML-API - GM-NOTES.md раздел 2.3. Неуверенное помечено // TODO verify.

// =====================================================================================
// fastlogs_platform_string() -> string
// Маппинг os_type -> значение поля "platform" контракта.
// Допустимые: WebGL|Android|iOS|Windows|macOS|Linux|GameMaker|PS4|PS5|Switch|Xbox|Other.
// Шлём конкретную ОС, когда известна; "GameMaker" как обобщённый фолбэк не используем,
//   потому что почти всегда знаем os_type. "Other" - для неизвестных.
// =====================================================================================
function fastlogs_platform_string() {
    switch (os_type) {
        case os_windows:        return "Windows";
        case os_macosx:         return "macOS";
        case os_linux:          return "Linux";
        case os_android:        return "Android";
        case os_ios:            return "iOS";
        case os_tvos:           return "iOS";          // tvOS близок к iOS; контракт tvOS не знает -> iOS // TODO verify уместность
        case os_ps4:            return "PS4";
        case os_ps5:            return "PS5";
        case os_switch:         return "Switch";
    }
    // HTML5 / WebGL: на части рантаймов os_type=os_browser, на части - отдельная константа.
    // Надёжнее проверить браузер отдельно (см. fastlogs_is_html5()).
    if (fastlogs_is_html5()) { return "WebGL"; }

    // Xbox-семейство: разные рантаймы экспонируют разные константы; проверяем все известные.
    if (fastlogs_os_is_xbox()) { return "Xbox"; }

    return "Other";
}

// HTML5/WebGL детект: на HTML5 os_browser != browser_not_a_browser.
function fastlogs_is_html5() {
    // os_browser определена на всех платформах; на нативных = browser_not_a_browser.
    return (os_browser != browser_not_a_browser);
}

// Xbox детект устойчиво к набору констант рантайма (os_xboxone / os_xboxseriesxs / os_uwp на GDK).
function fastlogs_os_is_xbox() {
    // Некоторые константы могут отсутствовать в части рантаймов - обращаемся осторожно.
    // В GML необъявленная встроенная константа - ошибка компиляции, поэтому перечисляем
    //   только заведомо существующие в 2024.x. // TODO verify полный список Xbox-констант в целевом рантайме.
    if (os_type == os_xboxone) { return true; }
    if (os_type == os_xboxseriesxs) { return true; }
    if (os_type == os_uwp) { return true; }            // UWP-сборки под Xbox/PC // TODO verify трактовку
    return false;
}

// =====================================================================================
// fastlogs_collect_device([extra_struct]) -> struct
// Собирает device{} по группам контракта. Пустые ключи опускаются на этапе payload
//   (fastlogs_struct_compact) - здесь кладём всё, что удалось получить, не кладём
//   заведомо пустые строки/невалидные значения.
// extra_struct (опц.) - доп. поля от интегратора (fastlogs_send opts.extraDevice),
//   мелко-мёржатся поверх собранных групп.
// =====================================================================================
function fastlogs_collect_device(extra_struct = undefined) {
    if (!FASTLOGS_ENABLED) { return {}; }

    var dev = {};

    // -------------------------------------------------------------------------------
    // os_get_info() -> ds_map платформо-зависимых ключей. Читаем целиком в локальный
    //   struct, чтобы маппить known-ключи и не падать на отсутствующих.
    //   Карту ОБЯЗАТЕЛЬНО уничтожаем (ds_map_destroy).
    // -------------------------------------------------------------------------------
    var info = fastlogs_os_info_to_struct();   // struct (может быть пустым)

    // ===== system =====
    var system = {};
    system.os       = fastlogs_os_name_string();           // человекочитаемая ОС
    system.osFamily = fastlogs_platform_string();          // семейство (= platform)
    // os_version -> real; формат платформо-зависим. Кладём как строку, если ненулевой.
    var osv = os_version;                                    // real // TODO verify формат на iOS/Android
    if (is_real(osv) && osv != 0) { system.osVersion = string(osv); } // расширение группы (контракт допускает)
    system.deviceType = fastlogs_device_type_string();      // Handheld/Console/Desktop/Phone/Tablet/Unknown
    system.locale     = os_get_language();                  // напр. "en"; регион отдельно
    var region = os_get_region();                           // напр. "US" (может быть "")
    if (is_string(region) && string_length(region) > 0) {
        // locale в контракте - напр. "ru-RU"; склеиваем language-REGION если есть оба
        if (is_string(system.locale) && string_length(system.locale) > 0) {
            system.locale = system.locale + "-" + region;
        }
    }
    // Память/ядра: из os_get_info, если рантайм отдал (ключи платформо-зависимы).
    // Windows DX11 / часть платформ отдают объём памяти; ключи разнятся -> мягко.
    var mem_mb = fastlogs_info_pick_memory_mb(info);
    if (mem_mb > 0) { system.memoryMB = mem_mb; }
    // is64bit (есть на всех нативных платформах из os_get_info).
    if (variable_struct_exists(info, "is64bit")) { system.is64bit = info[$ "is64bit"]; }

    // ===== graphics =====
    var graphics = {};
    // Имя адаптера: чистого кроссплатформенного GML-геттера нет; на Windows DX11 оно лежит
    //   в os_get_info под ключом video_adapter_description (прочие ключи - в supports ниже).
    var gpu_name = fastlogs_info_pick_string(info, ["video_adapter_description", "gpu", "graphics_adapter"]);
    if (gpu_name != "") { graphics.gpu = gpu_name; }
    // Тип графического API (Direct3D11/OpenGL/Metal/Vulkan) GM не отдаёт стандартной
    //   функцией; оставляем платформенный фолбэк по os_type. // TODO verify точную графику API в рантайме.
    var gapi = fastlogs_graphics_api_string();
    if (gapi != "") { graphics.deviceType = gapi; }
    // Прочие video_adapter_* складываем в supports{} (отладочно полезно, контракт допускает supports{}).
    var gsup = fastlogs_info_collect_prefixed(info, "video_adapter_");
    if (variable_struct_names_count(gsup) > 0) { graphics.supports = gsup; }

    // ===== display =====
    var display = {};
    var dw = display_get_width();
    var dh = display_get_height();
    if (dw > 0 && dh > 0) { display.screen = string(dw) + "x" + string(dh); }
    var dpi = fastlogs_display_dpi();                       // 0 если недоступно
    if (dpi > 0) { display.dpi = dpi; }
    display.fullScreen = bool(window_get_fullscreen());     // bool
    var hz = fastlogs_display_refresh_hz();                 // 0 если недоступно
    if (hz > 0) { display.refreshHz = hz; }
    var orient = fastlogs_display_orientation();            // "" если неизвестно
    if (orient != "") { display.orientation = orient; }

    // ===== application =====
    var application = {};
    application.engineVersion  = fastlogs_engine_version_string();   // GM_version / runtime / build_date
    application.platform       = fastlogs_platform_string();
    var fps_target = fastlogs_target_framerate();
    if (fps_target > 0) { application.targetFrameRate = fps_target; }
    var cfg = os_get_config();                              // имя build-конфига
    if (is_string(cfg) && string_length(cfg) > 0) { application.qualityLevel = cfg; }

    // ===== runtime =====
    var runtime = {};
    // room_get_name(room) - текущая сцена. room валиден после старта комнаты.
    if (room >= 0) {
        var rn = room_get_name(room);
        if (is_string(rn) && string_length(rn) > 0) { runtime.scene = rn; }
    }
    runtime.fps      = fps;            // целевые кадры (real)
    runtime.fpsReal  = fps_real;       // фактическая нагрузка (доп. поле; контракт допускает расширение группы)
    runtime.uptimeSec = floor(get_timer() / 1000000); // get_timer - микросекунды с запуска
    // frameCount: GM не даёт прямого глобального счётчика кадров -> опускаем (контроллер может вести свой). // TODO verify

    // ===== web (только HTML5/WebGL) =====
    // ВАЖНО: чистым GML на HTML5 доступны только размеры вьюпорта (browser_width/height).
    //   userAgent/url/referrer/language/hardwareConcurrency/deviceMemory/connection - НЕТ
    //   чистого GML API (нужен JS-extension через navigator). Интегратор может прокинуть их
    //   через opts.extraDevice.web.* (см. fastlogs_send). // TODO verify JS-extension путь.
    if (fastlogs_is_html5()) {
        var bw = browser_width;
        var bh = browser_height;
        if (bw > 0 && bh > 0) {
            // Размер вьюпорта браузера кладём в display как доп. инфо (web-группу оставляем
            //   интегратору через extraDevice, т.к. её поля недоступны чистым GML).
            display.browser = string(bw) + "x" + string(bh);
        }
    }

    // Сборка групп (пустые группы не кладём; компакт уберёт пустые ключи внутри).
    if (variable_struct_names_count(system) > 0)      { dev.system = system; }
    if (variable_struct_names_count(graphics) > 0)    { dev.graphics = graphics; }
    if (variable_struct_names_count(display) > 0)     { dev.display = display; }
    if (variable_struct_names_count(application) > 0) { dev.application = application; }
    if (variable_struct_names_count(runtime) > 0)     { dev.runtime = runtime; }

    // Мерж extraDevice от интегратора (поверх; глубина 1 уровень групп).
    if (is_struct(extra_struct)) {
        var gnames = variable_struct_get_names(extra_struct);
        for (var i = 0; i < array_length(gnames); i++) {
            var gk = gnames[i];
            var gv = variable_struct_get(extra_struct, gk);
            if (is_struct(gv) && variable_struct_exists(dev, gk) && is_struct(dev[$ gk])) {
                // мелкий мерж полей внутрь существующей группы
                var fnames = variable_struct_get_names(gv);
                for (var j = 0; j < array_length(fnames); j++) {
                    dev[$ gk][$ fnames[j]] = gv[$ fnames[j]];
                }
            } else {
                dev[$ gk] = gv;
            }
        }
    }

    return dev;
}

// =====================================================================================
// Вспомогательные хелперы устройства
// =====================================================================================

// os_get_info() -> struct (копия ds_map). Карта уничтожается. {} если функции/данных нет.
function fastlogs_os_info_to_struct() {
    var out = {};
    // os_get_info есть на нативных платформах; на HTML5 возвращает пустую/частичную карту.
    var m = os_get_info();
    if (!ds_exists(m, ds_type_map)) { return out; }
    // Безопасная итерация через массив ключей (не ломается на тонкостях find_next).
    var keys = ds_map_keys_to_array(m);
    for (var i = 0; i < array_length(keys); i++) {
        var key = keys[i];
        // Значение может быть real/string/bool/ds_map(вложенная). Вложенные карты пропускаем
        //   (в supports кладём только скаляры/строки во избежание утечек ds-ресурсов).
        var val = ds_map_find_value(m, key);
        if (is_real(val) || is_string(val) || is_bool(val)) {
            out[$ string(key)] = val;
        }
    }
    ds_map_destroy(m);
    return out;
}

// Достаёт первую непустую строку по списку возможных ключей из info-struct.
function fastlogs_info_pick_string(info, keys) {
    for (var i = 0; i < array_length(keys); i++) {
        var k = keys[i];
        if (variable_struct_exists(info, k)) {
            var v = info[$ k];
            if (is_string(v) && string_length(v) > 0) { return v; }
            if (is_real(v) && v != 0) { return string(v); }
        }
    }
    return "";
}

// Достаёт объём памяти (MB) из известных ключей os_get_info (платформо-зависимо).
function fastlogs_info_pick_memory_mb(info) {
    // Возможные ключи (байты): "TotalPhys"/"memory"/"total_memory" - набор зависит от рантайма.
    // // TODO verify точные ключи памяти os_get_info по платформам.
    var candidates_bytes = ["TotalPhys", "total_memory", "memory_total"];
    for (var i = 0; i < array_length(candidates_bytes); i++) {
        var k = candidates_bytes[i];
        if (variable_struct_exists(info, k)) {
            var v = info[$ k];
            if (is_real(v) && v > 0) { return floor(v / 1048576); }
        }
    }
    return 0;
}

// Собирает все ключи info с заданным префиксом в отдельный struct (для supports{}).
function fastlogs_info_collect_prefixed(info, prefix) {
    var out = {};
    var names = variable_struct_get_names(info);
    var plen = string_length(prefix);
    for (var i = 0; i < array_length(names); i++) {
        var n = names[i];
        if (string_length(n) >= plen && string_copy(n, 1, plen) == prefix) {
            out[$ n] = info[$ n];
        }
    }
    return out;
}

// Человекочитаемое имя ОС (для system.os).
function fastlogs_os_name_string() {
    var p = fastlogs_platform_string();
    var v = os_version;
    if (is_real(v) && v != 0) { return p + " (" + string(v) + ")"; }
    return p;
}

// deviceType по контракту (Handheld/Console/Desktop/Phone/Tablet/Unknown).
function fastlogs_device_type_string() {
    switch (os_type) {
        case os_windows:
        case os_macosx:
        case os_linux:        return "Desktop";
        case os_android:
        case os_ios:          return "Handheld";        // мобильные; точнее Phone/Tablet GML не различает надёжно
        case os_switch:       return "Handheld";
        case os_ps4:
        case os_ps5:
        case os_xboxone:
        case os_xboxseriesxs: return "Console";
    }
    if (fastlogs_is_html5()) { return "Web"; }
    return "Unknown";
}

// Графический API по платформе (фолбэк; GM не отдаёт это стандартной функцией).
function fastlogs_graphics_api_string() {
    // // TODO verify: на Windows GM по умолчанию DX11; на macOS/iOS - Metal или GL;
    //   на Android/Linux/HTML5 - OpenGL ES/WebGL. Это эвристика по умолчанию рантайма.
    switch (os_type) {
        case os_windows:      return "Direct3D11";
        case os_macosx:
        case os_ios:          return "OpenGL";          // часть рантаймов Metal // TODO verify
        case os_android:
        case os_linux:        return "OpenGL";
    }
    if (fastlogs_is_html5()) { return "WebGL"; }
    return "";
}

// DPI экрана (0 если недоступно). Стандартных функций две: display_get_dpi_x/_y
//   (простого display_get_dpi в GML НЕТ). Берём по оси X. На Mac/iOS значения могут
//   быть неточными (Apple не отдаёт корректный DPI) - но лучше что-то, чем ничего.
function fastlogs_display_dpi() {
    var d = display_get_dpi_x();                        // // TODO verify доступность на консолях
    if (is_real(d) && d > 0) { return floor(d); }
    return 0;
}

// Частота обновления экрана, Гц (0 если недоступно).
function fastlogs_display_refresh_hz() {
    var hz = display_get_frequency();                   // // TODO verify имя/доступность на всех платформах
    if (is_real(hz) && hz > 0) { return floor(hz); }
    return 0;
}

// Ориентация дисплея ("" если неизвестно). Предпочитаем display_get_orientation()
//   (возвращает display_landscape / display_landscape_flipped / display_portrait /
//   display_portrait_flipped); фолбэк - по соотношению сторон экрана.
function fastlogs_display_orientation() {
    var o = display_get_orientation();
    switch (o) {
        case display_landscape:
        case display_landscape_flipped: return "Landscape";
        case display_portrait:
        case display_portrait_flipped:  return "Portrait";
    }
    var dw = display_get_width();
    var dh = display_get_height();
    if (dw > 0 && dh > 0) {
        return (dw >= dh) ? "Landscape" : "Portrait";
    }
    return "";
}

// Целевой FPS (0 если не задан/неизвестен).
function fastlogs_target_framerate() {
    var g = game_get_speed(gamespeed_fps);              // целевой game speed в кадрах/сек
    if (is_real(g) && g > 0) { return floor(g); }
    return 0;
}

// Версия движка/рантайма для application.engineVersion.
function fastlogs_engine_version_string() {
    var s = "";
    // GM_version - версия проекта (Game Options); GM_runtime_version - версия рантайма.
    var rt = GM_runtime_version;                        // string
    if (is_string(rt) && string_length(rt) > 0) {
        s = "GM " + rt;
    } else {
        s = "GameMaker";
    }
    var bd = GM_build_date;                             // datetime real -> человекочитаемо
    if (is_real(bd) && bd != 0) {
        s += " (build " + date_datetime_string(bd) + ")";
    }
    return s;
}
