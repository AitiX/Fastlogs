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
    }

});
