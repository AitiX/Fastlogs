/// @description scr_fastlogs_util
// FastLogs GameMaker client - УТИЛИТЫ + ЧИСТКА PII (redaction, фича #3).
// Назначение: redaction чувствительных данных (PII) в тексте перед отправкой:
//   email / IPv4 / IPv6 / Bearer (Authorization) токены / длинные цифровые последовательности
//   -> "[redacted]". Применяется к logText, значениям context и текстам breadcrumbs.
//
// ВАЖНО ПРО REGEX (сверено WebSearch, июнь 2026): GameMaker НЕ имеет нативного runtime-regex.
//   manual даёт только string_replace / string_replace_all по ЛИТЕРАЛАМ (не паттернам).
//   Внешние extension'ы (RegexGM и т.п.) ломают zero-dependency drop-in клиента, поэтому
//   паттерны реализованы РУЧНЫМИ GML-сканерами строк (ord/string_char_at/string_pos),
//   эквивалентными нужным регуляркам. Каждое правило помечено своим regex-эквивалентом.
//   Набор правил РАСШИРЯЕМ: fastlogs_redact_rules_set([...]) / дефолт fastlogs_redact_default_rules().
//
// СВЕРИТЬ ПО MANUAL при импорте в IDE (manual отдаёт 403 на прямой fetch; ниже - стандартные,
//   но помечаю как требующие финальной сверки):
//   - ord(string) -> код первого символа (Unicode codepoint).            // TODO verify
//   - string_char_at(str, pos) -> символ на позиции pos (1-based).        // TODO verify
//   - string_length / string_byte_length / string_pos / string_copy /
//     string_delete / string_insert / string_replace_all / string_lower. // стандартные
//   Позиции строк в GML 1-based (подтверждено практикой проекта: string_copy(s,1,n)).
//
// Все ПУБЛИЧНЫЕ точки входа: ранний выход при !FASTLOGS_ENABLED.
// Сверять GML-API по GM-NOTES.md. Неуверенное помечать // TODO verify.

// =====================================================================================
// Эффективный флаг чистки PII: runtime-override (fastlogs_init({scrubPii})) -> макрос.
//   __fastlogs_cfg доступна из core; если core ещё не подключён - падаем на макрос.
// =====================================================================================
function fastlogs_scrub_pii_enabled() {
    if (!FASTLOGS_ENABLED) return false;
    var def = FASTLOGS_SCRUB_PII;
    if (script_exists(asset_get_index("__fastlogs_cfg"))) {
        return bool(__fastlogs_cfg("scrubPii", def));
    }
    return bool(def);
}

// =====================================================================================
// Низкоуровневые посимвольные предикаты (коды символов). ord() возвращает codepoint.
//   Работаем по codepoint'ам - все интересующие нас классы (цифры, hex, ASCII-знаки)
//   лежат в ASCII-диапазоне, так что посимвольный разбор по string_char_at безопасен.
// =====================================================================================
function fastlogs_char_is_digit(ch) {
    var c = ord(ch);
    return (c >= 48 && c <= 57);                 // '0'..'9'
}
function fastlogs_char_is_hex(ch) {
    var c = ord(ch);
    if (c >= 48 && c <= 57)  return true;        // 0-9
    if (c >= 65 && c <= 70)  return true;        // A-F
    if (c >= 97 && c <= 102) return true;        // a-f
    return false;
}
// "Атом" локальной части email / домена: буквы, цифры и набор знаков, допустимых в email.
function fastlogs_char_is_email_atom(ch) {
    var c = ord(ch);
    if (c >= 48 && c <= 57)  return true;        // 0-9
    if (c >= 65 && c <= 90)  return true;        // A-Z
    if (c >= 97 && c <= 122) return true;        // a-z
    // допустимые знаки в локальной части / домене: . _ % + - (без скобок/кавычек)
    switch (c) {
        case 46:  // .
        case 95:  // _
        case 37:  // %
        case 43:  // +
        case 45:  // -
            return true;
    }
    return false;
}
// Символ домена email: буквы/цифры/точка/дефис (для хвоста после '@').
function fastlogs_char_is_domain(ch) {
    var c = ord(ch);
    if (c >= 48 && c <= 57)  return true;
    if (c >= 65 && c <= 90)  return true;
    if (c >= 97 && c <= 122) return true;
    return (c == 46 || c == 45);                 // . -
}

// =====================================================================================
// Внутреннее: универсальный сканер "замени совпадения предиката-матчера на placeholder".
//   matcher(str, pos) -> длина совпадения В СИМВОЛАХ начиная с pos (>0), либо 0 если нет.
//   Идём слева направо; на совпадении вставляем placeholder и перескакиваем за него.
//   ПЕРФ: один проход O(n); вызывается РАЗОВО при сборке payload/краша, не в кадре.
//   Возвращает строку с заменами.
// =====================================================================================
function fastlogs_redact_scan(str, matcher, placeholder) {
    if (!is_string(str) || string_length(str) == 0) return str;
    var n   = string_length(str);
    var out = "";
    var i   = 1;                                  // 1-based
    while (i <= n) {
        var mlen = matcher(str, i);
        if (mlen > 0) {
            out += placeholder;
            i   += mlen;                          // перескочить совпадение
        } else {
            out += string_char_at(str, i);
            i   += 1;
        }
    }
    return out;
}

// =====================================================================================
// МАТЧЕРЫ (regex-эквиваленты). Каждый: (str, pos) -> длина совпадения в символах, либо 0.
// =====================================================================================

// EMAIL. regex-эквивалент: [A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}
//   Совпадение "якорим" на '@': матчер вызывается на КАЖДОЙ позиции, поэтому ловим '@' и
//   откатываемся влево по локальной части... но сканер идёт только вперёд. Чтобы не плодить
//   откаты, реализуем как "локальная часть -> @ -> домен" начиная с pos: если на pos стоит
//   валидный старт email и дальше встречается '@' с валидным доменом - матчим весь блок.
function fastlogs_match_email(str, pos) {
    var n = string_length(str);
    // 1) локальная часть: >=1 email-атом
    var i = pos;
    var local_len = 0;
    while (i <= n && fastlogs_char_is_email_atom(string_char_at(str, i))) { i += 1; local_len += 1; }
    if (local_len == 0) return 0;
    // 2) '@'
    if (i > n || string_char_at(str, i) != "@") return 0;
    i += 1;
    // 3) домен: метки [A-Za-z0-9-] через '.', минимум одна точка и TLD >=2 букв
    var dom_start = i;
    var last_dot  = -1;
    while (i <= n && fastlogs_char_is_domain(string_char_at(str, i))) {
        if (string_char_at(str, i) == ".") last_dot = i;
        i += 1;
    }
    if (i == dom_start) return 0;                 // нет домена
    if (last_dot < 0)   return 0;                 // нет точки -> не email
    // TLD после последней точки: >=2 буквы
    var tld_len = 0;
    var k = last_dot + 1;
    while (k <= n) {
        var c = ord(string_char_at(str, k));
        if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122)) { tld_len += 1; k += 1; }
        else break;
    }
    if (tld_len < 2) return 0;
    // Длина совпадения = до конца TLD (не включаем хвостовые точки/дефисы домена).
    var end = last_dot + tld_len;                 // позиция последней буквы TLD
    return (end - pos + 1);
}

// IPv4. regex-эквивалент: \b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b (с проверкой октетов 0..255).
function fastlogs_match_ipv4(str, pos) {
    var n = string_length(str);
    var i = pos;
    var octets = 0;
    while (octets < 4) {
        // 1..3 цифры
        var dstart = i;
        var val = 0;
        var dcount = 0;
        while (i <= n && dcount < 3 && fastlogs_char_is_digit(string_char_at(str, i))) {
            val = val * 10 + (ord(string_char_at(str, i)) - 48);
            i += 1; dcount += 1;
        }
        if (dcount == 0) return 0;                // нет цифры -> не октет
        if (val > 255) return 0;                  // вне диапазона октета
        octets += 1;
        if (octets < 4) {
            if (i > n || string_char_at(str, i) != ".") return 0;  // разделитель
            i += 1;
        }
    }
    // Не матчим, если сразу следом ещё цифра или точка (часть более длинного числа/версии).
    if (i <= n) {
        var nc = string_char_at(str, i);
        if (fastlogs_char_is_digit(nc) || nc == ".") return 0;
    }
    return (i - pos);
}

// IPv6. regex-эквивалент (упрощённый, ловит распространённые формы): группы hex (1..4 симв)
//   разделённые ':' с возможным "::" (сжатие нулей). Требуем минимум 2 двоеточия, чтобы не
//   путать с "time 12:30" или MAC. Матчер консервативный: hex-группы + ':' + опц. "::".
function fastlogs_match_ipv6(str, pos) {
    var n = string_length(str);
    var i = pos;
    var colons = 0;
    var groups = 0;
    var saw_double = false;
    var started = false;
    while (i <= n) {
        var ch = string_char_at(str, i);
        if (fastlogs_char_is_hex(ch)) {
            // hex-группа 1..4 символов
            var glen = 0;
            while (i <= n && glen < 4 && fastlogs_char_is_hex(string_char_at(str, i))) { i += 1; glen += 1; }
            groups += 1; started = true;
        } else if (ch == ":") {
            colons += 1; started = true;
            i += 1;
            if (i <= n && string_char_at(str, i) == ":") { saw_double = true; colons += 1; i += 1; }
        } else {
            break;
        }
    }
    if (!started) return 0;
    // Консервативный порог: >=2 двоеточия и >=2 hex-групп (или присутствует "::").
    if (colons < 2) return 0;
    if (!saw_double && groups < 2) return 0;
    return (i - pos);
}

// BEARER / AUTHORIZATION-токен. regex-эквивалент (без учёта регистра):
//   (Bearer|Authorization:?\s*Bearer)\s+[A-Za-z0-9._\-+/=]+
//   Матчим ключевое слово Bearer (после опц. "Authorization:" / "Authorization ") + сам токен.
function fastlogs_match_bearer(str, pos) {
    var n = string_length(str);
    var i = pos;
    // Опциональный префикс "authorization" + опц. ':' + пробелы.
    var lowered = string_lower(string_copy(str, pos, min(20, n - pos + 1)));
    if (string_pos("authorization", lowered) == 1) {
        i = pos + 13;                             // длина "authorization"
        if (i <= n && string_char_at(str, i) == ":") i += 1;
        while (i <= n && fastlogs_char_is_space(string_char_at(str, i))) i += 1;
    }
    // Ключевое слово "bearer" (без учёта регистра).
    var kw = string_lower(string_copy(str, i, min(6, n - i + 1)));
    if (kw != "bearer") return 0;
    i += 6;
    // Пробелы между Bearer и токеном (минимум один).
    var sp = 0;
    while (i <= n && fastlogs_char_is_space(string_char_at(str, i))) { i += 1; sp += 1; }
    if (sp == 0) return 0;
    // Сам токен: набор base64url/jwt-символов.
    var tstart = i;
    while (i <= n && fastlogs_char_is_token(string_char_at(str, i))) i += 1;
    if (i == tstart) return 0;                    // "Bearer" без токена -> не редактируем
    return (i - pos);
}
function fastlogs_char_is_space(ch) {
    var c = ord(ch);
    return (c == 32 || c == 9);                   // space, tab
}
function fastlogs_char_is_token(ch) {
    var c = ord(ch);
    if (c >= 48 && c <= 57)  return true;
    if (c >= 65 && c <= 90)  return true;
    if (c >= 97 && c <= 122) return true;
    switch (c) {
        case 46:  // .
        case 95:  // _
        case 45:  // -
        case 43:  // +
        case 47:  // /
        case 61:  // =
            return true;
    }
    return false;
}

// ДЛИННАЯ ЦИФРОВАЯ ПОСЛЕДОВАТЕЛЬНОСТЬ. regex-эквивалент: \d{N,} (N=FASTLOGS_REDACT_MIN_DIGITS).
//   Карты/телефоны/длинные id. Короткие числа (версии, счётчики, координаты) не трогаем.
function fastlogs_match_long_digits(str, pos) {
    var n = string_length(str);
    var i = pos;
    var cnt = 0;
    while (i <= n && fastlogs_char_is_digit(string_char_at(str, i))) { i += 1; cnt += 1; }
    var mind = max(2, FASTLOGS_REDACT_MIN_DIGITS);
    if (cnt >= mind) return cnt;
    return 0;
}

// =====================================================================================
// НАБОР ПРАВИЛ (РАСШИРЯЕМ). Каждое правило: { name, matcher }. Применяются по порядку.
//   Порядок важен: сперва структурные (email/bearer/ip), затем "длинные цифры" (иначе
//   цифры внутри IPv4 могли бы съесться раньше; но IPv4-матчер ловит весь блок, а
//   long-digits срабатывает только на >=N подряд цифр без точек, так что конфликта нет).
//   Кастомизация: fastlogs_redact_rules_set([{name,matcher}, ...]).
// =====================================================================================
function fastlogs_redact_default_rules() {
    return [
        { name: "bearer",     matcher: fastlogs_match_bearer      },
        { name: "email",      matcher: fastlogs_match_email       },
        { name: "ipv6",       matcher: fastlogs_match_ipv6        },
        { name: "ipv4",       matcher: fastlogs_match_ipv4        },
        { name: "longdigits", matcher: fastlogs_match_long_digits },
    ];
}

// Лениво вернуть активный набор правил из состояния (или дефолт). Хранится в core-state.
function __fastlogs_redact_rules() {
    if (script_exists(asset_get_index("__fastlogs_state"))) {
        var st = __fastlogs_state();
        if (!variable_struct_exists(st, "redact_rules") || !is_array(st.redact_rules)) {
            st.redact_rules = fastlogs_redact_default_rules();
        }
        return st.redact_rules;
    }
    return fastlogs_redact_default_rules();
}

/// Заменить активный набор правил redaction (расширяемость). no-op при !FASTLOGS_ENABLED.
/// @param {array} rules массив { name:string, matcher:function(str,pos)->len }
function fastlogs_redact_rules_set(rules) {
    if (!FASTLOGS_ENABLED) return;
    if (!is_array(rules)) return;
    if (script_exists(asset_get_index("__fastlogs_state"))) {
        __fastlogs_state().redact_rules = rules;
    }
}

// =====================================================================================
// fastlogs_redact(text) -> string
//   Прогоняет text через ВСЕ активные правила redaction по порядку. Если чистка выключена
//   (FASTLOGS_SCRUB_PII=false / runtime-override) - возвращает text как есть.
//   Безопасна к нестрокам ("" / приведение). РАЗОВАЯ операция (при сборке payload/краша).
// =====================================================================================
function fastlogs_redact(text) {
    if (!FASTLOGS_ENABLED) return is_string(text) ? text : "";
    if (!is_string(text) || string_length(text) == 0) return is_string(text) ? text : "";
    if (!fastlogs_scrub_pii_enabled()) return text;

    var placeholder = FASTLOGS_REDACT_PLACEHOLDER;
    var rules = __fastlogs_redact_rules();
    var out = text;
    for (var r = 0; r < array_length(rules); r++) {
        var rule = rules[r];
        if (!is_struct(rule) || !variable_struct_exists(rule, "matcher")) continue;
        out = fastlogs_redact_scan(out, rule.matcher, placeholder);
    }
    return out;
}
