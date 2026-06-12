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

  "screenshotPng": "iVBORw0KGgo...",       // ОПЦ. base64 PNG БЕЗ префикса "data:"; присылается только если включён тоггл
  "retentionDays": 14,                     // ОПЦ. per-request override; сервер делает clamp(1, app.maxRetentionDays)
  "title": "Crash on level load"           // ОПЦ. <=120 символов - заголовок записи в каталоге/вьюере
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

## 2. Просмотр

| Endpoint | Назначение |
|----------|-----------|
| `GET /<id>` | HTML-вьюер: device-info (сворачиваемые группы), счётчики E/W/L, фильтр по уровню, поиск, сворачивание стектрейсов, raw/pretty, copy, скриншот, кнопка «сохранить (pin)» |
| `GET /<id>/raw` | `text/plain` - сырой лог. `?download=1` → `attachment`. При `Accept-Encoding: gzip` отдаётся `.log.gz` без распаковки |
| `GET /<id>/screenshot` | `image/png` - скриншот (404 если нет) |
| `GET /api/logs/<id>` | JSON-данные для вьюера |

Несуществующий / просроченный / невалидный `id` → **единый `404`** (анти-перебор).

---

## 3. Каталог (хранилище ссылок) - `PlayJoy → Project → version → Log`

Команда листает все логи; **доступ командный** (viewer-токен / Basic / admin).

| Endpoint | Возвращает |
|----------|-----------|
| `GET /browse` | список Project (`appId` + отображаемое имя) |
| `GET /browse/<appId>` | список версий (`appVersion`) с количеством записей |
| `GET /browse/<appId>/<version>` | записи: `id, title, time, platform, counts, pinned` |

Маппинг: **PlayJoy** = инстанс сервера · **Project** = `appId` · **version** = `appVersion` · **Log** = `id`.

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
| `MAX_LOG_BYTES` (распакованный лог) | ~20 MB |
| Ретеншн по умолчанию | 30 дней |
| Ретеншн максимум | 365 дней |
| Rate limit | per `ip_hash` и per `appId` (→ `429 + Retry-After`) |

---

## 7. Инварианты для клиентов (Unity / GameMaker / прочие)

1. `screenshotPng` - **чистый base64 PNG без** `data:` префикса.
2. `counts` - всего за сессию; `logText` усечён по `MAX_LOG_BYTES` с пометкой об усечении.
3. Пустые/недоступные поля `device` - **опускать**, а не слать `null`/`0`.
4. На **WebGL**: `logEncoding=plain` (без gzip тела - preflight/CORS), отправка только через корутину, copy/open ссылки - синхронно из обработчика клика (user-gesture).
5. На **iOS**: endpoint только `https://` (ATS).
6. На **консольном ритейле**: клиент полностью отключён/вырезан (см. план: Unity `#if UNITY_EDITOR || DEVELOPMENT_BUILD`, GameMaker `LFA_ENABLED`).
7. `timestampUtc` - строго UTC ISO-8601.
