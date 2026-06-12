# FastLogs - логи игры в одну ссылку (гайд команды)

> Готово к вставке в Confluence. Полная версия с примерами - в репозитории: `docs/TEAM-GUIDE.md`. Источник правды по API - `CONTRACT.md`.
> Репозиторий: `https://github.com/PlayJoy/fastlogs` (замените на актуальный).

## Что это

FastLogs - кросс-движковый диагностический инструмент. Из запущенной игры одним жестом отправляешь рантайм-логи плюс полный срез устройства (и опц. скриншот) на свой сервер и получаешь короткую ссылку для просмотра в браузере. Ссылки складываются в каталог **PlayJoy -> Project -> version -> Log**. Движки: **Unity** и **GameMaker**. Платформы: WebGL, iOS, Android, Standalone. На консолях в релизе инструмент вырезается (без проблем на сертификации).

## Как пользуется тестер

1. Жест / хоткей (`F8`) -> открывается оверлей (счётчики E/W/L, тоггл "Скриншот").
2. Кнопка **Отправить**.
3. Короткая ссылка копируется в буфер (во вьюере есть QR).
4. По ссылке - вьюер: логи, фильтры, device-инфо, скриншот.

## Архитектура

|| Слой || Что делает ||
| Клиент (Unity C# / GameMaker GML) | Собирает кольцо логов + срез устройства + опц. скриншот, шлёт `POST /api/logs` (JSON по `CONTRACT.md`) |
| Сервер (Node + SQLite за nginx) | Принимает, хранит, отдаёт короткую ссылку, кладёт в каталог, асинхронно форвардит в sinks |
| Просмотр | Вьюер `GET /<id>`, командный каталог `GET /browse` |

```
Unity / GameMaker --POST /api/logs--> Сервер (SQLite + blobs) --> ссылка + каталог + sinks
```

---

## Быстрый старт: Unity

Версии Unity: **6000.1 (Unity 6)** и **2022.3 LTS**.

**1. Установка** (Git URL) - в `Packages/manifest.json`:

```json
{
  "dependencies": {
    "com.playjoy.fastlogs": "https://github.com/PlayJoy/fastlogs.git?path=/unity#main"
  }
}
```

**2. Конфиг**: `Tools > PlayJoy > FastLogs > Create Config Asset` (создаёт `Assets/Resources/FastLogsConfig.asset`).

**3. Заполнить секцию Server**:

|| Поле || Значение ||
| `EndpointUrl` | `https://logs.example.com/api/logs` (обязательно; на iOS только https) |
| `AppId` | `[a-z0-9_-]{2,32}` - Project в каталоге |
| `Token` | Bearer-токен ингеста (опц.) |
| `RetentionDaysOverride` | дни хранения; `0` = серверный дефолт |

**4. Код** (запись по умолчанию ВЫКЛ):

```csharp
using PlayJoy.FastLogs;

FastLogs.Init();              // грузит Resources/FastLogsConfig; идемпотентен
FastLogs.StartRecording();    // включить запись (или AutoStartRecording в конфиге)

FastLogs.Log("Checkpoint");
FastLogs.Warn("Low memory");
FastLogs.Error("Spawner failed");

using (FastLogs.RecordScope()) { /* пишется только этот участок */ }

var r = await FastLogs.SendAsync(includeScreenshot: true, title: "Crash on load");
if (r.Success) GUIUtility.systemCopyBuffer = r.Url;

FastLogs.ToggleOverlay();     // оверлей: F8 по умолчанию
```

В отчёт идут: логи (кольцо + ручные), полный device-срез, опц. скриншот. Готовый пример - сэмпл **Basic Usage** (Package Manager -> Samples).

---

## Быстрый старт: GameMaker

> Упакованного `.yymps` пока нет (планируется) - перенос ресурсов в свой проект **уточнить**. Пока берите скрипты `scr_fastlogs_*` и объект `obj_fastlogs_controller` из `gamemaker/FastLogsGM.yyp`.

**1. Перенести** в проект все `scr_fastlogs_*` и `obj_fastlogs_controller`; завести build-конфиг с именем `debug` (имя обязано совпадать с `.yyp`).

**2. Настроить `scr_fastlogs_config`**:

```gml
#macro FASTLOGS_ENDPOINT    "https://logs.example.com/api/logs"
#macro FASTLOGS_APP_ID      "mygame"
#macro FASTLOGS_TOKEN       ""
#macro FASTLOGS_APP_VERSION ""
```

**3. Контроллер** `obj_fastlogs_controller` (persistent) в первой комнате, либо `fastlogs_init()` в бутстрапе.

**4. Логирование** - одной строкой в существующий `trace()`:

```gml
function trace(_msg) {
    show_debug_message(_msg);
    flog(_msg);              // весь существующий лог идёт в FastLogs
}
```

**5. Запись и отправка** (по умолчанию ВЫКЛ):

```gml
fastlogs_record_start();             // включить запись
fastlogs_set_screenshot(true);       // опц. скриншот
fastlogs_send({ title: "Crash" });   // -> bool
fastlogs_toggle();                   // оверлей (vk_f8)
var url = fastlogs_last_url();
```

---

## Консоли и релиз (гейтинг)

В ритейле и на консолях инструмента **нет вообще** (накладные расходы = 0, нет конфликтов сертификации).

|| Движок || Механизм ||
| Unity | `#if UNITY_EDITOR \|\| DEVELOPMENT_BUILD` (+ `LOGSHARE_FORCE_ENABLED` для не-консольного release). Void-методы `[Conditional]` - стрипаются вместе с вызовами. PS4/PS5/GameCore/Switch жёстко заблокированы. **Публичный `FastLogs.*` компилируется всегда** - игра билдится везде. |
| GameMaker | `#macro Default: FASTLOGS_ENABLED false` / `#macro debug: FASTLOGS_ENABLED true`. В релизе контроллер не создаётся, все функции - no-op, нет `http_request`/`screen_save`. |

Включить в non-console release: Unity - `Build Defines Helper` (`LOGSHARE_FORCE_ENABLED`) + `EnableInRelease = true`; GameMaker - собирать конфигом `debug`.

---

## Приватность

* Логи и скриншоты могут содержать персональные данные.
* Скриншот по умолчанию **выключен**, только по явному запросу.
* Unity `Diagnostics > IncludeSensitive = false` опускает device model / identifier / URL / referrer.
* Ничего не шлётся автоматически (исключение: GM авто-отправка при краше, если включена).
* Доступ непубличный: короткая непредсказуемая ссылка, единый `404` на невалидный id, каталог под viewer-токеном.
* Ретеншн по умолчанию 30 дней; pin не удаляется.

---

## Как смотреть логи

**Вьюер** `GET /<id>`: фильтр E/W/L, поиск, raw/pretty, copy, сворачивание стектрейсов, device-группы, скриншот, кнопка pin (открыта по ссылке). Доп.: `/<id>/raw`, `/<id>/screenshot`.

**Каталог** `GET /browse` (под team viewer-токеном):

|| Уровень || Endpoint || Показывает ||
| Project | `/browse` | проекты (`appId` + имя) |
| version | `/browse/<appId>` | версии с количеством записей |
| Log | `/browse/<appId>/<version>` | записи: id, title, time, platform, counts, pinned |

Маппинг: PlayJoy = сервер, Project = `appId`, version = `appVersion`, Log = `id`.

---

## FAQ

|| Симптом || Что делать ||
| Не пришла ссылка | Проверь endpoint, включена ли запись (ВЫКЛ по умолчанию), вызван ли Init, не вырезан ли клиент в этом билде. Unity: `OnUploaded`/`result.Error`. GM: `http_status`. |
| Лог пустой | Включи запись: `StartRecording` / `fastlogs_record_start` / автостарт / `RecordScope`. |
| CORS на WebGL | Тело шлётся plain, copy/open из клика (делается автоматически). Проверь `CORS_ALLOW_ORIGIN` на сервере. |
| 401 / 403 | 401 - не передан токен (впиши `Token`/`FASTLOGS_TOKEN`). 403 - неверный токен или `appId` не зарегистрирован: попроси админа. |
| 413 / лог обрезан | Превышены лимиты (тело ~8MB, скриншот ~2MB, лог ~20MB). Уменьши `MaxLogTextBytes`/скриншот. |
| iOS не шлёт | Endpoint обязан быть `https://` (ATS). |

---

См. также: `CONTRACT.md` (контракт API), `unity/README.md`, `gamemaker/PUBLIC-API.md`, `docs/ADMIN-GUIDE.md` (для девопса).
