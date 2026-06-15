// FastLogsWeb.jslib - browser bridge for FastLogs on WebGL.
//
// Two entry points, called synchronously from a user-gesture handler (a click on
// the overlay) so the browser honours the clipboard write / window.open:
//   - FastLogsWeb_CopyToClipboard(textPtr): navigator.clipboard.writeText with a
//     textarea + document.execCommand('copy') fallback for older / insecure-context
//     browsers.
//   - FastLogsWeb_OpenUrl(urlPtr): window.open in a new tab (noopener), falling back
//     to location.href if the popup is blocked.
//
// Strings arrive as Emscripten heap pointers; UTF8ToString decodes them. Everything
// is wrapped in try/catch so a browser quirk never throws back into Unity.

mergeInto(LibraryManager.library, {

    FastLogsWeb_CopyToClipboard: function (textPtr) {
        try {
            var text = textPtr ? UTF8ToString(textPtr) : '';

            // Preferred path: async Clipboard API (secure contexts / user gesture).
            if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(text).catch(function (e) {
                    try { console.warn('[FastLogsWeb] clipboard.writeText failed, falling back', e); } catch (_) {}
                    try { FastLogsWeb_execCommandCopy(text); } catch (_) {}
                });
                return;
            }

            // Fallback: hidden textarea + execCommand('copy').
            FastLogsWeb_execCommandCopy(text);
        } catch (e) {
            try { console.warn('[FastLogsWeb] CopyToClipboard error', e); } catch (_) {}
        }

        function FastLogsWeb_execCommandCopy(value) {
            var ta = document.createElement('textarea');
            ta.value = value;
            ta.setAttribute('readonly', '');
            ta.style.position = 'fixed';
            ta.style.top = '-9999px';
            ta.style.left = '-9999px';
            document.body.appendChild(ta);
            ta.select();
            ta.setSelectionRange(0, ta.value.length);
            try { document.execCommand('copy'); } catch (_) {}
            document.body.removeChild(ta);
        }
    },

    FastLogsWeb_OpenUrl: function (urlPtr) {
        try {
            var url = urlPtr ? UTF8ToString(urlPtr) : '';
            if (!url) { return; }
            var win = null;
            try { win = window.open(url, '_blank', 'noopener'); } catch (_) {}
            // Popup blocked: navigate the current tab instead.
            if (!win) {
                try { window.location.href = url; } catch (_) {}
            }
        } catch (e) {
            try { console.warn('[FastLogsWeb] OpenUrl error', e); } catch (_) {}
        }
    },

    // FastLogsWeb_PickFile(title, goName, okMethod, cancelMethod): open a native file
    // dialog and read the chosen file, then call back into Unity via SendMessage. Must be
    // invoked from a user-gesture handler (a click) so the browser allows the dialog.
    //   - On success: SendMessage(goName, okMethod, "<fileName>\n<base64>"). The base64
    //     alphabet has no '\n', so the first newline cleanly splits name from data.
    //   - On cancel / read error: SendMessage(goName, cancelMethod, "<reason>").
    // The hidden <input> is appended to the DOM (some browsers ignore a detached input)
    // and removed after use. Everything is wrapped so a browser quirk never throws into
    // Unity. SendMessage is provided by the Unity WebGL loader (it is a jslib global).
    FastLogsWeb_PickFile: function (titlePtr, goNamePtr, okMethodPtr, cancelMethodPtr) {
        var goName = goNamePtr ? UTF8ToString(goNamePtr) : '';
        var okMethod = okMethodPtr ? UTF8ToString(okMethodPtr) : '';
        var cancelMethod = cancelMethodPtr ? UTF8ToString(cancelMethodPtr) : '';

        function cancel(reason) {
            try {
                if (goName && cancelMethod) { SendMessage(goName, cancelMethod, reason || ''); }
            } catch (_) {}
        }

        try {
            var input = document.createElement('input');
            input.type = 'file';
            input.style.position = 'fixed';
            input.style.top = '-9999px';
            input.style.left = '-9999px';

            // A focus event firing without a change shortly after means the dialog was
            // dismissed without a selection on most browsers; report it as a cancel.
            // `settled` flips only AFTER a file has been read; `changeFired` flips
            // SYNCHRONOUSLY the instant onchange runs (before the async FileReader), so the
            // focus->cancel timer can tell "a selection is being processed" from "dialog
            // dismissed". Without it, a slow FileReader on a large file could let the 500ms
            // timer fire a false cancel before onchange finishes reading.
            var settled = false;
            var changeFired = false;
            function cleanup() {
                try { if (input && input.parentNode) { input.parentNode.removeChild(input); } } catch (_) {}
            }

            input.onchange = function (ev) {
                changeFired = true;
                settled = true;
                try {
                    var files = (ev.target && ev.target.files) || input.files;
                    if (!files || files.length === 0) { cleanup(); cancel('cancelled'); return; }

                    var file = files[0];
                    var name = file.name || 'file.bin';
                    var reader = new FileReader();
                    reader.onload = function () {
                        cleanup();
                        try {
                            var result = reader.result || '';
                            // result is a data URL: "data:<mime>;base64,<data>". Strip the prefix.
                            var comma = result.indexOf(',');
                            var base64 = comma >= 0 ? result.substring(comma + 1) : result;
                            if (goName && okMethod) { SendMessage(goName, okMethod, name + '\n' + base64); }
                        } catch (e) {
                            try { console.warn('[FastLogsWeb] PickFile read parse error', e); } catch (_) {}
                            cancel('read error');
                        }
                    };
                    reader.onerror = function () {
                        cleanup();
                        cancel('read error');
                    };
                    reader.readAsDataURL(file);
                } catch (e) {
                    cleanup();
                    try { console.warn('[FastLogsWeb] PickFile onchange error', e); } catch (_) {}
                    cancel('read error');
                }
            };

            // Best-effort cancel detection: when the window regains focus after the dialog
            // closed without a change, report a cancel once (guarded by `settled`).
            window.addEventListener('focus', function onFocus() {
                window.removeEventListener('focus', onFocus);
                setTimeout(function () {
                    // Only treat as a cancel if onchange never fired at all. If it fired
                    // (changeFired) the FileReader is still working on a (possibly large)
                    // file, so leave the pick to resolve via onload / onerror.
                    if (!settled && !changeFired) { cleanup(); cancel('cancelled'); }
                }, 500);
            }, { once: true });

            document.body.appendChild(input);
            input.click();
        } catch (e) {
            try { console.warn('[FastLogsWeb] PickFile error', e); } catch (_) {}
            cancel('error');
        }
    }

});
