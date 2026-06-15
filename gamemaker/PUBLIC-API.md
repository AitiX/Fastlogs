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
  `endpoint, appId, token, appVersion, retentionDays, autoStartRecording, screenshot, tester,
  scrubPii, sessionId, autosendPatterns` (любое подмножество). Отсутствующие берутся из
  `scr_fastlogs_config`.
- `sessionId` (#9, опц.): GUID запуска. Если не задан - генерируется автоматически
  (RFC4122-v4-образный). Уходит с КАЖДЫМ отчётом в поле `sessionId` (см. ниже).
- `autosendPatterns` (#9, опц.): массив строк-паттернов авто-отправки по логу (см. раздел
  "Авто-отправка по паттерну").
- Возврат: `instance id` контроллера, либо `noone` если `!FASTLOGS_ENABLED`.
- Идемпотентна (повторный вызов не плодит контроллеры). `sessionId` фиксируется при ПЕРВОМ
  вызове `fastlogs_init` и далее не меняется в пределах запуска.

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
- `opts_struct` (опц., struct): `title` (string, <=120), `comment` (string, <=4000 -
  свободное описание проблемы тестером, уходит в поле `comment`; пустое опускается),
  `retentionDays` (int), `screenshot` (bool override), `extraDevice` (struct, доп. поля в device),
  `sentViaCode` (bool, батч B - см. ниже).
- Поле `tester` (имя тестера, <=120) НЕ передаётся через opts: оно берётся из настройки
  `FASTLOGS_TESTER` (или runtime-override `fastlogs_init({ tester })`, либо введённого в оверлее
  имени) и уходит с КАЖДЫМ отчётом автоматически; пустое опускается.
- `sentViaCode` (батч B): `true` -> отчёт инициирован из КОДА игры (прямой `fastlogs_send`/
  `fastlogs_quick_send` из кода интегратора, авто-отправка по паттерну, авто-отправка по крашу) -
  в payload уходит ключ `"sentViaCode": true` (паритет с Unity/сервером/вьюером для badge "code").
  Кнопка "Отправить" в ОВЕРЛЕЕ его НЕ ставит -> ручной send уходит БЕЗ `sentViaCode` (сервер
  трактует отсутствие как `false`; пустое не шлём). `callerFile`/`callerLine` для GM-клиента
  НЕ отправляются: в GML нет переносимой интроспекции места вызова (аналога C#
  `CallerFilePath`/`CallerLineNumber`) - фейк слать нельзя, поля осознанно ОПУЩЕНЫ.
- После УСПЕШНОЙ отправки при `FASTLOGS_COPY_ON_SEND` (деф. true) короткая ссылка (`url`)
  автоматически копируется в буфер обмена устройства. На WebGL копирование требует
  user-gesture и может не сработать (не падаем; кнопка "Копировать" в оверлее - fallback).
- Поведение: асинхронно (`http_request`); ответ обрабатывается в Async HTTP событии
  (`Other_62.gml`), при `201` заполняется `last_url`. Возврат: `true` если запрос
  поставлен в отправку, `false` если no-op (выключено / нет endpoint / уже идёт отправка
  или ожидается отложенный повтор текущего отчёта - новая отправка блокируется до успеха).
- RETRY-UNTIL-SUCCESS (фича RETRY): если отправка финально провалилась по ТРАНЗИЕНТНОЙ
  причине (сеть/5xx) даже после немедленных ретраев аплоадера, отчёт ставится на
  ОТЛОЖЕННЫЙ повтор каждые `FASTLOGS_RETRY_INTERVAL_SEC` секунд (деф. 30; 0 = выкл) и
  повторяется, пока не пройдёт успешно или пока не упрётся в `FASTLOGS_RETRY_MAX` (деф. 0
  = без предела). Pending всегда ОДИН: пока отчёт не отправлен успешно, новый `fastlogs_send`
  БЛОКИРУЕТСЯ (no-op + статус "Отправка уже идёт (ждём повтор)"), не отменяя текущий pending
  и не стартуя параллельную отправку - включая окно ОЖИДАНИЯ между попытками. Сам цикл повтора
  при этом продолжает слать текущий отчёт. Во время ожидания показывается статус "Повтор через
  Ns...". 4xx считается невосстановимым -> отложенный повтор не ставится (терминальный тост-ошибка).
- При `!FASTLOGS_ENABLED` -> `false` (no-op), `http_request` НЕ вызывается.

### `fastlogs_is_sending()` -> bool
`true`, пока есть незавершённый запрос (включая идущую отложенную попытку повтора).
Между отложенными попытками (ожидание по таймеру) -> `false`. При `!FASTLOGS_ENABLED` -> `false`.

### `fastlogs_retry_is_pending()` -> bool  (фича RETRY)
`true`, если есть отчёт, ожидающий отложенного повтора (идёт обратный отсчёт по таймеру).
При `!FASTLOGS_ENABLED` -> `false`.

### `fastlogs_last_url()` -> string
URL последнего успешно созданного лога (из ответа сервера). `""` если ещё нет.

### Авто-отправка по паттерну в логе (фича #9)
Список строк-паттернов `FASTLOGS_AUTOSEND_PATTERNS` (деф. `[]` = выкл; runtime-override
`fastlogs_init({ autosendPatterns: [...] })`). Если очередной `flog` (любого уровня)
**совпадает** с одним из паттернов - автоматически делается `fastlogs_send` текущей записи
(без скриншота, `title: "Auto-send (pattern)"`). Авто-отправка по паттерну уважает **тот же
троттл/лимит сессии**, что и авто-отправка по крашу
(`FASTLOGS_AUTOSEND_THROTTLE_SECONDS` / `FASTLOGS_AUTOSEND_SESSION_LIMIT` / оконный дедуп по
тексту), поэтому повторяющийся маркер не спамит сервер. Есть re-entrancy guard: логи/статусы
самого пути отправки не запускают авто-отправку рекурсивно.

> **ОГРАНИЧЕНИЕ (нет нативного regex в GML):** матч НЕ регулярка. Это регистронезависимая
> **подстрока** + минимальный glob через `*` ТОЛЬКО по краям паттерна:
> `"foo"` -> содержит `foo`; `"*foo"` -> ОКАНЧИВАЕТСЯ на `foo`; `"foo*"` -> НАЧИНАЕТСЯ с `foo`;
> `"*foo*"` -> подстрока. `*` в СЕРЕДИНЕ паттерна трактуется буквально (полноценный glob/regex
> не поддержан). Реализация - `scr_fastlogs_core` (`__fastlogs_log_matches_autosend`).

---

## sessionId (фича #9)

С КАЖДЫМ отчётом (payload) уходит опциональное поле `sessionId` - GUID **текущего запуска**
(один на всю сессию). Генерируется в `fastlogs_init` (RFC4122-v4-образный) либо задаётся явно
`fastlogs_init({ sessionId: "..." })`. Помогает группировать все отчёты одного запуска во вьюере.
Получить значение - `fastlogs_session_id()`. Пустое (до `fastlogs_init`) - в payload опускается.

---

## Отправка файла / папки (фича SEND-FILE)

Отдельно от лог-отчёта: отправить произвольный **файл** или **папку** на сервер и получить
короткую ссылку (как у отчёта), скачать через вьюер кнопкой Download. Транспорт - **JSON +
base64** на **отдельный** `POST <BASE_URL>/api/files` (НЕ multipart, НЕ внутри лог-отчёта).
Реализация - `scr_fastlogs_files`. Конфиг: `FASTLOGS_FILES_ENDPOINT` (`""` -> выводится из
`FASTLOGS_ENDPOINT` заменой `/api/logs`->`/api/files`), `FASTLOGS_MAX_FILE_BYTES` (деф. 25 MB).
Типовой кейс: выгрузить файл сейва с устройства разработчику - `fastlogs_send_file(game_save_id
+ "save01.dat", { title: "Сейв перед крашем", kind: "save" })`.

> **ИНВАРИАНТ:** к бинарю/именам файлов **PII-скраб НЕ применяется** - только кап по размеру.
> Файл/сейв уходит как есть (это сознательно).

Общие `opts` (опц., struct) для всех трёх функций:
`title` (string, <=120), `logId` (string - привязать к лог-отчёту, попадёт в `attachments`
вьюера), `groupId` (string - группировка аплоадов), `mime` (string - переопределить MIME),
`kind` (string - тип вложения; если не задан, проставляется автодефолт - `"file"` для
`fastlogs_send_file`, `"folder"` для `fastlogs_send_folder`/`fastlogs_send_files` - паритет с
Unity; явный `opts.kind` не переопределяется), `retentionDays` (int, <1 не шлётся), `name` (string -
переопределить имя файла в архиве/каталоге), `onDone` (function(result) - колбэк завершения,
вызывается из `Other_62.gml` после ответа сервера).

Структура `result` в `onDone`:
`{ success (bool), id (string), url (string - короткая ссылка вьюера), downloadUrl (string -
прямая ссылка на блоб), statusCode (real - HTTP-код ответа, 0 если запрос не дошёл),
error (string - `""` при успехе, `"network"` при сетевой ошибке, `"http_<код>"` при HTTP-ошибке) }`.

Все три возвращают `bool` СРАЗУ (синхронно): `true` если запрос поставлен в отправку; `false` если
no-op (`!FASTLOGS_ENABLED` / нет файла-папки / пустой блоб / превышен кап по DECODED-размеру / не
задан/невыводим endpoint / уже идёт другая отправка). Итог отправки приходит ПОЗЖЕ - в `onDone`
(если задан) и тостом. Ответ сервера (`201 { id, url, downloadUrl }`) разбирается в Async HTTP
событии (`Other_62.gml`) СВОЕЙ короткой веткой (тост + опц. колбэк), **без** retry-until-success
/ дренажа outbox / poison-pill - эта логика только для лог-отчётов. Single-flight: разделяет
очередь с лог-отправкой (одна за раз) - аплоад файла не стартует, пока идёт `fastlogs_send` или
ожидается его отложенный повтор. При успехе короткая ссылка авто-копируется в буфер обмена при
`FASTLOGS_COPY_ON_SEND` (на WebGL может не сработать - нужен user-gesture; не падаем).

### `fastlogs_send_file(path, [opts])` -> bool
Отправить ОДИН файл по пути `path`. `name` по умолчанию = basename пути, `mime` угадывается по
расширению имени (иначе `application/octet-stream`). Файл читается через `buffer_load` -> кап по
размеру -> `buffer_base64_encode` (как скриншот). Возврат `false` (no-op), если файла нет
(`!file_exists`) или `buffer_load` не удался.

### `fastlogs_send_folder(path, [opts])` -> bool
Зазиповать папку `path` (рекурсивно, метод **STORE** - без компрессии) в **один `.zip`** на
клиенте и отправить. `name` по умолчанию = `<имя папки>.zip`, `mime` = `application/zip`.
Папка зипуется в буфере вручную (один `.zip`, паритет с Unity); структура каталогов сохраняется
(rel-пути с прямыми слешами). Возврат `false` (no-op), если папки нет (`!directory_exists`) или
она пуста. Нечитаемые отдельные файлы пропускаются (не валят весь архив); кап считается по
размеру итогового `.zip`.
**Фолбэк group-upload:** если упаковка в `.zip` провалилась (`__fastlogs_zip_store` вернул `-1`),
отправка деградирует на **group-upload** - каждый файл папки уходит ОТДЕЛЬНЫМ аплоадом на
`/api/files` с общим `groupId` (метка операции), цепочкой (single-flight: файл[k+1] стартует в
`onDone` файла[k]). Так операция доедет даже без упаковки.

### `fastlogs_send_files(paths, [opts])` -> bool
Зазиповать массив путей `paths` в один `.zip` (метод STORE) и отправить. Имена в архиве -
basename каждого пути (при коллизии добавляется суффикс ` (k)` перед расширением). `name` по
умолчанию = `files.zip`, `mime` = `application/zip`. Отсутствующие/нечитаемые пути молча
пропускаются; если валидных файлов не осталось - `false` (no-op). Тот же **фолбэк group-upload**
при сбое упаковки, что и у `fastlogs_send_folder`.

> **ПРО `kind` ДЛЯ ПАПКИ/АРХИВА:** сервер принимает `kind` из набора
> `file|folder|save|snapshot|screenshot|archive|other` (иное -> `null`). Значение `"zip"` НЕ валидно,
> поэтому для папки-архива используется `kind="folder"` (паритет с Unity-клиентом, который шлёт
> `"folder"`), а не `"zip"`. При group-upload-фолбэке тот же `kind="folder"` на каждом файле.

---

## Полный снимок игры (фича SNAPSHOT)

ОДИН вызов собирает **обычный ЛОГ-ОТЧЁТ** (как `fastlogs_send`: логи + контекст + breadcrumbs +
срез устройства + опц. скриншот) И ВДОБАВОК упаковывает сохранения/данные игры в `snapshot.zip`,
который **прикрепляется к ТОЙ ЖЕ записи** как вложение (`kind="snapshot"`, привязка по `logId`).
Результат: одна запись лога = читаемый отчёт + кнопка **Download snapshot.zip** во вьюере.

> **РАЗДЕЛЕНИЕ (важно).** В `snapshot.zip` идут **ТОЛЬКО сейвы + зарегистрированные данные**, а НЕ
> собственные логи FastLogs - они уже являются телом отчёта, включать их в архив значило бы
> дублировать/рекурсировать. Папка FastLogs (`FASTLOGS_PERSIST_DIR`: rolling-лог, `settings.ini`,
> `pending/` outbox, временный PNG скриншота) **ИСКЛЮЧАЕТСЯ** из архива.

> **ИНВАРИАНТ PII.** Сейвы могут содержать персональные данные - это **осознанное дев-действие**.
> К блобу/именам файлов скраб НЕ применяется (как у файлового пути), только кап по размеру.

Источник по умолчанию (без регистрации): **вся папка сейвов** = `game_save_id` (GM sandbox),
рекурсивно, исключая папку FastLogs. `snapshot.zip` строится **в памяти** (grow-буфер), на диск
не пишется. На платформах, где `game_save_id` не перечисляется (консоли/HTML5, см. GM-NOTES 2.9),
дефолтный источник просто пуст - используйте `fastlogs_add_snapshot_source(...)`.

### `fastlogs_send_snapshot([opts])` -> bool
Отправить лог-отчёт и прикрепить к нему `snapshot.zip`. `opts` пробрасывается в `fastlogs_send`
(`title`/`comment`/`screenshot`/`retentionDays`/`extraDevice`...), плюс снимок-специфичные поля:
`includePersistent` (bool - override `FASTLOGS_SNAPSHOT_INCLUDE_PERSISTENT` на этот вызов),
`snapshotName` (string, деф. `"snapshot.zip"`), `snapshotTitle` (string, деф. `"Game snapshot"`),
`onSnapshotDone` (function(result) - колбэк завершения аплоада архива; структура `result` как у
файлового `onDone`). Возврат `bool` СРАЗУ как у `fastlogs_send` (`true` если ЛОГ-отправка
поставлена). `snapshot.zip` строится и уходит **только ПОСЛЕ УСПЕХА лог-отчёта** (`logId` присваивает
сервер в ответе): хук `log_on_done` в http-состоянии вызывается из `Other_62.gml` по успеху с
готовым `logId`. Если лог-отчёт окончательно не доставлен - вложение не отправляется (привязывать
не к чему). Кап `snapshot.zip` - `FASTLOGS_MAX_SNAPSHOT_BYTES` (деф. = `FASTLOGS_MAX_FILE_BYTES`).

### Реестр источников (добавляет ПОВЕРХ дефолтной папки сейвов)
- `fastlogs_add_snapshot_source(path)` -> bool - зарегистрировать доп. папку-источник (дубликаты
  игнорируются; путь нормализуется срезом хвостовых слешей).
- `fastlogs_add_snapshot_data(name, buffer_or_base64)` -> bool - добавить данные **в памяти** как
  файл архива. Второй аргумент: `buffer` (real - кодируем снимок содержимого СЕЙЧАС, владелец
  буфера остаётся за вызывающим) либо `string` (уже готовый base64).
- `fastlogs_remove_snapshot_source(path)` -> bool - снять источник-папку.
- `fastlogs_clear_snapshot_sources()` -> void - очистить ВСЕ источники и данные (дефолтную папку
  сейвов не затрагивает - ей управляет `FASTLOGS_SNAPSHOT_INCLUDE_PERSISTENT` / `opts`).

Все публичные функции при `!FASTLOGS_ENABLED` - no-op (ранний `return`). В архиве дефолтная папка
кладётся под префикс `saves/`, каждый зарегистрированный источник - под подпапку по его basename
(анти-коллизия суффиксом ` (k)`); структура каталогов сохраняется. REUSE: `__fastlogs_zip_store`
(#6a, файлы-только путь) и `__fastlogs_send_buffer` / `fastlogs_files_post_internal` (тот же
файловый аплоад на `/api/files` с `logId`).

---

## Оверлей

### `fastlogs_open()` / `fastlogs_close()` / `fastlogs_toggle()`
Показ/скрытие/переключение экранного оверлея (рисуется примитивами в Draw GUI).
no-op при `!FASTLOGS_ENABLED`.

### Имя тестера в оверлее (ОБЯЗАТЕЛЬНО для ручной отправки, батч B)
В оверлее есть РЕДАКТИРУЕМОЕ поле "Тестер" (inline-ввод через `keyboard_string`, как у поля
комментария). Кнопка "Отправить" ЗАБЛОКИРОВАНА (серая, без зоны клика, подпись "Отправить (нужно
имя)" + подсказка), пока имя тестера (после trim) пусто. Поле засевается эффективным именем из
`FASTLOGS_TESTER`/`fastlogs_init({ tester })` при первом показе (можно поправить). Введённое имя
применяется в runtime-конфиг (`st.cfg.tester`), откуда его читает payload, и уходит в поле
`tester` каждого отчёта. Гейт касается ТОЛЬКО ручного overlay-send; код/крэш/авто-отправка по
паттерну именем НЕ блокируются (там `tester` опционален). keyboard_string один на поля
"Тестер"/"Комментарий" -> фокус взаимоисключающий.

---

## Контекст и breadcrumbs (фича #2)

Едут с **каждым** отчётом (поля `context` / `breadcrumbs` в payload; пустые опускаются).

### `fastlogs_set_context(key, value)`
Задать пару контекста (object string->string). `key`/`value` приводятся к строке, усекаются
(`FASTLOGS_CONTEXT_KEY_MAX`=64 / `FASTLOGS_CONTEXT_VAL_MAX`=512). Пустой `key` игнорируется.
Значения чистятся redaction (#3) при сборке payload. no-op при `!FASTLOGS_ENABLED`.

### `fastlogs_remove_context(key)` / `fastlogs_clear_context()`
Удалить одну пару / очистить весь контекст.

### `fastlogs_breadcrumb(msg, [level])`
Добавить хлебную крошку в катящийся буфер (кап `FASTLOGS_BREADCRUMB_MAX`=100, кольцо).
`level` (опц.): `"info"|"warn"|"error"` или `FASTLOGS_LEVEL_*` (деф. `"info"`). Время крошки
(`t`, UTC ISO-8601) фиксируется в момент вызова. `m` усекается до 512. Тексты чистятся
redaction (#3) при сборке payload. ПЕРФ: запись O(1), без аллокаций в кадре (переиспользование слота).

### `fastlogs_clear_breadcrumbs()`
Очистить буфер крошек.

---

## Приватность / чистка PII (фича #3)

**ПО УМОЛЧАНИЮ ПРИВАТНО:** `FASTLOGS_SCRUB_PII = true`. Перед отправкой `logText`, значения
`context` и тексты `breadcrumbs` прогоняются через redaction: email / IPv4 / IPv6 / Bearer-токены /
длинные цифровые последовательности -> `"[redacted]"`. Чувствительные поля устройства уже
опускаются; `FASTLOGS_INCLUDE_SENSITIVE = false` (явный флаг намерения). IP тестера клиент не шлёт.

- Тоггл в оверлее (панель настроек, "Чистка PII (приватность)") с персистом в ini.
- Runtime-override: `fastlogs_init({ scrubPii: false })`.
- `fastlogs_redact(text) -> string` - применить redaction к строке (гейтится по настройке).
- `fastlogs_redact_rules_set(rules)` - заменить набор правил (расширяемость);
  `fastlogs_redact_default_rules()` - дефолтный набор `[{name,matcher}]`.

> **ВАЖНО:** GameMaker НЕ имеет нативного runtime-regex. Правила реализованы ручными
> GML-сканерами строк (regex-эквиваленты), без внешних extension'ов. См. `scr_fastlogs_util`.

---

## Персист краш-отчёта + досыл при старте (фича #1)

При авто-отправке по краху (необработанное исключение) отчёт **сначала синхронно пишется** в
дисковую очередь (`game_save_id`/`<persist>/pending/*.json`), **затем** делается попытка отправки;
на успех файл удаляется. На старте (`fastlogs_init`) очередь сканируется и неотправленные
отчёты досылаются - так жёсткий краш, убивший процесс до завершения HTTP, доедет на следующем
запуске. Кап очереди `FASTLOGS_PENDING_MAX`=5; без скриншота; с `logText/counts/comment/tester/
context/breadcrumbs`. За старт досылается не более `FASTLOGS_PENDING_RESEND_PER_START`.
Внутренние функции: `fastlogs_pending_write/delete/resend_all` (recorder), `fastlogs_pending_send` (http).

---

## Геттеры состояния

### `fastlogs_get_counts()` -> struct
Возвращает `{ error, warn, log }` - счётчики **за сессию** (как в payload `counts`).
При `!FASTLOGS_ENABLED` -> `{ error:0, warn:0, log:0 }`.

### `fastlogs_session_id()` -> string  (фича #9)
GUID **текущего запуска** (один на сессию). Генерируется в `fastlogs_init` (или берётся из
`fastlogs_init({ sessionId })`). Уходит с КАЖДЫМ отчётом в поле `sessionId` (опц.; пустое
опускается). До вызова `fastlogs_init` -> `""`. При `!FASTLOGS_ENABLED` -> `""`.

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
| `scr_fastlogs_context`      | контекст + breadcrumbs (#2): `fastlogs_set_context`/`remove_context`/`clear_context`, `fastlogs_breadcrumb`/`clear_breadcrumbs`, снимки для payload |
| `scr_fastlogs_core`         | `fastlogs_init` (+ досыл pending #1, генерация `sessionId` #9), `flog`/`fastlogs_log`/`warn`/`error` (+ авто-отправка по паттерну #9), кольцо, счётчики, `fastlogs_clear`, `fastlogs_get_counts`, `fastlogs_session_id` (#9), exception handler (+ персист pending #1), константы уровней |
| `scr_fastlogs_recorder`     | `fastlogs_record_start`/`stop`/`set`/`is_recording`, персист на диск + загрузка прошлых сессий, ротация; pending-очередь краша (#1): `fastlogs_pending_write`/`delete`/`resend_all` |
| `scr_fastlogs_device`       | сбор `device{}` по контракту (внутр.: `fastlogs_collect_device()`), маппинг `os_type`->platform |
| `scr_fastlogs_files`        | отправка файла/папки (SEND-FILE): `fastlogs_send_file`/`fastlogs_send_folder`/`fastlogs_send_files`; zip-store папки в буфере; **фолбэк group-upload** при сбое упаковки (#6a); сборка JSON-тела `/api/files`; кап по `FASTLOGS_MAX_FILE_BYTES` (бинарь без PII-скраба) |
| `scr_fastlogs_payload`      | сборка JSON-тела (внутр.: `fastlogs_build_payload(...)`), `timestampUtc`, `sessionId` (#9), усечение `logText`, опускание пустых полей, вложение `context`/`breadcrumbs` (#2) + redaction (#3) |
| `scr_fastlogs_http`         | `fastlogs_send`, `fastlogs_is_sending`, `fastlogs_last_url`, `fastlogs_retry_is_pending`, retry-until-success (отложенный повтор на Alarm[0]), отправка/разбор ответа (Async HTTP), `fastlogs_pending_send` (досыл краша #1); SEND-FILE: `fastlogs_files_endpoint`, `fastlogs_files_post_internal` (POST на `/api/files`) |
| `scr_fastlogs_overlay`      | `fastlogs_open`/`close`/`toggle`, отрисовка примитивами, обработка тап-зон |
| `scr_fastlogs_input`        | опрос hotkey/мыши/тача/геймпада -> вызовы overlay/copy |
| `scr_fastlogs_clipboard`    | `fastlogs_set_screenshot` тут НЕ реализуется; реализует copy-обёртку `clipboard_set_text` (last_url) |
| `scr_fastlogs_util`         | чистка PII / redaction (#3): `fastlogs_redact`, `fastlogs_redact_rules_set`, матчеры (email/IPv4/IPv6/Bearer/длинные цифры); прочие строковые хелперы |

`fastlogs_set_screenshot` - в `scr_fastlogs_core` (управляет флагом), фактический захват -
в `scr_fastlogs_payload`/`scr_fastlogs_http` через util-хелпер.

## События объекта `obj_fastlogs_controller` (placeholder-файлы для билдеров)

| Файл                 | Событие            | Что наполнить |
|----------------------|--------------------|---------------|
| `Create_0.gml`       | Create (0/0)       | init состояния, подгрузка персиста, exception handler |
| `Step_0.gml`         | Step (3/0)         | опрос ввода, отложенные задачи |
| `Alarm_0.gml`        | Alarm[0] (2/0)     | тик retry-until-success (отложенный повтор отправки, фича RETRY) |
| `Draw_64.gml`        | Draw GUI (8/64)    | отрисовка оверлея примитивами |
| `Other_62.gml`       | Async HTTP (7/62)  | разбор ответа ingest; ветвление по `request_kind` (`"log"` - лог-отчёт; `"file"` - аплоад `/api/files`, короткая ветка: тост/URL/колбэк) |
| `Other_63.gml`       | Async Save/Load (7/63) | завершение async-файловых операций (если используются) |
