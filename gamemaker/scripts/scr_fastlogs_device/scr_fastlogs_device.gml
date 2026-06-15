/// @description scr_fastlogs_device
// FastLogs GameMaker client - DEVICE (collects device{} per contract).
// Purpose: the most complete snapshot of hardware/OS/display/runtime in a struct,
//   grouped by contract groups (system/graphics/display/application/
//   runtime/web). Empty/unavailable fields are OMITTED (see CONTRACT.md invariant 3).
// Gating: when !FASTLOGS_ENABLED returns an empty struct {}.
// GML-API reference - GM-NOTES.md section 2.3. Uncertain items marked // TODO verify.

// =====================================================================================
// fastlogs_platform_string() -> string
// Maps os_type -> value of the "platform" contract field.
// Allowed: WebGL|Android|iOS|Windows|macOS|Linux|GameMaker|PS4|PS5|Switch|Xbox|Other.
// We send the concrete OS when known; "GameMaker" as a generic fallback is not used,
//   because os_type is almost always known. "Other" - for unknown platforms.
// =====================================================================================
function fastlogs_platform_string() {
    switch (os_type) {
        case os_windows:        return "Windows";
        case os_macosx:         return "macOS";
        case os_linux:          return "Linux";
        case os_android:        return "Android";
        case os_ios:            return "iOS";
        case os_tvos:           return "iOS";          // tvOS is close to iOS; contract doesn't know tvOS -> iOS // TODO verify appropriateness
        case os_ps4:            return "PS4";
        case os_ps5:            return "PS5";
        case os_switch:         return "Switch";
    }
    // HTML5 / WebGL: on some runtimes os_type=os_browser, on others - a separate constant.
    // More reliable to check for browser separately (see fastlogs_is_html5()).
    if (fastlogs_is_html5()) { return "WebGL"; }

    // Xbox family: different runtimes expose different constants; check all known ones.
    if (fastlogs_os_is_xbox()) { return "Xbox"; }

    return "Other";
}

// HTML5/WebGL detection: on HTML5 os_browser != browser_not_a_browser.
function fastlogs_is_html5() {
    // os_browser is defined on all platforms; on native platforms = browser_not_a_browser.
    return (os_browser != browser_not_a_browser);
}

// Xbox detection, robust to the set of runtime constants (os_xboxone / os_xboxseriesxs / os_uwp on GDK).
function fastlogs_os_is_xbox() {
    // Some constants may be absent on certain runtimes - access carefully.
    // In GML an undeclared built-in constant is a compile error, so we enumerate
    //   only those known to exist in 2024.x. // TODO verify full Xbox constant list in the target runtime.
    if (os_type == os_xboxone) { return true; }
    if (os_type == os_xboxseriesxs) { return true; }
    if (os_type == os_uwp) { return true; }            // UWP builds for Xbox/PC // TODO verify interpretation
    return false;
}

// =====================================================================================
// fastlogs_collect_device([extra_struct]) -> struct
// Collects device{} by contract groups. Empty keys are dropped at the payload stage
//   (fastlogs_struct_compact) - here we store everything we managed to retrieve, and do
//   not store known-empty strings/invalid values.
// extra_struct (opt.) - additional fields from the integrator (fastlogs_send opts.extraDevice),
//   shallow-merged on top of the collected groups.
// =====================================================================================
function fastlogs_collect_device(extra_struct = undefined) {
    if (!FASTLOGS_ENABLED) { return {}; }

    var dev = {};

    // -------------------------------------------------------------------------------
    // os_get_info() -> ds_map of platform-dependent keys. Read entirely into a local
    //   struct so we can map known keys without crashing on missing ones.
    //   The map MUST be destroyed (ds_map_destroy).
    // -------------------------------------------------------------------------------
    var info = fastlogs_os_info_to_struct();   // struct (may be empty)

    // ===== system =====
    var system = {};
    system.os       = fastlogs_os_name_string();           // human-readable OS name
    system.osFamily = fastlogs_platform_string();          // family (= platform)
    // os_version -> real; format is platform-dependent. Store as string if non-zero.
    var osv = os_version;                                    // real // TODO verify format on iOS/Android
    if (is_real(osv) && osv != 0) { system.osVersion = string(osv); } // group extension (contract allows it)
    system.deviceType = fastlogs_device_type_string();      // Handheld/Console/Desktop/Phone/Tablet/Unknown
    system.locale     = os_get_language();                  // e.g. "en"; region separately
    var region = os_get_region();                           // e.g. "US" (may be "")
    if (is_string(region) && string_length(region) > 0) {
        // locale in the contract - e.g. "ru-RU"; concatenate language-REGION if both are present
        if (is_string(system.locale) && string_length(system.locale) > 0) {
            system.locale = system.locale + "-" + region;
        }
    }
    // Memory/cores: from os_get_info, if the runtime provided them (keys are platform-dependent).
    // Windows DX11 / some platforms return memory size; keys vary -> soft lookup.
    var mem_mb = fastlogs_info_pick_memory_mb(info);
    if (mem_mb > 0) { system.memoryMB = mem_mb; }
    // is64bit (available on all native platforms via os_get_info).
    if (variable_struct_exists(info, "is64bit")) { system.is64bit = info[$ "is64bit"]; }

    // ===== graphics =====
    var graphics = {};
    // Adapter name: there is no clean cross-platform GML getter; on Windows DX11 it lives
    //   in os_get_info under key video_adapter_description (other keys - in supports below).
    var gpu_name = fastlogs_info_pick_string(info, ["video_adapter_description", "gpu", "graphics_adapter"]);
    if (gpu_name != "") { graphics.gpu = gpu_name; }
    // The graphics API type (Direct3D11/OpenGL/Metal/Vulkan) is not exposed by a standard
    //   GM function; use a platform-based fallback via os_type. // TODO verify exact graphics API in runtime.
    var gapi = fastlogs_graphics_api_string();
    if (gapi != "") { graphics.deviceType = gapi; }
    // Other video_adapter_* keys are stored in supports{} (useful for debugging; contract allows supports{}).
    var gsup = fastlogs_info_collect_prefixed(info, "video_adapter_");
    if (variable_struct_names_count(gsup) > 0) { graphics.supports = gsup; }

    // ===== display =====
    var display = {};
    var dw = display_get_width();
    var dh = display_get_height();
    if (dw > 0 && dh > 0) { display.screen = string(dw) + "x" + string(dh); }
    var dpi = fastlogs_display_dpi();                       // 0 if unavailable
    if (dpi > 0) { display.dpi = dpi; }
    display.fullScreen = bool(window_get_fullscreen());     // bool
    var hz = fastlogs_display_refresh_hz();                 // 0 if unavailable
    if (hz > 0) { display.refreshHz = hz; }
    var orient = fastlogs_display_orientation();            // "" if unknown
    if (orient != "") { display.orientation = orient; }

    // ===== application =====
    var application = {};
    application.engineVersion  = fastlogs_engine_version_string();   // GM_version / runtime / build_date
    application.platform       = fastlogs_platform_string();
    var fps_target = fastlogs_target_framerate();
    if (fps_target > 0) { application.targetFrameRate = fps_target; }
    var cfg = os_get_config();                              // build config name
    if (is_string(cfg) && string_length(cfg) > 0) { application.qualityLevel = cfg; }

    // ===== runtime =====
    var runtime = {};
    // room_get_name(room) - current scene. room is valid after the room has started.
    if (room >= 0) {
        var rn = room_get_name(room);
        if (is_string(rn) && string_length(rn) > 0) { runtime.scene = rn; }
    }
    runtime.fps      = fps;            // target frames (real)
    runtime.fpsReal  = fps_real;       // actual load (extra field; contract allows group extension)
    runtime.uptimeSec = floor(get_timer() / 1000000); // get_timer - microseconds since launch
    // frameCount: GM has no direct global frame counter -> omit (the controller can maintain its own). // TODO verify

    // ===== web (HTML5/WebGL only) =====
    // NOTE: pure GML on HTML5 only exposes viewport dimensions (browser_width/height).
    //   userAgent/url/referrer/language/hardwareConcurrency/deviceMemory/connection - NO
    //   pure GML API exists (a JS-extension via navigator is required). The integrator can pass
    //   them via opts.extraDevice.web.* (see fastlogs_send). // TODO verify JS-extension path.
    if (fastlogs_is_html5()) {
        var bw = browser_width;
        var bh = browser_height;
        if (bw > 0 && bh > 0) {
            // Browser viewport size stored in display as extra info (web group is left to
            //   the integrator via extraDevice, since its fields are not accessible from pure GML).
            display.browser = string(bw) + "x" + string(bh);
        }
    }

    // Assemble groups (empty groups are not added; compact will remove empty keys inside).
    if (variable_struct_names_count(system) > 0)      { dev.system = system; }
    if (variable_struct_names_count(graphics) > 0)    { dev.graphics = graphics; }
    if (variable_struct_names_count(display) > 0)     { dev.display = display; }
    if (variable_struct_names_count(application) > 0) { dev.application = application; }
    if (variable_struct_names_count(runtime) > 0)     { dev.runtime = runtime; }

    // Merge extraDevice from the integrator (on top; depth 1 group level).
    if (is_struct(extra_struct)) {
        var gnames = variable_struct_get_names(extra_struct);
        for (var i = 0; i < array_length(gnames); i++) {
            var gk = gnames[i];
            var gv = variable_struct_get(extra_struct, gk);
            if (is_struct(gv) && variable_struct_exists(dev, gk) && is_struct(dev[$ gk])) {
                // shallow-merge fields into the existing group
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
// Device helper functions
// =====================================================================================

// os_get_info() -> struct (copy of ds_map). The map is destroyed. {} if function/data not available.
function fastlogs_os_info_to_struct() {
    var out = {};
    // os_get_info is available on native platforms; on HTML5 it returns an empty/partial map.
    var m = os_get_info();
    if (!ds_exists(m, ds_type_map)) { return out; }
    // Safe iteration via a keys array (avoids edge cases with find_next).
    var keys = ds_map_keys_to_array(m);
    for (var i = 0; i < array_length(keys); i++) {
        var key = keys[i];
        // Value may be real/string/bool/ds_map (nested). Skip nested maps
        //   (only store scalars/strings in supports to avoid ds-resource leaks).
        var val = ds_map_find_value(m, key);
        if (is_real(val) || is_string(val) || is_bool(val)) {
            out[$ string(key)] = val;
        }
    }
    ds_map_destroy(m);
    return out;
}

// Returns the first non-empty string found under any of the given keys in info-struct.
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

// Returns memory size (MB) from known os_get_info keys (platform-dependent).
function fastlogs_info_pick_memory_mb(info) {
    // Possible keys (bytes): "TotalPhys"/"memory"/"total_memory" - set depends on runtime.
    // // TODO verify exact memory keys of os_get_info per platform.
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

// Collects all keys from info that start with the given prefix into a separate struct (for supports{}).
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

// Human-readable OS name (for system.os).
function fastlogs_os_name_string() {
    var p = fastlogs_platform_string();
    var v = os_version;
    if (is_real(v) && v != 0) { return p + " (" + string(v) + ")"; }
    return p;
}

// deviceType per contract (Handheld/Console/Desktop/Phone/Tablet/Unknown).
function fastlogs_device_type_string() {
    switch (os_type) {
        case os_windows:
        case os_macosx:
        case os_linux:        return "Desktop";
        case os_android:
        case os_ios:          return "Handheld";        // mobile; GML cannot reliably distinguish Phone/Tablet
        case os_switch:       return "Handheld";
        case os_ps4:
        case os_ps5:
        case os_xboxone:
        case os_xboxseriesxs: return "Console";
    }
    if (fastlogs_is_html5()) { return "Web"; }
    return "Unknown";
}

// Graphics API string by platform (fallback; GM does not expose this via a standard function).
function fastlogs_graphics_api_string() {
    // // TODO verify: on Windows GM defaults to DX11; on macOS/iOS - Metal or GL;
    //   on Android/Linux/HTML5 - OpenGL ES/WebGL. This is a heuristic based on runtime defaults.
    switch (os_type) {
        case os_windows:      return "Direct3D11";
        case os_macosx:
        case os_ios:          return "OpenGL";          // some runtimes use Metal // TODO verify
        case os_android:
        case os_linux:        return "OpenGL";
    }
    if (fastlogs_is_html5()) { return "WebGL"; }
    return "";
}

// Screen DPI (0 if unavailable). There are two standard functions: display_get_dpi_x/_y
//   (a plain display_get_dpi does NOT exist in GML). Using X-axis. On Mac/iOS values may
//   be inaccurate (Apple does not expose correct DPI) - but something is better than nothing.
function fastlogs_display_dpi() {
    var d = display_get_dpi_x();                        // // TODO verify availability on consoles
    if (is_real(d) && d > 0) { return floor(d); }
    return 0;
}

// Screen refresh rate in Hz (0 if unavailable).
function fastlogs_display_refresh_hz() {
    var hz = display_get_frequency();                   // // TODO verify name/availability on all platforms
    if (is_real(hz) && hz > 0) { return floor(hz); }
    return 0;
}

// Display orientation ("" if unknown). Prefers display_get_orientation()
//   (returns display_landscape / display_landscape_flipped / display_portrait /
//   display_portrait_flipped); falls back to screen aspect ratio.
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

// Target FPS (0 if not set/unknown).
function fastlogs_target_framerate() {
    var g = game_get_speed(gamespeed_fps);              // target game speed in frames/sec
    if (is_real(g) && g > 0) { return floor(g); }
    return 0;
}

// Engine/runtime version string for application.engineVersion.
function fastlogs_engine_version_string() {
    var s = "";
    // GM_version - project version (Game Options); GM_runtime_version - runtime version.
    var rt = GM_runtime_version;                        // string
    if (is_string(rt) && string_length(rt) > 0) {
        s = "GM " + rt;
    } else {
        s = "GameMaker";
    }
    var bd = GM_build_date;                             // datetime real -> human-readable
    if (is_real(bd) && bd != 0) {
        s += " (build " + date_datetime_string(bd) + ")";
    }
    return s;
}
