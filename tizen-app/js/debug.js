/* Debug telemetry — every line goes to the browser console, and optionally
 * to a PC listener as well.
 *
 * The console is the one that needs no setup: Apps2Samsung → Installed apps →
 * Debug puts the app in debug mode and opens chrome://inspect, and inspecting
 * it from there gives a real DevTools console with these lines in it, live,
 * filterable, on any machine that can reach the TV.  Nothing to configure,
 * nothing to keep running, and it works even when the network path to a
 * listener doesn't.  Lines are tagged [vlctv] so they're one filter away from
 * whatever else the WebView is saying.
 *
 * The HTTP POSTs are still there for capturing a session without DevTools
 * attached.  That half is configured under Settings → Debug logging,
 * persisted in localStorage, and ships DISABLED — the console output does
 * not depend on it.
 *
 * The last MAX_LINES lines are also kept in memory, so Settings → Debug
 * logging → Save debug log to USB can write out what happened after the
 * fact, with no listener running (issue #126; backup.js does the writing).
 */

var Debug = (function () {
    var CFG_KEY = 'vlctv_debug_v1';
    var startTs = Date.now();
    var seq     = 0;

    function loadCfg() {
        try {
            var c = JSON.parse(localStorage.getItem(CFG_KEY) || '{}');
            return { enabled: !!c.enabled, host: c.host || '', port: c.port || 9999 };
        } catch (e) {
            return { enabled: false, host: '', port: 9999 };
        }
    }
    var cfg = loadCfg();

    var MAX_LINES = 2000;        // ~200 KB at most; hours at the usual rate
    var lines     = [];
    var dropped   = 0;
    var startedAt = new Date();

    /* Whether the POST half has somewhere to go.  The console half is always
     * on: it costs nothing when no inspector is attached, and having to go
     * and enable something before the interesting thing happens again is
     * exactly what makes a bug hard to catch. */
    function active() { return cfg.enabled && !!cfg.host; }
    function url()    { return 'http://' + cfg.host + ':' + cfg.port + '/'; }

    function ts() {
        var t = (Date.now() - startTs) / 1000;
        return '[' + t.toFixed(3) + ']';
    }

    function send(tag, msg) {
        seq++;
        var payload = ts() + ' #' + seq + ' [' + tag + '] ' +
                      (typeof msg === 'string' ? msg : JSON.stringify(msg));

        lines.push(payload);
        // Trim in chunks rather than a shift per line once the buffer is full.
        if (lines.length > MAX_LINES + 200) {
            dropped += lines.length - MAX_LINES;
            lines.splice(0, lines.length - MAX_LINES);
        }

        /* DevTools first, so a line still lands there when the POST path is
         * off or the listener has gone away.  console.error for the tags that
         * mean something went wrong, so they keep DevTools' red styling and
         * its error filter. */
        try {
            var out = (tag === 'ERROR' || tag === 'WARN' ||
                       tag === 'JSERR' || tag === 'JSREJECT')
                ? console.error : console.log;
            out.call(console, '[vlctv]' + payload);
        } catch (e) {}

        if (!active()) return;
        var dest = url();
        try {
            var x = new XMLHttpRequest();
            x.open('POST', dest, true);
            x.setRequestHeader('Content-Type', 'text/plain');
            x.send(payload);
        } catch (e) {
            try {
                var img = new Image();
                img.src = dest + '?msg=' + encodeURIComponent(payload) + '&_=' + Date.now();
            } catch (e2) {}
        }
    }

    /* Convenience helpers — every "category" gets its own short tag */
    function info (m) { send('INFO',   m); }
    function warn (m) { send('WARN',   m); }
    function error(m) { send('ERROR',  m); }
    function view (m) { send('VIEW',   m); }
    function action(m){ send('ACTION', m); }
    function player(m){ send('PLAYER', m); }
    function browse(m){ send('BROWSE', m); }
    function key   (m){ send('KEY',    m); }

    /* Update + persist the endpoint config (called by the settings form). */
    function configure(c) {
        cfg = {
            enabled: !!(c && c.enabled),
            host: (c && c.host) ? String(c.host).trim() : '',
            port: (c && parseInt(c.port, 10)) || 9999
        };
        try { localStorage.setItem(CFG_KEY, JSON.stringify(cfg)); } catch (e) {}
    }
    function getConfig() { return { enabled: cfg.enabled, host: cfg.host, port: cfg.port }; }

    /* The log so far as one text: a header with what `info` says about the
     * build and the TV, then the lines as they went to the console, oldest
     * first.  The timestamps are seconds since the app started, which the
     * header gives as a clock time. */
    function exportText(info) {
        var head = ['Tessel debug log',
                    'exported: ' + new Date().toISOString(),
                    'started:  ' + startedAt.toISOString() + ' (line timestamps count seconds from then)'];
        for (var k in info) if (info[k]) head.push(k + ': ' + info[k]);
        head.push('lines: ' + lines.length + (dropped ? ' (' + dropped + ' earlier lines dropped)' : ''));
        return head.join('\n') + '\n\n' + lines.join('\n') + '\n';
    }
    function lineCount() { return lines.length; }

    /* debug.js loads before i18n.js; the form is wired once the page has
     * parsed, when I18n is there — except in the Node tests. */
    function tr(key, english) { return (typeof I18n !== 'undefined') ? I18n.t(key) : english; }

    /* Wire the Settings form (toggle + IP + port + Save). */
    function wireForm() {
        var save = document.getElementById('dbg-save');
        if (!save) return;
        var hostEl = document.getElementById('dbg-host');
        var portEl = document.getElementById('dbg-port');
        var enBtn  = document.getElementById('dbg-enabled');
        var enVal  = document.getElementById('dbg-enabled-val');
        if (hostEl) hostEl.value = cfg.host || '';
        if (portEl) portEl.value = cfg.port || 9999;
        var enState = cfg.enabled;
        function paint() { if (enVal) enVal.textContent = enState ? tr('common.on', 'On') : tr('common.off', 'Off'); }
        paint();
        if (enBtn) enBtn.addEventListener('click', function () { enState = !enState; paint(); });
        save.addEventListener('click', function () {
            configure({ enabled: enState,
                        host: hostEl ? hostEl.value : '',
                        port: portEl ? portEl.value : 9999 });
            if (typeof UI !== 'undefined' && UI.toast) UI.toast(tr('dbg.saved', 'Debug settings saved'));
            if (active()) send('INFO', 'debug logging enabled from settings → ' + url());
        });
    }
    if (document.readyState === 'loading')
        document.addEventListener('DOMContentLoaded', wireForm);
    else
        wireForm();

    /* Capture unhandled JS errors automatically */
    window.addEventListener('error', function (ev) {
        send('JSERR',
             (ev.message || '?') + ' @ ' + (ev.filename || '?') + ':' + ev.lineno);
    });
    window.addEventListener('unhandledrejection', function (ev) {
        send('JSREJECT',
             ev.reason && ev.reason.message ? ev.reason.message : String(ev.reason));
    });

    /* Boot banner — confirms the app loaded + the build it's from (only sent
     * when logging is enabled and an endpoint is set). */
    send('BOOT',
         'Tessel starting; UA=' + navigator.userAgent +
         '; href=' + location.href);

    return {
        send: send,
        info: info, warn: warn, error: error,
        view: view, action: action,
        player: player, browse: browse, key: key,
        configure: configure, getConfig: getConfig,
        exportText: exportText, lineCount: lineCount,
        get enabled() { return cfg.enabled; }
    };
})();

// Ignored by the Tizen/browser build; lets Node tests check what goes where.
if (typeof module !== 'undefined' && module.exports) module.exports = Debug;
