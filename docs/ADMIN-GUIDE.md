# FastLogs - руководство админа / девопса

Как развернуть сервер FastLogs, зарегистрировать игру, настроить уведомления (sinks), ретеншн, бэкап и безопасность. Пользовательская часть (для разработчика и тестера) - в [`TEAM-GUIDE.md`](TEAM-GUIDE.md).

Источники правды:

- Установка - [`../server/deploy/INSTALL.md`](../server/deploy/INSTALL.md) (generic, любой VPS/Docker)
- PlayJoy-специфика и ротация ключей - [`../server/deploy/DEPLOY-playjoy.md`](../server/deploy/DEPLOY-playjoy.md)
- Сервер - [`../server/README.md`](../server/README.md)
- Контракт API - [`../CONTRACT.md`](../CONTRACT.md)

Сервер - Node.js (>= 18) и SQLite (`better-sqlite3`) за nginx. Зависимостей минимум, дефолты нейтральные (`BASE_URL=http://localhost:8787`), лицензия MIT, так что инстанс переносится под свой домен без правок кода.

---

## 1. Развернуть сервер

### Вариант A. Docker (быстрее всего)

```bash
cd server
cp .env.example .env          # задать BASE_URL, ADMIN_TOKEN, VIEWER_TOKEN, IP_SALT и т.д.
docker compose up -d          # билдит образ, монтирует ./data и ./blobs, слушает 8787
# Зарегистрировать игру внутри контейнера:
docker compose exec fastlogs node scripts/add-app.js mygame "My Game" 30
```

### Вариант B. systemd / VPS (кратко по INSTALL.md)

Предусловия: Linux с systemd, Node >= 18, nginx, certbot. Сжатая последовательность (полностью - в [`../server/deploy/INSTALL.md`](../server/deploy/INSTALL.md)):

1. Системный пользователь `fastlogs` (`/var/lib/fastlogs`, `chmod 700`).
2. Deploy-пользователь (SSH-only, без root; sudo строго на `systemctl restart fastlogsd` и запуск node/npm от `fastlogs`).
3. Каталоги `app` / `data` / `blobs` под `/var/lib/fastlogs`, владелец `fastlogs`.
4. Синхронизировать `server/` в `/var/lib/fastlogs/app/server`, затем `npm ci --omit=dev`.
5. Конфиг `/etc/fastlogs/fastlogs.env` (`chmod 640`, `root:fastlogs`): заполнить `ADMIN_TOKEN`, `VIEWER_TOKEN`, `IP_SALT`, `BASE_URL=https://<домен>`; `DATA_DIR`/`BLOB_DIR` указать на `/var/lib/fastlogs/{data,blobs}`.
6. systemd-юниты: `fastlogsd.service`, `fastlogs-sweeper.service`, `fastlogs-sweeper.timer` -> `daemon-reload`, `enable --now`.
7. nginx reverse proxy (`nginx-fastlogs.conf`, `client_max_body_size 10M`), `nginx -t && reload`.
8. TLS: `certbot --nginx -d <домен>`.
9. DNS: A-запись `<домен> -> <IP сервера>`.

Последующие деплои - `./deploy/deploy.sh user@host` (rsync исходников, `npm ci --omit=dev`, миграции, рестарт `fastlogsd.service`).

### Ключевые переменные `.env`

| Переменная | Дефолт | Назначение |
|------------|--------|-----------|
| `PORT` | `8787` | порт Node (nginx проксирует сюда) |
| `BASE_URL` | `http://localhost:8787` | публичный URL для коротких ссылок - **обязательно сменить в проде** |
| `ADMIN_TOKEN` | _(пусто)_ | админ-токен: unpin, удаление, управление |
| `VIEWER_TOKEN` | _(пусто)_ | командный токен на чтение каталога `/browse` |
| `IP_SALT` | `change-me-please` | соль для хеширования IP - **поставить случайное значение** |
| `TRUST_PROXY` | `1` | доверять `X-Forwarded-For`/`X-Real-IP` от nginx; `0` только если Node открыт напрямую |
| `DATA_DIR` / `BLOB_DIR` | `./data` / `./blobs` | SQLite-БД и blob'ы (лог-тела + PNG) |
| `DEFAULT_RETENTION_DAYS` | `30` | ретеншн по умолчанию для новых логов |
| `MAX_RETENTION_DAYS` | `365` | жёсткий потолок ретеншна (clamp per-app и per-request) |
| `MAX_PAYLOAD_BYTES` | `8388608` | макс. размер тела (~8 MB) |
| `MAX_SCREENSHOT_BYTES` | `2097152` | макс. PNG (~2 MB) |
| `MAX_LOG_BYTES` | `20971520` | макс. распакованный лог (~20 MB) |
| `CORS_ALLOW_ORIGIN` | `*` | разрешённый origin (для WebGL) |

> Пустые `ADMIN_TOKEN` / `VIEWER_TOKEN` отключают соответствующую авторизацию - допустимо только в dev. В проде задавайте оба.

### Проверка после деплоя

`GET /api/health` (health-check) и сквозной ingest тестовым приложением. Тесты сервера - `npm test` (см. оговорку в `server/README.md`: запускать именно `npm test`, не `node --test test/`).

---

## 2. Зарегистрировать игру и выдать токен

Каждая игра (`appId`) регистрируется на сервере; при регистрации генерируется ingest-токен.

```bash
# С токеном (печатается ОДИН раз):
npm run add-app -- mygame "My Game Title" 30
# Без токена (открытый ingest):
npm run add-app -- mygame "My Game Title" --no-token
# Свой потолок ретеншна:
npm run add-app -- mygame "My Game Title" 14 --max-retention 90
# Напрямую (systemd-деплой):
sudo -u fastlogs node /var/lib/fastlogs/app/server/scripts/add-app.js mygame "My Game" 30
```

Аргументы и флаги (`scripts/add-app.js`):

| Аргумент / флаг | Значение |
|-----------------|----------|
| `<appId>` | обяз., `[a-z0-9_-]{2,32}` - это Project в каталоге |
| `"<name>"` | обяз., отображаемое имя |
| `[retentionDays]` | опц., дефолт = `DEFAULT_RETENTION_DAYS`, clamp до `maxRetentionDays` |
| `--max-retention N` | потолок ретеншна для этой игры |
| `--no-token` | открытый ingest (без токена) |
| `--keep-token` | при обновлении сохранить текущий токен |
| `--disabled` | зарегистрировать выключенной (`enabled=0`) |
| `--token <value>` | задать конкретный токен (всё равно хранится только хеш) |

Токен показывается один раз на stdout - в БД лежит только его sha256-хеш, восстановить нельзя. Передавайте его клиенту через защищённый канал (CI-secret, 1Password), не коммитьте в репозиторий. Клиент шлёт токен как `Authorization: Bearer <token>`: в Unity это поле `Config > Server > Token`, в GameMaker - макрос `FASTLOGS_TOKEN`. Повторный `add-app` для существующего `appId` обновляет запись и по умолчанию выпускает новый токен (старый перестаёт работать); сохранить старый - `--keep-token`.

Список приложений - `node scripts/list-apps.js`.

---

## 3. Настроить sinks (форвардинг ссылок)

На каждый успешный ingest сервер асинхронно (не блокируя ответ) шлёт компактный payload в настроенные назначения. Payload (см. `CONTRACT.md`, раздел 5): `project, projectName, version, platform, url, title, counts, time`.

Конфиг: глобально `config/sinks.json` (скопировать из `config/sinks.example.json`), плюс per-game override в `apps.sinks_json`. Per-app sinks добавляются к глобальному списку.

```bash
cp server/config/sinks.example.json server/config/sinks.json
# Вписать реальные webhook-URL / токены. Без реальных секретов в репозитории.
```

Каждый sink: `{ type, name?, enabled?, filter?, ...поля типа }`.

| Тип | Ключевые поля | Назначение |
|-----|---------------|-----------|
| `slack` | `url` (webhook), `username`, `iconEmoji`, `mentionOnError` | сообщение в Slack-канал |
| `discord` | `url` (webhook), `username`, `mentionOnError` | сообщение в Discord-канал |
| `webhook` | `url`, `method`, `headers`, `bodyTemplate` (шаблоны `{{project}}`, `{{url}}`, `{{counts.error}}`, `{{json}}`, ...), `retries`, `timeoutMs` | generic-вебхук с шаблонизируемым телом |
| `confluence` | `mode: "webhook"`, `url` (Atlassian automation hook) | запись в Confluence через automation |
| `googlesheet` | `url` (Apps Script `/exec`), `secret` | строка в Google-таблицу |

Фильтры (`filter`) - чтобы слать не на всё подряд: `errorOnly`, `minError`, `minWarn`, `platforms` / `excludePlatforms`, `apps`. Пример - только при ошибках в QA-канал:

```json
{ "type": "slack", "name": "qa-channel", "enabled": true,
  "filter": { "errorOnly": true },
  "url": "https://hooks.slack.com/services/REPLACE/WITH/REAL",
  "username": "FastLogs", "iconEmoji": ":rotating_light:", "mentionOnError": "<!here>" }
```

Ошибки sink **не валят ingest** (ретраи + логирование). Файл может быть голым массивом или обёрткой `{ "sinks": [...] }`.

---

## 4. Ретеншн и очистка

- Срок по умолчанию - `DEFAULT_RETENTION_DAYS` (30). Потолок - `MAX_RETENTION_DAYS` (365); per-app и per-request значения зажимаются `clamp(1, maxRetentionDays)`.
- Per-game срок - аргумент `retentionDays` в `add-app` (и `--max-retention`). Per-request override - клиент шлёт `retentionDays` (Unity `RetentionDaysOverride`, GameMaker `FASTLOGS_RETENTION_DAYS`).
- Удаление просроченных - sweeper: `npm run sweep` (вызывается из cron / systemd-таймера `fastlogs-sweeper.timer`).
- Pin: `POST /api/logs/<id>/pin` с `{ "pin": true }` ставит `expiresAt=null` (запись не удаляется); pin открыт по ссылке (удобно тестеру). Unpin (`pin:false`) и удаление - только под admin-токеном.

---

## 5. Бэкап

Состояние хранится в двух местах (вне webroot):

- `DATA_DIR` (по умолчанию `/var/lib/fastlogs/data`) - SQLite-БД (приложения, метаданные логов, токены-хеши, pin-флаги).
- `BLOB_DIR` (по умолчанию `/var/lib/fastlogs/blobs`) - тела логов (gzip) и PNG-скриншоты.

Бэкап = снимок обоих каталогов. Для консистентности SQLite либо останавливайте `fastlogsd` на время копирования, либо используйте `sqlite3 .backup` / VACUUM INTO на файле БД, затем копируйте `blobs`. Конкретная процедура расписания/хранилища бэкапов в репозитории не задана - **уточнить** под вашу инфраструктуру (cron + offsite-копия).

---

## 6. Безопасность

Секреты (`ADMIN_TOKEN`, `VIEWER_TOKEN`, `IP_SALT`, ingest-токены, ключи деплоя) держите только в `/etc/fastlogs/fastlogs.env` и защищённых хранилищах, никогда в репозитории (см. `.gitignore`). Токены игр хранятся как sha256-хеш и раздаются клиентам через CI-secret или 1Password; ротация - повторный `add-app` (новый токен, старый умирает), затем обновить конфиг клиента. `IP_SALT` должен быть случайным, иначе хеши IP перестают быть необратимыми.

Доступ к каталогу `/browse` - под viewer-токеном (team), удаление и unpin - под admin-токеном. Логи и скриншоты могут содержать персональные данные, поэтому короткие ссылки непубличные, на невалидный id отдаётся единый `404` (анти-перебор), ретеншн ограничен.

Ротация ключа деплоя (засвечен старый `dossh` root-ключ) - обязательная процедура, пошагово расписана в [`../server/deploy/DEPLOY-playjoy.md`](../server/deploy/DEPLOY-playjoy.md): unprivileged deploy-пользователь со scoped sudo, новый ed25519-ключ с passphrase, установка публичного ключа, проверка, удаление старого root-ключа, `PermitRootLogin prohibit-password`. Там же - PlayJoy-прод (домен `fastlogs.playjoystudios.com`, дроплет `134.122.49.207`) и миграция со старого `UnityWebServer`. Деплой в прод - только после явного sign-off владельца сервиса.
