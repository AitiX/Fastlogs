# FastLogs - Basic Usage Sample

This sample shows the minimal integration: init, record, send on a key press,
and handle the result. It covers everything a QA workflow needs.

## What the sample does

1. **Init** - calls `FastLogs.Init()` in `Awake`, picking up `Resources/FastLogsConfig`
   (or the in-memory default if none exists).
2. **Start recording** - immediately calls `FastLogs.StartRecording()` so all
   subsequent `Debug.Log` output is captured in the ring buffer.
3. **Log a message** - `FastLogs.Log("FastLogs basic usage sample started.")` adds
   a tagged entry to the buffer.
4. **Attach context and breadcrumbs** - in `Awake` the sample calls
   `FastLogs.SetContext("level", "1")` / `SetContext("mode", "sample")` and
   `FastLogs.Breadcrumb("Sample initialized")`, then drops another breadcrumb on each
   send. This enriches every report with what the player was doing (Context section in
   the viewer) and a trail of recent events (Breadcrumbs timeline). Context survives
   until changed/cleared; breadcrumbs roll over after the last ~100. Both are
   PII-scrubbed before upload by default.
5. **Send on key press** - press `F9` (configurable in the Inspector) to call
   `FastLogs.SendAsync(includeScreenshot: true, title: "Manual report from sample", comment: "...")`.
   `title` is a short headline; `comment` is the tester's free-form problem
   description (both optional). The tester name and "copy link on send" behaviour
   are read from the config (`Config > UI`), so they apply to every report.
   The coroutine-backed await works on every Unity version and on WebGL.
6. **Handle the result** - logs the shareable URL on success or the error on failure;
   also wires `FastLogs.OnUploaded` to demonstrate the event callback.
7. **Overlay** - once FastLogs is initialized, press `F8` (the default trigger key
   configured in `TriggerConfig`) to open or close the share overlay from anywhere.
   You can also call `FastLogs.ShowOverlay()` from code or a UI button.

## How to import

In the Unity Package Manager, select the FastLogs package, open the **Samples** tab,
and click **Import** next to "Basic Usage". Unity copies the sample into
`Assets/Samples/FastLogs/<version>/BasicUsage/`.

## Minimum setup before running

1. Create a `FastLogsConfig` asset:
   `Tools > PlayJoy > FastLogs > Create Config Asset`
2. In the Inspector, set `Server > EndpointUrl` to your FastLogs server address
   (e.g. `https://logs.example.com/api/logs`).
3. Set `Server > AppId` (e.g. `mygame`).
4. Optionally set `Server > Token` if your server requires one.
5. Add the `FastLogsBasicUsage` component to any GameObject in your scene and enter
   Play Mode (Editor) or build as a Development Build.

## Notes

- All `FastLogs.*` calls in this script compile in retail/console builds; the void
  calls are stripped by the compiler and the `SendAsync` return path returns a safe
  disabled result.
- `RecordScope` example: wrap code in `using (FastLogs.RecordScope()) { ... }` to
  capture only that section.
- Unhandled exceptions are captured and auto-sent in dev (on by default), persisted
  to a disk outbox first so a crash that kills the process is re-sent on the next
  launch. No sample wiring is needed - throw an uncaught exception to see it.
- On WebGL the `await` resolves via the same coroutine path - no threads are used.
