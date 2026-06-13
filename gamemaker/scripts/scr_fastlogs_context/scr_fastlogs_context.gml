/// @description scr_fastlogs_context
// FastLogs GameMaker client - КОНТЕКСТ + BREADCRUMBS (фича #2).
// Публичное API из кода игры:
//   fastlogs_set_context(key, value)   - задать пару контекста (едет с КАЖДЫМ отчётом)
//   fastlogs_clear_context()           - очистить весь контекст
//   fastlogs_breadcrumb(msg, [level])  - добавить хлебную крошку (катящийся буфер последних N)
// Внутренние снимки для payload:
//   fastlogs_context_snapshot()        -> struct string->string (опц. пустой)
//   fastlogs_breadcrumbs_snapshot()    -> array { t, m, lvl } в хронологическом порядке
//
// Хранилище в global.__fastlogs (core-state), чтобы API звался из любого контекста без
//   with/instance_find (как остальное состояние клиента):
//   - context     : struct (ключ->строка-значение)
//   - bc_ring     : array кап FASTLOGS_BREADCRUMB_MAX (кольцо), bc_head/bc_count
// ПЕРФ: контекст - словарь (правка O(1)); крошка - запись в кольцо O(1), БЕЗ аллокаций в кадре
//   (struct-слот переиспользуется по обороту кольца, как в core ring). Redaction/сериализация
//   делаются РАЗОВО при сборке payload, не на горячем пути.
//
// Все ПУБЛИЧНЫЕ точки входа: ранний выход при !FASTLOGS_ENABLED (геттеры -> безопасные дефолты).
// level крошки in info|warn|error (контракт; иначе нормализуем к "info").

// =====================================================================================
// Внутреннее: лениво создать и вернуть подсостояние context внутри global.__fastlogs.
//   Зависит от __fastlogs_state() (core). Если core ещё не подключён - вернёт undefined,
//   и публичные функции деградируют в no-op (безопасно к порядку вызовов).
// =====================================================================================
function __fastlogs_ctx_state() {
    if (!script_exists(asset_get_index("__fastlogs_state"))) return undefined;
    var st = __fastlogs_state();
    if (!variable_struct_exists(st, "context") || !is_struct(st.context)) {
        st.context = {};
    }
    if (!variable_struct_exists(st, "bc_ring") || !is_array(st.bc_ring)) {
        var cap = max(1, FASTLOGS_BREADCRUMB_MAX);
        st.bc_ring  = array_create(cap, undefined);
        st.bc_cap   = cap;
        st.bc_head  = 0;   // куда писать следующую
        st.bc_count = 0;   // валидных записей (<= cap)
    }
    return st;
}

// =====================================================================================
// fastlogs_set_context(key, value) - задать пару контекста.
//   key/value приводятся к строке; усекаются по FASTLOGS_CONTEXT_KEY/VAL_MAX (мягкая защита,
//   сервер тоже капает). Пустой ключ игнорируется. Значение храним сырым; redaction
//   значений делается при сборке payload (не здесь - чтобы не редактировать дважды/раньше).
// =====================================================================================
function fastlogs_set_context(key, value) {
    if (!FASTLOGS_ENABLED) return;
    var st = __fastlogs_ctx_state();
    if (is_undefined(st)) return;

    var k = string(key);
    if (string_length(k) == 0) return;
    if (string_length(k) > FASTLOGS_CONTEXT_KEY_MAX) k = string_copy(k, 1, FASTLOGS_CONTEXT_KEY_MAX);

    var v = string(value);
    if (string_length(v) > FASTLOGS_CONTEXT_VAL_MAX) v = string_copy(v, 1, FASTLOGS_CONTEXT_VAL_MAX);

    // variable_struct_set безопасен для произвольных строковых ключей (в т.ч. с пробелами).
    variable_struct_set(st.context, k, v);
}

// =====================================================================================
// fastlogs_remove_context(key) - удалить одну пару контекста (если есть). Удобно точечно.
// =====================================================================================
function fastlogs_remove_context(key) {
    if (!FASTLOGS_ENABLED) return;
    var st = __fastlogs_ctx_state();
    if (is_undefined(st)) return;
    var k = string(key);
    if (variable_struct_exists(st.context, k)) {
        variable_struct_remove(st.context, k);
    }
}

// =====================================================================================
// fastlogs_clear_context() - очистить весь контекст.
// =====================================================================================
function fastlogs_clear_context() {
    if (!FASTLOGS_ENABLED) return;
    var st = __fastlogs_ctx_state();
    if (is_undefined(st)) return;
    st.context = {};
}

// =====================================================================================
// Внутреннее: нормализовать уровень крошки к info|warn|error. Принимает строку или
//   FASTLOGS_LEVEL_* (real). Иначе -> "info".
// =====================================================================================
function __fastlogs_bc_level_norm(level) {
    if (is_string(level)) {
        var l = string_lower(level);
        if (l == "warn" || l == "warning") return "warn";
        if (l == "error" || l == "err")    return "error";
        if (l == "info")                   return "info";
        return "info";
    }
    if (is_real(level)) {
        switch (floor(level)) {
            case FASTLOGS_LEVEL_ERROR: return "error";
            case FASTLOGS_LEVEL_WARN:  return "warn";
            default:                   return "info";
        }
    }
    return "info";
}

// =====================================================================================
// fastlogs_breadcrumb(msg, [level]) - добавить хлебную крошку в катящийся буфер.
//   level (опц.): "info"|"warn"|"error" или FASTLOGS_LEVEL_* (деф. "info").
//   t (время) фиксируем сразу как UTC ISO-8601 (через __fastlogs_utc_iso из recorder, если
//   есть) - чтобы крошка несла момент СВОЕГО появления, а не момент отправки.
//   ПЕРФ: запись в кольцо O(1), переиспользуем struct-слот по обороту (без аллокации на крошку).
// =====================================================================================
function fastlogs_breadcrumb(msg, level = "info") {
    if (!FASTLOGS_ENABLED) return;
    var st = __fastlogs_ctx_state();
    if (is_undefined(st)) return;

    var m = string(msg);
    if (string_length(m) > FASTLOGS_BREADCRUMB_MSG_MAX) m = string_copy(m, 1, FASTLOGS_BREADCRUMB_MSG_MAX);
    var lvl = __fastlogs_bc_level_norm(level);

    // Время крошки (UTC ISO-8601). Если recorder не подключён - оставим "" (payload опустит t).
    var t = "";
    if (script_exists(asset_get_index("__fastlogs_utc_iso"))) {
        t = __fastlogs_utc_iso();
    }

    // Запись в кольцо: переиспользуем существующий struct-слот, иначе создаём.
    var slot = st.bc_ring[st.bc_head];
    if (is_struct(slot)) {
        slot.t   = t;
        slot.m   = m;
        slot.lvl = lvl;
    } else {
        slot = { t: t, m: m, lvl: lvl };
        st.bc_ring[st.bc_head] = slot;
    }
    st.bc_head = (st.bc_head + 1) mod st.bc_cap;
    if (st.bc_count < st.bc_cap) st.bc_count += 1;
}

// =====================================================================================
// fastlogs_clear_breadcrumbs() - очистить буфер хлебных крошек.
// =====================================================================================
function fastlogs_clear_breadcrumbs() {
    if (!FASTLOGS_ENABLED) return;
    var st = __fastlogs_ctx_state();
    if (is_undefined(st)) return;
    for (var i = 0; i < st.bc_cap; i++) st.bc_ring[i] = undefined;
    st.bc_head  = 0;
    st.bc_count = 0;
}

// =====================================================================================
// fastlogs_context_snapshot() -> struct (КОПИЯ контекста ключ->строка).
//   Возвращает НОВЫЙ struct, чтобы payload мог его редактировать (redaction значений) и
//   компактить, не трогая живое состояние. Пустой контекст -> {} (payload опустит).
// =====================================================================================
function fastlogs_context_snapshot() {
    if (!FASTLOGS_ENABLED) return {};
    var st = __fastlogs_ctx_state();
    if (is_undefined(st)) return {};
    var out = {};
    var keys = variable_struct_get_names(st.context);
    for (var i = 0; i < array_length(keys); i++) {
        var k = keys[i];
        var v = variable_struct_get(st.context, k);
        out[$ k] = is_string(v) ? v : string(v);
    }
    return out;
}

// =====================================================================================
// fastlogs_breadcrumbs_snapshot() -> array { t, m, lvl } в ХРОНОЛОГИЧЕСКОМ порядке.
//   Возвращает массив НОВЫХ структур-копий (payload редактирует m через redaction и
//   компактит). Пустой буфер -> [] (payload опустит).
// =====================================================================================
function fastlogs_breadcrumbs_snapshot() {
    if (!FASTLOGS_ENABLED) return [];
    var st = __fastlogs_ctx_state();
    if (is_undefined(st)) return [];
    var out = [];
    if (st.bc_count <= 0) return out;
    // Старейшая запись: при полном кольце - bc_head; иначе - 0.
    var start = (st.bc_count >= st.bc_cap) ? st.bc_head : 0;
    for (var i = 0; i < st.bc_count; i++) {
        var idx = (start + i) mod st.bc_cap;
        var rec = st.bc_ring[idx];
        if (is_struct(rec)) {
            array_push(out, {
                t:   variable_struct_exists(rec, "t")   ? rec.t   : "",
                m:   variable_struct_exists(rec, "m")   ? rec.m   : "",
                lvl: variable_struct_exists(rec, "lvl") ? rec.lvl : "info",
            });
        }
    }
    return out;
}
