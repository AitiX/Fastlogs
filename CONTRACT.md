# FastLogs - общий контракт (источник правды)

Этот документ - **единый контракт** между всеми клиентами (Unity, GameMaker, будущие движки) и сервером. Любой клиент, формирующий запрос по этой схеме, совместим. Менять контракт - только согласованно и с версионированием.

## Базовый URL

```
http://localhost:8787
```

(пример; в проде - ваш домен через `BASE_URL`)

Версия API в пути: `/api/v1/...` (на старте можно без версии - `/api/...`, но закладываем `v1`).

---

## 1. Ingest - отправка лога

### `POST /api/logs`

**Заголовки запроса:**
- `Content-Type: application/json` (обязательно)
- `Authorization: Bearer <ingest_token>` (опционально, но рекомендуется; токен на игру)
- `Content-Encoding: gzip` (опционально - если всё тело сжато; основной путь - несжатый JSON, где сжат только `logText`)

**Тело (JSON):**

```jsonc
{
  "appId": "lfa",                          // ОБЯЗ. [a-z0-9_-]{2,32} - идентификатор игры (= Project в каталоге)
  "platform": "WebGL",                     // ОБЯЗ. WebGL|Android|iOS|Windows|macOS|Linux|GameMaker|PS4|PS5|Switch|Xbox|Other
  "appVersion": "1.4.2 (build 318)",       // ОБЯЗ. строка версии (= version в каталоге)
  "timestampUtc": "2026-06-12T09:30:00Z",  // ОБЯЗ. ISO-8601 UTC (момент формирования на клиенте)

  "counts": {                              // ОБЯЗ. счётчики ЗА СЕССИЮ (не «в пределах кольца»)
    "error": 3, "warn": 12, "log": 540
  },

  "logText": "H4sIA...",                   // ОБЯЗ. текст логов; кодировка - см. logEncoding
  "logEncoding": "gzip+base64",            // ОБЯЗ. plain | gzip+base64

  "device": {                              // ОБЯЗ. объект; максимально полный срез, группы РАСШИРЯЕМЫ, ключи платформо-зависимы.
                                           //       Пустые/недоступные поля клиент ОПУСКАЕТ (не шлёт null).
    "system":      { "model": "", "os": "", "osFamily": "", "cpu": "", "cores": 8, "cpuFreqMHz": 0,
                     "memoryMB": 8192, "deviceType": "Handheld", "battery": 0.82, "batteryStatus": "Discharging",
                     "locale": "ru-RU", "timezone": "" },
    "graphics":    { "gpu": "", "vendor": "", "apiVersion": "", "deviceType": "Vulkan", "vramMB": 0,
                     "shaderLevel": 0, "maxTextureSize": 0, "supports": {} },
    "display":     { "screen": "1080x2400", "dpi": 421, "orientation": "", "safeArea": "",
                     "fullScreen": true, "refreshHz": 120, "displays": 1 },
    "application": { "engineVersion": "", "platform": "", "identifier": "", "installMode": "", "sandboxType": "",
                     "targetFrameRate": 60, "qualityLevel": "", "genuine": true },
    "runtime":     { "scene": "", "loadedScenes": [], "timeScale": 1, "uptimeSec": 0, "fps": 0, "frameCount": 0 },
    "memory":      { "managedMB": 0, "totalAllocatedMB": 0, "gcMB": 0 },
    "network":     { "reachability": "" },
    "build":       { "commit": "", "branch": "", "buildNumber": "", "buildDate": "" },
    "web":         { "userAgent": "", "url": "", "referrer": "", "language": "",
                     "hardwareConcurrency": 0, "deviceMemoryGB": 0, "connection": "" }
  },

  "screenshotPng": "iVBORw0KGgo...",       // ОПЦ. base64 PNG БЕЗ префикса "data:" (legacy: один скриншот по тоглу)
  "screenshotsPng": ["iVBOR...", "iVBOR..."], // ОПЦ. несколько base64 PNG (без "data:"); сервер берёт array + legacy single, кап MAX_SCREENSHOTS (8)
  "retentionDays": 14,                     // ОПЦ. per-request override; сервер делает clamp(1, app.maxRetentionDays)
  "title": "Crash on level load",          // ОПЦ. <=120 символов - заголовок записи в каталоге/вьюере
  "comment": "Открыл уровень 3, зависло на загрузке",  // ОПЦ. <=4000 символов - свободный комментарий тестера (описание проблемы), показывается во вьюере
  "tester": "Alex",                                    // ОПЦ. <=120 символов - имя тестера (из настроек клиента), показывается во вьюере
  "sessionId": "a3f1c9e2-...",             // ОПЦ. <=128 символов - идентификатор ЗАПУСКА (один GUID на всю сессию клиента).
                                           //       Один и тот же для всех отчётов одного запуска => в каталоге/вьюере есть фильтр
                                           //       и ссылка «все логи этой сессии». Хранится как есть (форма не проверяется);
                                           //       пустой/пробелы -> null.

  "sentViaCode": true,                     // ОПЦ. boolean - true для ЛЮБОЙ не-ручной отправки: прямой вызов из кода
                                           //       (FastLogs.Send / SendReport / SendFile и т.п.) ЛИБО автоматическая
                                           //       (авто-краш, авто-отправка по паттерну). false ТОЛЬКО для ручной
                                           //       отправки кнопкой «Send» в оверлее (где имя QA обязательно).
                                           //       Только литеральный JSON true считается code-send; иное/отсутствие -> false.
                                           //       При false ПУСТО НЕ слать (сервер трактует отсутствие как false).
                                           //       (Оба движка ДОЛЖНЫ совпадать: авто-отправки = code-send=true.)
  "callerFile": "Assets/Scripts/Boss.cs",  // ОПЦ. <=260 символов - файл места вызова ПРЯМОГО code-send (для бейджа во вьюере).
  "callerLine": 142,                       // ОПЦ. целое >=0 - строка места вызова code-send (в паре с callerFile).
                                           //       callerFile/callerLine только для ПРЯМОГО вызова из кода; для оверлей-send
                                           //       И для авто-отправок опускать (-> null; у авто нет места вызова в игре).

  "context": {                             // ОПЦ. произвольные пары ключ->значение (строки), едут с каждым отчётом.
                                           //       Сервер: кап ~4KB суммарно, ключ<=64 символов, значение<=512 символов;
                                           //       лишнее усекается/отбрасывается. Невалидный тип (не объект) -> игнор.
    "level": "3", "playerId": "abc"
  },

  "breadcrumbs": [                         // ОПЦ. катящийся буфер последних событий (хлебных крошек).
                                           //       Сервер: кап 100 элементов и ~16KB суммарно; лишнее отбрасывается.
                                           //       Невалидный тип (не массив) -> игнор.
    { "t": "2026-06-12T09:29:58Z",         //   t   - ISO-8601 UTC, момент события (опц.)
      "m": "opened shop",                  //   m   - текст крошки (обязателен у элемента; усекается до 512)
      "lvl": "info" }                      //   lvl - info|warn|error (опц.; иное значение отбрасывается)
  ]
}
```

**Ответ `201 Created`:**

```json
{
  "id": "a7Bk9Q",
  "url": "http://localhost:8787/a7Bk9Q",
  "rawUrl": "http://localhost:8787/a7Bk9Q/raw",
  "expiresAt": "2026-06-26T09:30:00Z"
}
```

**Коды ошибок (тело `{ "error": "<code>", "message": "<text>" }`):**

| Код | Когда |
|-----|-------|
| `400 bad_request` | невалидный JSON, отсутствует обязательное поле, неверный enum |
| `401 unauthorized` | игра требует токен, а он не передан |
| `403 forbidden` | неверный токен или `appId` не зарегистрирован/выключен |
| `413 payload_too_large` | превышен лимит размера (см. лимиты) |
| `415 unsupported_media_type` | `Content-Type` не `application/json` |
| `429 too_many_requests` | rate limit; заголовок `Retry-After` |
| `500 internal_error` | ошибка сервера |

---

## 1b. Files - отправка произвольного файла (SendFile / SendFolder)

Отдельный эндпоинт для выгрузки **произвольного файла или папки** (папка зипуется **на клиенте** в один `.zip`) и получения короткой ссылки - как у отчёта. Это **НЕ** часть лог-отчёта: отдельный `POST /api/files`, отдельный (больший) лимит тела.

### `POST /api/files`

**Заголовки запроса:**
- `Content-Type: application/json` (обязательно)
- `Authorization: Bearer <ingest_token>` (те же правила авторизации, что у `/api/logs`: per-app токен / общий team-токен / auto-register)

**Тело (JSON):**

```jsonc
{
  "appId": "lfa",                  // ОБЯЗ. [a-z0-9_-]{2,32}
  "platform": "Windows",           // ОБЯЗ. тот же enum, что у /api/logs
  "appVersion": "1.4.2 (build 318)", // ОБЯЗ. строка версии
  "name": "save_slot_3.zip",       // ОБЯЗ. имя файла (сервер берёт только basename; путь обрезается)
  "mime": "application/zip",       // ОПЦ. MIME-тип; по умолчанию отдаётся application/octet-stream
  "fileBase64": "UEsDBBQ...",      // ОБЯЗ. содержимое файла в base64 (БЕЗ префикса "data:")
  "kind": "save",                  // ОПЦ. file|folder|save|screenshot|archive|other (иное -> null)
  "logId": "a7Bk9Q",               // ОПЦ. привязка к логу: файл появится в attachments[] этого лога
  "groupId": "session-42",         // ОПЦ. групповая метка (несколько файлов одной операции)
  "title": "Save before crash",    // ОПЦ. <=120 символов
  "tester": "Alex",                // ОПЦ. <=120 символов
  "retentionDays": 14              // ОПЦ. clamp(1, app.maxRetentionDays)
}
```

**Ответ `201 Created`:**

```json
{
  "id": "K3p9Zx",
  "url": "http://localhost:8787/files/K3p9Zx",
  "downloadUrl": "http://localhost:8787/files/K3p9Zx/download",
  "expiresAt": "2026-06-26T09:30:00Z"
}
```

**Просмотр / скачивание:**

| Endpoint | Назначение |
|----------|-----------|
| `GET /files/<id>` | лёгкий HTML: имя, размер, кнопка **Download** (кейс «выгрузить сейв разработчику») |
| `GET /files/<id>/download` | сам блоб; `Content-Disposition: attachment` с корректным именем, `Content-Type` из `mime` |

Файл, привязанный по `logId`, дополнительно появляется в `attachments[]` ответа `GET /api/logs/<id>` и в панели **Attachments** вьюера лога (`downloadUrl` - относительный).

**Коды ошибок** - те же, что у `/api/logs`:

| Код | Когда |
|-----|-------|
| `400 bad_request` | невалидный JSON, нет `appId`/`platform`/`appVersion`/`name`/`fileBase64`, неверный enum, пустой декод base64 |
| `401 unauthorized` | игра требует токен, а он не передан |
| `403 forbidden` | неверный токен или `appId` не зарегистрирован/выключен |
| `413 payload_too_large` | размер **распакованного** блоба превышает `MAX_FILE_BYTES`, либо тело запроса больше лимита чтения |
| `415 unsupported_media_type` | `Content-Type` не `application/json` |
| `429 too_many_requests` | rate limit; заголовок `Retry-After` |
| `500 internal_error` | ошибка сервера |

**Инварианты Files:**
- Кап - по **DECODED**-размеру: `MAX_FILE_BYTES` (по умолчанию 25 MB). Проверяется и на клиенте (до отправки), и на сервере. У `/api/files` **отдельный больший лимит чтения тела** (`MAX_FILE_BODY_BYTES`, по умолчанию `MAX_FILE_BYTES`*4/3 + запас на JSON), **не** общий `MAX_PAYLOAD` (8 MB).
- **PII-скраб к бинарю НЕ применяется**: блоб хранится и отдаётся **байт-в-байт**, без чистки и без перекодирования (в т.ч. без gzip). Единственная защита - размерный кап. Скраб (см. §7.9) действует только для текстов лога/`context`/`breadcrumbs`.
- Папка зипуется **на клиенте** (Unity: `ZipArchive` в `MemoryStream`; GameMaker: zip-store буфера) - сервер получает один обычный файл.
- Ретеншн - **как у логов**: `expiresAt` по `retentionDays` (clamp по `app.maxRetentionDays`), pin продлевает, sweeper удаляет просроченные непиннутые (блоб - до строки). Несуществующий/просроченный/невалидный `id` -> единый `404`.

---

## 2. Просмотр

| Endpoint | Назначение |
|----------|-----------|
| `GET /<id>` | HTML-вьюер: device-info (сворачиваемые группы), счётчики E/W/L, фильтр по уровню, поиск, сворачивание стектрейсов, raw/pretty, copy, скриншот, кнопка «сохранить (pin)» |
| `GET /<id>/raw` | `text/plain` - сырой лог. `?download=1` → `attachment`. При `Accept-Encoding: gzip` отдаётся `.log.gz` без распаковки |
| `GET /<id>/screenshot` | `image/png` - первый скриншот (индекс 0; 404 если нет) |
| `GET /<id>/screenshot/<n>` | `image/png` - n-й скриншот (0-based; 404 если индекс вне диапазона) |
| `GET /api/logs/<id>` | JSON-данные для вьюера (вкл. `screenshotCount` и массив `screenshots`) |

Несуществующий / просроченный / невалидный `id` → **единый `404`** (анти-перебор).

---

## 3. Каталог (хранилище ссылок) - `PlayJoy → Project → version → Log`

Команда листает все логи; **доступ командный** (viewer-токен / Basic / admin).

| Endpoint | Возвращает |
|----------|-----------|
| `GET /browse` | список Project (`appId` + отображаемое имя) |
| `GET /browse/<appId>` | список версий (`appVersion`) с количеством записей |
| `GET /browse/<appId>?session=<sessionId>` | записи ОДНОЙ сессии (все логи одного запуска), новые сверху |
| `GET /browse/<appId>/<version>` | записи: `id, title, time, platform, counts, pinned, sessionId, folder` |
| `GET /browse/<appId>/<version>?folder=<path>` | те же записи, но только из папки `<path>` (пустой `folder=` -> корень) |
| `GET /api/search?appId=<id>&q=<query>[&version=<v>]` | полнотекстовый поиск по логам приложения |
| `GET /api/folders?appId=<id>` | список папок проекта (для каталога) |
| `POST /api/folders/move` | переложить выбранные логи в папку (вручную в каталоге) |

Маппинг: **PlayJoy** = инстанс сервера · **Project** = `appId` · **version** = `appVersion` · **Log** = `id`.

Все endpoints каталога (вкл. `?session=`, `/api/search` и `/api/folders`) под тем же viewer-доступом: `Authorization: Bearer <viewer|admin>` или `?token=<...>`. Без токена -> `401`.

**Алиасы appId (переименование проекта).** Проект можно переименовать (сменить `appId`/slug и/или отображаемое имя) admin-скриптом `node scripts/rename-app.js <oldAppId> <newAppId> ["New Name"]`. **Старый `appId` продолжает работать**: ingest под старым slug попадает в новый проект; `GET /browse/<старый>`, `GET /browse/<старый>/<version>`, `GET /api/search?appId=<старый>` и `GET /api/folders?appId=<старый>` резолвятся в канонический (новый) проект. При переименовании логи и файлы перекеиваются на новый `app_id`, **`id` логов не меняется** (ссылки `/<id>` от `appId` не зависят и продолжают работать), блобы на диске не трогаются. Старый slug сохраняется как alias; цепочка переименований (a->b->c) - все исторические slug резолвятся в текущий канонический. Неизвестный/несуществующий slug -> `404`/`403` как раньше.

### 3a. Полнотекстовый поиск - `GET /api/search`

Поиск по логам одного приложения (только JSON; каталожная страница вызывает его сама).

**Query-параметры:**
- `appId` (ОБЯЗ.) - идентификатор игры;
- `q` (ОБЯЗ.) - запрос; разбивается на слова, слова AND-ятся; завершающая `*` в слове = префиксный поиск (`Null*`). Спецсинтаксис FTS5 (column-filter, NEAR, кавычки) экранируется - инъекция в `MATCH` невозможна, кривой запрос не даёт `500` (просто пустой результат);
- `version` (ОПЦ.) - точная версия для доп. фильтрации результата;
- `token` (ОПЦ. в query) - viewer-токен, если не передан в заголовке.

**Индексируется:** `title`, `tester`, `comment`, значения `context`, `sceneContext` и сам текст лога (`logText`). Движок - SQLite FTS5 (contentless: сам текст не дублируется на диске). Логи, созданные до появления поиска, до-индексируются лениво (батчем на запрос) и/или скриптом `npm run backfill-fts`.

**Ответ `200`:**

```json
{
  "appId": "lfa", "query": "null reference", "version": null, "count": 2,
  "results": [
    { "id": "a7Bk9Q", "title": "Crash on level load", "time": "2026-06-12T09:30:00Z",
      "platform": "WebGL", "counts": { "error": 3, "warn": 12, "log": 540 },
      "version": "1.4.2 (build 318)", "sessionId": "a3f1c9e2-...",
      "snippet": "NullReferenceException at PlayerController.Update ..." }
  ]
}
```

| Код | Когда |
|-----|-------|
| `400 bad_request` | не передан `appId` |
| `401 unauthorized` | нет/неверный viewer-токен |
| `404 not_found` | `appId` не зарегистрирован |
| `503 search_unavailable` | сборка SQLite без FTS5 (поиск отключён) |

### 3b. Сессии - `GET /browse/<appId>?session=<sessionId>`

Все логи одного запуска (по `sessionId` из ingest), новые сверху, только живые (pinned либо не просроченные). Ответ - как у списка логов версии: `{ appId, name, sessionId, logs: [...] }`, где каждый элемент - каталожная запись (вкл. `version` и `sessionId`). Несуществующая сессия -> пустой `logs` (не ошибка). `GET /api/logs/<id>` отдаёт `sessionId` (или `null`).

### 3c. Папки логов - ручная организация в каталоге

У лога есть опциональное поле `folder` - путь-строка с вложенностью через `/` (например `Release/QA`). Корень = отсутствие папки (`folder = null`). Папки **не задаются клиентом/ingest** - их назначают вручную во вьюере-каталоге (см. ниже), чтобы команда могла раскладывать логи проекта по папкам. Папка существует, пока в ней есть хотя бы один лог (создаётся неявно при перекладывании первого лога, исчезает, когда последний лог из неё ушёл). Поле `folder` присутствует в каталожной записи (`GET /browse/<appId>/<version>`) и в `GET /api/logs/<id>` (или `null`).

**`GET /api/folders?appId=<id>`** (viewer-доступ) -> `{ "appId": "<канонический>", "folders": ["Release/QA", "Investigating", ...] }` - различные непустые пути папок проекта по алфавиту (корень неявный, в списке не показывается). `appId` резолвится через алиасы.

**`POST /api/folders/move`** (viewer-доступ) - переложить выборку логов в папку.

```jsonc
{
  "appId": "lfa",                 // ОБЯЗ. (резолвится через алиасы)
  "ids": ["a7Bk9Q", "K3p9Zx"],    // ОБЯЗ. непустой массив id логов (макс. FOLDER_MOVE_MAX_IDS)
  "folder": "Release/QA"          // ОПЦ. путь папки; пусто/blank/null -> корень
}
```

Ответ `200`: `{ "appId": "<канонический>", "folder": "Release/QA"|null, "moved": <int> }`. `moved` - сколько строк реально сменили папку: id, не принадлежащие этому проекту (или несуществующие), молча пропускаются (move изолирован по `app_id`). Токен передаётся `Authorization: Bearer <viewer|admin>` или `?token=`.

**Валидация `folder`:** слэши нормализуются (`\` -> `/`, повторные `/` схлопываются, сегменты тримятся, пустые отбрасываются), затем проверяются ограничения - глубина (`FOLDER_MAX_DEPTH`, по умолчанию 8), длина пути (`FOLDER_MAX_LEN`, 200) и сегмента (`FOLDER_SEGMENT_MAX_LEN`, 60). Запрещены сегменты `.`/`..` (traversal) и управляющие символы -> `400 bad_request`. Пустой путь -> корень (всегда валиден).

| Код | Когда |
|-----|-------|
| `400 bad_request` | нет `appId`/`ids`, пустой `ids`, слишком много id, невалидный `folder` (traversal/контрол-символы/слишком длинно/глубоко) |
| `401 unauthorized` | нет/неверный viewer-токен |
| `404 not_found` | `appId` не зарегистрирован (и не алиас) |
| `413 payload_too_large` | тело запроса больше лимита чтения |

---

## 4. Pin (сохранить дольше срока)

### `POST /api/logs/<id>/pin` - тело `{ "pin": true|false }`
- `pin:true` → `expiresAt=null`, `pinned=true`. **Открыто по ссылке** (тестеру удобно).
- `pin:false` (unpin) и удаление - **только admin-токен**.

---

## 5. Форвардинг ссылок (sinks) - конфиг сервера

На успешный ingest сервер **асинхронно** (не блокируя ответ) шлёт в настроенные назначения payload:

```json
{ "project": "lfa", "projectName": "Looking For Aliens", "version": "1.4.2 (build 318)",
  "platform": "WebGL", "url": "http://localhost:8787/a7Bk9Q",
  "title": "Crash on level load", "counts": { "error": 3, "warn": 12, "log": 540 },
  "time": "2026-06-12T09:30:00Z" }
```

Типы sink: `webhook` (generic, шаблонизируемый payload + заголовки), пресеты `slack` / `discord` / `confluence` / `googlesheet`. Конфиг: `config/sinks.json` (глобально) + `apps.sinks_json` (per-game override). Фильтры (напр. только при `error>0`). Ошибки sink не валят ingest (ретраи + логирование).

---

## 6. Лимиты (значения по умолчанию, настраиваемы)

| Параметр | Значение |
|----------|----------|
| Размер тела запроса (nginx `client_max_body_size`) | 10 MB |
| `MAX_PAYLOAD` (приложение) | ~8 MB |
| `MAX_SCREENSHOT` (PNG) | ~2 MB |
| `MAX_SCREENSHOTS` (скриншотов на отчёт) | 8 |
| `MAX_LOG_BYTES` (распакованный лог) | ~20 MB |
| `MAX_FILE_BYTES` (распакованный блоб `/api/files`) | ~25 MB |
| `MAX_FILE_BODY_BYTES` (лимит тела `/api/files`) | `MAX_FILE_BYTES`*4/3 + запас (~34 MB) |
| Ретеншн по умолчанию | 30 дней |
| Ретеншн максимум | 365 дней |
| Rate limit | per `ip_hash` и per `appId` (→ `429 + Retry-After`) |

---

## 7. Инварианты для клиентов (Unity / GameMaker / прочие)

1. `screenshotPng` / `screenshotsPng[]` - **чистый base64 PNG без** `data:` префикса (один или массив; сервер берёт оба, кап `MAX_SCREENSHOTS`).
2. `counts` - всего за сессию; `logText` усечён по `MAX_LOG_BYTES` с пометкой об усечении.
3. Пустые/недоступные поля `device` - **опускать**, а не слать `null`/`0`.
4. На **WebGL**: `logEncoding=plain` (без gzip тела - preflight/CORS), отправка только через корутину, copy/open ссылки - синхронно из обработчика клика (user-gesture).
5. На **iOS**: endpoint только `https://` (ATS).
6. На **консольном ритейле**: клиент полностью отключён/вырезан (см. план: Unity `#if UNITY_EDITOR || DEVELOPMENT_BUILD`, GameMaker `LFA_ENABLED`).
7. `timestampUtc` - строго UTC ISO-8601.
8. `context` / `breadcrumbs` - **опциональны**; пустые НЕ слать (не слать `{}` / `[]`). Это объект `string->string` и массив объектов соответственно. Сервер обрезает по капам (`context` ~4KB / ключ<=64 / значение<=512; `breadcrumbs` 100 шт / ~16KB), приводит значения к строкам и игнорирует невалидный тип (не валит запрос). Поэтому клиент не обязан сам дублировать капы, но **должен** держать локальный кольцевой буфер крошек разумного размера.
9. **Приватность по умолчанию**: PII-чистка (email, IPv4/IPv6, Bearer/Authorization-токены, длинные цифровые последовательности -> `[redacted]`) применяется клиентом к `logText`, значениям `context` и текстам `breadcrumbs` ДО отправки; чувствительные поля устройства/URL/идентификаторы по умолчанию не шлются. IP тестера клиент не шлёт (сервер хеширует соль+sha256). Всё это переключаемо в настройках клиента (включить отправку чувствительного / выключить чистку).
10. **Провенанс отправки** (`sentViaCode` / `callerFile` / `callerLine`): при отправке из КОДА игры клиент шлёт `sentViaCode=true` и место вызова (`callerFile`+`callerLine`) для бейджа во вьюере; при отправке кнопкой «Send» в оверлее эти поля опускаются (сервер трактует отсутствие `sentViaCode` как `false`). `tester` (имя тестера) **обязателен на РУЧНОЙ оверлей-отправке**: оверлей блокирует «Send», пока не введено непустое (после trim) имя; на code-send `tester` опционален.
