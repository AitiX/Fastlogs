# FastLogs - руководство для команды

Как пользоваться FastLogs разработчику Unity и GameMaker, как смотреть логи и что важно знать про релиз и приватность.

Источники правды (если найдёте расхождение - верьте им, а не этому гайду):

- Контракт API - [`../CONTRACT.md`](../CONTRACT.md)
- Сервер - [`../server/README.md`](../server/README.md), установка - [`../server/deploy/INSTALL.md`](../server/deploy/INSTALL.md)
- Unity - [`../unity/README.md`](../unity/README.md), архитектура - [`../unity/ARCHITECTURE.md`](../unity/ARCHITECTURE.md)
- GameMaker - [`../gamemaker/PUBLIC-API.md`](../gamemaker/PUBLIC-API.md), заметки - [`../gamemaker/GM-NOTES.md`](../gamemaker/GM-NOTES.md)

---

## 1. Что такое FastLogs и зачем

Из запущенной игры одним жестом отправить рантайм-логи плюс диагностический срез устройства (и опционально скриншот) на свой сервер и получить короткую ссылку для просмотра в браузере. Ссылки складываются в каталог `PlayJoy -> Project -> version -> Log`. Работает на WebGL и веб-порталах, iOS, Android и Standalone (Windows / macOS / Linux), на движках Unity и GameMaker. На консолях в релизе инструмент вырезается целиком, чтобы не мешать сертификации.

### Как это выглядит для тестера

Тестер делает жест или жмёт хоткей (по умолчанию `F8`), открывается оверлей со счётчиками ошибок, предупреждений и логов (E/W/L) и тогглом «Скриншот». Жмёт «Отправить» и получает короткую ссылку: она копируется в буфер обмена, а в Unity-оверлее рядом рисуется её QR, чтобы снять камерой телефона. По ссылке открывается вьюер - логи с фильтрами, поиском, device-инфо и (если был включён тоггл) скриншотом.

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

Клиент (Unity или GameMaker) собирает кольцевой буфер логов, срез устройства и опциональный скриншот, формирует JSON строго по [`../CONTRACT.md`](../CONTRACT.md) и шлёт `POST /api/logs`. Сервер (Node + SQLite за nginx) принимает запрос, сохраняет данные, отдаёт короткую ссылку и кладёт запись в каталог; на каждый успешный ingest он асинхронно форвардит компактный payload в настроенные sinks, не блокируя ответ клиенту. Просмотр - вьюер по ссылке `GET /<id>` и командный каталог `GET /browse`.

Контракт единый для всех движков: любой клиент, формирующий запрос по схеме из `CONTRACT.md`, совместим с тем же сервером.

---

## 3. Быстрый старт: Unity

Поддерживаемые версии Unity: **6000.1 (Unity 6)** и **2022.3 LTS**.

### 3.1. Установка пакета

Способ 1 (рекомендуется) - по Git URL. Добавьте в `Packages/manifest.json`:

```jsonc
{
  "dependencies": {
    "com.playjoy.fastlogs": "https://github.com/AitiX/Fastlogs.git?path=/unity#main"
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

Оверлей - это UI отправки в один тап: тоггл скриншота, поле заголовка и кликабельная ссылка результата. После успешной отправки в Unity-оверлее рядом со ссылкой рисуется её QR (снять камерой другого устройства; в GameMaker QR нет). Открывается жестом из конфига (по умолчанию `F8`) или из кода:

```csharp
FastLogs.ShowOverlay();
FastLogs.HideOverlay();
FastLogs.ToggleOverlay();
```

Жест настраивается в `Config > Trigger`: клавиатурный хоткей (`ToggleKey`, по умолчанию `F8`, опц. модификатор), мультитач (`MultiTouchFingerCount`) и shake-to-open на мобильных (`EnableShake`). На **WebGL** копирование ссылки и открытие её в новой вкладке должны происходить внутри обработчика клика (user-gesture) - оверлей делает это автоматически.

### 3.7. Что попадает в отчёт

Логи - кольцевой буфер консоли плюс ручные `FastLogs.Log/Warn/Error`, усечённый по `MaxLogTextBytes`. Срез устройства - группы system/graphics/display/application/runtime/memory/network/build (`SystemInfo`, `Application`, `Screen`, `QualitySettings`, `Time`, сцены, GC, reachability, cloud-build manifest); на WebGL добавляется web-группа (userAgent, язык и т.п.). Контекст (`FastLogs.SetContext`) и breadcrumbs (`FastLogs.Breadcrumb`) едут с каждым отчётом и по умолчанию проходят PII-чистку - см. раздел 5. Скриншот прикладывается только при включённом тоггле в оверлее или `SendAsync(includeScreenshot: true)`, по умолчанию выключен. Плюс счётчики E/W/L за сессию.

Готовый пример интеграции - сэмпл **Basic Usage** (Package Manager -> вкладка Samples -> Import): init, recording, `RecordScope`, `SendAsync` с `await` и событие `OnUploaded`.

---

## 4. Быстрый старт: GameMaker

GameMaker-клиент - это набор скриптов `scr_fastlogs_*` и объект `obj_fastlogs_controller` (см. проект-скелет `gamemaker/FastLogsGM.yyp`). Публичный API - в [`../gamemaker/PUBLIC-API.md`](../gamemaker/PUBLIC-API.md), технические заметки по GML - в [`../gamemaker/GM-NOTES.md`](../gamemaker/GM-NOTES.md).

> Готового упакованного `.yymps` пока нет (статус "планируется"). Перенос ресурсов в свой проект - **уточнить** (когда появится `.yymps`, импорт пойдёт через `Tools > Import Local Package`). Пока переносите ресурсы из `gamemaker/` вручную: папку-скелет `FastLogs` со всеми `scr_fastlogs_*` и `obj_fastlogs_controller`.

### 4.1. Импорт ресурсов в проект

1. Добавьте в свой проект все скрипты `scr_fastlogs_*` (`core`, `recorder`, `device`, `payload`, `http`, `overlay`, `input`, `clipboard`, `screenshot`, `util`, `config`) и объект `obj_fastlogs_controller` (с его событиями `Create_0`, `Step_0`, `Draw_64`, `Other_62` - Async HTTP, `Other_63` - Async Save/Load).
2. Заведите в проекте build-конфиг с именем `debug` (в FastLogsGM он уже есть). Имя должно **точно совпадать** с именем конфига в `.yyp`, иначе гейтинг не сработает (см. раздел 7).

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

Автостарт записи - макрос `FASTLOGS_AUTO_START_RECORDING` (по умолчанию `false`). Авто-отправка при необработанном исключении - макрос `FASTLOGS_AUTOSEND_ON_EXCEPTION` (по умолчанию `true`): краш сначала персистится в дисковый outbox, потом идёт попытка отправки; если процесс умер раньше - отчёт дошлётся при следующем запуске. Подробно про надёжную доставку крашей - раздел 8.

### 4.6. Оверлей

```gml
fastlogs_open();    // показать
fastlogs_close();   // скрыть
fastlogs_toggle();  // переключить
```

Оверлей рисуется примитивами в Draw GUI, по умолчанию открывается хоткеем `FASTLOGS_HOTKEY_TOGGLE` (`vk_f8`) или геймпад-комбо `FASTLOGS_GP_TOGGLE`.

---

## 4b. Отправка файла или папки (SendFile / SendFolder)

Иногда нужны не логи, а сам **файл**: выгрузить с устройства тестера файл сейва, дамп, конфиг или базу - и дать разработчику короткую ссылку на скачивание, как у обычного отчёта. Для этого в ядре есть отдельный канал: произвольный файл или папка уходит на отдельный `POST /api/files`, сервер возвращает короткую ссылку, по которой во вьюере файл качается кнопкой **Download**. Папка перед отправкой зипуется **на клиенте** в один `.zip`. Гейтинг тот же, что у всего FastLogs: в ритейле и на консолях этот код вырезан (см. раздел 7), так что вызовы в игровом коде в проде безвредны.

Типовой кейс: тестер ловит баг, который воспроизводится только на его сейве. Он (или ваш код по хоткею) шлёт файл сейва на сервер, разработчик открывает ссылку и скачивает сейв себе. Ещё удобнее - приложить файл прямо к лог-отчёту (`logId` / `AttachFile`), тогда сейв виден в панели **Attachments** того же лога.

### Что важно знать до интеграции

- **Кап размера.** Лимит по **распакованному** (decoded) размеру блоба - `MAX_FILE_BYTES`, по умолчанию **25 MB**. Проверяется и на клиенте (до отправки), и на сервере; для папки кап считается по размеру **итогового** `.zip`. Превышение - чистый отказ (`413` на сервере / no-op на клиенте), не исключение. Меняется в конфиге клиента (`Files.MaxFileBytes` / `FASTLOGS_MAX_FILE_BYTES`) и на сервере (`MAX_FILE_BYTES`).
- **Бинарь НЕ скрабится.** PII-чистка (раздел 9) к блобу и именам файлов **не применяется** - файл уходит и хранится **байт-в-байт**, без редактирования и перекодирования. Это сознательный инвариант (сейв должен дойти как есть). Единственная защита - размерный кап. Не шлите этим каналом то, что содержит чужие персональные данные, если оно вам в открытом виде не нужно.
- **Ретеншн и доступ - как у логов.** Файл живёт настраиваемый срок (`retentionDays`, clamp по серверному максимуму), затем удаляется sweeper'ом; ссылка короткая и непредсказуемая, несуществующий или просроченный id отдаёт единый `404`.
- **Отдельный эндпоинт.** Это **не** часть лог-отчёта: отдельный `POST /api/files` с отдельным (большим) лимитом тела (`MAX_FILE_BODY_BYTES` = `MAX_FILE_BYTES`*4/3 + запас, ~34 MB), не общий `MAX_PAYLOAD_BYTES` (8 MB). Endpoint выводится из основного: Unity - из `Server.EndpointUrl` заменой `/api/logs` на `/api/files` (можно переопределить `Files.FilesEndpointUrl`); GameMaker - из `FASTLOGS_ENDPOINT` так же (или явный `FASTLOGS_FILES_ENDPOINT`).
- **За nginx.** В дефолтном деплое nginx стоит `client_max_body_size 10m` (`server/deploy/nginx-fastlogs.conf`) - он отрубит файлы крупнее ~7.5 MB (по распакованному размеру) ещё до сервера. Чтобы реально выгружать файлы до `MAX_FILE_BYTES` (25 MB), поднимите `client_max_body_size` для `/api/files` (или глобально) до уровня `MAX_FILE_BODY_BYTES`.

### Unity

Фасад - часть `FastLogs.*`, как и остальной API. Есть fire-and-forget void-вызовы (помечены `[Conditional]`, в ритейле тело и места вызова удаляются компилятором) и awaitable-перегразки, возвращающие `FlogTask<FileUploadResultDto>` (компилируются везде; в вырезанном билде возвращают «disabled»-результат, не кидают).

```csharp
// Fire-and-forget (результат показывается тостом; в ритейле вырезано целиком):
FastLogs.SendFile(Application.persistentDataPath + "/save_slot_3.dat", title: "Save before crash");
FastLogs.SendFolder(Application.persistentDataPath + "/Saves", title: "All saves");

// Awaitable - получить ссылку в коде:
var result = await FastLogs.SendFileAsync(savePath, title: "Save before crash");
if (result.Success)
{
    Debug.Log("Download: " + result.DownloadUrl);   // GET /files/<id>/download
    GUIUtility.systemCopyBuffer = result.Url;        // страница вьюера с кнопкой Download
}
else
{
    Debug.LogWarning("File upload failed: " + result.Error);
}

// Папка (зипуется на клиенте в один .zip) и набор файлов в один архив:
await FastLogs.SendFolderAsync(Application.persistentDataPath + "/Saves", title: "All saves");
await FastLogs.SendFilesAsync(new[] { pathA, pathB }, title: "Repro set");
```

`FileUploadResultDto` несёт `Success`, `Id`, `Url` (страница вьюера файла), `DownloadUrl` (прямой блоб), `ExpiresAt`, `StatusCode`, `Retryable`, `Error`. `Url` ведёт на лёгкую страницу `GET /files/<id>` с кнопкой Download (кейс «выгрузить сейв разработчику»), `DownloadUrl` - сразу на блоб.

**WebGL: только byte[].** В вебе у клиента нет доступа к файловой системе по пути, поэтому path-перегрузки (`SendFile`, `SendFileAsync(path, ...)`, `SendFolder*`, `SendFilesAsync`) на WebGL честно возвращают **Fail** с понятным сообщением (не кидают исключение). Работает только перегрузка по байтам, её и используйте, когда данные уже в памяти:

```csharp
byte[] bytes = SerializeSaveToBytes();
var result = await FastLogs.SendFileAsync(bytes, "save_slot_3.dat", title: "WebGL save");
```

**Привязать файл к лог-отчёту.** Чтобы файл появился в панели **Attachments** конкретного лога, поставьте путь в очередь до отправки отчёта - файл уедет вместе со **следующим** успешным `SendAsync` и привяжется к нему на сервере:

```csharp
FastLogs.AttachFile(savePath);                 // в очередь (папка зипуется при отправке)
await FastLogs.SendAsync(title: "Crash with save");  // лог + приложенный файл
// FastLogs.ClearAttachments();                // сбросить очередь, не отправляя
```

`AttachFile` - тоже void `[Conditional]` (в ритейле вырезано), очередь капается (старое вытесняется), на WebGL это no-op (нет файловой системы).

### GameMaker

Три функции, все возвращают `bool` (`true` - запрос поставлен в отправку; `false` - no-op: `!FASTLOGS_ENABLED`, нет файла/папки, превышен кап, не задан endpoint или уже идёт отправка). Ответ сервера (`201 { id, url, downloadUrl }`) разбирается в Async HTTP событии своей короткой веткой - тост плюс опциональный колбэк, без retry-until-success и дренажа outbox (это только для лог-отчётов).

```gml
// Один файл (name и mime по умолчанию выводятся из имени файла):
fastlogs_send_file(save_path, { title: "Save before crash" });

// Папка -> один .zip (метод STORE, без компрессии) на клиенте, name по умолчанию = <имя папки>.zip:
fastlogs_send_folder(save_dir, { title: "All saves" });

// Несколько файлов в один .zip (name по умолчанию = "files.zip"):
fastlogs_send_files([path_a, path_b], { title: "Repro set" });
```

Общие `opts` (struct, все опциональны) для всех трёх: `title` (<=120), `logId` (привязать к лог-отчёту - файл попадёт в его `attachments` во вьюере), `groupId` (группировка нескольких аплоадов одной операции), `mime` (переопределить MIME), `kind` (тип вложения; по умолчанию `"file"` для одиночного и `"folder"` для папки/набора), `retentionDays` (срок хранения; `<1` не шлётся), `name` (переопределить имя файла в каталоге/архиве), `onDone` (`function(result)` - колбэк с `{ success, id, url, downloadUrl, statusCode, error }`).

```gml
// Привязать сейв к свежему лог-отчёту и забрать ссылку колбэком:
fastlogs_send_file(save_path, {
    title:    "Save attached",
    logId:    fastlogs_last_url() != "" ? /* id последнего лога */ : undefined,
    onDone:   function(r) { if (r.success) clipboard_set_text(r.downloadUrl); }
});
```

Конфиг GameMaker: `FASTLOGS_FILES_ENDPOINT` (`""` -> выводится из `FASTLOGS_ENDPOINT`), кап `FASTLOGS_MAX_FILE_BYTES` (деф. 25 MB). На HTML5 доступ к файлам по пути ограничен платформой - так же, как со скриншотом (раздел 6), это нюанс среды GameMaker/HTML5.

---

## 5. Контекст и breadcrumbs: быстрый триаж

Голый стек на пустой консоли говорит только «что-то упало». Полезный отчёт отвечает на «что игрок делал, в каком был состоянии и какой путь привёл к багу». Для этого есть контекст (снимок состояния «сейчас») и breadcrumbs (катящийся след последних событий). Оба едут с каждым отчётом и каждым крашем, во вьюере это отдельные сворачиваемые секции **Context** и **Breadcrumbs**. Стоят дёшево: контекст - запись в словарь, крошка - запись в кольцо O(1), без аллокаций в кадре; PII-чистка и сериализация делаются разово при сборке отчёта.

### 5.1. Контекст: привязать состояние/игрока/уровень

Контекст - это набор пар `ключ -> значение` (строки), снимок которых уходит с каждым отчётом. Кладите туда то, по чему хотите искать и группировать баги: id/ник игрока, текущий уровень/сцену, режим, фичефлаги, билд-канал, состояние «дошёл-докуда».

Unity:

```csharp
FastLogs.SetContext("playerId", playerId);   // привязать отчёт к игроку
FastLogs.SetContext("level", "3-2");          // где он был
FastLogs.SetContext("mode", "ranked");
FastLogs.SetContext("level", null);           // null-значение УДАЛЯЕТ ключ
FastLogs.ClearContext();                       // сбросить всё (напр. при выходе в меню)
```

GameMaker:

```gml
fastlogs_set_context("playerId", global.player_id);
fastlogs_set_context("level", "3-2");
fastlogs_remove_context("level");   // удалить один ключ
fastlogs_clear_context();           // сбросить весь контекст
```

Контекст **накапливается и перетирается по ключу** - выставили один раз при смене уровня/режима, дальше он сам едет с любым отчётом. Лимиты (мягко режутся на клиенте, сервер тоже капает): ключ <= 64 символов, значение <= 512, суммарно ~4 KB на отчёт. Не пихайте сюда простыни - для длинных событий есть breadcrumbs.

### 5.2. Breadcrumbs: видеть путь к багу

Breadcrumb - короткая запись о произошедшем событии («открыл магазин», «нажал купить», «загрузка уровня началась»). Они складываются в катящийся буфер последних **100** (старые вытесняются), несут момент **своего** появления (UTC-таймстемп) и уровень, и во вьюере показываются **таймлайном** - получается реконструкция последних шагов перед падением.

Unity:

```csharp
FastLogs.Breadcrumb("Opened shop");
FastLogs.Breadcrumb("Purchase tapped: sku_gold_100");
FastLogs.Breadcrumb("Network request failed", FastLogLevel.Warning);
FastLogs.Breadcrumb("Save load failed", FastLogLevel.Error);
```

GameMaker (`level` опционально, по умолчанию `"info"`; принимает строку `"info"|"warn"|"error"` или `FASTLOGS_LEVEL_*`):

```gml
fastlogs_breadcrumb("Opened shop");
fastlogs_breadcrumb("Purchase tapped", "warn");
fastlogs_breadcrumb("Save load failed", FASTLOGS_LEVEL_ERROR);
fastlogs_clear_breadcrumbs();   // очистить след (редко нужно - кольцо само вытесняет старое)
```

Уровень крошки нормализуется к `info|warn|error` (контракт). Текст одной крошки режется до 512 символов, весь буфер сервер капает до 100 шт / ~16 KB. Крошки - это **след событий**, а не дубль логов: пишите ключевые переходы (экран/стадия/важное действие/внешний вызов), а не каждый кадр.

### 5.3. Как это ускоряет разбор

Положили `playerId` и `level` в контекст - в отчёте сразу видно, кого и где накрыло, и можно сопоставить с жалобой тестера. Таймлайн breadcrumbs показывает последовательность действий до краша, и часто это и есть ответ «как воспроизвести»; уровень крошки (`info`/`warn`/`error`) подсвечивает, где начало портиться, ещё до самого исключения. Контекст и breadcrumbs прикладываются и к авто-краш-отчётам (раздел 8), так что даже отчёт, доехавший на следующем запуске, несёт состояние и путь к багу.

### 5.4. Куда встраивать в проекте

`SetContext` ставьте в местах смены состояния: загрузка уровня или сцены, вход в режим/матч, логин игрока, переключение крупной фичи. Один вызов на переход, не на кадр. `Breadcrumb` - на значимых событиях: переходы экранов, важные действия игрока (покупка, старт боя), границы загрузок, внешние вызовы (сеть, IAP, сейв), редкие ветки; удобно завести тонкую обёртку и звать её из своих менеджеров. Комментарий тестера (`SendAsync(comment: ...)` / `fastlogs_send({ comment })` или поле в оверлее) добавляет свободное описание «что делал и что увидел». Связка «контекст плюс breadcrumbs плюс комментарий» закрывает почти весь первичный триаж без переспросов.

> В релизе/на консолях это, как и весь инструмент, вырезается (см. раздел 7): в Unity void-вызовы `SetContext`/`Breadcrumb` и их аргументы удаляются компилятором, в GameMaker функции делают ранний no-op. Поэтому встраивать вызовы в игровой код безопасно - в проде их нет.

---

## 6. Платформенные нюансы

- WebGL: `logEncoding = plain` (без gzip тела, чтобы не ловить preflight/CORS), отправка только через корутину, copy/open ссылки синхронно из обработчика клика. В Unity это делается автоматически.
- iOS: endpoint только `https://` (ATS).
- GameMaker / HTML5: `screen_save` на HTML5 не работает, скриншот там недоступен.
- Пустые и недоступные поля `device` клиент опускает (не шлёт `null`/`0`).

---

## 7. Консоли и релиз: гейтинг

В ритейле и на консолях инструмента нет вообще - запрещённые сетевые и скриншот-вызовы просто не попадают в исполняемый код, поэтому нет лишних накладных расходов и конфликтов на сертификации.

### Unity

Весь init / networking / overlay / screenshot / перехват логов обёрнут в:

```csharp
#if UNITY_EDITOR || DEVELOPMENT_BUILD || (LOGSHARE_FORCE_ENABLED && !(UNITY_PS4 || UNITY_PS5 || UNITY_GAMECORE || UNITY_SWITCH))
```

Публичный фасад `FastLogs.*` компилируется всегда, поэтому игровой код, который зовёт FastLogs, билдится везде, включая ритейл и консоли. Void-методы (`Init`, `Log`, `StartRecording`, `ShowOverlay`, ...) помечены `[Conditional]`: в ритейле компилятор убирает и тело метода, и все места вызова. Методы с возвращаемым значением (`IsRecording`, `SendAsync`, `RecordScope`, `Counts`) компилируются везде, но в вырезанном билде возвращают безопасные no-op-дефолты. Консольные платформы (PS4, PS5, GameCore, Switch) жёстко заблокированы `#if`-гардом - включить FastLogs на консоли без правки исходников пакета нельзя.

Включить FastLogs в release-билде (mobile / standalone / WebGL, не консоль): `Tools > PlayJoy > FastLogs > Build Defines Helper` добавит дефайн `LOGSHARE_FORCE_ENABLED` для целевой платформы, затем `Config > Enable > EnableInRelease = true`. Делайте это только при осознанной операционной необходимости - в проде пойдёт HTTP-трафик и опциональные скриншоты.

### GameMaker

Гейтинг - через макрос `FASTLOGS_ENABLED`, заданный **по build-конфигу**:

```gml
#macro Default: FASTLOGS_ENABLED false   // релиз: клиент ВЫКЛ, контроллер не создаётся
#macro debug:   FASTLOGS_ENABLED true    // отладка: клиент ВКЛ
```

Имя `debug` обязано совпадать с именем build-конфига в `.yyp`. При `!FASTLOGS_ENABLED` каждая публичная функция делает безопасный ранний выход (no-op), контроллер в релизе не создаётся - значит в ритейле на консолях нет вызовов `http_request` / `screen_save`. Собираете на консоль ритейл-конфигом `Default` - инструмент отсутствует.

---

## 8. Краши: захват и надёжная доставка

Жёсткий краш убивает процесс до того, как успеет завершиться HTTP-отправка, и раньше такое исключение терялось. Модель теперь такая: захват краша всегда, доставка при первой возможности. Каждый необработанный краш в первую очередь (раньше любых предохранителей) синхронно пишется в дисковый outbox, поэтому уже не теряется.

### Как это работает

При необработанном исключении отчёт сразу сериализуется в дисковую очередь (Unity `persistentDataPath/FastLogs/pending/<id>.json`, GameMaker - каталог `pending`), и только затем идёт попытка обычного аплоада; успешная отправка удаляет файл. Если процесс умер до конца HTTP, файл остаётся в outbox, и на следующем старте `Init` / `fastlogs_init` сканирует очередь и дошлёт неотправленные краши прошлых сессий - так краш, убивший игру, всё равно доедет. Unity вдобавок дренит очередь в простое после завершения текущих отправок, поэтому отложенный из-за занятости отчёт уходит, как только канал освободился.

Цикл одинаковых крашей не плодит файлы: захват дедупится по сигнатуре стека (отдельно от дедупа доставки), а кап очереди (Unity `PendingCrashCap`, GameMaker `FASTLOGS_PENDING_MAX`, по умолчанию 5) держит число файлов ограниченным. Предохранители ограничивают только темп аплоада, а не захват: троттл (Unity `MinSecondsBetweenAutoSends`, по умолчанию 30 с), кап-на-сессию (`MaxAutoSendsPerSession`, по умолчанию 10) и блокировка во время текущей отправки решают лишь, слать ли немедленно сейчас; пропущенный по ним отчёт остаётся в outbox и уйдёт дренажем или на следующем старте. Постоянная `4xx` (400/401/403/413/415, неретраебельно) убирает файл из очереди как poison-pill - бесконечно слать его смысла нет; транзиентные сбои (сеть, `statusCode 0`, `5xx`) остаются на диске для будущей попытки.

Авто-отправка при краше включена по умолчанию в dev (Unity `Config > Auto-send > AutoSendOnException = true`, GameMaker `FASTLOGS_AUTOSEND_ON_EXCEPTION = true`). Авто-краш-отчёт идёт без скриншота (упавший кадр редко полезен, а захват стоит кадр) и несёт контекст плюс breadcrumbs (раздел 5). В релизе и на консолях инструмент вырезан целиком, поэтому краши там не шлются by design (раздел 7).

> Практический итог: при краше жать ничего не надо - отчёт уже на сервере или доедет при следующем запуске. Откройте каталог `/browse` своей игры.

---

## 9. Приватность (приватно по умолчанию)

Из коробки наружу уходит минимум, а потенциальный PII режется ещё до отправки. Включать чувствительное и выключать чистку - осознанный шаг интегратора.

### Что НЕ уходит по умолчанию

PII вычищается перед отправкой. Чистка (Unity `Config > Diagnostics > ScrubPii = true`, GameMaker `FASTLOGS_SCRUB_PII = true`) разово, при сборке отчёта и при записи краша в outbox, прогоняет через redaction текст логов, значения контекста и тексты breadcrumbs: email, IPv4, IPv6, Bearer/Authorization-токены и длинные цифровые последовательности (9+ цифр подряд) заменяются на `[redacted]`.

Чувствительные поля устройства, URL и идентификаторы не шлются. Unity `IncludeSensitive = false` опускает device model, identifier приложения, а на WebGL - URL страницы и referrer; в GameMaker `FASTLOGS_INCLUDE_SENSITIVE = false`, и его device-скрипт заведомо чувствительные идентификаторы и так не собирает. Сырой IP тестера клиент не шлёт вовсе - для rate-limit сервер берёт IP только из соединения и хранит его как соль плюс `sha256`, а не в открытом виде. Скриншот по умолчанию выключен и снимается только по явному запросу (тоггл в оверлее или `includeScreenshot: true` / `fastlogs_set_screenshot(true)`). При обычной работе само ничего не уходит - все аплоады инициирует пользователь; единственное исключение, авто-отправка при краше (раздел 8), тоже проходит PII-чистку.

### Как включить больше или выключить чистку

Чувствительные поля включаются через Unity `IncludeSensitive = true` или GameMaker `FASTLOGS_INCLUDE_SENSITIVE` / `fastlogs_init({ includeSensitive: true })`. PII-чистка выключается через Unity `ScrubPii = false` или GameMaker `FASTLOGS_SCRUB_PII` / `fastlogs_init({ scrubPii: false })`; тоггл чистки есть и в панели настроек оверлея. Свои секреты и форматы добавляются паттернами: Unity `PiiScrubber.AddPattern("<regex>")` до первой отправки, GameMaker `fastlogs_redact_rules_set([{name, matcher}, ...])` (дефолтный набор - `fastlogs_redact_default_rules()`).

### Осторожность с PII

Чистка - best-effort, а не гарантия. Она может перередактировать (длинное число, таймстемп или id из 9+ цифр уедет в `[redacted]`) - осознанный компромисс в пользу приватности; и наоборот, нестандартный формат секрета может не попасть под дефолтные паттерны, для таких случаев добавляйте свой. Логи и скриншоты всё равно могут содержать персональные данные - то, что вы сами туда пишете, имена в UI на скрине и т.п. Не логируйте секреты осознанно, а в контекст кладите идентификаторы, а не приватные сведения.

### Доступ и хранение

Ссылка короткая, но непредсказуемая; несуществующий, просроченный или невалидный `id` отдаёт единый `404` (анти-перебор). Каталог `/browse` - под командной авторизацией (viewer-токен). Записи живут настраиваемый срок (по умолчанию 30 дней на сервере), затем удаляются sweeper'ом; закреплённые (pin) не удаляются.

---

## 10. Как смотреть логи

### По ссылке (вьюер)

`GET /<id>` - HTML-вьюер. Внутри: device-info сворачиваемыми группами; счётчики E/W/L и фильтр по уровню (Error / Warning / Log); поиск по тексту; сворачивание стектрейсов, переключение raw / pretty и copy; скриншот, если был приложен; кнопка «сохранить (pin)», чтобы запись не удалилась по ретеншну (pin открыт по ссылке, удобно тестеру).

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

## 11. FAQ / troubleshooting

**Не пришла ссылка / отправка не сработала.**
Проверьте по шагам: задан ли `EndpointUrl` / `FASTLOGS_ENDPOINT`; включена ли запись (по умолчанию ВЫКЛ - нажмите Start или включите автостарт); инициализирован ли клиент (`Init` / `fastlogs_init`); активен ли клиент в этом флейворе билда (в ритейле он вырезан - см. раздел 7). В Unity подпишитесь на `OnUploaded` или прочитайте `result.Error`; в GameMaker - `fastlogs_last_url()` пуст, смотрите Async HTTP `http_status`.

**Запись выключена - в логе пусто.**
Запись по умолчанию выключена. Включите `FastLogs.StartRecording()` / `fastlogs_record_start()`, либо автостарт (`AutoStartRecording` / `FASTLOGS_AUTO_START_RECORDING`), либо оберните участок в `RecordScope()`.

**CORS / ошибка на WebGL.**
На WebGL тело шлётся `plain` (без gzip), чтобы не ловить preflight; copy/open ссылки - из обработчика клика. Клиенты делают это сами. Если всё равно CORS - проверьте на сервере `CORS_ALLOW_ORIGIN` (по умолчанию `*`) и что endpoint доступен с домена игры.

**Токен / 401 / 403.**
`401 unauthorized` - игра требует токен, а он не передан: впишите `Token` / `FASTLOGS_TOKEN`. `403 forbidden` - неверный токен или `appId` не зарегистрирован/выключен на сервере: попросите админа зарегистрировать игру (`scripts/add-app.js`) и выдать токен. Токен показывается **один раз** при регистрации.

**`413 payload_too_large` / лог обрезан.**
Превышены лимиты (тело ~8 MB, скриншот ~2 MB, распакованный лог ~20 MB). Уменьшите `MaxLogTextBytes` / `FASTLOGS_MAX_LOG_BYTES` или размер скриншота (`MaxDimension`). Клиент сам усекает лог с пометкой об усечении.

**iOS: отправка не идёт.**
Endpoint должен быть `https://` (ATS). `http://` на iOS заблокирован системой.

**Каталог `/browse` просит логин.**
Каталог под командной авторизацией. Возьмите viewer-токен у админа.
