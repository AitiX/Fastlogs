// WebFilePicker - the WebGL <input type=file> bridge for FastLogs (feature #7).
//
// On WebGL a file dialog can only be opened from inside a user-gesture handler, and
// the chosen file is read asynchronously (FileReader). The browser side lives in
// FastLogsWeb.jslib (FastLogsWeb_PickFile); it opens the picker and, once a file is
// read, calls back into Unity via SendMessage onto THIS component's GameObject:
//   - OnWebFilePicked(payload) where payload = "<fileName>\n<base64>" (base64 has no
//     newline, so the first '\n' splits name from data),
//   - OnWebFilePickCancelled(reason) when the user cancels or the read fails.
//
// SendMessage targets a GameObject by NAME and finds only ACTIVE objects, so this host
// is a normal (non-hidden) DontDestroyOnLoad object with a stable, unique name. One
// pick is in flight at a time; a second request while one is open fails cleanly.
//
// On every NON-WebGL platform (and in the Editor) there is no browser file dialog, so
// Pick is an honest no-op that returns a "not supported" failure - game code should use
// FastLogs.SendFileAsync(byte[], fileName) (or a native picker) there.
//
// Gated like the rest of the package.

#if UNITY_EDITOR || DEVELOPMENT_BUILD || (LOGSHARE_FORCE_ENABLED && !(UNITY_PS4 || UNITY_PS5 || UNITY_GAMECORE || UNITY_SWITCH))
#define FASTLOGS_ENABLED
#endif

#if FASTLOGS_ENABLED
using System;
using UnityEngine;

#if UNITY_WEBGL && !UNITY_EDITOR
using System.Runtime.InteropServices;
#endif

namespace PlayJoy.FastLogs
{
    /// <summary>
    /// Persistent host that opens the browser file dialog on WebGL and routes the chosen
    /// file's bytes back to a caller-supplied sink. Internal: the public surface is
    /// <see cref="FastLogs.WebPickAndSendFile"/>, wired through the runtime.
    /// </summary>
    internal sealed class WebFilePicker : MonoBehaviour
    {
        // Stable, unique name so the jslib SendMessage target resolves. Must match the
        // name passed to FastLogsWeb_PickFile below.
        private const string HostName = "FastLogsWebFilePicker";

        // The send sink for the picked bytes (set by the runtime: bytes + fileName ->
        // upload task). The result of that upload completes the pending pick task.
        private Func<byte[], string, FlogTask<FileUploadResultDto>> _sendSink;

        // The task handed back to the caller of Pick(); resolved on send, cancel or error.
        private FlogTask<FileUploadResultDto> _pending;
        private bool _picking; // one dialog at a time

        public static WebFilePicker Create(Func<byte[], string, FlogTask<FileUploadResultDto>> sendSink)
        {
            var go = new GameObject(HostName);
            // NOT hidden: SendMessage(HostName, ...) from jslib resolves by GameObject.Find,
            // which only finds active, named objects.
            DontDestroyOnLoad(go);
            var picker = go.AddComponent<WebFilePicker>();
            picker._sendSink = sendSink;
            return picker;
        }

        public void Shutdown()
        {
            if (this == null)
            {
                return;
            }
            // Resolve any in-flight pick so an awaiter never hangs.
            if (_pending != null)
            {
                _pending.SetResult(FileUploadResultDto.Fail("FastLogs: file picker shut down before a file was chosen."));
                _pending = null;
            }
            _picking = false;
            Destroy(gameObject);
        }

        /// <summary>
        /// Open the browser file dialog (WebGL only) and upload the chosen file via the
        /// send sink, returning an awaitable result. On non-WebGL platforms, or when a pick
        /// is already in progress, resolves immediately with a failure.
        /// </summary>
        public FlogTask<FileUploadResultDto> Pick(string title)
        {
#if UNITY_WEBGL && !UNITY_EDITOR
            if (_picking)
            {
                return FlogTask.FromResult(FileUploadResultDto.Fail("FastLogs: a file pick is already in progress."));
            }
            if (_sendSink == null)
            {
                return FlogTask.FromResult(FileUploadResultDto.Fail("FastLogs: no send sink for the picked file."));
            }

            var task = FlogTask.Create<FileUploadResultDto>();
            _pending = task;
            _picking = true;
            try
            {
                FastLogsWeb_PickFile(title ?? string.Empty, HostName, "OnWebFilePicked", "OnWebFilePickCancelled");
            }
            catch (Exception e)
            {
                FlogLog.Exception(e);
                _picking = false;
                _pending = null;
                task.SetResult(FileUploadResultDto.Fail("FastLogs: failed to open the file picker: " + e.Message));
            }
            return task;
#else
            return FlogTask.FromResult(FileUploadResultDto.Fail(
                "FastLogs: WebPickAndSendFile is only supported on WebGL. Use SendFileAsync(byte[], fileName) on other platforms."));
#endif
        }

        // ---- jslib callbacks (invoked via SendMessage; must be public, single string) ----

        /// <summary>
        /// Called by the browser bridge with "fileName\nbase64Bytes". Decodes and uploads
        /// via the send sink, then forwards the upload result onto the pending pick task.
        /// </summary>
        public void OnWebFilePicked(string payload)
        {
            FlogTask<FileUploadResultDto> task = _pending;
            _pending = null;
            _picking = false;

            if (task == null)
            {
                return; // no awaiter (e.g. shut down); nothing to resolve
            }

            try
            {
                if (string.IsNullOrEmpty(payload))
                {
                    task.SetResult(FileUploadResultDto.Fail("FastLogs: empty file payload from picker."));
                    return;
                }

                int nl = payload.IndexOf('\n');
                string fileName = nl >= 0 ? payload.Substring(0, nl) : "file.bin";
                string base64 = nl >= 0 ? payload.Substring(nl + 1) : payload;

                byte[] bytes;
                try { bytes = Convert.FromBase64String(base64); }
                catch (Exception e)
                {
                    FlogLog.Exception(e);
                    task.SetResult(FileUploadResultDto.Fail("FastLogs: failed to decode picked file: " + e.Message));
                    return;
                }

                if (_sendSink == null)
                {
                    task.SetResult(FileUploadResultDto.Fail("FastLogs: no send sink for the picked file."));
                    return;
                }

                FlogTask<FileUploadResultDto> upload = _sendSink(bytes, string.IsNullOrEmpty(fileName) ? "file.bin" : fileName);
                if (upload == null)
                {
                    task.SetResult(FileUploadResultDto.Fail("FastLogs: file upload could not be started."));
                    return;
                }

                // Forward the upload result onto the caller's pick task once it resolves.
                ForwardResult(upload, task);
            }
            catch (Exception e)
            {
                FlogLog.Exception(e);
                task.SetResult(FileUploadResultDto.Fail("FastLogs: file pick failed: " + e.Message));
            }
        }

        /// <summary>Called by the browser bridge when the user cancels or the read fails.</summary>
        public void OnWebFilePickCancelled(string reason)
        {
            FlogTask<FileUploadResultDto> task = _pending;
            _pending = null;
            _picking = false;
            if (task == null)
            {
                return;
            }
            string detail = string.IsNullOrEmpty(reason) ? "cancelled" : reason;
            task.SetResult(FileUploadResultDto.Fail("FastLogs: file pick " + detail + "."));
        }

        // Complete `pick` with `upload`'s result once it resolves. upload is completed on
        // the main thread (coroutine), so the continuation runs inline / on the main thread.
        private static void ForwardResult(FlogTask<FileUploadResultDto> upload, FlogTask<FileUploadResultDto> pick)
        {
            try
            {
                var awaiter = upload.GetAwaiter();
                awaiter.OnCompleted(() =>
                {
                    try { pick.SetResult(upload.Result); }
                    catch (Exception e)
                    {
                        FlogLog.Exception(e);
                        pick.SetResult(FileUploadResultDto.Fail("FastLogs: file upload faulted: " + e.Message));
                    }
                });
            }
            catch (Exception e)
            {
                FlogLog.Exception(e);
                pick.SetResult(FileUploadResultDto.Fail("FastLogs: failed to track file upload: " + e.Message));
            }
        }

#if UNITY_WEBGL && !UNITY_EDITOR
        [DllImport("__Internal")]
        private static extern void FastLogsWeb_PickFile(string title, string goName, string okMethod, string cancelMethod);
#endif
    }
}
#endif
