# FastLogs GameMaker client - публичный API (контракт для билдеров)

Точные сигнатуры публичных функций. Это **обязательный контракт**: билдеры реализуют
именно эти имена/сигнатуры/поведение. Реализация распределена по `scr_fastlogs_*`
(см. распределение ниже). Тело запроса - строго по `../CONTRACT.md`. Формат проекта и
сверенные GML-API - в `GM-NOTES.md`.

## Сквозные инварианты

- **Гейтинг:** КАЖДАЯ публичная функция при `!FASTLOGS_ENABLED` делает безопасный ранний
  выход (no-op). Геттеры в этом случае возвращают безопасные дефолты (см. ниже).
  Контроллер `obj_fastlogs_controller` в релизе (`Default`) не создаётся.
- **Без длинного тире** в коде/комментах/строках.
- **Префиксы:** функции `fastlogs_*`, алиас `flog`; объект `obj_fastlogs_controller`;
  макросы `FASTLOGS_*`.
- Все функции безопасны к вызову до `fastlogs_init` (делают no-op / ленивую инициализацию),
  чтобы интегратор не падал на порядке вызовов.

---

## Инициализация

### `fastlogs_init([config_struct])`
Создаёт `obj_fastlogs_controller` (если ещё нет), инициализирует кольцо/счётчики/персист,
регистрирует обработчик исключений (если `FASTLOGS_AUTOSEND_ON_EXCEPTION`).
- `config_struct` (опц., struct) - runtime-override макросов: поля
  `endpoint, appId, token, appVersion, retentionDays, autoStartRecording, screenshot`
  (любое подмножество). Отсутствующие берутся из `scr_fastlogs_config`.
- Возврат: `instance id` контроллера, либо `noone` если `!FASTLOGS_ENABLED`.
- Идемпотентна (повторный вызов не плодит контроллеры).

---

## Логирование

### `flog(message, [level])` - короткий алиас `fastlogs_log`
Добавляет запись в лог. **Пишет на диск только если запись включена** (recording on);
в память (кольцо) - всегда, когда `FASTLOGS_ENABLED`.
- `message` (любой тип -> приводится к строке).
- `level` (опц.): `FASTLOGS_LEVEL_LOG` (деф.) | `FASTLOGS_LEVEL_WARN` | `FASTLOGS_LEVEL_ERROR`.
  // билдер core заводит эти макросы-уровни (0/1/2) в scr_fastlogs_config или core.
- Инкрементит счётчик соответствующего уровня **за сессию**.

### `fastlogs_log(message)` / `fastlogs_warn(message)` / `fastlogs_error(message)`
Удобные обёртки над `flog` с фиксированным уровнем.

### `fastlogs_clear()`
Очищает кольцо в памяти и счётчики сессии. Персист-файл на диске **не трогает**
(история между сессиями сохраняется). // билдер: при необходимости отдельный флаг clear-disk.

---

## Запись (recording) и персист

### `fastlogs_record_start()`
Включает запись (эквивалент `fastlogs_record_set(true)`): с этого момента новые `flog`
персистятся на диск (rolling-файл в `game_save_id`, лимит `FASTLOGS_PERSIST_MAX_BYTES`).

### `fastlogs_record_stop()`
Выключает запись (`fastlogs_record_set(false)`). Накопленное на диске остаётся.

### `fastlogs_record_set(enabled)`
- `enabled` (bool). Включает/выключает запись. Персистит флаг (ini) при `FASTLOGS_PERSIST_ENABLED`.

### `fastlogs_is_recording()` -> bool
Текущее состояние записи. При `!FASTLOGS_ENABLED` -> `false`.

---

## Скриншот

### `fastlogs_set_screenshot(enabled)`
- `enabled` (bool). Тоггл включения скриншота в следующий `fastlogs_send`.
  При включении следующий payload получит `screenshotPng` (чистый base64 PNG без `data:`).
  Снятие кадра: `screen_save -> buffer_load -> buffer_base64_encode` (см. GM-NOTES 2.2).

---

## Отправка

### `fastlogs_send([opts_struct])` -> bool
Собирает payload по `CONTRACT.md` и шлёт `POST` на `FASTLOGS_ENDPOINT`
(`Content-Type: application/json`, при наличии токена `Authorization: Bearer <token>`).
- `opts_struct` (опц., struct): `title` (string, <=120), `retentionDays` (int),
  `screenshot` (bool override), `extraDevice` (struct, доп. поля в device).
- Поведение: асинхронно (`http_request`); ответ обрабатывается в Async HTTP событии
  (`Other_62.gml`), при `201` заполняется `last_url`. Возврат: `true` если запрос
  поставлен в отправку, `false` если no-op (выключено / нет endpoint / уже идёт отправка
  при запрете параллельных - на усмотрение билдера http).
- При `!FASTLOGS_ENABLED` -> `false` (no-op), `http_request` НЕ вызывается.

### `fastlogs_is_sending()` -> bool
`true`, пока есть незавершённый запрос. При `!FASTLOGS_ENABLED` -> `false`.

### `fastlogs_last_url()` -> string
URL последнего успешно созданного лога (из ответа сервера). `""` если ещё нет.

---

## Оверлей

### `fastlogs_open()` / `fastlogs_close()` / `fastlogs_toggle()`
Показ/скрытие/переключение экранного оверлея (рисуется примитивами в Draw GUI).
no-op при `!FASTLOGS_ENABLED`.

---

## Геттеры состояния

### `fastlogs_get_counts()` -> struct
Возвращает `{ error, warn, log }` - счётчики **за сессию** (как в payload `counts`).
При `!FASTLOGS_ENABLED` -> `{ error:0, warn:0, log:0 }`.

---

## Константы уровней (заводит билдер core/config)

- `FASTLOGS_LEVEL_LOG`   = 0
- `FASTLOGS_LEVEL_WARN`  = 1
- `FASTLOGS_LEVEL_ERROR` = 2

---

## Распределение реализации по скриптам (для билдеров)

| Скрипт                      | Реализует |
|-----------------------------|-----------|
| `scr_fastlogs_config`       | макросы (ГОТОВО, не билдить) |
| `scr_fastlogs_core`         | `fastlogs_init`, `flog`/`fastlogs_log`/`warn`/`error`, кольцо, счётчики, `fastlogs_clear`, `fastlogs_get_counts`, регистрация exception handler, константы уровней |
| `scr_fastlogs_recorder`     | `fastlogs_record_start`/`stop`/`set`/`is_recording`, персист на диск + загрузка прошлых сессий, ротация |
| `scr_fastlogs_device`       | сбор `device{}` по контракту (внутр.: `fastlogs_collect_device()`), маппинг `os_type`->platform |
| `scr_fastlogs_payload`      | сборка JSON-тела (внутр.: `fastlogs_build_payload(...)`), `timestampUtc`, усечение `logText`, опускание пустых полей |
| `scr_fastlogs_http`         | `fastlogs_send`, `fastlogs_is_sending`, `fastlogs_last_url`, отправка/разбор ответа (Async HTTP) |
| `scr_fastlogs_overlay`      | `fastlogs_open`/`close`/`toggle`, отрисовка примитивами, обработка тап-зон |
| `scr_fastlogs_input`        | опрос hotkey/мыши/тача/геймпада -> вызовы overlay/copy |
| `scr_fastlogs_clipboard`    | `fastlogs_set_screenshot` тут НЕ реализуется; реализует copy-обёртку `clipboard_set_text` (last_url) |
| `scr_fastlogs_util`         | UTC ISO-8601, json-escape, усечение строк, файловые/буферные хелперы |

`fastlogs_set_screenshot` - в `scr_fastlogs_core` (управляет флагом), фактический захват -
в `scr_fastlogs_payload`/`scr_fastlogs_http` через util-хелпер.

## События объекта `obj_fastlogs_controller` (placeholder-файлы для билдеров)

| Файл                 | Событие            | Что наполнить |
|----------------------|--------------------|---------------|
| `Create_0.gml`       | Create (0/0)       | init состояния, подгрузка персиста, exception handler |
| `Step_0.gml`         | Step (3/0)         | опрос ввода, отложенные задачи |
| `Draw_64.gml`        | Draw GUI (8/64)    | отрисовка оверлея примитивами |
| `Other_62.gml`       | Async HTTP (7/62)  | разбор ответа ingest |
| `Other_63.gml`       | Async Save/Load (7/63) | завершение async-файловых операций (если используются) |
