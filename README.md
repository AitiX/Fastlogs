# FastLogs

Из запущенной игры одним жестом отправить рантайм-логи плюс диагностический срез устройства (и опционально скриншот) на свой сервер и получить короткую ссылку для просмотра в браузере. Ссылки складываются в каталог `<Company> -> Project -> version -> Log`. Один сервер обслуживает несколько игр и движков: два клиента (Unity и GameMaker) поверх единого JSON-контракта.

В мобильных, WebGL и консольных билдах у разработчика нет доступа к консоли движка, а тестеру неудобно описывать баг словами и пересылать логи файлами. Типовой обходной путь - кинуть лог через сторонний pastebin - даёт текст без структуры, без среза устройства и с коротким сроком жизни. Тестер ловит баг и шлёт лог кнопкой или жестом, получает короткую ссылку (в Unity-оверлее рядом рисуется её QR), кидает разработчику. Тот открывает ссылку и видит консоль с фильтрами E/W/L и поиском, срез устройства, контекст, breadcrumbs, скриншот и комментарий тестера. Краши уходят сами при необработанном исключении и не теряются: сначала пишутся в дисковый outbox и доезжают на следующем запуске.

> Это лендинг репозитория. Подробный гайд для интегратора с примерами - [`docs/TEAM-GUIDE.md`](docs/TEAM-GUIDE.md); единый JSON-контракт API (источник правды для любого клиента) - [`CONTRACT.md`](CONTRACT.md); деплой и администрирование - [`docs/ADMIN-GUIDE.md`](docs/ADMIN-GUIDE.md) и [`server/deploy/`](server/deploy/).

## Содержание

1. [Что такое FastLogs и зачем](#1-что-такое-fastlogs-и-зачем)
2. [Архитектура](#2-архитектура)
3. [Быстрый старт: Unity](#3-быстрый-старт-unity)
4. [Быстрый старт: GameMaker](#4-быстрый-старт-gamemaker)
5. [Контекст и breadcrumbs: быстрый триаж](#5-контекст-и-breadcrumbs-быстрый-триаж)
6. [Контекст сцены (Unity)](#6-контекст-сцены-unity)
7. [Надёжная отправка, correlation-код и анти-цикл (Unity)](#7-надёжная-отправка-correlation-код-и-анти-цикл-unity)
8. [Отправка файлов и папок (SendFile / SendFolder)](#8-отправка-файлов-и-папок-sendfile--sendfolder)
9. [Краши: захват и доставка](#9-краши-захват-и-доставка)
10. [Платформы, гейтинг и релиз](#10-платформы-гейтинг-и-релиз)
11. [Приватность (приватно по умолчанию)](#11-приватность-приватно-по-умолчанию)
12. [Как смотреть логи](#12-как-смотреть-логи)
13. [Быстрый старт: сервер](#13-быстрый-старт-сервер)
14. [Лимиты](#14-лимиты)
15. [FAQ / troubleshooting](#15-faq--troubleshooting)
16. [Структура репозитория](#16-структура-репозитория)

---

## 1. Что такое FastLogs и зачем

Клиент (Unity или GameMaker) держит кольцевой буфер логов, по запросу собирает срез устройства, контекст, breadcrumbs и опциональный скриншот, формирует JSON строго по [`CONTRACT.md`](CONTRACT.md) и шлёт `POST /api/logs`. Сервер сохраняет данные, отдаёт короткую ссылку и кладёт запись в каталог. Под новый движок добавить клиент - это вопрос реализации одного HTTP-запроса по схеме.

Платформы: WebGL и веб-порталы, iOS, Android, Standalone (Windows / macOS / Linux). На консолях в релизе инструмент вырезается целиком (раздел 10).

### Как это выглядит для тестера

Тестер делает жест или жмёт хоткей (по умолчанию `F8`) - открывается оверлей со счётчиками ошибок, предупреждений и логов (E/W/L), полем заголовка, тогглами `[ ] Screenshot` и `[ ] Scene`. Жмёт «Отправить»: оверлей сразу закрывается, а итог приходит тостом («logs sent» или «logs + context sent», либо ошибка с кнопкой Retry) - ловить ссылку в открытой панели не нужно. Ссылка авто-копируется в буфер устройства, тост показывает её с кнопками Copy/Open, а в Unity-оверлее рядом - QR этой ссылки, чтобы снять камерой другого устройства (в GameMaker QR нет). По ссылке открывается вьюер: логи с фильтрами и поиском, device-инфо, контекст и breadcrumbs, дерево контекста сцены и скриншот (если были приложены).

Команда видит все отправленные логи в каталоге: **`<Company>`** (инстанс сервера) -> **Project** (`appId` игры) -> **version** (версия билда) -> **Log** (конкретная запись).

---

## 2. Архитектура

```
   Игра (клиент)                  Сервер FastLogs                Получатели
   -------------                  ---------------                ----------
  Unity  C#  ----\                                          /--> короткая ссылка (вьюер)
                  >-- POST /api/logs --> ingest --> SQLite --+--> каталог /browse
  GameMaker GML -/        (JSON)         + blobs (лог/PNG)   \--> sinks (Slack/Discord/
                                                                  webhook/Confluence/Sheet)
```

Клиент собирает кольцо логов, срез устройства, контекст и breadcrumbs, прогоняет PII-чистку и шлёт `POST /api/logs`. Сервер (Node + SQLite за nginx) принимает запрос, кладёт лог и PNG в blob-хранилище, метаданные в SQLite, отдаёт короткую ссылку и заносит запись в каталог. На каждый успешный ingest он асинхронно форвардит компактный payload в настроенные sinks, не блокируя ответ клиенту. Просмотр - вьюер `GET /<id>` и командный каталог `GET /browse`.

---

## 3. Быстрый старт: Unity

Поддерживаемые версии Unity: **6000.1 (Unity 6)** и **2022.3 LTS**.

### 3.1. Установка пакета

Способ 1 (рекомендуется) - по Git URL. Добавьте в `Packages/manifest.json`:

```jsonc
{
  "dependencies": {
    "com.<company>.fastlogs": "<REPO_URL>?path=/unity#main"
  }
}
```

Суффикс `?path=/unity` указывает Unity Package Manager использовать как корень пакета только подкаталог `unity/`. Подставьте свой `<REPO_URL>` и ветку/тег.

Способ 2 (embedded / local) - скопируйте папку `unity/` в `Packages/` проекта и переименуйте в `com.<company>.fastlogs`. Unity подхватит её сама.

### 3.2. Создание конфига

FastLogs читает настройки из ScriptableObject `FastLogsConfig`, лежащего в любой папке `Resources/` под `Assets/`.

1. Меню `Tools > <Company> > FastLogs > Create Config Asset` - ассет создастся в `Assets/Resources/FastLogsConfig.asset` и выделится в Project.
2. Либо ПКМ в Project -> `Create > <Company> > FastLogs > Config`.

Если конфиг уже есть, команда меню подсветит существующий, а не создаст дубль.

### 3.3. Заполнение конфига

Откройте ассет в Inspector. Минимум для отправки - секция `Server`:

| Поле | Что задать | Дефолт |
|------|-----------|--------|
| `EndpointUrl` | Полный URL ингеста, напр. `<SERVER_URL>/api/logs`. Без него отправка не работает. | пусто |
| `AppId` | Идентификатор проекта `[a-z0-9_-]{2,32}` - по нему логи группируются в каталоге. | пусто |
| `Token` | Опциональный Bearer-токен ингеста (если сервер его требует). | пусто |
| `RetentionDaysOverride` | Срок хранения в днях для этого клиента. `0` = серверный дефолт. | `0` |

Важно: на **iOS** endpoint обязан быть `https://` (App Transport Security). Inspector предупредит, если вписать `http://`.

Остальные секции (`Capture`, `Recording`, `Auto-send`, `Screenshot`, `Scene Context`, `Diagnostics`, `Trigger`, `Net`, `Retry`, `Loop Guard`, `UI`, `Enable`) имеют рабочие дефолты - можно не трогать. Несколько чисел, на которые стоит взглянуть: `Capture > RingCapacity` = 1000 записей, `Capture > MaxLogTextBytes` = 1 MB (клиентский кап текста лога; `0` - без капа), `Screenshot > MaxDimension` = 1280 (даунскейл по большей стороне). Полная таблица полей - в [`unity/README.md`](unity/README.md).

### 3.4. Инициализация и запись (по умолчанию запись ВЫКЛЮЧЕНА)

Вызовите `FastLogs.Init()` один раз рано в бутстрапе (например, в `Awake` менеджера, который грузится раньше всех). `Init` идемпотентен; при `config == null` грузит `Resources/FastLogsConfig` автоматически.

```csharp
using <Company>.FastLogs;

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

// 3) Автостартом: Config > Recording > AutoStartRecording = true (запись включится на Init)
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
var result = await FastLogs.SendAsync(includeScreenshot: true, title: "My report", comment: "after fight");
if (result.Success)
    GUIUtility.systemCopyBuffer = result.Url; // скопировать ссылку
else
    Debug.LogWarning("Upload failed: " + result.Error);

// Быстрая отправка из кода без открытия оверлея (хоткей/жест зовут то же самое):
FastLogs.Send();
```

`FlogTask<UploadResultDto> SendAsync(bool includeScreenshot = false, string title = null, string comment = null)` awaitable на всех версиях Unity (через корутинный `FlogTask`, без зависимости от `Task`/`Awaitable`, WebGL-safe). Если FastLogs вырезан из билда, `SendAsync` мгновенно вернёт `UploadResultDto.Disabled`; если не инициализирован - `UploadResultDto.Fail("FastLogs is not initialized.")`. `Send()` - fire-and-forget, без UI, итог приходит тостом.

### 3.6. Оверлей и жесты

Оверлей - UI отправки в один тап: поле заголовка, тогглы `[ ] Screenshot` и `[ ] Scene`, кликабельная ссылка результата. Внутри есть и панель настроек, где тестер прямо в рантайме переключает рантайм-тогглы (как минимум PII-чистку, `ScrubPii`, раздел 11) без пересборки. Открывается жестом из конфига или из кода:

```csharp
FastLogs.ShowOverlay();
FastLogs.HideOverlay();
FastLogs.ToggleOverlay();
```

Жесты настраиваются в `Config > Trigger`:

| Поле | Что | Дефолт |
|------|-----|--------|
| `ToggleKey` (+ `Modifier`) | Клавиша открытия оверлея | `F8`, без модификатора |
| `EnableQuickSendKeyboard` / `QuickSendKey` | Хоткей быстрой отправки без UI | выкл / `F9` |
| `QuickSendCornerTaps` | Тапов в угол экрана для быстрой отправки | `0` (выкл) |
| `MultiTouchFingerCount` | Пальцев мультитача для открытия | `0` (выкл) |
| `EnableShake` / `ShakeThreshold` / `ShakeCooldownSeconds` | Shake-to-open на мобильных | выкл / `2.5` / `1.0` |

На **WebGL** копирование ссылки и открытие её в новой вкладке должны происходить внутри обработчика клика (user-gesture) - оверлей делает это автоматически.

### 3.7. Что попадает в отчёт

Логи - кольцевой буфер консоли плюс ручные `FastLogs.Log/Warn/Error`, усечённый по `MaxLogTextBytes`. Срез устройства - группы system / graphics / display / application / runtime / memory / network / build (`SystemInfo`, `Application`, `Screen`, `QualitySettings`, `Time`, сцены, GC, reachability, cloud-build manifest); на WebGL добавляется web-группа (userAgent, язык и т.п.). Контекст (`SetContext`) и breadcrumbs (`Breadcrumb`) едут с каждым отчётом и по умолчанию проходят PII-чистку (раздел 11). Скриншот прикладывается только при включённом тоггле или `SendAsync(includeScreenshot: true)` - по умолчанию выключен. Контекст сцены (раздел 6) - по тогглу `[ ] Scene` или из кода. Плюс счётчики E/W/L за сессию.

Готовый пример интеграции - сэмпл **Basic Usage** (Package Manager -> вкладка Samples -> Import): init, recording, `RecordScope`, `SendAsync` с `await` и событие `OnUploaded`.

---

## 4. Быстрый старт: GameMaker

GameMaker-клиент - набор скриптов `scr_fastlogs_*` и объект `obj_fastlogs_controller`. Публичный API - в [`gamemaker/PUBLIC-API.md`](gamemaker/PUBLIC-API.md), технические заметки - в [`gamemaker/GM-NOTES.md`](gamemaker/GM-NOTES.md). Префиксы: функции `fastlogs_*`, короткий алиас `flog`, макросы `FASTLOGS_*`.

### 4.1. Импорт ресурсов и build-конфиг

1. Перенесите в свой проект все скрипты `scr_fastlogs_*` (`core`, `recorder`, `device`, `payload`, `http`, `overlay`, `input`, `clipboard`, `screenshot`, `util`, `config`) и объект `obj_fastlogs_controller` с его событиями `Create_0`, `Step_0`, `Alarm_0` (тик отложенного повтора), `Draw_64` (Draw GUI), `Other_62` (Async HTTP) и `Other_63` (Async Save/Load). Готового `.yymps` пока нет - ресурсы переносятся вручную (когда появится `.yymps`, импорт пойдёт через `Tools > Import Local Package`).
2. Заведите build-конфиг с именем `debug` (`FASTLOGS_ENABLED = true`). Имя должно **точно совпадать** с именем конфига в `.yyp`, иначе гейтинг не сработает (раздел 10).

### 4.2. Настройка `scr_fastlogs_config`

Откройте `scr_fastlogs_config` и задайте макросы под свой сервер (дефолты нейтральные/пустые):

```gml
#macro FASTLOGS_ENDPOINT      "<SERVER_URL>/api/logs"   // полный URL ингеста
#macro FASTLOGS_APP_ID        "<project>"               // [a-z0-9_-]{2,32}, = Project в каталоге
#macro FASTLOGS_TOKEN         ""                         // ingest-токен или "" без заголовка
#macro FASTLOGS_APP_VERSION   ""                         // "" -> GM_version, либо задайте вручную
```

Если `FASTLOGS_ENDPOINT` пуст - `fastlogs_send` делает no-op с предупреждением. Прочие макросы (кольцо, персист, скриншот, хоткеи) уже имеют рабочие дефолты.

### 4.3. Контроллер и инициализация

Создайте экземпляр `obj_fastlogs_controller` (он **persistent**, переживает смену комнат) в самой первой комнате игры, либо вызовите `fastlogs_init()` рано в бутстрапе. `fastlogs_init` создаёт контроллер, если его ещё нет, инициализирует кольцо/счётчики/персист и регистрирует обработчик исключений. Функция идемпотентна, возвращает instance id или `noone`.

```gml
// Опционально с runtime-override макросов:
fastlogs_init({
    endpoint:           "<SERVER_URL>/api/logs",
    appId:              "<project>",
    token:              "",
    autoStartRecording: false
});
```

### 4.4. Логирование `flog()`, запись и отправка

`flog(message, [level])` - короткий алиас `fastlogs_log`. Самый удобный способ влить FastLogs в существующий проект - одной строкой в свою обёртку над `show_debug_message()`:

```gml
function trace(_msg) {
    show_debug_message(_msg);
    flog(_msg);                 // одна строка - и весь существующий лог идёт в FastLogs
}

flog("Checkpoint reached");                     // FASTLOGS_LEVEL_LOG (деф.)
flog("Low memory", FASTLOGS_LEVEL_WARN);
fastlogs_error("Spawner failed");               // обёртка с фиксированным уровнем
```

В память (кольцо) запись идёт всегда, пока `FASTLOGS_ENABLED`; на диск (персист) - только когда запись включена. Поэтому буфер может быть непуст, даже если «запись» формально выключена.

```gml
// Запись по умолчанию ВЫКЛ:
fastlogs_record_start();      // включить запись (персист новых flog на диск)
fastlogs_record_stop();       // выключить (накопленное на диске остаётся)
fastlogs_record_set(true);    // явный set
fastlogs_is_recording();      // -> bool
fastlogs_clear();             // очистить кольцо И счётчики сессии (в отличие от Unity ClearRecording, который счётчики НЕ трогает); персист-файл на диске не трогается

fastlogs_set_screenshot(true);              // включить скриншот в следующий send
var ok = fastlogs_send({ title: "Crash on load", comment: "after fight" }); // -> bool
fastlogs_is_sending();                      // -> bool (идёт ли отправка прямо сейчас)
fastlogs_retry_is_pending();                // -> bool (есть ли отложенный повтор)
fastlogs_last_url();                        // URL последнего успешного лога ("" если нет)
fastlogs_get_counts();                      // -> struct { error, warn, log } за сессию

fastlogs_open();  fastlogs_close();  fastlogs_toggle();   // оверлей (хоткей vk_f8)
```

Поля `opts` для `fastlogs_send`: `title` (<=120), `comment` (<=4000), `retentionDays` (int), `screenshot` (bool), `extraDevice` (struct). Имя тестера задаётся макросом `FASTLOGS_TESTER` или через `fastlogs_init`, не через `opts`. После успешной отправки при `FASTLOGS_COPY_ON_SEND` (деф. `true`) `url` копируется в буфер.

> Контекст сцены, correlation-код и per-call-site анти-цикл (разделы 6 и 7) на текущий момент есть только в Unity-клиенте; в GameMaker-API их аналогов нет. Контекст, breadcrumbs (раздел 5), приватность (раздел 11) и надёжная доставка крашей (раздел 9) в GameMaker есть.

---

## 5. Контекст и breadcrumbs: быстрый триаж

Контекст и breadcrumbs отвечают на вопросы «что делал игрок, в каком был состоянии и как пришёл к багу». Контекст - снимок состояния «сейчас», breadcrumbs - катящийся след последних событий. Оба едут с каждым отчётом и каждым крашем, во вьюере это отдельные сворачиваемые секции **Context** и **Breadcrumbs**. Стоят дёшево: контекст - запись в словарь, крошка - запись в кольцо O(1); PII-чистка и сериализация делаются разово при сборке отчёта, не на горячем пути.

### 5.1. Контекст

Контекст - набор пар `ключ -> значение` (строки), снимок которых уходит с каждым отчётом. Кладите туда то, по чему хотите искать и группировать баги: id/ник игрока, уровень/сцену, режим, фичефлаги, билд-канал.

```csharp
// Unity
FastLogs.SetContext("playerId", playerId);
FastLogs.SetContext("level", "3-2");
FastLogs.SetContext("level", null);  // null-значение УДАЛЯЕТ ключ
FastLogs.ClearContext();             // сбросить всё (напр. при выходе в меню)
```

```gml
// GameMaker
fastlogs_set_context("playerId", global.player_id);
fastlogs_set_context("level", "3-2");
fastlogs_remove_context("level");    // удалить один ключ
fastlogs_clear_context();            // сбросить весь контекст
```

Контекст **накапливается и перетирается по ключу** - выставили один раз при смене уровня/режима, дальше он сам едет с любым отчётом. Лимиты (мягко режутся на клиенте, сервер тоже капает): ключ <= 64 символов, значение <= 512, суммарно ~4 KB на отчёт.

### 5.2. Breadcrumbs

Breadcrumb - короткая запись о произошедшем событии («открыл магазин», «нажал купить»). Они складываются в катящийся буфер последних **100** (старые вытесняются), несут момент своего появления (UTC) и уровень, во вьюере показываются **таймлайном** - реконструкция последних шагов перед падением.

```csharp
// Unity
FastLogs.Breadcrumb("Opened shop");
FastLogs.Breadcrumb("Network request failed", FastLogLevel.Warning);
```

```gml
// GameMaker (level опционально, деф. "info"; принимает "info"|"warn"|"error" или FASTLOGS_LEVEL_*)
fastlogs_breadcrumb("Opened shop");
fastlogs_breadcrumb("Purchase tapped", "warn");
fastlogs_clear_breadcrumbs();   // редко нужно - кольцо само вытесняет старое
```

Уровень нормализуется к `info|warn|error`. Текст одной крошки режется до 512 символов, весь буфер сервер капает до 100 шт / ~16 KB. Крошки - это **след событий**, а не дубль логов: пишите ключевые переходы (экран/стадия/важное действие/внешний вызов), а не каждый кадр.

### 5.3. Куда встраивать в проекте

`SetContext` ставьте на сменах состояния: загрузка уровня или сцены, вход в режим/матч, логин игрока, переключение крупной фичи (один вызов на переход, не на кадр). `Breadcrumb` - на значимых событиях: переходы экранов, важные действия игрока (покупка, старт боя), границы загрузок, внешние вызовы (сеть, IAP, сейв), редкие ветки. Удобно завести тонкую обёртку и звать её из своих менеджеров. Контекст, breadcrumbs и комментарий тестера уходят с каждым отчётом, в том числе с авто-краш-отчётами (раздел 9), доехавшими на следующем запуске.

В релизе/на консолях это, как и весь инструмент, вырезается (раздел 10): в Unity void-вызовы `SetContext`/`Breadcrumb` и их аргументы удаляет компилятор, в GameMaker функции делают ранний no-op. Встраивать вызовы в игровой код безопасно - в проде их нет.

---

## 6. Контекст сцены (Unity)

Иногда стек и логи не отвечают на «а в каком состоянии была сцена в момент бага». Контекст сцены снимает снимок **всей иерархии всех загруженных сцен плюс `DontDestroyOnLoad`**: объекты -> компоненты -> сериализуемые поля. Во вьюере это отдельное сворачиваемое дерево **Scene Context**. Снимок reflection-тяжёлый и ограничен лимитами `Config > Scene Context`, поэтому он **one-shot, никогда не на кадр**.

```csharp
// Приложить снимок к следующей отправке:
FastLogs.CaptureSceneContext();        // снять иерархию, добавить в очередь к ближайшему Send
FastLogs.SendSceneContext();           // снять и отправить сразу одним вызовом

// Повтор в рамках сессии (loop guard игнорирует второй вызов, если allowRepeat=false):
FastLogs.SendSceneContext(allowRepeat: true);
```

Сигнатуры: `void CaptureSceneContext(bool allowRepeat = false)` и `void SendSceneContext(bool allowRepeat = false)`. В оверлее то же самое делает тоггл `[ ] Scene`: включил - и Send приложит контекст сцены, а тост скажет «logs + context sent». Capture/Send-сцены защищены одноразовым loop guard: повторный вызов игнорируется, если снимок уже в очереди (или уже был отправлен для `SendSceneContext`), пока не передать `allowRepeat: true`.

Лимиты снимка (`Config > Scene Context`, все режутся мягко с пометкой `truncated`):

| Поле | Дефолт | Поле | Дефолт |
|------|--------|------|--------|
| `MaxObjects` | `5000` | `MaxStringLength` | `200` |
| `MaxDepth` | `12` | `MaxCollectionElements` | `20` |
| `MaxComponentsPerObject` | `40` | `MaxBytes` | `1 MB` |
| `MaxFieldsPerComponent` | `60` | | |

---

## 7. Надёжная отправка, correlation-код и анти-цикл (Unity)

### 7.1. Send закрывает оверлей и показывает тост

Тап по «Отправить» в оверлее сразу закрывает панель, а итог приходит тостом - не нужно держать UI открытым и ловить ссылку. Текст тоста зависит от того, был ли приложен контекст сцены: **«logs sent»** или **«logs + context sent»** (с пометкой «link copied»); при ошибке - тост с кнопкой Retry. Ссылка авто-копируется в буфер (`Config > UI > CopyLinkOnSend`, деф. `true`), а тост даёт кнопки Copy/Open и QR. То же из кода - `FastLogs.Send()` (fire-and-forget, без UI, итог тостом). При сетевых сбоях работает внешний retry-loop с интервалом `Config > Retry > RetryIntervalSeconds` (деф. `30`, `0` = выключен) и потолком попыток `MaxRetryAttempts` (деф. `0` = бесконечно).

### 7.2. Correlation-код: дождаться нужного лога

Когда нужно поймать конкретный отчёт среди многих (например, «вот сейчас воспроизведу баг»), пометьте отчёты коротким кодом, а на стороне инструмента дождитесь именно его:

```csharp
FastLogs.SetCorrelationCode("4729");   // <=64 символов; null/empty снимает код
// ... теперь любой Send/SendAsync несёт этот код в payload
```

Код едет в поле `correlationCode` (клиентский кап 64 символа). На сервере есть эндпоинт `GET /api/await/:appId?code=&token=` (под viewer-токеном) и CLI-обёртка над ним:

```bash
node server/src/tools/fastlogs-await.js \
  --app <project> --code 4729 --token <TOKEN> --base <SERVER_URL>
# поллит /api/await/:appId?code= с интервалом (деф. 3 c, таймаут 600 c) и пишет
# await-state.json: { status, code, app, id, url, rawUrl, checkedAt, foundAt, error }
# status: "waiting" | "found" | "timeout" | "error"
# exit 0 = found, 2 = timeout, 1 = error
```

Эндпоинт резолвит самый свежий **живой** (не просроченный) лог приложения с этим кодом и возвращает `{ found, id, url, rawUrl, createdAt }` (если нет - `found: false` со всеми полями `null`). Это позволяет встроить ожидание лога в автотест или CI: попросили тестера задать код, дождались `found`, забрали `url`/`rawUrl`.

### 7.3. Анти-цикл: защита от зацикленной отправки (per call-site)

Если одно место кода (`Send` / `SendAsync` / `SendSceneContext`) шлёт логи слишком часто, можно случайно засыпать сервер. Анти-цикл работает **per call-site**: место вызова определяется через C# `CallerInfo` (`[CallerFilePath]` + `[CallerLineNumber]`), и счётчик ведётся отдельно для каждой строки кода.

При превышении порога (`Config > Loop Guard > MaxCodeSendsPerSite`, деф. `10`) перед отправкой показывается подтверждение с весом будущего лога: «возможно зацикливание, отправить ~N KB?». Кнопки:

- **«Нет»** - глушит **именно этот** вызов (`file:line`) до конца сессии: дальнейшие отправки с этой строки молча дропаются.
- **«Да»** - сбрасывает счётчик сайта и фиксирует в отчёте `loopConfirmedBy` (имя тестера или `unknown`) и `loopSite` (ключ call-site), чтобы ответственность за «прорыв» порога была на подтвердившем.

Одновременно висит только один диалог: пока он показан, прочие over-threshold отправки дропаются (без стопки окон). Если UI недоступен (`EnableUI = false` или нет оверлея), сверх порога идёт молчаливый дроп с варнингом каждые `NoUiWarnEvery` штук (деф. `10`). Сам guard включается флагом `Config > Loop Guard > Enabled` (деф. `true`).

---

## 8. Отправка файлов и папок (SendFile / SendFolder)

Иногда нужно вытащить с устройства разработчика не лог, а сам артефакт - файл сейва, дамп, конфиг, профайл, целую папку. FastLogs шлёт произвольный **файл или папку** на тот же сервер отдельным запросом `POST /api/files` и отдаёт короткую ссылку - как у отчёта, со страницей-вьюером и кнопкой **Download**. Типовой кейс: «выгрузи мне сейчас файл сейва» - тестер зовёт одну строку, разработчик открывает ссылку и качает блоб. Папка зипуется **на клиенте** в один `.zip`. Это часть ядра плагина и так же гейтится (в ритейле и на консолях вырезано, раздел 10), поэтому вызовы безопасно оставлять в игровом коде.

Важный инвариант: к бинарю **PII-чистка (раздел 11) НЕ применяется** - блоб уходит и хранится байт-в-байт, единственная защита - размерный кап `MAX_FILE_BYTES` (раздел 14, по умолчанию ~25 MB по распакованному размеру, проверяется и на клиенте, и на сервере). Не выгружайте файлами то, что не должно покинуть устройство как есть.

### 8.1. Unity

Awaitable-перегрузки возвращают `FlogTask<FileUploadResultDto>` (как `SendAsync`, корутинный, WebGL-safe) и компилируются везде; в вырезанном билде сразу отдают `FileUploadResultDto.Disabled`, без инициализации - `Fail(...)`.

```csharp
using <Company>.FastLogs;

// Файл по пути -> { Success, Url, DownloadUrl, ExpiresAt, StatusCode, Error }:
var result = await FastLogs.SendFileAsync(Application.persistentDataPath + "/save_slot_3.dat",
                                          title: "Save before crash");
if (result.Success)
    GUIUtility.systemCopyBuffer = result.DownloadUrl;  // прямая ссылка на скачивание
else
    Debug.LogWarning("File upload failed: " + result.Error);

// Папка целиком -> зипуется на клиенте в один .zip и отправляется:
await FastLogs.SendFolderAsync(Application.persistentDataPath + "/Saves", title: "All saves");

// Несколько файлов одним архивом:
await FastLogs.SendFilesAsync(new[] { pathA, pathB }, title: "Repro set");
```

Перегрузки `SendFileAsync(string path, ...)`, `SendFolderAsync(string path, ...)` и `SendFilesAsync(IReadOnlyList<string> paths, ...)` берут `title` опционально (call-site фиксируется через `CallerInfo`, как у `SendAsync`). Поле результата `Url` - страница-вьюер `GET /files/<id>`, `DownloadUrl` - прямой блоб `GET /files/<id>/download` (`Content-Disposition: attachment`).

Fire-and-forget без `await` (итог приходит тостом, как у `Send()`) - `void`-методы помечены `[Conditional]` и в ритейле компилятор удаляет и тело, и места вызова с аргументами:

```csharp
FastLogs.SendFile(path, title: "Save");     // fire-and-forget, тост с результатом
FastLogs.SendFolder(folderPath);            // зип папки + отправка
```

Можно приложить файл(ы) **к обычному отчёту** - тогда они появятся в панели **Attachments** вьюера лога (привязка по `logId` на сервере):

```csharp
FastLogs.AttachFile(path);   // поставить в очередь к СЛЕДУЮЩЕЙ успешной отправке отчёта
FastLogs.ClearAttachments(); // снять очередь, не отправляя
await FastLogs.SendAsync(title: "Crash with save");  // приложенные файлы догрузятся и привяжутся к этому логу
```

`AttachFile` капится (старое вытесняется), папка в очереди зипуется в момент аплоада.

**WebGL-нюанс.** На WebGL у клиента нет доступа к файловой системе по пути, поэтому **path-перегрузки** (`SendFileAsync(path)`, `SendFolderAsync`, `SendFilesAsync`, `SendFile`, `SendFolder`, `AttachFile`) честно возвращают `Fail("...no file system...")` / делают no-op, а не кидают исключение. Рабочий путь на WebGL - **byte[]-перегрузка**, которой данные передаются из памяти:

```csharp
// WebGL-safe: данные уже в памяти, путь не нужен
byte[] bytes = SerializeSave();
var result = await FastLogs.SendFileAsync(bytes, fileName: "save_slot_3.dat", title: "Save");
```

### 8.2. GameMaker

Те же три операции (`bool`-результат: `true` - запрос поставлен в отправку, `false` - no-op при `!FASTLOGS_ENABLED` / нет файла / превышен кап / нет endpoint):

```gml
fastlogs_send_file(path, { title: "Save before crash" });
fastlogs_send_folder(folder_path, { title: "All saves" }); // zip-store папки в один .zip
fastlogs_send_files([path_a, path_b], { title: "Repro set" });
```

`opts` (опц., struct, общие для всех трёх): `title` (<=120), `logId` (привязать к лог-отчёту -> в `attachments` вьюера), `groupId` (групповая метка), `mime` (переопределить MIME), `kind` (тип вложения; автодефолт `"file"` / `"folder"`), `retentionDays` (int), `name` (имя в каталоге/архиве), `onDone(result)` (колбэк с `{ success, id, url, downloadUrl, statusCode, error }`). При успехе короткая ссылка авто-копируется в буфер при `FASTLOGS_COPY_ON_SEND`. Папка зипуется в буфере методом **STORE** (без компрессии) - для паритета с Unity один `.zip`. Конфиг: `FASTLOGS_FILES_ENDPOINT` (`""` -> выводится из `FASTLOGS_ENDPOINT` заменой `/api/logs` -> `/api/files`), `FASTLOGS_MAX_FILE_BYTES` (деф. 25 MB). На HTML5 доступа к ФС по пути нет - там действует то же ограничение, что у Unity-WebGL.

### 8.3. Что отдаёт сервер

`POST /api/files` на `201` возвращает `{ id, url, downloadUrl, expiresAt }`. Просмотр и скачивание:

| Endpoint | Что отдаёт |
|----------|-----------|
| `GET /files/<id>` | лёгкий standalone-вьюер: имя, размер, кнопка **Download** (кейс «выгрузить сейв разработчику») |
| `GET /files/<id>/download` | сам блоб; `Content-Disposition: attachment` с корректным именем, `Content-Type` из `mime` |

Файл, привязанный по `logId`, дополнительно появляется в `attachments[]` ответа `GET /api/logs/<id>` и в панели **Attachments** вьюера лога (там у каждого вложения своя кнопка **Download**). Ретеншн - как у логов (раздел 11): запись живёт настраиваемый срок и затем удаляется sweeper'ом (блоб - до строки), несуществующий / просроченный / невалидный `id` отдаёт единый `404`. Точная схема тела, коды ошибок (400/401/403/413/415/429/500) и инварианты - в [`CONTRACT.md`](CONTRACT.md) (раздел Files).

---

## 9. Краши: захват и доставка

Жёсткий краш убивает процесс до того, как успеет завершиться HTTP-отправка. Модель: захват краша всегда, доставка при первой возможности. Каждый необработанный краш в первую очередь (раньше любых предохранителей) синхронно пишется в дисковый outbox (Unity `persistentDataPath/FastLogs/pending/<id>.json`, GameMaker - каталог `pending`), и только затем идёт попытка обычного аплоада; успешная отправка удаляет файл. Если процесс умер до конца HTTP, файл остаётся, и на следующем старте `Init` / `fastlogs_init` сканирует очередь и дошлёт неотправленные краши прошлых сессий. Unity вдобавок дренит очередь в простое после текущих отправок.

Цикл одинаковых крашей не плодит файлы: захват дедупится по сигнатуре стека, а кап очереди (Unity `PendingCrashCap`, GameMaker `FASTLOGS_PENDING_MAX`, деф. 5) держит число файлов ограниченным. Предохранители ограничивают только **темп** аплоада, не захват: троттл (`MinSecondsBetweenAutoSends`, деф. 30 с), кап-на-сессию (`MaxAutoSendsPerSession`, деф. 10) и блокировка во время текущей отправки решают лишь, слать ли немедленно; пропущенный по ним отчёт уйдёт дренажем или на следующем старте. Постоянная `4xx` (400/401/403/413/415) убирает файл как poison-pill; транзиентные сбои (сеть, `statusCode 0`, `5xx`) остаются на диске.

Авто-отправка при краше включена по умолчанию в dev (`Auto-send > AutoSendOnException = true`, GameMaker `FASTLOGS_AUTOSEND_ON_EXCEPTION = true`), идёт без скриншота (упавший кадр редко полезен, а захват стоит кадр) и несёт контекст плюс breadcrumbs (раздел 5). В релизе и на консолях инструмент вырезан целиком - краши там не шлются by design (раздел 10).

При краше отчёт уже на сервере или доедет на следующем запуске - специально ничего делать не надо, просто откройте каталог `/browse` своей игры.

---

## 10. Платформы, гейтинг и релиз

### 10.1. Платформенные нюансы

- **WebGL**: `logEncoding = plain` (без gzip тела, чтобы не ловить preflight/CORS), отправка только через корутину, copy/open ссылки синхронно из обработчика клика. В Unity это делается автоматически.
- **iOS**: endpoint только `https://` (ATS).
- **GameMaker / HTML5**: `screen_save` на HTML5 не работает, скриншот там недоступен.
- Пустые и недоступные поля `device` клиент опускает (не шлёт `null`/`0`).
- `platform` в контракте: `WebGL | Android | iOS | Windows | macOS | Linux | GameMaker | PS4 | PS5 | Switch | Xbox | Other`.

### 10.2. Консоли и релиз: гейтинг

В ритейле и на консолях инструмента нет вообще - запрещённые сетевые и скриншот-вызовы просто не попадают в исполняемый код, поэтому нет лишних накладных расходов и конфликтов на сертификации.

**Unity.** Весь init / networking / overlay / screenshot / перехват логов компилируется только под дефайном:

```csharp
#if UNITY_EDITOR || DEVELOPMENT_BUILD || (LOGSHARE_FORCE_ENABLED && !(UNITY_PS4 || UNITY_PS5 || UNITY_GAMECORE || UNITY_SWITCH))
```

Публичный фасад `FastLogs.*` компилируется всегда, поэтому игровой код, зовущий FastLogs, билдится везде, включая ритейл и консоли. Void-методы (`Init`, `Log`, `StartRecording`, `ShowOverlay`, `SetContext`, `Send`, ...) помечены `[Conditional("UNITY_EDITOR"), Conditional("DEVELOPMENT_BUILD"), Conditional("LOGSHARE_FORCE_ENABLED")]`: в ритейле компилятор убирает и тело, и все места вызова вместе с аргументами. Методы с возвращаемым значением (`IsInitialized`, `IsRecording`, `Counts`, `SendAsync`, `RecordScope`) компилируются везде, но в вырезанном билде возвращают безопасные no-op-дефолты. Консольные платформы (PS4, PS5, GameCore, Switch) жёстко заблокированы `#if`-гардом - включить FastLogs на консоли без правки исходников пакета нельзя.

Runtime-гейт (`FastLogsGate`): в Editor смотрит `Enable > EnableInEditor`, в DEVELOPMENT_BUILD - `EnableInDevelopment`, в forced player - `EnableInRelease` (деф. `false`). Включить FastLogs в release-билде (mobile / standalone / WebGL, не консоль): `Tools > <Company> > FastLogs > Build Defines Helper` добавит дефайн `LOGSHARE_FORCE_ENABLED` для целевой платформы, затем `Config > Enable > EnableInRelease = true`. Делайте это только при осознанной необходимости - в проде пойдёт HTTP-трафик и опциональные скриншоты.

**GameMaker.** Гейтинг - через макрос `FASTLOGS_ENABLED`, заданный **по build-конфигу**:

```gml
#macro Default:FASTLOGS_ENABLED false   // релиз: клиент ВЫКЛ, контроллер не создаётся
#macro debug:FASTLOGS_ENABLED true      // отладка: клиент ВКЛ
```

Синтаксис config-scope чувствителен: пробела после двоеточия конфига быть не должно (`Default:FASTLOGS_ENABLED`, не `Default: FASTLOGS_ENABLED`). Имя `debug` обязано совпадать с именем build-конфига в `.yyp`. При `!FASTLOGS_ENABLED` каждая публичная функция делает безопасный ранний выход (no-op), контроллер в релизе не создаётся - значит в ритейле нет вызовов `http_request` / `screen_save`.

---

## 11. Приватность (приватно по умолчанию)

Из коробки наружу уходит минимум, а потенциальный PII режется ещё до отправки. Включать чувствительное и выключать чистку - осознанный шаг интегратора.

**Что НЕ уходит по умолчанию.** PII-чистка (Unity `Config > Diagnostics > ScrubPii = true`, GameMaker `FASTLOGS_SCRUB_PII = true`) разово, при сборке отчёта и при записи краша в outbox, прогоняет через redaction текст логов, значения контекста и тексты breadcrumbs: email, IPv4, IPv6, Bearer/Authorization-токены и длинные цифровые последовательности (9+ цифр подряд) заменяются на `[redacted]`. Чувствительные поля устройства, URL и идентификаторы под флагом, выключенным по умолчанию (Unity `IncludeSensitive = false` опускает device model, identifier приложения, а на WebGL - URL страницы и referrer; GameMaker `FASTLOGS_INCLUDE_SENSITIVE = false`). Сырой IP тестера клиент не шлёт вовсе - для rate-limit сервер берёт IP только из соединения и хранит как `salt + sha256` (см. `IP_SALT`), а не в открытом виде. Скриншот по умолчанию выключен. При обычной работе само ничего не уходит: все аплоады инициирует пользователь, единственное исключение - авто-отправка при краше (раздел 9), тоже проходит PII-чистку.

**Как включить больше или выключить чистку.** Чувствительные поля - через Unity `IncludeSensitive = true` или GameMaker `FASTLOGS_INCLUDE_SENSITIVE` / `fastlogs_init({ includeSensitive: true })`. Чистка выключается через Unity `ScrubPii = false` или GameMaker `FASTLOGS_SCRUB_PII` / `fastlogs_init({ scrubPii: false })`; тоггл есть и в панели настроек оверлея. Свои секреты добавляются паттернами: Unity `PiiScrubber.AddPattern("<regex>")` до первой отправки, GameMaker `fastlogs_redact_rules_set([...])` (дефолтный набор - `fastlogs_redact_default_rules()`).

**Осторожность.** Чистка - best-effort, а не гарантия. Она может перередактировать (длинное число, таймстемп или id из 9+ цифр уедет в `[redacted]`) - осознанный компромисс в пользу приватности; и наоборот, нестандартный формат секрета может не попасть под дефолтные паттерны. Логи и скриншоты всё равно могут содержать персональные данные - то, что вы сами туда пишете, имена в UI на скрине и т.п. Не логируйте секреты осознанно, а в контекст кладите идентификаторы, а не приватные сведения.

**Доступ и хранение.** Ссылка короткая, но непредсказуемая; несуществующий, просроченный или невалидный `id` отдаёт единый `404` (анти-перебор). Каталог `/browse` под командной авторизацией (viewer-токен). Записи живут настраиваемый срок (по умолчанию 30 дней), затем удаляются sweeper'ом; закреплённые (pin) не удаляются. Секреты (ingest-токены, `ADMIN_TOKEN`, `VIEWER_TOKEN`, `IP_SALT`) держите в `.env`/защищённом хранилище, не в репозитории.

---

## 12. Как смотреть логи

### По ссылке (вьюер)

`GET /<id>` - HTML-вьюер. Внутри: device-info сворачиваемыми группами; счётчики E/W/L и фильтр по уровню (Error / Warning / Log); поиск по тексту; сворачивание стектрейсов, переключение raw / pretty и copy; секции **Context** и **Breadcrumbs**, дерево **Scene Context** (если был приложен); скриншот, если был; кнопка **Pin**, чтобы запись не удалилась по ретеншну. Pin открыт прямо по ссылке вьюера (без viewer-токена), так что тестер сам закрепляет свой лог от удаления.

Дополнительно:

| Endpoint | Что отдаёт |
|----------|-----------|
| `GET /<id>/raw` | сырой лог (`?download=1` отдаст файлом, gzip passthrough) |
| `GET /<id>/screenshot` | первый PNG (индекс 0) |
| `GET /<id>/screenshot/<n>` | n-й PNG (0-based) |
| `GET /api/logs/<id>` | JSON для вьюера |

### Каталог (вся команда)

`GET /browse` - каталог под **viewer-токеном** (team / Basic / admin). Иерархия:

| Уровень | Endpoint | Что показывает |
|---------|----------|----------------|
| Project | `GET /browse` | список проектов (`appId` + отображаемое имя) |
| version | `GET /browse/<appId>` | версии (`appVersion`) с количеством записей |
| Log | `GET /browse/<appId>/<version>` | записи: id, title, время, платформа, counts, pinned |

Есть и группировка по сигнатуре краша: `GET /browse/<appId>/crashes`. Маппинг: **`<Company>`** = инстанс сервера, **Project** = `appId`, **version** = `appVersion`, **Log** = `id`.

### Уведомления (sinks)

Если админ настроил sinks, на каждый успешный ingest короткая ссылка прилетает в Slack / Discord / webhook / Confluence / Google Sheet (с фильтрами, напр. только при ошибках). Настройка - в [`docs/ADMIN-GUIDE.md`](docs/ADMIN-GUIDE.md).

---

## 13. Быстрый старт: сервер

Node.js >= 18, единственная зависимость - `better-sqlite3`.

```bash
cd server
cp .env.example .env        # задать BASE_URL, ADMIN_TOKEN, VIEWER_TOKEN, IP_SALT
npm install && npm start    # node src/server.js
node scripts/add-app.js <project> "<Name>" 30   # зарегистрировать игру (retention 30 дней)
```

Точка входа - `src/server.js`, но сам HTTP-роутер и регистрация эндпоинтов - в `src/index.js`. `add-app.js` печатает ingest-токен **один раз** (base62, ~238 бит), в БД хранится только его `sha256`-хеш. Позиционные аргументы: `appId` (`^[a-z0-9_-]{2,32}$`), `name`, опц. `retentionDays` (clamp в `[1, maxRetention]`). Опции: `--max-retention N`, `--no-token`, `--keep-token`, `--disabled`, `--token <value>`. Повторный запуск обновляет приложение и по умолчанию минтит новый токен (`--keep-token` сохраняет старый). Прочие npm-скрипты: `npm test`, `npm run sweep`, `npm run list-apps`, `npm run migrate`.

Ключевые переменные `.env`:

| Переменная | Назначение | Дефолт |
|-----------|------------|--------|
| `BASE_URL` | Публичный URL для коротких ссылок (обязательно сменить в проде) | `http://localhost:8787` |
| `ADMIN_TOKEN` | unpin, удаление, управление; пусто отключает admin-auth (dev) | пусто |
| `VIEWER_TOKEN` | Чтение каталога `/browse`; пусто **закрывает** каталог (fail-closed, 401 всем кроме admin) | пусто |
| `IP_SALT` | Соль для хеширования IP; поставить случайное значение | `change-me-please` |
| `DEFAULT_RETENTION_DAYS` / `MAX_RETENTION_DAYS` | Срок хранения по умолчанию / максимум | `30` / `365` |
| `CORS_ALLOW_ORIGIN` | CORS для WebGL | `*` |

Прочее (выборочно): `PORT=8787`, `HOST=127.0.0.1`, `DATA_DIR=./data`, `BLOB_DIR=./blobs`, `MAX_SCREENSHOTS=8`, `TEAM_INGEST_TOKEN`, `ALLOW_AUTO_REGISTER=0`, `TRUST_PROXY=1`, `SWEEP_INTERVAL_SEC=3600`, плюс triage/crash-signature/Redmine-настройки. Полная таблица переменных и деплой по systemd/Docker - в [`server/README.md`](server/README.md) и [`server/deploy/`](server/deploy/).

### Ingest и доп. эндпоинты

`POST /api/logs` принимает тело по контракту, на `201` отвечает `{ id, url, rawUrl, expiresAt }`. Несуществующий или просроченный `id` отдаёт единый `404`. Дополнительно: `POST /api/logs/<id>/pin`, `.../status`, `.../tags`, `.../redmine`, `GET /api/health`, `GET /api/await/:appId` (раздел 7.2).

---

## 14. Лимиты

| Параметр | Значение |
|----------|----------|
| nginx `client_max_body_size` | 10 MB (см. примечание про файлы ниже) |
| Тело запроса лога (`MAX_PAYLOAD_BYTES`) | ~8 MB |
| Скриншот PNG (`MAX_SCREENSHOT_BYTES`) | ~2 MB |
| Скриншотов на отчёт (`MAX_SCREENSHOTS`) | 8 |
| Распакованный лог (`MAX_LOG_BYTES`) | ~20 MB |
| Файл/папка, распакованный блоб (`MAX_FILE_BYTES`) | ~25 MB |
| Тело запроса `/api/files` (`MAX_FILE_BODY_BYTES`) | `MAX_FILE_BYTES`*4/3 + запас (~34 MB), **отдельно** от `MAX_PAYLOAD_BYTES` |
| Контекст | ~4 KB суммарно; ключ <= 64, значение <= 512 |
| Breadcrumbs | 100 шт / ~16 KB; текст <= 512 |
| `title` / `comment` / `tester` | <= 120 / <= 4000 / <= 120 |
| `correlationCode` | <= 64 |
| Retention | 30 дней по умолчанию, 365 максимум |

Клиент усекает лог по `MaxLogTextBytes` (Unity, деф. 1 MB) с пометкой об усечении ещё до отправки.

> **Файлы за nginx.** Лимит тела `/api/files` (`MAX_FILE_BODY_BYTES`, ~34 MB) отдельный и больше общего `MAX_PAYLOAD_BYTES` (8 MB) - так аплоад файла до `MAX_FILE_BYTES` помещается в base64-конверт. Но в дефолтном деплое nginx стоит `client_max_body_size 10m` ([`server/deploy/nginx-fastlogs.conf`](server/deploy/nginx-fastlogs.conf)), и он отрубит файлы крупнее ~7.5 MB (по распакованному размеру) ещё до Node. Чтобы выгружать файлы вплоть до `MAX_FILE_BYTES`, поднимите `client_max_body_size` для `/api/files` (или глобально) до уровня `MAX_FILE_BODY_BYTES`.

---

## 15. FAQ / troubleshooting

**Не пришла ссылка / отправка не сработала.** Проверьте по шагам: задан ли `EndpointUrl` / `FASTLOGS_ENDPOINT`; включена ли запись (по умолчанию ВЫКЛ - нажмите Start или включите автостарт); инициализирован ли клиент (`Init` / `fastlogs_init`); активен ли клиент в этом флейворе билда (в ритейле он вырезан - раздел 10). В Unity подпишитесь на `OnUploaded` или прочитайте `result.Error`; в GameMaker - `fastlogs_last_url()` пуст, смотрите Async HTTP `http_status`.

**Запись выключена - в логе пусто.** Включите `FastLogs.StartRecording()` / `fastlogs_record_start()`, либо автостарт (`AutoStartRecording` / `FASTLOGS_AUTO_START_RECORDING`), либо оберните участок в `RecordScope()`.

**Отправка просит подтверждение «возможно зацикливание».** Сработал анти-цикл (раздел 7.3): эта строка кода уже отправила больше `MaxCodeSendsPerSite` раз (деф. 10 с одного `file:line`). «Нет» заглушит её до конца сессии, «Да» пропустит и запишет в отчёт `loopConfirmedBy`/`loopSite`. Если это не цикл - поднимите порог, вынесите отправку в одно место или используйте `allowRepeat`.

**CORS / ошибка на WebGL.** На WebGL тело шлётся `plain` (без gzip), copy/open - из обработчика клика; клиенты делают это сами. Если всё равно CORS - проверьте `CORS_ALLOW_ORIGIN` (деф. `*`) и доступность endpoint с домена игры.

**Токен / 401 / 403.** `401` - игра требует токен, а он не передан: впишите `Token` / `FASTLOGS_TOKEN`. `403` - неверный токен или `appId` не зарегистрирован/выключен: попросите админа зарегистрировать игру (`scripts/add-app.js`). Токен показывается **один раз** при регистрации.

**`413 payload_too_large` / лог обрезан.** Превышены лимиты (раздел 14: тело лога ~8 MB, скриншот ~2 MB, распакованный лог ~20 MB). Уменьшите `MaxLogTextBytes` или размер скриншота (`MaxDimension`). Клиент сам усекает лог с пометкой об усечении. Для файлов/папок `413` означает превышение `MAX_FILE_BYTES` (~25 MB по распакованному размеру) - у `/api/files` свой больший лимит тела (`MAX_FILE_BODY_BYTES`, ~34 MB), не общий 8 MB; если деплой за nginx, проверьте ещё и `client_max_body_size` (раздел 14, примечание про файлы).

**iOS: отправка не идёт.** Endpoint должен быть `https://` (ATS); `http://` на iOS заблокирован системой.

**Каталог `/browse` просит логин / отдаёт 401.** Каталог под viewer-токеном; при пустом `VIEWER_TOKEN` он закрыт для всех, кроме admin (fail-closed). Возьмите viewer-токен у админа.

**`fastlogs-await` не дожидается лога.** Проверьте, что отчёт реально помечен кодом (`SetCorrelationCode` до отправки), что `--app` и `--code` совпадают, а `--token` - валидный viewer/admin. Exit 2 = таймаут (деф. 600 c), 1 = ошибка.

---

## 16. Структура репозитория

| Каталог | Что внутри |
|---------|-----------|
| [`CONTRACT.md`](CONTRACT.md) | Единый JSON-контракт API для всех клиентов (источник правды) |
| [`server/`](server/) | Сервер (Node + SQLite за nginx): ingest, вьюер, каталог, sinks, ретеншн + sweeper, тесты, деплой |
| [`unity/`](unity/) | UPM-пакет `com.<company>.fastlogs` (C#), ставится по git-URL |
| [`gamemaker/`](gamemaker/) | GML-клиент (скрипты `scr_fastlogs_*` + объект `obj_fastlogs_controller`) |
| [`docs/`](docs/) | Гайды: [`TEAM-GUIDE.md`](docs/TEAM-GUIDE.md) (интеграция с примерами), [`ADMIN-GUIDE.md`](docs/ADMIN-GUIDE.md) (деплой и админство) |

## Лицензия

MIT (см. [`LICENSE`](LICENSE)).