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
 *     hold is on, assets/keepawake.mp4 — a black 176×144 clip at one frame
 *     a second, 35 KB for half an hour — plays behind the opaque picture
 *     view.  AVPlay is asked first, with each way of naming the file it
 *     might take; an OLED set answered the plain path with
 *     PLAYER_ERROR_INVALID_URI (issue #132), so when AVPlay takes none of
 *     them a muted, looping <video> plays it instead — the page can always
 *     read its own files.  The clip restarts when it runs out and stops
 *     with release().  The player's own AVPlay session is never touched:
 *     when music is on in the background, that playback is the hold.
 *
 * Everything each step answers goes to the debug log, so a TV where the
 * screensaver still comes can say which of the three gave way. */

var KeepAwake = (function () {
    var VIDEO = 'assets/keepawake.mp4';

    var held = false;        // a hold is on
    var videoOn = false;     // our clip is playing (or being started)
    var videoFailed = false; // the clip wouldn't play this hold; don't keep trying
    var attempt = 0;         // bumped per start/stop, so a stale callback is ignored
    var element = null;      // the <video> when AVPlay took none of the paths
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
    /* Every name for the clip AVPlay might take, most likely first: the
     * plain path under where the filesystem API says the package is, the
     * same as a file:// URI, then both again under the folder the page was
     * loaded from.  The package folder goes first because the page's can
     * be a virtual one (a 2024 set loaded index.html from file:/// and
     * AVPlay rejected /assets/keepawake.mp4, then took the real path under
     * /home/owner/apps_rw, issue #132); where the two are the same folder
     * the list is just shorter. */
    function videoCandidates(packageUri) {
        var list = [];
        function add(s) { if (s && list.indexOf(s) < 0) list.push(s); }
        function both(p) {
            add(p);
            if (p.charAt(0) === '/') add('file://' + p);
        }
        if (packageUri) both(videoPath(packageUri.replace(/\/?$/, '/')));
        both(videoPath());
        return list;
    }
    /* cb(uri of the package folder, or '') — never throws, always answers. */
    function packageUri(cb) {
        try {
            tizen.filesystem.resolve('wgt-package', function (dir) {
                var u = '';
                try { u = dir.toURI(); } catch (e) {}
                cb(u);
            }, function () { cb(''); }, 'r');
        } catch (e) { cb(''); }
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
        if (av && playerBusy()) { log('player has AVPlay (' + Player.state() + '); its playback is the hold'); return; }
        videoOn = true;
        var token = ++attempt;
        if (!av) { log('no AVPlay for the keep-awake clip'); startElement(token); return; }
        packageUri(function (pkg) {
            if (token === attempt) tryAvplay(videoCandidates(pkg), 0, token);
        });
    }
    function giveUp(what) {
        videoFailed = true; videoOn = false;
        log('keep-awake clip ' + what);
    }
    /* Path `i` of `list` in AVPlay; one it won't take moves on to the next,
     * and when none is left, to the <video>.  An error once the clip plays
     * ends the clip for this hold. */
    function tryAvplay(list, i, token) {
        if (i >= list.length) { startElement(token); return; }
        var av = avplay(), path = list[i], playing = false, done = false;
        function current() { return token === attempt && !done; }
        function rejected(what) {
            if (!current()) return;
            done = true;
            try { av.close(); } catch (e) {}
            if (playing) { giveUp('error: ' + what); return; }
            log('keep-awake clip ' + path + ': ' + what);
            tryAvplay(list, i + 1, token);
        }
        try {
            try { av.close(); } catch (e) {}
            av.open(path);
            av.setListener({
                onstreamcompleted: function () { if (current()) restartVideo(); },
                onerror:           function (e) { rejected(why(e)); },
                onerrormsg:        function (c, m) { rejected(m || c); }
            });
            var play = function () {
                if (!current()) return;
                try { av.play(); playing = true; log('keep-awake clip playing (' + path + ')'); }
                catch (e) { rejected('play() threw: ' + why(e)); }
            };
            if (typeof av.prepareAsync === 'function') {
                av.prepareAsync(play, function (e) { rejected('prepareAsync failed: ' + why(e)); });
            } else { av.prepare(); play(); }
        } catch (e) { rejected('open failed: ' + why(e)); }
    }
    function restartVideo() {
        var av = avplay();
        if (!av) return;
        try { av.stop(); av.prepare(); av.play(); log('keep-awake clip restarted'); }
        catch (e) { videoOn = false; log('keep-awake clip restart failed: ' + why(e)); }
    }
    /* The clip in a muted, looping <video>, out of sight behind the views. */
    function startElement(token) {
        if (typeof document === 'undefined' || !document.body) { giveUp('has nowhere to play'); return; }
        var v = document.createElement('video');
        v.muted = true;
        v.loop = true;
        v.setAttribute('muted', '');
        v.setAttribute('playsinline', '');
        v.setAttribute('aria-hidden', 'true');
        v.style.cssText = 'position:fixed;left:0;top:0;width:2px;height:2px;opacity:0.01;' +
                          'pointer-events:none;z-index:-1';
        function failed(what) {
            if (token !== attempt || element !== v) return;
            removeElement();
            giveUp('in <video> ' + what);
        }
        v.addEventListener('playing', function () {
            if (token === attempt && element === v) log('keep-awake clip playing in <video> (' + VIDEO + ')');
        });
        v.addEventListener('error', function () {
            failed('error ' + ((v.error && v.error.code) || '?'));
        });
        element = v;
        v.src = VIDEO;
        document.body.appendChild(v);
        try {
            var p = v.play();
            if (p && typeof p.then === 'function') p.then(null, function (e) { failed('play() refused: ' + why(e)); });
        } catch (e) { failed('play() threw: ' + why(e)); }
    }
    function removeElement() {
        var v = element;
        element = null;
        if (!v) return;
        try { v.pause(); } catch (e) {}
        try { v.removeAttribute('src'); v.load(); } catch (e) {}
        try { if (v.parentNode) v.parentNode.removeChild(v); } catch (e) {}
    }
    function stopVideo() {
        attempt++;
        if (!videoOn) return;
        videoOn = false;
        if (element) { removeElement(); log('keep-awake clip stopped'); return; }
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

    return { hold: hold, release: release, isHeld: isHeld,
             videoPath: videoPath, videoCandidates: videoCandidates };
})();

// Ignored by the Tizen/browser build; lets Node tests require the module.
if (typeof module !== 'undefined' && module.exports) module.exports = KeepAwake;
