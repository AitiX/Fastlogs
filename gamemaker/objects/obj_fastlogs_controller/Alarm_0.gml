/// @description FastLogs controller - Alarm[0] (eventType 2 / eventNum 0)
// RETRY-UNTIL-SUCCESS (фича RETRY): таймер отложенного повтора отправки.
// Срабатывает раз в СЕКУНДУ, пока есть pending-отчёт на повтор (взводится в scr_fastlogs_http:
//   __fastlogs_retry_arm_alarm). Тик уменьшает обратный отсчёт, обновляет статус
//   "Повтор через Ns..." и по нулю запускает сам повтор. ПЕРФ: это alarm движка, а не опрос
//   в каждом кадре - между тиками FastLogs не делает работы и не аллоцирует.
// Сверено по GM-NOTES 1.6: Alarm[0] = eventType 2 / eventNum 0 -> файл Alarm_0.gml; GM сам
//   декрементирует alarm[0] каждый Step и вызывает это событие при достижении 0.
if (!FASTLOGS_ENABLED) { exit; }

// Вся логика отсчёта/перезапуска/запуска повтора - в scr_fastlogs_http (единый источник истины
//   http-состояния). Сам тик перевзводит alarm на следующую секунду, пока pending активен.
if (script_exists(asset_get_index("fastlogs_retry_tick"))) {
    fastlogs_retry_tick();
}
