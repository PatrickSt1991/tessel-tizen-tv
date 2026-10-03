/* Keeps the TV from putting its screensaver over a still picture while the
 * app is showing one on purpose — the picture slideshow (issues #115, #126).
 *
 * Three things hold it off, because no single one does on every TV:
 *
 *  1. AppCommon's screensaver switch.  Samsung requires it of every app, and
 *     it is what turns the ordinary screensaver off on LCD sets.  Firmware
 *     can let it lapse, so it is asked again with every hold().
 *  2. The Power API's screen lock, where the firmware has it.  Most TVs
 *     don't (`tizen.power` is undefined there) — then it is skipped quietly.
 *  3. A hidden video.  Samsung's OLED sets run a panel-protection
 *     screensaver after two minutes without a key press, and that one
 *     ignores (1) and (2): it is the "same still image for 2 minutes"
 *     protection from Samsung's support pages, and nothing in the settings
 *     turns it off.  What it does respect is media playback, so while a
 *     hold is on, AVPlay plays assets/keepawake.mp4 — a black 176×144 clip
 *     at one frame a second, 35 KB for half an hour — behind the opaque
 *     picture view.  It restarts when it runs out and stops with release().
 *     The player's own AVPlay session is never touched: when music is on in
 *     the background, that playback is the hold.
 *
 * Everything each step answers goes to the debug log, so a TV where the
 * screensaver still comes can say which of the three gave way. */

var KeepAwake = (function () {
    var VIDEO = 'assets/keepawake.mp4';

    var held = false;        // a hold is on
    var videoOn = false;     // our clip is playing in AVPlay
    var videoFailed = false; // the clip wouldn't play this hold; don't keep trying
    var reason = '';

    function log(m) { if (typeof Debug !== 'undefined' && Debug.info) Debug.info('keepawake: ' + m); }
    function why(e) { return (e && (e.message || e.name)) || String(e); }

    /* The clip's path for AVPlay, which wants a plain absolute path rather
     * than a file:// URI (see Player.avplayUrl).  index.html sits in the
     * widget's root, so the clip is next to it. */
    function videoPath(href) {
        var base = String(href || (typeof location !== 'undefined' && location.href) || '');
        var s = base.replace(/[?#].*$/, '').replace(/[^\/]*$/, '') + VIDEO;
        if (s.indexOf('file://') === 0) {
            s = s.slice(7);
            try { s = decodeURIComponent(s); } catch (e) {}
        }
        return s;
    }

    function avplay() {
        return (typeof webapis !== 'undefined' && webapis.avplay) ? webapis.avplay : null;
    }
    /* The player has AVPlay for a film or music of its own. */
    function playerBusy() {
        try {
            if (typeof Player === 'undefined' || !Player.getBackend) return false;
            if (Player.getBackend() !== 'avplay') return false;
            var s = Player.state();
            return s !== 'NONE' && s !== 'IDLE';
        } catch (e) { return false; }
    }

    function screenSaver(off, note) {
        try {
            var ac = webapis.appcommon;
            ac.setScreenSaver(off ? ac.AppCommonScreenSaverState.SCREEN_SAVER_OFF
                                  : ac.AppCommonScreenSaverState.SCREEN_SAVER_ON,
                function () { note('screensaver ' + (off ? 'off' : 'on')); },
                function (e) { note('setScreenSaver failed: ' + why(e)); });
        } catch (e) { note('setScreenSaver threw: ' + why(e)); }
    }
    function powerLock(on, note) {
        if (typeof tizen === 'undefined' || !tizen.power) { note('no Power API on this TV'); return; }
        try {
            if (on) tizen.power.request('SCREEN', 'SCREEN_NORMAL');
            else    tizen.power.release('SCREEN');
            note('power.' + (on ? 'request' : 'release') + '(SCREEN) ok');
        } catch (e) { note('power.' + (on ? 'request' : 'release') + ' failed: ' + why(e)); }
    }

    function startVideo() {
        if (videoOn || videoFailed) return;
        var av = avplay();
        if (!av) { videoFailed = true; log('no AVPlay for the keep-awake clip'); return; }
        if (playerBusy()) { log('player has AVPlay (' + Player.state() + '); its playback is the hold'); return; }
        var path = videoPath();
        function failed(what) {
            videoFailed = true; videoOn = false;
            log('keep-awake clip ' + what);
            try { av.close(); } catch (e) {}
        }
        try {
            try { av.close(); } catch (e) {}
            av.open(path);
            av.setListener({
                onstreamcompleted: function () { if (videoOn) restartVideo(); },
                onerror:           function (e) { failed('error: ' + why(e)); },
                onerrormsg:        function (c, m) { failed('error: ' + (m || c)); }
            });
            videoOn = true;   // set before prepare so a sync play path counts
            var play = function () {
                try { av.play(); log('keep-awake clip playing (' + path + ')'); }
                catch (e) { failed('play() threw: ' + why(e)); }
            };
            if (typeof av.prepareAsync === 'function') {
                av.prepareAsync(play, function (e) { failed('prepareAsync failed: ' + why(e)); });
            } else { av.prepare(); play(); }
        } catch (e) { failed('open failed: ' + why(e)); }
    }
    function restartVideo() {
        var av = avplay();
        if (!av) return;
        try { av.stop(); av.prepare(); av.play(); log('keep-awake clip restarted'); }
        catch (e) { videoOn = false; log('keep-awake clip restart failed: ' + why(e)); }
    }
    function stopVideo() {
        if (!videoOn) return;
        videoOn = false;
        var av = avplay();
        if (!av) return;
        try { av.stop(); } catch (e) {}
        try { av.close(); } catch (e) {}
        log('keep-awake clip stopped');
    }

    /* Keep the screen awake until release().  Call it again as often as
     * you like (the slideshow does with every picture): the switches are
     * re-asserted, the clip is left playing, and only a change is logged. */
    function hold(what) {
        var changed = !held;
        held = true;
        reason = what || reason || '';
        function note(m) { if (changed) log((reason ? reason + ': ' : '') + m); }
        powerLock(true, note);
        screenSaver(true, note);
        startVideo();
    }
    function release() {
        if (!held) return;
        held = false;
        function note(m) { log((reason ? reason + ': ' : '') + m); }
        stopVideo();
        videoFailed = false;
        powerLock(false, note);
        screenSaver(false, note);
        reason = '';
    }
    function isHeld() { return held; }

    return { hold: hold, release: release, isHeld: isHeld, videoPath: videoPath };
})();

// Ignored by the Tizen/browser build; lets Node tests require the module.
if (typeof module !== 'undefined' && module.exports) module.exports = KeepAwake;
