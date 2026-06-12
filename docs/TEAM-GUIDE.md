# FastLogs - руководство для команды

Главный гайд по инструменту FastLogs: как им пользоваться разработчику Unity и GameMaker, как смотреть логи и что важно знать про релиз и приватность. Это рекомендация команды "как правильно".

Источники правды (если найдёте расхождение - верьте им, а не этому гайду):

- Контракт API - [`../CONTRACT.md`](../CONTRACT.md)
- Сервер - [`../server/README.md`](../server/README.md), установка - [`../server/deploy/INSTALL.md`](../server/deploy/INSTALL.md)
- Unity - [`../unity/README.md`](../unity/README.md), архитектура - [`../unity/ARCHITECTURE.md`](../unity/ARCHITECTURE.md)
- GameMaker - [`../gamemaker/PUBLIC-API.md`](../gamemaker/PUBLIC-API.md), заметки - [`../gamemaker/GM-NOTES.md`](../gamemaker/GM-NOTES.md)

---

## 1. Что такое FastLogs и зачем

FastLogs - это кросс-движковый диагностический инструмент: из запущенной игры одним жестом отправить рантайм-логи плюс полный диагностический срез устройства (и опционально скриншот) на свой сервер и получить **короткую ссылку** для быстрого просмотра в браузере. Ссылки автоматически складываются в каталог `PlayJoy -> Project -> version -> Log`. Работает на всех платформах (WebGL / веб-порталы, iOS, Android, Standalone) и на нескольких движках (Unity, GameMaker). На консолях в релизе инструмент полностью вырезается, чтобы не мешать сертификации.

### Как это выглядит для тестера

1. Тестер делает жест/нажимает хоткей (по умолчанию `F8`) - открывается **оверлей** со счётчиками ошибок/предупреждений/логов (E/W/L) и тогглом "Скриншот".
2. Жмёт **Отправить**.
3. Получает **короткую ссылку** (она копируется в буфер обмена, во вьюере доступен QR).
4. По ссылке открывается **вьюер** - логи с фильтрами, поиском, device-инфо и (если был включён тоггл) скриншотом.

Команда видит все отправленные логи в каталоге: **PlayJoy** (инстанс сервера) -> **Project** (`appId` игры) -> **version** (версия билда) -> **Log** (конкретная запись).

---

## 2. Архитектура кратко

```
   Игра (клиент)                  Сервер FastLogs                Получатели
   -------------                  ---------------                ----------
  Unity  C#  ----\                                          /--> короткая ссылка
                  >-- POST /api/logs --> ingest --> SQLite --+--> каталог /browse
  GameMaker GML -/        (JSON)         + blobs (лог/PNG)   \--> sinks (Slack/Discord/
                                                                  webhook/Confluence/Sheet)
```

- **Клиент** (Unity или GameMaker) собирает кольцевой буфер логов, диагностический срез устройства и опц. скриншот, формирует JSON строго по [`../CONTRACT.md`](../CONTRACT.md) и шлёт `POST /api/logs`.
- **Сервер** (Node + SQLite за nginx) принимает запрос, сохраняет данные, отдаёт короткую ссылку и кладёт запись в каталог. На каждый успешный ingest асинхронно форвардит компактный payload в настроенные sinks (не блокируя ответ клиенту).
- **Просмотр**: вьюер по ссылке `GET /<id>` и командный каталог `GET /browse`.

Контракт - единый для всех движков. Любой клиент, формирующий запрос по схеме из `CONTRACT.md`, совместим с тем же сервером.

---

## 3. Быстрый старт: Unity

Поддерживаемые версии Unity: **6000.1 (Unity 6)** и **2022.3 LTS**.

### 3.1. Установка пакета

Способ 1 (рекомендуется) - по Git URL. Добавьте в `Packages/manifest.json`:

```jsonc
{
  "dependencies": {
    "com.playjoy.fastlogs": "https://github.com/PlayJoy/fastlogs.git?path=/unity#main"
  }
}
```

Замените URL и ветку на актуальные для вашего репозитория. Суффикс `?path=/unity` указывает Unity Package Manager использовать как корень пакета только подкаталог `unity/`.

Способ 2 (embedded / local) - скопируйте папку `unity/` в `Packages/` вашего проекта и переименуйте в `com.playjoy.fastlogs`. Unity подхватит её сама.

### 3.2. Создание конфига

FastLogs читает настройки из ScriptableObject `FastLogsConfig`, лежащего в любой папке `Resources/` под `Assets/`.

1. Меню `Tools > PlayJoy > FastLogs > Create Config Asset`. Ассет создастся в `Assets/Resources/FastLogsConfig.asset` и выделится в Project.
2. Либо ПКМ в Project -> `Create > PlayJoy > FastLogs > Config`.

Если конфиг в проекте уже есть, команда меню просто подсветит существующий, а не создаст дубль.

### 3.3. Заполнение конфига

Откройте ассет в Inspector. Минимум для отправки - секция `Server`:

| Поле | Что задать |
|------|-----------|
| `EndpointUrl` | Полный URL ингеста, напр. `https://logs.example.com/api/logs`. Без него отправка не работает. |
| `AppId` | Идентификатор проекта `[a-z0-9_-]{2,32}` - по нему логи группируются в каталоге. |
| `Token` | Опциональный Bearer-токен ингеста (если сервер его требует). |
| `RetentionDaysOverride` | Срок хранения в днях для этого клиента. `0` = серверный дефолт. |

Важно: на **iOS** endpoint обязан быть `https://` (App Transport Security). Inspector предупредит, если вписать `http://`.

Остальные секции (`Capture`, `Recording`, `Screenshot`, `Diagnostics`, `Trigger`, `Net`, `UI`, `Enable`) имеют рабочие дефолты - можно не трогать. Полная таблица полей - в [`../unity/README.md`](../unity/README.md).

### 3.4. Инициализация и запись (по умолчанию запись ВЫКЛЮЧЕНА)

Вызовите `FastLogs.Init()` один раз рано в бутстрапе (например, в `Awake` менеджера, который грузится раньше всех). `Init` идемпотентен.

```csharp
using PlayJoy.FastLogs;

// Простейший вариант - грузит Resources/FastLogsConfig автоматически:
FastLogs.Init();

// Или с явным ассетом, назначенным в Inspector:
[SerializeField] private FastLogsConfig _config;
FastLogs.Init(_config);
```

Запись логов в буфер **по умолчанию выключена**. Включить можно тремя способами:

```csharp
// 1) Вручную, командой:
FastLogs.StartRecording();   // начать захват в кольцевой буфер
FastLogs.StopRecording();    // остановить (буфер не очищается)
FastLogs.SetRecording(true); // эквивалент Start/Stop одним вызовом
FastLogs.ClearRecording();   // очистить буфер (счётчики сессии НЕ сбрасываются)

// 2) Только на конкретный участок кода:
using (FastLogs.RecordScope())
{
    DoSomethingImportant();  // всё, что логируется тут, попадёт в буфер
}

// 3) Автостартом: Config > Recording > AutoStartRecording = true
//    (запись включится сразу на Init)
```

Ручные записи в лог (помимо перехвата `Debug.Log`):

```csharp
FastLogs.Log("Checkpoint reached");
FastLogs.Warn("Low memory: " + available + " MB");
FastLogs.Error("Enemy spawner failed to initialize");
FastLogs.Log("Verbose detail", FastLogLevel.Log); // с явным уровнем
```

### 3.5. Отправка отчёта

```csharp
// Fire-and-forget, результат через событие:
FastLogs.OnUploaded += r => Debug.Log("Uploaded: " + r.Url);
FastLogs.SendAsync(includeScreenshot: true, title: "Crash on level load");

// Или await (работает на всех версиях Unity и на WebGL):
var result = await FastLogs.SendAsync(includeScreenshot: true, title: "My report");
if (result.Success)
    GUIUtility.systemCopyBuffer = result.Url; // скопировать ссылку
else
    Debug.LogWarning("Upload failed: " + result.Error);
```

`SendAsync` awaitable на всех версиях Unity (через корутинный `FlogTask`, без зависимости от `Task`/`Awaitable`, WebGL-safe).

### 3.6. Оверлей и панель настроек

Оверлей - это UI отправки в один тап: тоггл скриншота, поле заголовка и кликабельная ссылка результата. Открывается жестом из конфига (по умолчанию `F8`) или из кода:

```csharp
FastLogs.ShowOverlay();
FastLogs.HideOverlay();
FastLogs.ToggleOverlay();
```

Жест настраивается в `Config > Trigger`: клавиатурный хоткей (`ToggleKey`, по умолчанию `F8`, опц. модификатор), мультитач (`MultiTouchFingerCount`) и shake-to-open на мобильных (`EnableShake`). На **WebGL** копирование ссылки и открытие её в новой вкладке должны происходить внутри обработчика клика (user-gesture) - оверлей делает это автоматически.

### 3.7. Что попадает в отчёт

- **Логи** - кольцевой буфер консоли (плюс ручные `FastLogs.Log/Warn/Error`), усечённый по `MaxLogTextBytes`.
- **Полный срез устройства** - system/graphics/display/application/runtime/memory/network/build (`SystemInfo`, `Application`, `Screen`, `QualitySettings`, `Time`, сцены, GC, reachability, cloud-build manifest). На WebGL добавляется web-группа (userAgent, язык и т.п.).
- **Скриншот** - опционально, только если включён тоггл в оверлее или `SendAsync(includeScreenshot: true)`. По умолчанию выключен.
- Счётчики E/W/L - за сессию.

Готовый пример интеграции - сэмпл **Basic Usage** (Package Manager -> вкладка Samples -> Import). Он показывает init, recording, `RecordScope`, `SendAsync` с `await` и событие `OnUploaded`.

---

## 4. Быстрый старт: GameMaker

GameMaker-клиент - это набор скриптов `scr_fastlogs_*` и объект `obj_fastlogs_controller` (см. проект-скелет `gamemaker/FastLogsGM.yyp`). Публичный API - в [`../gamemaker/PUBLIC-API.md`](../gamemaker/PUBLIC-API.md), технические заметки по GML - в [`../gamemaker/GM-NOTES.md`](../gamemaker/GM-NOTES.md).

> Готового упакованного `.yymps` пока нет (статус "планируется"). Перенос ресурсов в свой проект - **уточнить** (когда появится `.yymps`, импорт пойдёт через `Tools > Import Local Package`). Пока переносите ресурсы из `gamemaker/` вручную: папку-скелет `FastLogs` со всеми `scr_fastlogs_*` и `obj_fastlogs_controller`.

### 4.1. Импорт ресурсов в проект

1. Добавьте в свой проект все скрипты `scr_fastlogs_*` (`core`, `recorder`, `device`, `payload`, `http`, `overlay`, `input`, `clipboard`, `screenshot`, `util`, `config`) и объект `obj_fastlogs_controller` (с его событиями `Create_0`, `Step_0`, `Draw_64`, `Other_62` - Async HTTP, `Other_63` - Async Save/Load).
2. Заведите в проекте build-конфиг с именем `debug` (в FastLogsGM он уже есть). Имя должно **точно совпадать** с именем конфига в `.yyp`, иначе гейтинг не сработает (см. раздел 6).

### 4.2. Настройка `scr_fastlogs_config`

Откройте `scr_fastlogs_config` и задайте макросы под свой сервер (дефолты нейтральные/пустые):

```gml
#macro FASTLOGS_ENDPOINT      "https://logs.example.com/api/logs"  // <BASE_URL>/api/logs
#macro FASTLOGS_APP_ID        "mygame"     // [a-z0-9_-]{2,32}, = Project в каталоге
#macro FASTLOGS_TOKEN         ""           // ingest-токен или "" без заголовка
#macro FASTLOGS_APP_VERSION   ""           // "" -> возьмётся GM_version, либо задайте вручную
```

Если `FASTLOGS_ENDPOINT` пустой - `fastlogs_send` делает no-op с предупреждением. Прочие макросы (кольцо, персист, скриншот, хоткеи, цвета оверлея) уже имеют рабочие дефолты, менять не обязательно.

### 4.3. Контроллер в первой комнате

Создайте экземпляр `obj_fastlogs_controller` (он **persistent** - переживает смену комнат) в самой первой комнате игры, либо вызовите `fastlogs_init()` рано в бутстрапе. `fastlogs_init` создаёт контроллер, если его ещё нет, инициализирует кольцо/счётчики/персист и регистрирует обработчик исключений.

```gml
// Опционально с runtime-override макросов:
fastlogs_init({
    endpoint: "https://logs.example.com/api/logs",
    appId:    "mygame",
    token:    "",
    autoStartRecording: false
});
```

`fastlogs_init` идемпотентна и безопасна к вызову до полной настройки.

### 4.4. Интеграция логирования `flog()`

`flog(message, [level])` - короткий алиас `fastlogs_log`. Самый удобный способ влить FastLogs в существующий проект - одной строкой в ваш текущий `trace()` / обёртку над `show_debug_message()`:

```gml
function trace(_msg) {
    show_debug_message(_msg);
    flog(_msg);                 // одна строка - и весь существующий лог идёт в FastLogs
}
```

Уровни:

```gml
flog("Checkpoint reached");                     // FASTLOGS_LEVEL_LOG (деф.)
flog("Low memory", FASTLOGS_LEVEL_WARN);
fastlogs_error("Spawner failed");               // обёртка с фиксированным уровнем
```

В память (кольцо) запись идёт всегда, пока `FASTLOGS_ENABLED`; на диск (персист) - только когда запись включена.

### 4.5. Запись и отправка (по умолчанию запись ВЫКЛЮЧЕНА)

```gml
fastlogs_record_start();      // включить запись (персист новых flog на диск)
fastlogs_record_stop();       // выключить (накопленное на диске остаётся)
fastlogs_record_set(true);    // явный set
fastlogs_is_recording();      // -> bool

fastlogs_set_screenshot(true);          // включить скриншот в следующий send
fastlogs_send({ title: "Crash on load" }); // -> bool (true = запрос поставлен)
fastlogs_last_url();                    // URL последнего успешного лога ("" если нет)
```

Автостарт записи - макрос `FASTLOGS_AUTO_START_RECORDING` (по умолчанию `false`). Авто-отправка при необработанном исключении - макрос `FASTLOGS_AUTOSEND_ON_EXCEPTION` (по умолчанию `true`; best-effort плюс персист на диск, отправка может не успеть до закрытия - тогда уйдёт при следующем запуске).

### 4.6. Оверлей

```gml
fastlogs_open();    // показать
fastlogs_close();   // скрыть
fastlogs_toggle();  // переключить
```

Оверлей рисуется примитивами в Draw GUI, по умолчанию открывается хоткеем `FASTLOGS_HOTKEY_TOGGLE` (`vk_f8`) или геймпад-комбо `FASTLOGS_GP_TOGGLE`.

---

## 5. Платформенные нюансы

- **WebGL**: `logEncoding = plain` (без gzip тела, чтобы не ловить preflight/CORS); отправка только через корутину; copy/open ссылки - синхронно из обработчика клика. В Unity это делается автоматически.
- **iOS**: endpoint только `https://` (ATS).
- **GameMaker / HTML5**: `screen_save` на HTML5 не работает - скриншот там недоступен.
- Пустые/недоступные поля `device` клиент **опускает** (не шлёт `null`/`0`).

---

## 6. Консоли и релиз: гейтинг

Принцип: **в ритейле и на консолях инструмента нет вообще** - чтобы не было лишних накладных расходов и конфликтов на сертификации (запрещённые сетевые/скриншот-вызовы просто не попадают в исполняемый код).

### Unity

Весь init / networking / overlay / screenshot / перехват логов обёрнут в:

```csharp
#if UNITY_EDITOR || DEVELOPMENT_BUILD || (LOGSHARE_FORCE_ENABLED && !(UNITY_PS4 || UNITY_PS5 || UNITY_GAMECORE || UNITY_SWITCH))
```

- **Публичный фасад `FastLogs.*` компилируется всегда** - игровой код, который зовёт FastLogs, билдится везде, включая ритейл и консоли.
- Void-методы (`Init`, `Log`, `StartRecording`, `ShowOverlay`, ...) помечены `[Conditional]` - в ритейле компилятор убирает и тело метода, и **все места вызова** (ноль накладных расходов).
- Методы с возвращаемым значением (`IsRecording`, `SendAsync`, `RecordScope`, `Counts`) компилируются везде, но в вырезанном билде возвращают безопасные no-op-дефолты.
- Консольные платформы (PS4, PS5, GameCore, Switch) жёстко заблокированы `#if`-гардом. Включить FastLogs на консоли без правки исходников пакета нельзя.

Включить FastLogs в **release-билде** (mobile / standalone / WebGL, не консоль): `Tools > PlayJoy > FastLogs > Build Defines Helper` добавит дефайн `LOGSHARE_FORCE_ENABLED` для целевой платформы, затем `Config > Enable > EnableInRelease = true`. Делайте это только при осознанной операционной необходимости - в проде пойдёт HTTP-трафик и опц. скриншоты.

### GameMaker

Гейтинг - через макрос `FASTLOGS_ENABLED`, заданный **по build-конфигу**:

```gml
#macro Default: FASTLOGS_ENABLED false   // релиз: клиент ВЫКЛ, контроллер не создаётся
#macro debug:   FASTLOGS_ENABLED true    // отладка: клиент ВКЛ
```

Имя `debug` обязано совпадать с именем build-конфига в `.yyp`. При `!FASTLOGS_ENABLED` каждая публичная функция делает безопасный ранний выход (no-op), контроллер в релизе не создаётся - значит в ритейле на консолях нет вызовов `http_request` / `screen_save`. Собираете на консоль ритейл-конфигом `Default` - инструмент отсутствует.

---

## 7. Приватность

- **Что собирается**: рантайм-логи, полный диагностический срез устройства, счётчики E/W/L, опц. скриншот. Логи и скриншоты **могут содержать персональные данные**.
- **Скриншот** по умолчанию **выключен**, снимается только по явному запросу (тоггл в оверлее или `includeScreenshot: true` / `fastlogs_set_screenshot(true)`).
- **Чувствительные поля** (Unity: `Config > Diagnostics > IncludeSensitive`, по умолчанию `false`) опускают device model, identifier приложения и на WebGL - URL страницы и referrer.
- **Ничего не отправляется автоматически** - все аплоады инициируются пользователем (жест / вызов API). Исключение: GameMaker может делать best-effort авто-отправку при краше, если включён `FASTLOGS_AUTOSEND_ON_EXCEPTION`.
- **Непубличный доступ**: ссылка короткая, но непредсказуемая; несуществующий/просроченный/невалидный `id` отдаёт единый `404` (анти-перебор). Каталог `/browse` - под командной авторизацией (viewer-токен).
- **Ретеншн**: записи живут настраиваемый срок (по умолчанию 30 дней на сервере), затем удаляются sweeper'ом. "Закреплённые" (pin) не удаляются.

---

## 8. Как смотреть логи

### По ссылке (вьюер)

`GET /<id>` - HTML-вьюер. Возможности:

- device-info сворачиваемыми группами;
- счётчики E/W/L и **фильтр по уровню** (Error / Warning / Log);
- **поиск** по тексту;
- сворачивание стектрейсов, переключение **raw / pretty**, copy;
- **скриншот** (если был приложен);
- кнопка **"сохранить (pin)"** - чтобы запись не удалилась по ретеншну (pin открыт по ссылке, удобно тестеру).

Дополнительно: `GET /<id>/raw` - сырой лог (`?download=1` отдаст файлом), `GET /<id>/screenshot` - PNG.

### Каталог (вся команда)

`GET /browse` - каталог под **viewer-токеном** (team-токен / Basic / admin). Иерархия:

| Уровень | Endpoint | Что показывает |
|---------|----------|----------------|
| Project | `GET /browse` | список проектов (`appId` + отображаемое имя) |
| version | `GET /browse/<appId>` | версии (`appVersion`) с количеством записей |
| Log | `GET /browse/<appId>/<version>` | записи: id, title, время, платформа, counts, pinned |

Маппинг: **PlayJoy** = инстанс сервера, **Project** = `appId`, **version** = `appVersion`, **Log** = `id`.

### Уведомления (sinks)

Если админ настроил sinks, на каждый успешный ingest короткая ссылка прилетает в Slack / Discord / webhook / Confluence / Google Sheet (с фильтрами, напр. только при ошибках). Настройка - в [`ADMIN-GUIDE.md`](ADMIN-GUIDE.md).

---

## 9. FAQ / troubleshooting

**Не пришла ссылка / отправка не сработала.**
Проверьте по шагам: задан ли `EndpointUrl` / `FASTLOGS_ENDPOINT`; включена ли запись (по умолчанию ВЫКЛ - нажмите Start или включите автостарт); инициализирован ли клиент (`Init` / `fastlogs_init`); активен ли клиент в этом флейворе билда (в ритейле он вырезан - см. раздел 6). В Unity подпишитесь на `OnUploaded` или прочитайте `result.Error`; в GameMaker - `fastlogs_last_url()` пуст, смотрите Async HTTP `http_status`.

**Запись выключена - в логе пусто.**
Запись по умолчанию выключена осознанно. Включите `FastLogs.StartRecording()` / `fastlogs_record_start()`, либо автостарт (`AutoStartRecording` / `FASTLOGS_AUTO_START_RECORDING`), либо оберните участок в `RecordScope()`.

**CORS / ошибка на WebGL.**
На WebGL тело шлётся `plain` (без gzip), чтобы не ловить preflight; copy/open ссылки - из обработчика клика. Клиенты делают это сами. Если всё равно CORS - проверьте на сервере `CORS_ALLOW_ORIGIN` (по умолчанию `*`) и что endpoint доступен с домена игры.

**Токен / 401 / 403.**
`401 unauthorized` - игра требует токен, а он не передан: впишите `Token` / `FASTLOGS_TOKEN`. `403 forbidden` - неверный токен или `appId` не зарегистрирован/выключен на сервере: попросите админа зарегистрировать игру (`scripts/add-app.js`) и выдать токен. Токен показывается **один раз** при регистрации.

**`413 payload_too_large` / лог обрезан.**
Превышены лимиты (тело ~8 MB, скриншот ~2 MB, распакованный лог ~20 MB). Уменьшите `MaxLogTextBytes` / `FASTLOGS_MAX_LOG_BYTES` или размер скриншота (`MaxDimension`). Клиент сам усекает лог с пометкой об усечении.

**iOS: отправка не идёт.**
Endpoint должен быть `https://` (ATS). `http://` на iOS заблокирован системой.

**Каталог `/browse` просит логин.**
Это нормально - каталог под командной авторизацией. Возьмите viewer-токен у админа.
