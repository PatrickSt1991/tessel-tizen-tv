/* Tessel Lite: one screen to give a URL, and AVPlay to play it.
 *
 * ES5 only, see js/core.js.  Focus is a CSS class moved by the arrow keys; the
 * text field only gets real focus on OK, because on these sets focus alone
 * opens the on-screen keyboard. */

var LiteApp = (function () {
    'use strict';

    var KEY = {
        LEFT: 37, UP: 38, RIGHT: 39, DOWN: 40, ENTER: 13,
        BACK: 10009,
        PLAY: 415, PAUSE: 19, STOP: 413, REWIND: 412, FF: 417, PLAYPAUSE: 10252,
        RED: 403,
        IME_DONE: 65376, IME_CANCEL: 65385
    };
    // registerKey one at a time: registerKeyBatch only came with Tizen 2.4
    var REGISTER = ['MediaPlay', 'MediaPause', 'MediaStop', 'MediaRewind', 'MediaFastForward',
                    'MediaPlayPause', 'ColorF0Red'];

    var VISIBLE_RECENT = 5;      // rows that fit under the heading
    var STEP_MS = 10000, BIG_STEP_MS = 60000;
    var OSD_MS = 5000;

    var el = {};
    var recent = [];
    var focus = 0;               // 0 the text field, 1 Play, 2.. the recent rows
    var top = 0;                 // first recent row on screen
    var typing = false;

    var playing = false;
    var state = 'idle';          // idle | opening | playing | paused | buffering
    var durationMs = 0, positionMs = 0;
    var currentUrl = '';
    var osdTimer = null;

    function $(id) { return document.getElementById(id); }
    function setText(node, text) { if (node) node.textContent = text; }
    function setClass(node, name, on) {
        if (!node) return;
        var parts = (node.className || '').split(/\s+/), out = [];
        for (var i = 0; i < parts.length; i++) if (parts[i] && parts[i] !== name) out.push(parts[i]);
        if (on) out.push(name);
        node.className = out.join(' ');
    }
    function av() { return (typeof webapis !== 'undefined' && webapis.avplay) ? webapis.avplay : null; }
    function attempt(fn) { try { return fn(); } catch (e) { return undefined; } }

    /* ── Home ─────────────────────────────────────────────────────── */
    function message(text) { setText(el.message, text || ''); }

    function renderRecent() {
        while (el.recent.firstChild) el.recent.removeChild(el.recent.firstChild);
        el.recentTitle.style.display = recent.length ? 'block' : 'none';
        for (var i = top; i < recent.length && i < top + VISIBLE_RECENT; i++) {
            var row = document.createElement('div');
            row.className = 'row' + (focus === i + 2 ? ' focus' : '');
            row.style.top = ((i - top) * 80) + 'px';
            setText(row, recent[i]);
            el.recent.appendChild(row);
        }
    }

    function renderFocus() {
        if (focus > recent.length + 1) focus = recent.length + 1;
        if (focus >= 2) {
            var idx = focus - 2;
            if (idx < top) top = idx;
            if (idx >= top + VISIBLE_RECENT) top = idx - VISIBLE_RECENT + 1;
        } else {
            top = 0;
        }
        setClass(el.urlRow, 'focus', focus === 0);
        setClass(el.playRow, 'focus', focus === 1);
        renderRecent();
        setText(el.hint, focus === 0 ? 'OK: type an address, then Done on the keyboard' :
                         focus === 1 ? 'OK: play the address above' :
                                       'OK: play \u00a0\u00a0 Red: remove from this list');
    }

    function startTyping() {
        typing = true;
        message('');
        attempt(function () { el.url.focus(); });
    }
    function stopTyping() {
        typing = false;
        attempt(function () { el.url.blur(); });
    }

    function playTyped() {
        var url = LiteCore.normalizeUrl(el.url.value);
        if (!url) {
            message('That is not an address. It should look like http://example.com/stream.m3u8');
            focus = 0;
            return renderFocus();
        }
        el.url.value = url;
        open(url);
    }

    function homeKey(code) {
        if (typing) {
            // Done lands on Play instead of starting the stream: a slip of the
            // thumb on the keyboard should not cost a failed attempt.
            if (code === KEY.IME_DONE) {
                stopTyping();
                if (el.url.value) { focus = 1; renderFocus(); }
                return true;
            }
            if (code === KEY.IME_CANCEL || code === KEY.BACK) { stopTyping(); return true; }
            return false;                       // the keyboard's own keys
        }
        switch (code) {
        case KEY.UP:
            if (focus > 0) { focus--; renderFocus(); }
            return true;
        case KEY.DOWN:
            if (focus < recent.length + 1) { focus++; renderFocus(); }
            return true;
        case KEY.ENTER:
        case KEY.PLAY:
        case KEY.PLAYPAUSE:
            if (focus === 0 && code === KEY.ENTER) startTyping();
            else if (focus <= 1) playTyped();
            else open(recent[focus - 2]);
            return true;
        case KEY.RED:
            if (focus >= 2) {
                recent = LiteCore.removeRecent(localStorage, recent[focus - 2]);
                renderFocus();
            }
            return true;
        case KEY.BACK:
            attempt(function () { tizen.application.getCurrentApplication().exit(); });
            return true;
        }
        return false;
    }

    /* ── Player ───────────────────────────────────────────────────── */
    function screenSaver(on) {
        attempt(function () {
            var s = webapis.appcommon.AppCommonScreenSaverState;
            webapis.appcommon.setScreenSaver(on ? s.SCREEN_SAVER_ON : s.SCREEN_SAVER_OFF);
        });
    }

    function renderOsd() {
        var label = state === 'opening' ? 'Opening…' :
                    state === 'buffering' ? 'Buffering…' :
                    state === 'paused' ? 'Paused' : 'Playing';
        setText(el.osdState, label);
        setText(el.osdTitle, currentUrl);
        if (durationMs > 0) {
            setText(el.osdTime, LiteCore.formatTime(positionMs) + ' / ' + LiteCore.formatTime(durationMs));
            el.osdBar.style.display = 'block';
            el.osdFill.style.width = LiteCore.percent(positionMs, durationMs) + '%';
        } else {
            setText(el.osdTime, state === 'opening' ? '' : 'Live');
            el.osdBar.style.display = 'none';
        }
    }

    function showOsd() {
        setClass(document.body, 'osd', true);
        renderOsd();
        if (osdTimer) clearTimeout(osdTimer);
        osdTimer = setTimeout(function () {
            osdTimer = null;
            // it stays while there is something to wait for or to resume
            if (state === 'playing') setClass(document.body, 'osd', false);
        }, OSD_MS);
    }

    function setState(next) {
        state = next;
        if (next === 'playing') { if (document.body.className.indexOf('osd') >= 0) renderOsd(); }
        else showOsd();
    }

    function close(why) {
        var p = av();
        if (p) {
            attempt(function () { p.stop(); });
            attempt(function () { p.close(); });
        }
        if (osdTimer) { clearTimeout(osdTimer); osdTimer = null; }
        playing = false;
        state = 'idle';
        screenSaver(true);
        setClass(document.body, 'osd', false);
        setClass(document.body, 'playing', false);
        recent = LiteCore.readRecent(localStorage);
        message(why || '');
        renderFocus();
    }

    function fail(what) {
        close('Could not play this address' + (what ? ' (' + what + ')' : '') + '.');
    }

    var listener = {
        onbufferingstart: function () { if (playing && state !== 'paused') setState('buffering'); },
        onbufferingprogress: function () {},
        onbufferingcomplete: function () { if (playing && state === 'buffering') setState('playing'); },
        oncurrentplaytime: function (ms) {
            positionMs = Number(ms) || 0;
            if (document.body.className.indexOf('osd') >= 0) renderOsd();
        },
        onstreamcompleted: function () { if (playing) close(''); },
        onevent: function () {},
        onerror: function (type) { if (playing) fail(String(type || 'error')); },
        ondrmevent: function () {},
        onsubtitlechange: function () {}
    };

    function open(url) {
        var p = av();
        if (!p) return message('This TV has no AVPlay, so Tessel Lite cannot play anything here.');
        message('');
        currentUrl = url;
        durationMs = 0; positionMs = 0;
        playing = true;
        setClass(document.body, 'playing', true);
        setState('opening');
        try {
            attempt(function () { p.close(); });     // whatever a previous run left open
            p.open(url);
            p.setListener(listener);
            p.setDisplayRect(0, 0, 1920, 1080);
        } catch (e) {
            return fail(e && (e.name || e.message));
        }

        function ready() {
            if (!playing || currentUrl !== url) return;
            try {
                p.play();
            } catch (e) {
                return fail(e && (e.name || e.message));
            }
            durationMs = Number(attempt(function () { return p.getDuration(); })) || 0;
            screenSaver(false);
            recent = LiteCore.addRecent(localStorage, url);
            setState('playing');
            showOsd();
        }
        function refused(e) {
            if (playing && currentUrl === url) fail(e && (e.name || e.message));
        }

        try {
            if (typeof p.prepareAsync === 'function') p.prepareAsync(ready, refused);
            else { p.prepare(); ready(); }
        } catch (e) {
            refused(e);
        }
    }

    function togglePause() {
        var p = av();
        if (!p || state === 'opening') return;
        if (state === 'paused') {
            if (attempt(function () { p.play(); return true; })) setState('playing');
            showOsd();
        } else {
            if (attempt(function () { p.pause(); return true; })) setState('paused');
        }
    }

    function jump(ms) {
        var p = av();
        if (!p || state === 'opening' || !(durationMs > 0)) return showOsd();   // nowhere to go in a live stream
        attempt(function () {
            if (ms > 0) p.jumpForward(Math.min(ms, Math.max(0, durationMs - positionMs - 1000)));
            else p.jumpBackward(Math.min(-ms, positionMs));
        });
        positionMs = Math.max(0, Math.min(durationMs, positionMs + ms));
        showOsd();
    }

    function playerKey(code) {
        switch (code) {
        case KEY.BACK:
        case KEY.STOP:      close(''); return true;
        case KEY.ENTER:
        case KEY.PLAYPAUSE: togglePause(); return true;
        case KEY.PLAY:      if (state === 'paused') togglePause(); else showOsd(); return true;
        case KEY.PAUSE:     if (state !== 'paused') togglePause(); else showOsd(); return true;
        case KEY.LEFT:      jump(-STEP_MS); return true;
        case KEY.RIGHT:     jump(STEP_MS); return true;
        case KEY.REWIND:    jump(-BIG_STEP_MS); return true;
        case KEY.FF:        jump(BIG_STEP_MS); return true;
        case KEY.UP:
        case KEY.DOWN:      showOsd(); return true;
        }
        return false;
    }

    /* ── Start ────────────────────────────────────────────────────── */
    function onKey(ev) {
        var code = ev.keyCode;
        var handled = playing ? playerKey(code) : homeKey(code);
        if (handled && ev.preventDefault) ev.preventDefault();
    }

    function init() {
        el.url = $('url'); el.urlRow = $('url-row'); el.playRow = $('play-row');
        el.recent = $('recent'); el.recentTitle = $('recent-title');
        el.message = $('message'); el.hint = $('hint');
        el.osdState = $('osd-state'); el.osdTitle = $('osd-title'); el.osdTime = $('osd-time');
        el.osdBar = $('osd-bar'); el.osdFill = $('osd-fill');

        for (var i = 0; i < REGISTER.length; i++) {
            (function (name) { attempt(function () { tizen.tvinputdevice.registerKey(name); }); })(REGISTER[i]);
        }

        recent = LiteCore.readRecent(localStorage);
        if (recent.length) { el.url.value = recent[0]; focus = 1; }
        renderFocus();

        document.addEventListener('keydown', onKey, false);
        // the keyboard was closed some other way: the field is no longer being typed in
        el.url.addEventListener('blur', function () { typing = false; }, false);
        // Home key, another app, the TV going off: let go of the stream
        document.addEventListener('visibilitychange', function () {
            if (document.hidden && playing) close('');
        }, false);
        document.addEventListener('webkitvisibilitychange', function () {
            if (document.webkitHidden && playing) close('');
        }, false);
    }

    if (typeof document !== 'undefined') {
        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, false);
        else init();
    }

    return { init: init, KEY: KEY };
})();
