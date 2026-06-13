# FastLogs - статус развёртывания и что нужно от тебя

Документ описывает, что уже сделано автоматически, и пошаговый гайд по шагам, которые требуют твоего участия (доступы/решения/редакторы). Без таких шагов публичный https-эндпоинт не заработает.

## Что уже сделано автоматически

- Сервер FastLogs развёрнут на дроплете `134.122.49.207` как Docker-контейнер по конвенции (образ `fastlogs-server`, node:22-slim - обходит старый glibc Ubuntu 18.04).
  - Каталог: `/opt/fastlogs` (код + `.env` + тома `data/`, `blobs/`).
  - Слушает только `127.0.0.1:8787` (наружу не торчит, проксируется через host-nginx).
  - Секреты сгенерированы на сервере и лежат в `/opt/fastlogs/.env` (chmod 600): `ADMIN_TOKEN`, `VIEWER_TOKEN`, `IP_SALT`. Ретеншн 30 дней, CORS `*`, `TRUST_PROXY=1`.
  - Зарегистрирована игра `terraformers` (ingest-токен выдаётся при регистрации, см. вывод/`.env`-заметку; хранить как секрет).
- Добавлен nginx-сайт `fastlogs.playjoystudios.com` (HTTP) -> проксирует на контейнер. TLS пока нет (нужен DNS, см. ниже).
- Локальный git-репозиторий закоммичен (`E:\Repositories\fastlogs`), `gh` (GitHub CLI) установлен.

## Шаг 1 (нужен ты) - DNS A-запись -> публичный https

Это единственное, что блокирует рабочий https-эндпоинт. Я не могу менять DNS (это у регистратора/DNS-провайдера домена `playjoystudios.com`).

1. Зайди в панель DNS-провайдера зоны `playjoystudios.com` (там же, где заведены `lookingforaliens`, `pixelsjoy` и т.д.).
2. Добавь запись:
   - Тип: `A`
   - Имя/Host: `fastlogs`
   - Значение/IP: `134.122.49.207`
   - TTL: по умолчанию.
3. Дождись пропагации (обычно минуты, иногда до часа). Проверка: `nslookup fastlogs.playjoystudios.com` должен вернуть `134.122.49.207`.

Как только запись зарезолвится - скажи мне (или просто напиши "dns готов"), и я **автоматически**:
- выпущу TLS-сертификат: `certbot --nginx -d fastlogs.playjoystudios.com` (certbot на сервере уже есть),
- проверю `https://fastlogs.playjoystudios.com/api/health`,
- пришлю финальный эндпоинт + ingest-токен для клиента.

(Если предпочитаешь путь без DNS - можно повесить на путь существующего домена, напр. `https://lookingforaliens.playjoystudios.com/fl/`. Скажи - переключу.)

## Шаг 2 (можно я, нужен твой вход) - GitHub репозиторий AitiX/Fastlogs

`gh` установлен, но не авторизован. Два варианта:

- Вариант A (проще): сам создай **пустой private** репозиторий `github.com/AitiX/Fastlogs` (без README/gitignore/license). Затем скажи мне - я добавлю remote и запушу (Git Credential Manager должен подхватить твою авторизацию; если всплывёт окно входа - подтверди).
- Вариант B: выполни в терминале `gh auth login` (GitHub.com -> HTTPS -> Login with a web browser), пройди вход. После этого я сам создам репо и запушу: `gh repo create AitiX/Fastlogs --private --source . --push`.

После пуша в Common (`EditorTools`) добавлю только ссылку (git-dependency для Unity), без копии кода.

## Шаг 3 (по конвенции) - nginx-конфиг в git-репо

По вики (страница "Server") nginx-конфиги версионируются в `git.playjoystudios.com/PlayJoy/nginx_playjoystudios_com` (ссылка с вики отдала 404 - проверь точный путь/доступ). Я добавил рабочий конфиг напрямую в `/etc/nginx/sites-available/fastlogs.conf`, но для соблюдения конвенции его стоит закоммитить в этот репо. Готовый конфиг лежит в репозитории FastLogs: `server/deploy/nginx-fastlogs.conf` (плюс актуальная HTTP-версия теперь на сервере). Дай точный URL репо - и я подгоню/добавлю конфиг туда по образцу соседних сервисов.

## Шаг 4 (безопасность, СРОЧНО, требует координации) - ротация ключа dossh

`D:\Other\UnityWebServer\dossh` - это приватный **root-ключ** к серверу в открытом виде, он засвечен. Сервер общий, и у `root` сейчас **12 SSH-ключей** (часть наверняка чужие/сервисные), `PermitRootLogin yes`. Удалять ключи и менять sshd в одиночку опасно - можно отрезать доступ другим. Поэтому сделай по согласованию с тем, кто админит сервер:

1. Сгенерировать новый ключ для деплоя (с парольной фразой):
   `ssh-keygen -t ed25519 -f deploy_fastlogs -C deploy-fastlogs`
2. Завести отдельного deploy-юзера (без root) и положить туда новый публичный ключ; узкий sudo только на нужные docker/systemctl команды.
3. Найти в `/root/.ssh/authorized_keys` запись, соответствующую `dossh` (комментарий ключа `alex`), и удалить именно её (не трогая остальные 11).
4. По возможности `PermitRootLogin prohibit-password` (согласовать - вдруг кто-то ходит под root по паролю/ключу).
5. Удалить `D:\Other\UnityWebServer\dossh` из рабочих копий; считать ключ скомпрометированным навсегда.

Если хочешь - подготовлю точные команды под вашу конкретную раскладку, но выполнять их на общем сервере лучше тебе/админу.

## Шаг 5 (нужен ты) - проверка компиляции клиентов

Stub-компиляция (dotnet с Unity-заглушками) прошла с 0 ошибок, но живую проверку лучше сделать в редакторах:

- Unity: открой `LookingForAliens` в Unity 6000.1.17f1 - я заведу `RecompileBridge`, вложу пакет `com.playjoy.fastlogs` и проверю компиляцию в редакторе.
- GameMaker: открой `gamemaker/FastLogsGM.yyp` в GMS2 2024.x (см. `gamemaker/IMPORT.md`), собери debug-конфиг, экспортируй `.yymps` для раздачи.

## Шаг 6 - подключить Terraformers к серверу (после Шага 1)

Когда https заработает:
- Unity (Terraformers): в `FastLogsConfig` -> `EndpointUrl = https://fastlogs.playjoystudios.com`, `AppId = terraformers`, `Token = <ingest-токен terraformers>`. Запись по умолчанию выкл - включается `FastLogs.StartRecording()` / `RecordScope` / `AutoStartRecording`.
- Каталог логов команды: `https://fastlogs.playjoystudios.com/browse` (с `VIEWER_TOKEN` из `/opt/fastlogs/.env`).

## Полезные команды на сервере (для тебя/админа)

```bash
cd /opt/fastlogs
docker compose ps                  # статус
docker compose logs --tail=50 fastlogs
docker compose restart fastlogs
cat .env                           # секреты (ADMIN/VIEWER/IP_SALT)
docker compose exec -T fastlogs node scripts/list-apps.js     # список игр
docker compose exec -T fastlogs node scripts/add-app.js <id> "<Name>" 30   # новая игра + токен
```
