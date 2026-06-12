/// @description scr_fastlogs_config
// FastLogs GameMaker client - КОНФИГУРАЦИЯ (дефолтные макросы).
// НЕЙТРАЛЬНЫЕ дефолты: без playjoystudios, без секретов. Интегратор переопределяет
// эти значения в своём проекте (например, в отдельном config-скрипте поверх).
// Сверять GML-API по GM-NOTES.md. Контракт тела запроса: ../../CONTRACT.md.

// =====================================================================================
// КОНСОЛЬ-БЕЗОПАСНОСТЬ / ГЕЙТИНГ (per-config)
// -------------------------------------------------------------------------------------
// FASTLOGS_ENABLED задаётся ПО КОНФИГУ СБОРКИ. Имена конфигов должны совпадать с .yyp:
//   Default - релизный конфиг (клиент ВЫКЛ, контроллер не создаётся, нет http/screen_save).
//   debug   - отладочный конфиг (клиент ВКЛ).
// Паттерн как __INPUT_DEBUG_STEAM_INPUT / __SCRIBBLE_DEBUG.
// В ритейле на консолях собирают Default -> запрещённые сетевые/скриншот-вызовы не исполняются.
#macro                FASTLOGS_ENABLED false
#macro Default:       FASTLOGS_ENABLED false
#macro debug:         FASTLOGS_ENABLED true

// =====================================================================================
// СЕРВЕР / ИНГЕСТ (тот же сервер, что у Unity-клиента)
// -------------------------------------------------------------------------------------
// Endpoint - полный URL ингеста по контракту: <BASE_URL>/api/logs
// Дефолт пустой -> интегратор ОБЯЗАН задать (иначе fastlogs_send делает no-op + предупреждение).
#macro FASTLOGS_ENDPOINT      ""        // напр. "http://localhost:8787/api/logs"
#macro FASTLOGS_APP_ID        ""        // [a-z0-9_-]{2,32}, = Project в каталоге
#macro FASTLOGS_TOKEN         ""        // ingest-токен (Authorization: Bearer ...); "" = без заголовка
#macro FASTLOGS_APP_VERSION   ""        // "" -> взять GM_version / задать вручную

// Ретеншн (per-request override; сервер clamp(1, app.maxRetentionDays)). -1 = не слать поле.
#macro FASTLOGS_RETENTION_DAYS -1

// HTTP timeout на установку соединения, мс. // TODO verify применимость http_set_connect_timeout.
#macro FASTLOGS_HTTP_TIMEOUT_MS 15000

// =====================================================================================
// ЗАПИСЬ ЛОГОВ (кольцо + персист)
// -------------------------------------------------------------------------------------
// Размер кольцевого буфера в памяти (число строк-записей лога).
#macro FASTLOGS_RING_SIZE     2000

// Автостарт записи. ПО УМОЛЧАНИЮ ВЫКЛ - запись включается fastlogs_record_start()/set(true).
#macro FASTLOGS_AUTO_START_RECORDING false

// Персист на диск: сохранять лог между сессиями (rolling-файл с лимитом, маркер сессии).
#macro FASTLOGS_PERSIST_ENABLED   true
// Относительный путь файла лога внутри game_save_id.
#macro FASTLOGS_PERSIST_DIR       "fastlogs"
#macro FASTLOGS_PERSIST_FILE      "session.log"
// Максимальный размер персист-файла на диске (байт) перед ротацией.
#macro FASTLOGS_PERSIST_MAX_BYTES 1048576   // 1 MB

// Усечение logText в payload (распакованный лог), байт. Контракт: усекать с пометкой.
#macro FASTLOGS_MAX_LOG_BYTES     2000000   // ~2 MB (сервер MAX_LOG_BYTES ~20 MB - запас вниз)

// Кодировка лога в payload. На WebGL обязателен plain; держим plain везде для простоты.
#macro FASTLOGS_LOG_ENCODING      "plain"

// =====================================================================================
// СКРИНШОТ
// -------------------------------------------------------------------------------------
// Включать ли скриншот в payload по умолчанию (тоггл; runtime - fastlogs_set_screenshot).
#macro FASTLOGS_SCREENSHOT_DEFAULT false
// Имя временного PNG в game_save_id для пути screen_save -> buffer_load -> base64.
#macro FASTLOGS_SCREENSHOT_TMP     "fastlogs_shot_tmp.png"

// =====================================================================================
// АВТО-ОТПРАВКА
// -------------------------------------------------------------------------------------
// Автоматически отправлять при необработанном исключении (best-effort + персист на диск).
#macro FASTLOGS_AUTOSEND_ON_EXCEPTION true

// =====================================================================================
// УПРАВЛЕНИЕ / ХОТКЕИ
// -------------------------------------------------------------------------------------
// Клавиша-тоггл оверлея (на платформах с клавиатурой). vk_* константа.
#macro FASTLOGS_HOTKEY_TOGGLE  vk_f8
// Геймпад-комбо для консолей. // TODO verify константы gp_* под целевые платформы.
#macro FASTLOGS_GP_TOGGLE      gp_select

// =====================================================================================
// ОВЕРЛЕЙ (цвета/раскладка; рисуем ПРИМИТИВАМИ, без спрайтов)
// -------------------------------------------------------------------------------------
#macro FASTLOGS_COL_BG        $000000     // фон панели (BGR в GM make_colour_rgb-нотации hex - см. ниже)
#macro FASTLOGS_COL_PANEL     $1A1A1A
#macro FASTLOGS_COL_TEXT      $E6E6E6
#macro FASTLOGS_COL_ERROR     $4040FF     // красный (GM hex = $BBGGRR)
#macro FASTLOGS_COL_WARN      $20C0FF     // жёлто-оранжевый
#macro FASTLOGS_COL_LOG       $C0C0C0     // серый
#macro FASTLOGS_COL_BTN       $303030
#macro FASTLOGS_COL_BTN_HOVER $4A4A4A
#macro FASTLOGS_COL_ACCENT    $50C878     // акцент (зелёный)

#macro FASTLOGS_BG_ALPHA      0.85        // прозрачность фоновой панели
#macro FASTLOGS_BTN_MIN_SIZE  64          // мин. размер тап-зоны (px), крупные кнопки для тача
