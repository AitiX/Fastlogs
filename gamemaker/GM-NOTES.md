# FastLogs GameMaker client - заметки разработчика

Технические заметки по формату проекта GMS2 2024.x и сверке GML-API.
Источник формата: разбор реального проекта `E:\Repositories\Chivalware` (IDE 2024.14.2.213).

---

## 1. Формат проекта GMS2 2024.x (как устроено на диске)

Все ресурсные файлы (`.yyp`, `.yy`) - это **JSON с висячими (trailing) запятыми** и
ключами в кавычках. Каждый файл начинается с тег-ключа типа (`"$GMProject":"v1"`,
`"$GMScript":"v1"`, `"$GMObject":""`, `"$GMFolder":""`) и заканчивается полями
`"resourceType"` + `"resourceVersion":"2.0"`. Висячая запятая после последнего поля и
перед `}` / `]` - это **норма** для GM, её надо сохранять.

### 1.1. `.yyp` (корневой проект, `$GMProject` v1)

Ключевые секции (порядок как в Chivalware):

```jsonc
{
  "$GMProject":"v1",
  "%Name":"<ProjectName>",
  "AudioGroups":[ {"$GMAudioGroup":"v1","%Name":"audiogroup_default","exportDir":"","name":"audiogroup_default","resourceType":"GMAudioGroup","resourceVersion":"2.0","targets":-1,} ],
  "configs":{ "children":[ {"children":[],"name":"debug",} ], "name":"Default", },  // дерево build-конфигов
  "defaultScriptType":1,
  "Folders":[ /* список GMFolder, см. 1.2 */ ],
  "IncludedFiles":[ /* GMIncludedFile, можно пусто [] */ ],
  "isEcma":false,
  "LibraryEmitters":[],
  "MetaData":{ "IDEVersion":"2024.14.2.213", },
  "name":"<ProjectName>",
  "resources":[ /* плоский список ВСЕХ ресурсов, см. 1.3 */ ],
  "resourceType":"GMProject",
  "resourceVersion":"2.0",
  "RoomOrderNodes":[ {"roomId":{"name":"rm_init","path":"rooms/rm_init/rm_init.yy",},} ],  // порядок комнат
  "templateType":"game",
  "TextureGroups":[ {"$GMTextureGroup":"",...,"name":"Default",...} ],
}
```

Примечания:
- `configs` - дерево конфигов сборки. `name:"Default"` - корень, `children` - вложенные
  (напр. `debug`). Имя конфига используется в per-config макросах (`#macro debug:NAME ...`).
- `resources` - **плоский** массив; КАЖДЫЙ ресурс (скрипт, объект, комната, спрайт...)
  обязан быть тут перечислен, иначе IDE его не видит.
- `RoomOrderNodes` - обязателен хотя бы с одной комнатой, иначе игра не запустится
  (для библиотеки-скелета комната не нужна; но чтобы проект открывался без ошибок,
  RoomOrderNodes может быть пустым `[]` - комнату добавит интегратор).
- `MetaData.IDEVersion` - версия IDE; GM при открытии сам обновит/нормализует.

### 1.2. Запись папки в `Folders[]` (`$GMFolder`)

```jsonc
{"$GMFolder":"","%Name":"FastLogs","folderPath":"folders/FastLogs.yy","name":"FastLogs","resourceType":"GMFolder","resourceVersion":"2.0",}
```

- `folderPath` - виртуальный путь вида `folders/<...>.yy` (на диске **файла нет**, это
  логический путь дерева ресурсов). Вложенность кодируется через `/` в `folderPath`.
- На имя этой папки ссылаются ресурсы в поле `parent` (см. 1.4/1.5).

### 1.3. Ссылка на ресурс в `resources[]`

```jsonc
{"id":{"name":"obj_fastlogs_controller","path":"objects/obj_fastlogs_controller/obj_fastlogs_controller.yy",},}
{"id":{"name":"scr_fastlogs_core","path":"scripts/scr_fastlogs_core/scr_fastlogs_core.yy",},}
```

`name` = имя ресурса, `path` = относительный путь к `.yy`-файлу от корня проекта.

### 1.4. `.yy` скрипта (`$GMScript` v1)

```jsonc
{
  "$GMScript":"v1",
  "%Name":"scr_fastlogs_core",
  "isCompatibility":false,
  "isDnD":false,
  "name":"scr_fastlogs_core",
  "parent":{ "name":"FastLogs", "path":"folders/FastLogs.yy", },  // ссылка на GMFolder
  "resourceType":"GMScript",
  "resourceVersion":"2.0",
}
```

Код скрипта лежит рядом: `scripts/<name>/<name>.gml`. Один `.gml` может содержать
несколько `function ...() {}` (в GMS2 скрипт-ассет = файл с функциями).

### 1.5. `.yy` объекта (`$GMObject`)

```jsonc
{
  "$GMObject":"",
  "%Name":"obj_fastlogs_controller",
  "eventList":[ /* список GMEvent, см. 1.6 */ ],
  "managed":true,
  "name":"obj_fastlogs_controller",
  "overriddenProperties":[],
  "parent":{ "name":"FastLogs", "path":"folders/FastLogs.yy", },
  "parentObjectId":null,       // объект-родитель (наследование), null = нет
  "persistent":true,           // переживает смену комнаты - НУЖНО контроллеру
  "physicsAngularDamping":0.1, "physicsDensity":0.5, "physicsFriction":0.2,
  "physicsGroup":1, "physicsKinematic":false, "physicsLinearDamping":0.1,
  "physicsObject":false, "physicsRestitution":0.1, "physicsSensor":false,
  "physicsShape":1, "physicsShapePoints":[], "physicsStartAwake":true,
  "properties":[],
  "resourceType":"GMObject", "resourceVersion":"2.0",
  "solid":false, "spriteId":null, "spriteMaskId":null, "visible":true,
}
```

Поля physics* обязательны в схеме объекта (значения по умолчанию как выше).
`spriteId:null` - объект без спрайта (оверлей рисуем примитивами).

### 1.6. Событие (`$GMEvent`) и где лежит его код

Запись события в `eventList`:

```jsonc
{"$GMEvent":"v1","%Name":"","collisionObjectId":null,"eventNum":<N>,"eventType":<T>,"isDnD":false,"name":"","resourceType":"GMEvent","resourceVersion":"2.0",}
```

Код события - отдельный файл `objects/<obj>/<EventFile>.gml`. Имя файла = `<Тип>_<eventNum>.gml`.

Сверенная по Chivalware карта (`obj_director`) тип/номер -> файл:

| Событие         | eventType | eventNum | Файл события            |
|-----------------|-----------|----------|-------------------------|
| Create          | 0         | 0        | `Create_0.gml`          |
| Step (Normal)   | 3         | 0        | `Step_0.gml`            |
| Step Begin      | 3         | 1        | `Step_1.gml`            |
| Step End        | 3         | 2        | `Step_2.gml`            |
| Alarm[0]        | 2         | 0        | `Alarm_0.gml`           |
| Draw (Normal)   | 8         | 0        | `Draw_0.gml`            |
| Draw GUI        | 8         | 64       | `Draw_64.gml`           |
| Draw GUI End    | 8         | 65       | `Draw_65.gml`           |
| Async - HTTP    | 7         | 62       | `Other_62.gml`          |
| Async - Save/Load | 7       | 63       | `Other_63.gml`          |
| Async - System  | 7         | 75       | `Other_75.gml`          |

ВАЖНО (подтверждено разбором `obj_director`: там есть `Draw_64.gml`, `Draw_75/76/77.gml`,
`Other_3/4/5.gml`): файлы Async-событий (`eventType 7`) именуются `Other_<eventNum>.gml`,
а НЕ `Async_*.gml`. Draw-семейство (`eventType 8`) - `Draw_<eventNum>.gml`.

Значения eventNum для Async (eventType 7), сверено с практикой GM:
- Async HTTP = **62** -> `Other_62.gml`
- Async Save/Load = **63** -> `Other_63.gml`
- Async System = 75, Async Networking = 68, Async Dialog = 63? (нет - 63 это Save/Load).
  // TODO verify точные номера прочих Async по IDE при импорте; для нас критичны 62 и 63.

В этом скелете у `obj_fastlogs_controller` события:
Create (0/0), Step (3/0), Alarm[0] (2/0 -> `Alarm_0.gml`), Draw GUI (8/64),
Async HTTP (7/62 -> `Other_62.gml`), Async Save/Load (7/63 -> `Other_63.gml`).

ПРИМЕЧАНИЕ по RETRY-UNTIL-SUCCESS (фича RETRY): отложенный повтор отправки реализован на
`Alarm[0]` контроллера. Используемые GML-механизмы (стабильные built-in, сверить по Manual
при импорте, online недоступен):
- `alarm[i] = frames;` - аксессор массива alarm[0..11] инстанса. GM каждый Step сам
  декрементирует и вызывает событие `Alarm[i]` при достижении 0. `alarm[i] = -1` выключает.
  Счётчик в ШАГАХ (кадрах логики), поэтому секунды -> кадры по `game_get_speed(gamespeed_fps)`.
  Tick раз в секунду (перевзвод на 1 c), а НЕ опрос в кадре. // TODO verify поведение alarm на
  persistent-инстансе через смену комнат (ожидается: счётчик сохраняется вместе с инстансом).
- `with (obj_fastlogs_controller) { alarm[0] = ... }` - адресуем единственный persistent-
  контроллер из скрипта (alarm принадлежит инстансу, не скрипту). `instance_exists(obj_..)`
  перед `with` как страховка. // TODO verify (стандартный `with`/`instance_exists`).
- `game_get_speed(gamespeed_fps)` - уже используется в overlay (`fastlogs_ui_toast_frames_for`).

ПРИМЕЧАНИЕ по скриншоту: `screen_save()` рекомендуется звать в **Draw GUI End (8/65)**
для консистентного результата. В текущем скелете скриншот снимается из публичного API/Draw GUI;
если потребуется надёжный кадр - билдер оверлея/скриншота может добавить событие Draw GUI End (8/65).

---

## 2. Verified GML APIs (сверка WebSearch, июнь 2026)

Помечено `// TODO verify` всё, что не удалось подтвердить дословно (manual.gamemaker.io
отдаёт 403 на прямой fetch; зеркала редиректят на него; часть деталей бралась из
сводки поиска и форумов).

### 2.1. HTTP (async)

`request_id = http_request(url, method, header_map, body);` - ПОДТВЕРЖДЕНО.
- `url` (string) - с протоколом (`http://` / `https://`).
- `method` (string) - `"GET"|"POST"|"PUT"|"DELETE"|...`.
- `header_map` - **DS map** key/value строк (НЕ struct). Ключ без двоеточия. Создаём
  `ds_map_create()`, наполняем `ds_map_add(m,"Content-Type","application/json")`,
  после вызова `ds_map_destroy(m)` (карту можно уничтожать сразу - GM копирует значения).
- `body` (string) - тело; если не нужно, `""` или `0`.
- Возвращает **request id** (real) для сопоставления в Async HTTP событии.

Async HTTP event (eventType 7 / eventNum 62), читаем `async_load` (ds_map) - ПОДТВЕРЖДЕНО
(сверено WebSearch июнь 2026, manual http_request/async_load):
- `async_load[? "id"]` - id запроса (сравнить со своим сохранённым).
- `async_load[? "status"]` - **`1` = данные ещё качаются (progress)**, **`0` = загрузка завершена (финал)**,
  **`<0` = ошибка**. (Уточнение: финал именно `0`, НЕ ">0". Раньше тут было неверно.)
- `async_load[? "http_status"]` - HTTP-код (200/201/4xx/5xx). При сетевой ошибке может быть 0.
- `async_load[? "result"]` - тело ответа (string), доступно при финале. ПРИМ.: при http_status != 2xx
  поле `result` может быть пустым (известный баг YoYo #5287) - не полагаться на тело при не-2xx.
- `async_load[? "response_headers"]` - **ds_map заголовков ответа** (ИМЯ КЛЮЧА: `response_headers`,
  НЕ `result_headers`). Может отсутствовать -> проверять `ds_exists(map, ds_type_map)` перед чтением.

Прочее: `http_set_request_crossorigin(...)` (HTML5/CORS), `http_set_connect_timeout(ms)` существует.

### 2.2. Скриншот / base64 PNG

- `screen_save(fname)` - ПОДТВЕРЖДЕНО: сохраняет PNG финального рендера application surface
  (или окна, если app surface выключен). Рекомендовано звать в **Draw GUI End**.
  **НЕ работает на HTML5.** Возврат не документирован как значимый.
- `screen_save_part(fname,x,y,w,h)` - часть экрана в PNG.
- `surface_save(surface_id, fname)` / `surface_save_part(...)` - PNG из surface; только формат
  `surface_rgba8unorm` (дефолт).
- `buffer_get_surface(buffer, surface, offset)` - ПОДТВЕРЖДЕНО (пишет **сырые RGBA** пиксели
  в буфер, это НЕ PNG). Для PNG в base64 НЕ годится напрямую.
- `buffer_base64_encode(buffer, offset, size)` - ПОДТВЕРЖДЕНО: возвращает base64-строку
  из участка буфера.

**Выбранный путь для `screenshotPng` (чистый base64 PNG, по контракту, без `data:`):**
1. `screen_save(tmp_png)` в безопасной точке Draw (Draw GUI / Draw GUI End).
2. `var b = buffer_load(tmp_png);`  // читает PNG-файл целиком в буфер
3. `var s = buffer_base64_encode(b, 0, buffer_get_size(b));`
4. `buffer_delete(b);` и удалить tmp-файл.
Так в base64 попадают именно PNG-байты файла. (Альтернатива `buffer_get_surface`+ручной PNG
не нужна и сложнее.) // TODO verify: на некоторых платформах screen_save пишет асинхронно/в
sandbox - проверить, что файл готов к buffer_load в том же кадре (при необходимости отложить
на следующий шаг).

### 2.3. OS / устройство

- `os_type` - константа платформы (`os_windows`, `os_macosx`, `os_linux`, `os_android`,
  `os_ios`, `os_tvos`, `os_ps4`, `os_ps5`, `os_switch`, `os_xboxone`, `os_xboxseriesxs`,
  `os_uwp`, ...). Маппим в `platform` контракта (Windows/macOS/Linux/Android/iOS/PS4/PS5/Switch/Xbox/Other).
  Спец-случай контракта: значение `"GameMaker"` допустимо как обобщённая платформа, но лучше
  слать конкретную ОС, когда известна.
- `os_version` (real) - версия ОС (напр. Windows 10 -> 655360). // TODO verify формат на iOS/Android.
- `os_device` - DEPRECATED (для мобильных), предпочтительно `os_get_info()`.
- `os_get_info()` - возвращает **ds_map** с платформо-зависимыми ключами (видеоадаптер, память,
  GPU и т.п.); карту нужно `ds_map_destroy()`. Точный набор ключей по платформам
  // TODO verify по IDE при импорте (manual отдаёт 403, зеркало docs2 недоступно).
  Маппинг ключей в `device{...}` контракта делает scr_fastlogs_device/payload.
- `os_browser` - тип браузера на HTML5 (`browser_chrome`, ...), иначе `browser_not_a_browser`.
- Доп. сведения: `display_get_width/height()`, `window_get_width/height()`,
  `display_get_dpi()` (есть не везде // TODO verify), `os_get_language()`, `os_get_region()`,
  `os_get_config()` (имя build-конфига), `GM_runtime_version`, `GM_version`, `gpu_get_*`.

### 2.4. Исключения

- `exception_unhandled_handler(callback)` - ПОДТВЕРЖДЕНО: перехват необработанных исключений.
  Колбэк получает **exception struct** с полями: `message` (string, короткое),
  `longMessage` (string, длинное), `script` (string, где возникло),
  `stacktrace` (array of string). Игра **всё равно закроется** после колбэка - "продолжить"
  нельзя. Поэтому в колбэке: записать в лог (recorder, на диск синхронно) и по возможности
  попытаться отправить (best-effort; async-отправка может не успеть до закрытия -> главное
  персист на диск, отправка на следующем запуске).
  В 2024.1400.2 пофикшен баг с анонимной функцией из расширения.

### 2.5. Буфер обмена

- `clipboard_set_text(string)` / `clipboard_get_text()` / `clipboard_has_text()` - ПОДТВЕРЖДЕНО
  как стандартные функции. // TODO verify доступность на консолях (обычно нет -> гейтить).

### 2.6. Персист настроек / файлы

- `ini_open(fname)` ... `ini_write_string/real(sec,key,val)` / `ini_read_string/real(sec,key,def)`
  ... `ini_close()` - для мелких настроек (вкл/выкл записи, hotkey). Файл в `game_save_id`.
- `game_save_id` - путь к sandbox-папке сохранений (с завершающим слешем). Запись лога/ini сюда.
  Для лог-файла: `game_save_id + "fastlogs/..."` (создать каталог при необходимости через
  работу с файлами/буферами).
- Буферы файлов: `buffer_load(fname)`, `buffer_save(buf,fname)`, `buffer_save_ext`,
  `buffer_create`, `buffer_write/read`, `buffer_get_size`, `buffer_delete`.
- `file_exists`, `file_delete`, `directory_exists`, `directory_create`.

### 2.7. JSON (struct-based)

- `json_stringify(value, [prettify], [filter])` - struct/array -> JSON-строка. Функции структа
  не сериализуются. В 2024.x есть необяз. `prettify` (bool) и `filter`.
- `json_parse(string, [filter], [inhibit_string_convert])` - JSON -> вложенные struct/array.
  Рекомендуется `option_legacy_json_parsing=false` (struct-режим). Для тела запроса собираем
  обычный GML-struct и `json_stringify`. ВНИМАНИЕ: для управления порядком/опусканием пустых
  полей device проще собирать строку/структ вручную и опускать пустые ключи (контракт требует
  НЕ слать пустые/`null`).
- ISO-8601 UTC `timestampUtc`: GM не даёт готового UTC-ISO. Берём `date_*`/`get_timer` +
  `date_get_timezone`/перевод в UTC и форматируем `YYYY-MM-DDThh:mm:ssZ` вручную в util.
  // TODO verify лучший способ UTC в GM (часто используют date_to_struct + ручной offset).

### 2.8. Чистка PII / redaction (фича #3) - НЕТ нативного regex

GameMaker **не имеет нативного runtime-regex** (сверено WebSearch, июнь 2026: manual даёт
только `string_replace`/`string_replace_all` по ЛИТЕРАЛАМ; regex - только сторонние extension'ы
типа RegexGM, которые ломают zero-dependency drop-in клиента). Поэтому redaction в
`scr_fastlogs_util` реализован **ручными GML-сканерами** строк (regex-эквиваленты), один проход
O(n), РАЗОВО при сборке payload/краша (не в кадре). Используемые built-in (СВЕРИТЬ по Manual
при импорте, manual отдаёт 403 на прямой fetch):
- `ord(string)` -> Unicode codepoint первого символа.                     // TODO verify
- `string_char_at(str, pos)` -> символ на позиции `pos` (1-based).        // TODO verify
- `string_lower(str)`, `string_pos`, `string_copy`, `string_length`,
  `string_replace_all` - стандартные строковые (1-based позиции).
Правила РАСШИРЯЕМЫ: `fastlogs_redact_rules_set([{name, matcher}])`. Каждый matcher:
`(str, pos) -> длина совпадения в символах | 0`. Покрытие: email / IPv4 (с проверкой октетов) /
IPv6 (консервативно, >=2 двоеточий) / Bearer+Authorization токены / длинные цифры (>=N подряд).

### 2.9. Дисковая очередь pending краша (фича #1) - перечисление файлов

- `file_find_first(mask, attr)` / `file_find_next()` / `file_find_close()` - ПОДТВЕРЖДЕНО
  (manual): перебор файлов по маске (напр. `dir + "/*.json"`), `attr=0` -> обычные файлы.
  `file_find_first` возвращает **только имя файла** (без пути) -> путь склеиваем сами; вернёт
  `""` когда файлов больше нет; `.`/`..` пропускаем; ОБЯЗАТЕЛЬНО `file_find_close()`.
- `array_sort(array, true)` - ПОДТВЕРЖДЕНО: сортировка строкового массива по алфавиту (asc).
  Имена pending-файлов начинаются с zero-padded UTC -> лексикографический порядок = хронологический.
- `directory_create(dir)` / `directory_exists(dir)` - создание/проверка каталога в `game_save_id`.
- `variable_struct_remove(struct, name)` / `variable_struct_set/get` - ПОДТВЕРЖДЕНО (2.3.1+).
- Пути относительны `game_save_id` (как у лог-файла рекордера). // TODO verify поведение
  file_find_* в sandbox на консолях/HTML5 (там перечисление может быть ограничено -> в этом
  случае досыл просто вернёт 0, краш всё равно записан и попытается уйти немедленно).

---

## 3. Консоль-безопасность (гейтинг)

`#macro FASTLOGS_ENABLED` задаётся per-config:
```gml
#macro Default:FASTLOGS_ENABLED false
#macro debug:FASTLOGS_ENABLED  true
```
(паттерн как `__INPUT_DEBUG_*` / `__SCRIBBLE_DEBUG`). Имя `debug` должно совпадать с именем
build-конфига в `.yyp` (`configs`). В этом скелете заведён конфиг `debug`.

Все публичные входные точки при `!FASTLOGS_ENABLED` делают ранний выход; контроллер в релизе
не создаётся -> в ритейле НЕТ вызовов `http_request`/`screen_save` (чисто для сертификации
PS/Switch/Xbox: запрещённые сетевые/скриншот-вызовы не попадают в сборку по факту исполнения).

---

## 4. Открытые вопросы / TODO verify (собрать при первом импорте в IDE)

1. Точные `eventNum` для Async-событий, кроме HTTP(62)/Save-Load(63).
2. Набор ключей `os_get_info()` по платформам (Windows/Android/iOS/консоли).
3. Поведение `screen_save` относительно готовности файла в том же кадре (sync vs async).
4. Наличие/тип `async_load[? "result_headers"]` в 2024.x.
5. Лучший способ получения UTC ISO-8601 в GML.
6. Доступность `clipboard_*` и `display_get_dpi` на целевых платформах.

## Источники (сверка API)
- http_request: https://manual.gamemaker.io/monthly/en/GameMaker_Language/GML_Reference/Asynchronous_Functions/HTTP/http_request.htm
- async_load: https://manual.gamemaker.io/beta/en/GameMaker_Language/GML_Overview/Variables/Builtin_Global_Variables/async_load.htm
- screen_save: https://manual.gamemaker.io/lts/en/GameMaker_Language/GML_Reference/Cameras_And_Display/screen_save.htm
- surface_save: https://manual.gamemaker.io/lts/en/GameMaker_Language/GML_Reference/Drawing/Surfaces/surface_save.htm
- buffer_base64_encode: https://manual.gamemaker.io/lts/en/GameMaker_Language/GML_Reference/Buffers/buffer_base64_encode.htm
- buffer_get_surface: https://manual.gamemaker.io/beta/en/GameMaker_Language/GML_Reference/Buffers/buffer_get_surface.htm
- exception_unhandled_handler: https://manual.gamemaker.io/beta/en/GameMaker_Language/GML_Reference/Debugging/exception_unhandled_handler.htm
- json_parse: https://manual.gamemaker.io/beta/en/GameMaker_Language/GML_Reference/File_Handling/Encoding_And_Hashing/json_parse.htm
- json_stringify: https://manual.gamemaker.io/lts/en/GameMaker_Language/GML_Reference/File_Handling/Encoding_And_Hashing/json_stringify.htm
- os_version: https://manual.gamemaker.io/monthly/en/GameMaker_Language/GML_Reference/OS_And_Compiler/os_version.htm
