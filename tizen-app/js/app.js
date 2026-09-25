/* Top-level app coordinator: state, view transitions, action dispatch.
 *
 * Views (mutually exclusive):
 *   home    — start screen with three tiles
 *   url     — keyboard-input URL entry
 *   browse  — file browser (USB / local roots)
 *   player  — fullscreen video with OSD
 */

(function () {

    /* ── Recently-played (localStorage-backed, capped) ───────────────── */
    var RECENT_KEY = 'vlctv_recent_v1';
    function getRecent() {
        try { return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]'); }
        catch (e) { return []; }
    }
    function pushRecent(item) {
        /* Subtitle entries carry a Tizen File object that won't survive
         * JSON.stringify (it serializes to {}).  Keep only the plain
         * fields needed to find the same sibling SRT on the next replay —
         * Browser.readSubtitleText will lazily re-resolve the File from
         * the path when it's actually needed.  Extracted-from-MP4 subs
         * are skipped: they live in wgt-private-tmp with random names and
         * get re-generated on next file open anyway. */
        var subs = (item.subtitles || [])
            .filter(function (s) { return s && !s._extracted; })
            .map(function (s) {
                return {
                    name:     s.name,
                    lang:     s.lang || '',
                    ext:      s.ext  || '',
                    fullPath: s.fullPath || '',
                    uri:      s.uri || ''
                };
            });
        var entry = { uri: item.uri, title: item.title };
        if (subs.length) entry.subtitles = subs;

        var list = getRecent().filter(function (x) { return x.uri !== entry.uri; });
        list.unshift(entry);
        list = list.slice(0, 20);
        try { localStorage.setItem(RECENT_KEY, JSON.stringify(list)); } catch (e) {}
    }

    /* ── Watched history (localStorage map uri → timestamp) ──────────
     * Lets the browser mark already-seen episodes so navigating a series
     * folder shows at a glance which files are done.  An item is marked
     * watched when playback finishes (oncomplete) or when the user leaves
     * after watching ≥ 90 % of it. */
    var WATCHED_KEY = 'vlctv_watched_v1';
    function getWatched() {
        try { return JSON.parse(localStorage.getItem(WATCHED_KEY) || '{}'); }
        catch (e) { return {}; }
    }
    function isWatched(uri) {
        if (!uri) return false;
        return !!getWatched()[uri];
    }
    function markWatched(uri) {
        if (!uri) return;
        // A finished file should start from the beginning next time.
        clearResumePos(uri);
        var w = getWatched();
        if (w[uri]) return;
        w[uri] = Date.now();
        // Cap growth: drop the oldest entries once we pass 500.
        var keys = Object.keys(w);
        if (keys.length > 500) {
            keys.sort(function (a, b) { return w[a] - w[b]; })
                .slice(0, keys.length - 500)
                .forEach(function (k) { delete w[k]; });
        }
        try { localStorage.setItem(WATCHED_KEY, JSON.stringify(w)); } catch (e) {}
    }

    /* ── Resume positions (localStorage map uri → {pos, dur, ts}) ─────
     * Lets a reopened file continue from where the user left off.  The
     * position is checkpointed every few seconds while playing (so it
     * survives a power-off where exitPlayer never runs) and saved on
     * exit / standby.  It's cleared once the file counts as watched
     * (oncomplete or ≥ 90 %) so finished files restart from zero. */
    var RESUME_KEY = 'vlctv_resume_v1';
    var RESUME_MIN_MS = 30000;   // positions in the first 30 s aren't worth resuming
    /* Aim the resume seek this far BEFORE the saved position.  AVPlay can
     * only land on keyframes and rounds the seek target forward to the
     * next one (~5-6 s GOPs are typical), so an exact-target seek ends up
     * PAST where the user left off.  Backing off 10 s makes the snap land
     * at or just before the exit point — replaying a few seconds of
     * context instead of silently skipping content. */
    var RESUME_BACKOFF_MS = 10000;
    /* Prev doubles as Restart: past this point in the file it seeks to 0,
     * and only a press within the first seconds jumps to the previous item
     * (the music-player convention).  Also the floor for dimming the OSD
     * button when there is neither a previous item nor anything to rewind. */
    var RESTART_THRESHOLD_MS = 3000;

    // Where the error hints send people for the transcode server.
    var RELEASES_URL = 'github.com/PatrickSt1991/tessel-tizen-tv/releases';

    function getResumeMap() {
        try { return JSON.parse(localStorage.getItem(RESUME_KEY) || '{}'); }
        catch (e) { return {}; }
    }
    function setResumeMap(m) {
        try { localStorage.setItem(RESUME_KEY, JSON.stringify(m)); } catch (e) {}
    }
    function resumePosFor(uri) {
        if (!uri) return 0;
        var r = getResumeMap()[uri];
        return (r && r.pos > RESUME_MIN_MS) ? r.pos : 0;
    }
    function saveResumePos(uri, timeMs, durMs) {
        if (!uri) return;
        var m = getResumeMap();
        if (!timeMs || timeMs < RESUME_MIN_MS) {
            // Stopped near the start: drop any stale position so the next
            // open starts clean instead of jumping to an old spot.
            if (m[uri]) { delete m[uri]; setResumeMap(m); }
            return;
        }
        m[uri] = { pos: Math.floor(timeMs), dur: Math.floor(durMs || 0), ts: Date.now() };
        // Cap growth: drop the oldest entries once we pass 200.
        var keys = Object.keys(m);
        if (keys.length > 200) {
            keys.sort(function (a, b) { return m[a].ts - m[b].ts; })
                .slice(0, keys.length - 200)
                .forEach(function (k) { delete m[k]; });
        }
        setResumeMap(m);
    }
    function clearResumePos(uri) {
        if (!uri) return;
        var m = getResumeMap();
        if (m[uri]) { delete m[uri]; setResumeMap(m); }
    }

    /* ── State ────────────────────────────────────────────────────── */
    var state = {
        view:       'home',        // home | url | browse | player
        browseDir:  null,          // current Tizen File or null at root listing
        browseAtRoot: true,        // true when listing the virtual roots
        playingUri: null,
        playingTitle: '',
        // Where the current playback was launched from, so exiting the
        // player returns to that menu instead of always jumping home.
        origin:     'home',        // 'browse' | 'recent' | 'url' | 'home'
        originDir:  null,          // Tizen File of the browse folder when origin==='browse'
        // Ordered playable siblings + position, powering auto-play / next-prev.
        playlist:   [],            // [{ uri, title, subtitles }]
        playlistIndex: -1,
        // Set while smart routing plays a share file directly instead of
        // through the transcode server: { uri, title, opts } to replay if the
        // direct open never starts.  See retryThroughServer().
        directFallback: null
    };
    // Latest progress sample, used to decide partial-watch → watched on exit.
    var lastProgress = { time: 0, duration: 0 };
    // Throttle for the periodic resume-position checkpoint.
    var lastResumeSaveAt = 0;
    // Whether the OSD Prev button is currently lit as "Restart".
    var prevRestartLit = false;

    /* When the TV goes to standby, Tizen suspends the WebView.  AVPlay does
     * NOT survive this cleanly: on wake the session comes back with A/V
     * desync (short standby) or in a broken state where every operation
     * returns a codec-shaped error (long standby — the "MKV couldn't be
     * played" false report in issue #42).  Instead of trusting whatever
     * AVPlay hands back, we snapshot the current file + position on hidden
     * and re-open it from scratch on visible.  See onVisibilityChange +
     * the pendingResume block in the onstatechange('playing') handler. */
    var standbySnapshot = null;
    var pendingResume   = null;

    /* ── Init ─────────────────────────────────────────────────────── */
    function init() {
        Remote.init();

        // Wire button data-action click → dispatch.  Buttons stay
        // keyboard-activatable too because UI.activateFocused() calls click().
        document.body.addEventListener('click', function (ev) {
            var t = ev.target.closest('[data-action]');
            if (t) handleAction(t.dataset.action, t);
        });

        // Collapsible Settings sections (issue #28): clicking a section
        // toggle expands or collapses the next-sibling .settings-group it
        // points at via data-toggle.  Because the collapsed state uses
        // display:none, the inputs inside fall out of the focusable list
        // and the D-pad can't accidentally land on them — which is what
        // was popping the on-screen keyboard repeatedly and lagging /
        // crashing the app on slower Tizen firmware.
        document.body.addEventListener('click', function (ev) {
            var t = ev.target.closest('.settings-section-toggle');
            if (!t) return;
            var grp = document.getElementById(t.getAttribute('data-toggle'));
            if (!grp) return;
            var opening = grp.classList.contains('is-collapsed');
            grp.classList.toggle('is-collapsed', !opening);
            t.setAttribute('aria-expanded', opening ? 'true' : 'false');
            UI.refreshFocusables();
        });

        // Preset URL chips
        document.querySelectorAll('.preset').forEach(function (el) {
            el.addEventListener('click', function () {
                document.getElementById('url-input').value = el.dataset.url;
                openUrl(el.dataset.url);
            });
        });

        // Global remote handler — dispatched per current view
        Remote.push(globalKeyHandler);

        // Player events
        Player.setListener('onstatechange', function (s) {
            if (typeof Debug !== 'undefined') Debug.player('state → ' + s);
            updatePlayPauseButton(s);
            if (s === 'playing') {
                /* Don't clear the watchdog here — it needs to keep running so
                 * it can detect the "PLAYING but stuck at time=0" case.  The
                 * watchdog disarms itself once it sees time advancing. */
                hideSpinner();
                showOSD(true);
                scheduleOSDHide();
                applyLanguagePreferences();
                updateSpeedButton();   // Player.open reset speed to 1×; reflect it on the OSD

                /* Post-standby resume (issue #42): apply the saved position
                 * + paused state once the freshly-reopened file is actually
                 * playing.  Left paused so pressing Play resumes on the
                 * user's terms rather than blasting audio on TV wake. */
                if (pendingResume) {
                    var pr = pendingResume; pendingResume = null;
                    if (typeof Debug !== 'undefined')
                        Debug.player('standby-resume: seekTo=' + pr.pos + ' paused=' + pr.paused);
                    try {
                        if (pr.pos > 1500) {
                            Player.seekTo(pr.pos);
                            if (pr.announce) UI.toast(I18n.t('player.resumedFrom', fmtTime(pr.pos)));
                        }
                        if (pr.paused) Player.pause();
                    } catch (e) {}
                }
            }
        });
        Player.setListener('onerror', function (msg) {
            var text = typeof msg === 'string' ? msg
                       : (msg && msg.message ? msg.message : JSON.stringify(msg));
            if (typeof Debug !== 'undefined') Debug.error('player onerror: ' + text);
            if (retryThroughServer('player error: ' + text)) return;
            // If the failing URL is an SMB proxy stream, drain the service's
            // ring-buffer log to the PC listener so we can diagnose what the
            // proxy was doing when AVPlay gave up.
            if (typeof SMB !== 'undefined' && SMB.isStreamUrl && SMB.isStreamUrl(state.playingUri)) {
                try { SMB.dumpServiceLogs(); } catch (e) {}
            }
            showError(text);
        });
        Player.setListener('onbuffering', function (active) {
            if (active) showSpinner(I18n.t('player.buffering'));
            else hideSpinner();
        });
        Player.setListener('onprogress', function (p) {
            lastProgress = { time: (p && p.time) || 0, duration: (p && p.duration) || 0 };
            // A committed scrub seek stays "waiting" until the playhead
            // lands near its target (async AVPlay seeks report the pre-seek
            // position for a while), with a timeout for failed seeks.
            if (scrub.waiting && !scrub.active &&
                (Math.abs(lastProgress.time - scrub.pos) <= SCRUB_SETTLE_TOL_MS ||
                 Date.now() - scrub.commitAt > SCRUB_SETTLE_MAX_MS))
                scrub.waiting = false;
            // While scrubbing or settling, the bar shows the preview
            // position, not the real playhead.
            if (!scrub.active && !scrub.waiting)
                updateProgress(p && p.time, p && p.duration);
            // Prev lights up as Restart once past the first seconds.
            var canRestart = lastProgress.time > RESTART_THRESHOLD_MS;
            if (canRestart !== prevRestartLit) { prevRestartLit = canRestart; updateNextPrevButtons(); }
            // Checkpoint the position every 5 s so it survives a power-off
            // or app kill where exitPlayer never gets a chance to run.
            if (state.playingUri && lastProgress.time >= RESUME_MIN_MS &&
                Date.now() - lastResumeSaveAt > 5000) {
                lastResumeSaveAt = Date.now();
                saveResumePos(state.playingUri, lastProgress.time, lastProgress.duration);
            }
        });
        Player.setListener('oncomplete', function () {
            if (Settings.get('repeatMode') === 'one' && state.playingUri) {
                if (typeof Debug !== 'undefined') Debug.player('oncomplete: repeating');
                Player.seekTo(0);
                Player.play();
                return;
            }
            // A file that played to the end counts as watched.
            markWatched(state.playingUri);
            // Auto-play the next sibling if enabled and one exists.
            if (Settings.get('autoPlay') && playNext(true)) return;
            UI.toast(I18n.t('player.finished'));
            exitPlayer();
        });
        // A track being read out of the container, or one that turned out
        // unreadable — the only place the user hears about either.
        Player.setListener('onsubnotice', function (msg) {
            if (msg) UI.toast(msg);
        });
        Player.setListener('onsubsupdated', function () {
            // Tracks the container declared but AVPlay never listed land
            // here — give an unmatched language preference another go.
            retrySubtitlePreference();
            // MP4 embedded-sub extraction completed.  If the CC menu is
            // currently open, re-render it so the new entries appear.
            var menu = document.getElementById('track-menu');
            if (menu && !menu.classList.contains('hidden')) {
                openTrackMenu();
            }
        });

        // Reflow display rect on size changes
        window.addEventListener('resize', Player.setDisplayRect);

        // Standby-safe playback restore (issue #42).
        document.addEventListener('visibilitychange', onVisibilityChange);

        // Second path for dedicated remote media keys (issue #42): on some
        // Samsung Smart Monitors the remote's Play / Pause / FF / RW keys
        // never arrive as `keydown` events at all — they're routed through
        // Chromium's MediaSession API instead.  Register handlers so those
        // remotes control playback too.  Only meaningful for the HTML5
        // backend (MP4/HLS); the AVPlay backend doesn't own a media element
        // and never becomes the browser's "active" media session, so this
        // is best-effort — the tvinputdevice path in remote.js remains the
        // primary route for AVPlay files.
        installMediaSessionHandlers();

        UI.showView('view-home');
        updateRepeatButton();        // reflect saved repeat preference on OSD
        updateShuffleButton();       // reflect saved shuffle preference on OSD
        /* A mode saved by an older build that no longer exists — the zoom
           and crop modes AVPlay turned out to be incapable of — would show
           as Fit on the OSD while the stored value said otherwise. */
        if (!AspectRatio.isKnown(Settings.get('aspectMode'))) Settings.set('aspectMode', 'fit');
        updateAspectButton();        // reflect the saved aspect mode on the OSD
        SubtitleStyle.apply();       // push saved subtitle appearance onto the overlay
    }

    /* ── Action dispatcher ────────────────────────────────────────── */
    function handleAction(action, el) {
        if (typeof Debug !== 'undefined') Debug.action(action);
        switch (action) {
            case 'open-url':           UI.showView('view-url'); state.view = 'url'; break;
            case 'browse-usb':         openBrowserAtRoot(); break;
            case 'browse-smb':         SMB.openBrowser(); break;
            case 'browse-recent':      openRecent(); break;
            case 'open-settings':      openSettings(); break;
            case 'open-current-url': {
                var v = document.getElementById('url-input').value.trim();
                if (v) openUrl(v);
                else UI.toast(I18n.t('url.enterFirst'));
                break;
            }
            case 'fetch-remote-url':   fetchRemoteUrl(); break;
            case 'back-home':          backToHome(); break;
            case 'play-pause':         Player.togglePause(); scheduleOSDHide(); break;
            case 'stop':               exitPlayer(); break;
            case 'prev':               handlePrev(); break;
            case 'next':               if (!playNext(false)) UI.toast(I18n.t('player.noNext'));     break;
            case 'rewind':             Player.seekRel(-10000); flashOSD(); break;
            case 'forward':            Player.seekRel( 10000); flashOSD(); break;
            case 'seek-backward':      Player.seekRel(-60000); flashOSD(); break;
            case 'seek-forward':       Player.seekRel( 60000); flashOSD(); break;
            case 'toggle-repeat':      toggleRepeat(); break;
            case 'toggle-shuffle':     toggleShuffle(); break;
            case 'open-speed-picker':  openSpeedPicker(); break;
            case 'open-aspect-picker': openAspectPicker(); break;
            case 'open-track-menu':    openTrackMenu(); break;
            case 'close-track-menu':   closeTrackMenu(); break;
            case 'setting-ui-lang':       openUiLangPicker(); break;
            case 'setting-audio-lang':    openLangPicker('audioLang',    I18n.t('settings.audioLang'), LanguageList.forAudio());    break;
            case 'setting-subtitle-lang': openLangPicker('subtitleLang', I18n.t('settings.subtitleLang'), LanguageList.forSubtitle()); break;
            case 'setting-repeat-mode':   openRepeatPicker(); break;
            case 'setting-auto-play':     openAutoPlayPicker(); break;
            case 'setting-resume-mode':   openResumeModePicker(); break;
            case 'setting-shuffle':       openShufflePicker(); break;
            case 'setting-aspect-mode':   openAspectPicker(); break;
            case 'setting-subtitle-size':     openSubtitlePicker('subtitleSize',     I18n.t('settings.subSize'),     SubtitleStyle.forSize());     break;
            case 'setting-subtitle-font':     openSubtitlePicker('subtitleFont',     I18n.t('settings.subFont'),     SubtitleStyle.forFont());     break;
            case 'setting-subtitle-position': openSubtitlePicker('subtitlePosition', I18n.t('settings.subPosition'), SubtitleStyle.forPosition()); break;
            case 'setting-subtitle-bg':       openSubtitlePicker('subtitleBg',       I18n.t('settings.subBg'),       SubtitleStyle.forBg());       break;
            case 'close-picker':       closePicker(); break;
        }
    }

    /* ── URL playback ─────────────────────────────────────────────── */
    function openUrl(url) {
        var title = urlBaseName(url);
        state.origin    = 'url';
        state.originDir = null;
        state.playlist  = [{ uri: url, title: title }];
        state.playlistIndex = 0;
        playUri(url, title, { askResume: true });
    }

    /* ── URL drop (paste from any device) ─────────────────────────────
     * Pull the most recent URL the user pasted from their phone/tablet/laptop
     * and play it. The field is filled first so the URL is visible if
     * playback fails. Pairing (code + QR) lives in Settings. */
    function fetchRemoteUrl() {
        if (typeof UrlDrop === 'undefined') { UI.toast(I18n.t('url.dropUnavailable')); return; }
        UI.toast(I18n.t('url.checking'));
        UrlDrop.fetchLatest(function (err, url) {
            if (err) {
                if (typeof Debug !== 'undefined') Debug.error('url-drop: ' + err);
                UI.toast(I18n.t('url.serviceDown'));
                return;
            }
            if (!url) {
                UI.toast(I18n.t('url.nothingWaiting'));
                return;
            }
            var input = document.getElementById('url-input');
            if (input) input.value = url;
            UI.toast(I18n.t('url.gotIt'));
            openUrl(url);
        });
    }

    /* Pairing block in Settings: code + bare page URL + a locally-generated
     * QR (encodes the page URL with the code in the hash, so scanning opens
     * the device page already paired). QR is rendered offline — the code
     * never leaves the TV via a third-party QR service. */
    function renderPairingBlock() {
        if (typeof UrlDrop === 'undefined') return;
        var urlEl  = document.getElementById('pair-url');
        var codeEl = document.getElementById('pair-code');
        if (urlEl)  urlEl.textContent  = UrlDrop.pageUrl();
        if (codeEl) codeEl.textContent = UrlDrop.code();

        var qrEl = document.getElementById('pair-qr');
        if (!qrEl) return;
        if (typeof qrcode === 'undefined') { qrEl.textContent = ''; return; }
        try {
            var qr = qrcode(0, 'M');
            qr.addData(UrlDrop.deviceUrl());
            qr.make();
            qrEl.innerHTML = '<img alt="' + escapeHtml(I18n.t('cast.qrAlt')) + '" ' +
                'style="width:100%;height:100%;image-rendering:pixelated" src="' +
                qr.createDataURL(8, 8) + '">';
        } catch (e) {
            if (typeof Debug !== 'undefined') Debug.error('pair-qr: ' + e);
            qrEl.textContent = '';
        }
    }
    function urlBaseName(url) {
        try {
            var p = url.split('?')[0].split('#')[0];
            var seg = p.split('/').filter(Boolean);
            return decodeURIComponent(seg[seg.length - 1] || url);
        } catch (e) { return url; }
    }

    /* ── File browser ─────────────────────────────────────────────── */
    function openBrowserAtRoot() {
        state.browseAtRoot = true;
        state.browseDir   = null;
        UI.showView('view-browse'); state.view = 'browse';
        document.getElementById('browse-title').textContent = I18n.t('browse.storage');
        document.getElementById('browse-path').textContent = '/';

        Browser.listRoots(function (err, roots) {
            var ul = document.getElementById('browse-list');
            ul.innerHTML = '';
            if (err) {
                ul.innerHTML = '<li><span class="icon">!</span><span class="name">' +
                               err.message + '</span></li>';
                return;
            }
            if (!roots.length) {
                ul.innerHTML = '<li><span class="icon">i</span>'
                             + '<span class="name">' + escapeHtml(I18n.t('browse.noStorage')) + '</span></li>';
                return;
            }
            roots.forEach(function (r, i) {
                var li = document.createElement('li');
                li.dataset.tag = 'root-' + i;
                li.dataset.idx = i;
                var pretty = prettifyRootName(r.name);
                var isUsb  = /removable|usb/i.test(r.name);
                li.innerHTML  =
                    '<span class="icon">' + (isUsb ? '💾' : '📁') + '</span>' +
                    '<span class="name">' + escapeHtml(pretty) + '</span>' +
                    '<span class="meta">' + escapeHtml(r.fullPath) + '</span>';
                li.addEventListener('click', function () {
                    state.browseAtRoot = false;
                    listInto(r.dir);
                });
                ul.appendChild(li);
            });
            UI.refreshFocusables(); UI.focusOn(ul.firstElementChild);
        });
    }

    function listInto(dir) {
        if (!dir) return;
        state.browseDir = dir;
        document.getElementById('browse-title').textContent = dir.name || I18n.t('browse.folder');
        document.getElementById('browse-path').textContent = dir.fullPath;

        Browser.listDir(dir, function (err, entries) {
            var ul = document.getElementById('browse-list');
            ul.innerHTML = '';
            if (err) {
                ul.innerHTML = '<li><span class="icon">!</span><span class="name">'
                             + err.message + '</span></li>';
                return;
            }
            // Ordered list of playable media in this folder — the playlist
            // that auto-play and next/prev walk through.
            var playlist = entries
                .filter(function (e) { return e.playable; })
                .map(function (e) { return { uri: e.uri, title: e.name, subtitles: e.subtitles, file: e.file }; });

            entries.forEach(function (e) {
                if (e.isDir === false && !e.playable) return; // hide non-media files
                var li = document.createElement('li');
                li.dataset.uri = e.uri || '';
                li.dataset.dir = e.isDir ? '1' : '0';
                var watched = !e.isDir && isWatched(e.uri);
                if (watched) li.classList.add('watched-item');
                var watchedBadge = watched ? '<span class="watched" title="' + escapeHtml(I18n.t('browse.watched')) + '">✓</span>' : '';
                var subBadge = (e.subtitles && e.subtitles.length)
                    ? '<span class="meta">CC ×' + e.subtitles.length + '</span>'
                    : '';
                li.innerHTML =
                    '<span class="icon">' + (e.isDir ? '📁' : '🎬') + '</span>' +
                    '<span class="name">' + escapeHtml(e.name) + '</span>' +
                    watchedBadge +
                    subBadge +
                    (e.isDir ? '' :
                        '<span class="meta">' + Browser.humanSize(e.size) + '</span>');
                li.addEventListener('click', function () {
                    if (e.isDir) { listInto(e.file); return; }
                    var idx = playlist.findIndex(function (p) { return p.uri === e.uri; });
                    playFromList('browse', playlist, idx >= 0 ? idx : 0, dir);
                });
                ul.appendChild(li);
            });
            UI.refreshFocusables();
            UI.focusOn(ul.firstElementChild);
        });
    }

    function browseUp() {
        if (state.browseAtRoot) { backToHome(); return; }
        var p = Browser.parentOf(state.browseDir);
        if (!p) { openBrowserAtRoot(); return; }
        listInto(p);
    }

    function openRecent() {
        var list = getRecent();
        if (!list.length) { UI.toast(I18n.t('recent.none')); return; }
        UI.showView('view-browse'); state.view = 'browse'; state.browseAtRoot = true;
        document.getElementById('browse-title').textContent = I18n.t('home.recent');
        document.getElementById('browse-path').textContent = '';
        var ul = document.getElementById('browse-list'); ul.innerHTML = '';
        var playlist = list.map(function (item) {
            return { uri: item.uri, title: item.title, subtitles: item.subtitles };
        });
        list.forEach(function (item, i) {
            var li = document.createElement('li');
            var watched = isWatched(item.uri);
            if (watched) li.classList.add('watched-item');
            var watchedBadge = watched ? '<span class="watched" title="' + escapeHtml(I18n.t('browse.watched')) + '">✓</span>' : '';
            li.innerHTML = '<span class="icon">★</span>' +
                           '<span class="name">' + escapeHtml(item.title) + '</span>' +
                           watchedBadge +
                           '<span class="meta">' + escapeHtml(item.uri) + '</span>';
            li.addEventListener('click', function () {
                playFromList('recent', playlist, i, null);
            });
            ul.appendChild(li);
        });
        UI.refreshFocusables();
        UI.focusOn(ul.firstElementChild);
    }

    /* ── Standby handling (issue #42) ────────────────────────────────
     * Tizen sends `visibilitychange` when the TV screen turns off / the app
     * gets hidden by another surface.  AVPlay's session doesn't survive
     * that reliably (see the standbySnapshot comment above); we tear down
     * on hidden and, on wake, re-open the same file with the saved
     * subtitles list and defer a seek-to-position + pause until the new
     * session actually reaches PLAYING (handled in the onstatechange
     * listener). */
    function onVisibilityChange() {
        if (document.visibilityState === 'hidden') {
            if (state.view !== 'player' || !state.playingUri) return;
            var subs = [];
            var cur = state.playlist[state.playlistIndex];
            if (cur && cur.subtitles) subs = cur.subtitles;
            standbySnapshot = {
                uri:       state.playingUri,
                title:     state.playingTitle,
                subtitles: subs,
                // Preserve the live Tizen File object for standby resumes;
                // it carries size/path APIs used by incremental extraction.
                file:      cur && cur.file ? cur.file : null,
                pos:       Player.currentTime() || 0,
                paused:    Player.state() === 'PAUSED'
            };
            if (typeof Debug !== 'undefined')
                Debug.player('visibility=hidden: snapshot pos=' + standbySnapshot.pos + 'ms paused=' + standbySnapshot.paused);
            // Persist the exact position too — if the TV never wakes back
            // into the app, the next launch still resumes from here.
            saveResumePos(state.playingUri, standbySnapshot.pos, lastProgress.duration);
            try { Player.stop(); } catch (e) {}
        } else if (document.visibilityState === 'visible') {
            if (!standbySnapshot) return;
            var ss = standbySnapshot; standbySnapshot = null;
            if (typeof Debug !== 'undefined')
                Debug.player('visibility=visible: restoring ' + ss.uri + ' at ' + ss.pos + 'ms');
            playUri(ss.uri, ss.title, {
                subtitles: ss.subtitles,
                file:      ss.file,
                resume:    { pos: ss.pos, paused: ss.paused }
            });
        }
    }

    /* ── Common: open a URI in player view ────────────────────────── */
    var openWatchdog = null;
    function playUri(uri, title, opts) {
        opts = opts || {};
        if (typeof Debug !== 'undefined') Debug.player('playUri uri=' + uri + '  title=' + title);

        /* Issue #78: a file opened from a list or the URL screen that has a
         * saved position asks Continue / Start over first (Settings → Resume
         * playback = Ask).  The prompt runs BEFORE anything below touches
         * player state, so BACK / Cancel simply leaves the user where they
         * were.  Next/Prev, auto-play and standby wakes never ask. */
        if (opts.askResume && !opts.resume &&
            Settings.get('resumeMode') === 'ask' && resumePosFor(uri)) {
            var again = {};
            for (var k in opts) again[k] = opts[k];
            again.askResume = false;
            openPicker(title || uri, [
                { code: 'continue', name: I18n.t('resume.continueFrom', fmtTime(resumePosFor(uri))) },
                { code: 'restart',  name: I18n.t('resume.restart') }
            ], 'continue', function (val) {
                again.fromStart = (val === 'restart');
                playUri(uri, title, again);
            });
            return;
        }
        // Reset the once-per-file gate so applyLanguagePreferences runs for
        // the new file (and not for the previous file).
        prefsAppliedFor = null;
        lastProgress = { time: 0, duration: 0 };
        lastResumeSaveAt = 0;
        prevRestartLit = false;
        resetScrub();          // a scrub/settle from the previous file must
                               // not freeze the new file's progress bar

        /* Seek-once-playing (applied in the onstatechange('playing')
         * handler): a standby wake passes an explicit resume point via
         * opts.resume; otherwise fall back to the persisted last-watched
         * position so a reopened file continues where the user left off.
         * Always assigned, so a stale pendingResume from a restore that
         * never reached PLAYING can't leak into the next file. */
        if (opts.resume) {
            pendingResume = { pos: opts.resume.pos, paused: opts.resume.paused };
        } else if (opts.fromStart || Settings.get('resumeMode') === 'never') {
            // Starting over: drop the saved position so the file also opens
            // clean next time (until playback saves a new one).
            clearResumePos(uri);
            pendingResume = null;
        } else {
            var resumeAt = resumePosFor(uri);
            pendingResume = resumeAt
                ? { pos: Math.max(0, resumeAt - RESUME_BACKOFF_MS), paused: false, announce: true }
                : null;
        }

        state.playingUri = uri;
        state.playingTitle = title || uri;
        state.directFallback = null;
        updateNextPrevButtons();
        UI.showView('view-player'); state.view = 'player';
        if (typeof Debug !== 'undefined') Debug.view('player');

        document.getElementById('osd-title').textContent = title || uri;
        document.getElementById('osd-top').classList.remove('hidden');
        document.getElementById('osd-bottom').classList.remove('hidden');
        showSpinner(I18n.t('player.openingShort'));
        hideError();

        // Defer slightly so the <object> element is laid out before AVPlay
        // tries to bind to it.  No need to call setDisplayRect here — AVPlay
        // is in an idle state before open() and would error with INVALID_STATE.
        // The proper setDisplayRect happens after prepareAsync succeeds.
        setTimeout(function () {
            // A USB / internal file may be routed through the paired transcode
            // server (for surround, or a codec the TV can't decode), and with
            // smart routing a share file the server would only remux skips it.
            // That changes which URL AVPlay opens, not the identity of what's
            // playing — `uri` stays the key for recents, resume, watched and
            // subtitle lookup, and the resolver hands back `uri` unchanged
            // whenever routing isn't on or isn't available.
            var resolve = (typeof TranscodeServer !== 'undefined' && TranscodeServer.resolvePlaybackUri)
                ? TranscodeServer.resolvePlaybackUri
                : function (u, done) { done(u); };
            resolve(uri, function (openUrl, route) {
                // Arming the relay or probing is async; the user may have
                // backed out or started something else in the meantime.
                if (state.playingUri !== uri) return;
                state.directFallback = (route && route.fallback)
                    ? { uri: uri, title: title, opts: opts } : null;
                if (openUrl !== uri && typeof Debug !== 'undefined')
                    Debug.player((state.directFallback ? 'smart routing: playing directly → '
                                                       : 'routing through transcode server → ') + openUrl);
                Player.open(openUrl, {
                    title:     title,
                    subtitles: opts.subtitles || [],
                    file:      opts.file || null,
                    // Where embedded subtitles are read from.  On the direct
                    // route that's the file itself — `uri` would be the
                    // server's /play URL, and reading it starts a transcode.
                    sourceUri: state.directFallback ? openUrl : uri
                });
            });
        }, 50);

        // Watchdog: detect two failure modes —
        //   1. AVPlay never reaches PLAYING within 20 s (stuck in IDLE/READY)
        //   2. AVPlay reports PLAYING but currentTime stays at 0 for 10 s
        //      AND we're not buffering — i.e. a real codec stall, not a
        //      slow source still filling its buffer (common on the SMB
        //      proxy path for small or oddly-laid-out files).
        clearInterval(openWatchdog);
        var watchdogStart = Date.now();
        openWatchdog = setInterval(function () {
            var elapsed = Date.now() - watchdogStart;
            var state   = Player.state();
            var time    = Player.currentTime();
            var buffering  = (typeof Player.isBuffering === 'function') ? Player.isBuffering() : false;
            var lastBuffer = (typeof Player.lastBufferingMs === 'function') ? Player.lastBufferingMs() : 0;
            var bufferingRecent = buffering || (lastBuffer && Date.now() - lastBuffer < 5000);

            if (elapsed > 20000 && state !== 'PLAYING' && state !== 'PAUSED' && !bufferingRecent) {
                clearInterval(openWatchdog);
                if (retryThroughServer('stuck loading, AVPlay state ' + state)) return;
                showError(I18n.t('player.stuck', state), 'codec');
                return;
            }
            if (elapsed > 10000 && state === 'PLAYING' && (!time || time === 0) && !bufferingRecent) {
                clearInterval(openWatchdog);
                if (retryThroughServer('playhead not advancing')) return;
                showError(I18n.t('player.stalled'));
                return;
            }
            if (state === 'PLAYING' && time > 0) {
                // We're actually progressing — disarm.
                clearInterval(openWatchdog);
            }
        }, 1000);

        pushRecent({ uri: uri, title: title || uri, subtitles: opts.subtitles });
        scheduleOSDHide();
    }

    /* Smart routing sent this share file straight to AVPlay and it never
     * started: remember that, and replay it through the transcode server —
     * where it would have gone without smart routing (issue #87).  Only
     * before anything has played; past that an error is about the file or
     * the network, not the route. */
    function retryThroughServer(why) {
        var fb = state.directFallback;
        if (!fb || fb.uri !== state.playingUri || lastProgress.time > 0) return false;
        state.directFallback = null;
        clearInterval(openWatchdog);
        if (typeof Debug !== 'undefined')
            Debug.player('smart routing: direct play failed (' + why + ') — retrying through the transcode server');
        if (typeof TranscodeServer !== 'undefined' && TranscodeServer.markDirectFailed)
            TranscodeServer.markDirectFailed(fb.uri);
        try { Player.stop(); } catch (e) {}
        UI.toast(I18n.t('player.viaServer'));
        var again = {};
        for (var k in fb.opts) again[k] = fb.opts[k];
        again.askResume = false;   // already answered for this open
        playUri(fb.uri, fb.title, again);
        return true;
    }

    /* ── Playlist navigation (auto-play + next/prev) ──────────────── */
    /* Fisher-Yates on a copy.  When shuffle is on we still put the user's
     * clicked item at index 0 so playback starts with what they picked and
     * only *subsequent* items are randomized — matches how music apps
     * behave when you tap a specific track with shuffle enabled. */
    function shufflePlaylist(list, keepFirstIdx) {
        var out = list.slice();
        for (var i = out.length - 1; i > 0; i--) {
            var j = Math.floor(Math.random() * (i + 1));
            var tmp = out[i]; out[i] = out[j]; out[j] = tmp;
        }
        if (keepFirstIdx >= 0 && keepFirstIdx < list.length) {
            var pinned = list[keepFirstIdx];
            var cur = out.indexOf(pinned);
            if (cur > 0) { out[cur] = out[0]; out[0] = pinned; }
        }
        return out;
    }
    function playFromList(origin, playlist, idx, dir) {
        state.origin        = origin;
        state.originDir     = dir;
        if (Settings.get('shuffle') && playlist && playlist.length > 1) {
            state.playlist      = shufflePlaylist(playlist, idx);
            state.playlistIndex = 0;
        } else {
            state.playlist      = playlist || [];
            state.playlistIndex = idx;
        }
        var item = state.playlist[state.playlistIndex];
        if (!item) return;
        playUri(item.uri, item.title, { subtitles: item.subtitles || [], file: item.file || null, askResume: true });
    }
    function playNext(isAuto) {
        var ni = state.playlistIndex + 1;
        if (state.playlistIndex < 0 || ni >= state.playlist.length) return false;
        var item = state.playlist[ni];
        state.playlistIndex = ni;
        if (isAuto) UI.toast(I18n.t('player.upNext', item.title));
        playUri(item.uri, item.title, { subtitles: item.subtitles || [], file: item.file || null });
        return true;
    }
    /* OSD Prev / MediaTrackPrevious: restart the current file when we're
     * past the first few seconds, otherwise go to the previous item.  A
     * second press right after a restart therefore lands on the previous
     * item, exactly like a music player. */
    function handlePrev() {
        if (lastProgress.time > RESTART_THRESHOLD_MS) {
            if (scrub.active) cancelScrub(false);
            Player.seekTo(0);
            updateProgress(0, lastProgress.duration);
            flashOSD();
            UI.toast(I18n.t('player.restarted'));
            return;
        }
        if (!playPrev()) UI.toast(I18n.t('player.noPrev'));
    }
    function playPrev() {
        if (state.playlistIndex <= 0) return false;
        var pi = state.playlistIndex - 1;
        var item = state.playlist[pi];
        state.playlistIndex = pi;
        playUri(item.uri, item.title, { subtitles: item.subtitles || [], file: item.file || null });
        return true;
    }
    /* Dim the prev/next OSD buttons when there's nothing on that side.
     * Prev stays lit once the file is far enough in to restart. */
    function updateNextPrevButtons() {
        var prev = document.getElementById('btn-prev');
        var next = document.getElementById('btn-next');
        if (prev) prev.classList.toggle('disabled',
            state.playlistIndex <= 0 && lastProgress.time <= RESTART_THRESHOLD_MS);
        if (next) next.classList.toggle('disabled',
            state.playlistIndex < 0 || state.playlistIndex + 1 >= state.playlist.length);
    }

    /* Leave the player and return to the menu playback was launched from,
     * rather than always jumping back to the home screen. */
    function exitPlayer() {
        // Watched ≥ 90 % counts as seen even if the user stops before the end
        // (markWatched also drops the resume position); anything short of
        // that keeps its position so the file can pick up where it left off.
        if (lastProgress.duration && lastProgress.time / lastProgress.duration >= 0.9)
            markWatched(state.playingUri);
        else if (lastProgress.time > 0)   // time===0 → playback never started;
            saveResumePos(state.playingUri, lastProgress.time, lastProgress.duration);

        resetScrub();
        Player.stop();
        hideError();
        document.getElementById('osd-top').classList.add('hidden');
        document.getElementById('osd-bottom').classList.add('hidden');
        closeTrackMenu();

        if (state.origin === 'browse' && state.originDir) {
            if (typeof Debug !== 'undefined') Debug.view('browse (return)');
            UI.showView('view-browse'); state.view = 'browse'; state.browseAtRoot = false;
            listInto(state.originDir);
        } else if (state.origin === 'recent') {
            if (typeof Debug !== 'undefined') Debug.view('recent (return)');
            openRecent();
        } else {
            backToHome();
        }
    }

    function backToHome() {
        if (typeof Debug !== 'undefined') Debug.view('home');
        resetScrub();
        Player.stop();
        state.view = 'home';
        UI.showView('view-home');
        hideError();
        document.getElementById('osd-top').classList.add('hidden');
        document.getElementById('osd-bottom').classList.add('hidden');
        closeTrackMenu();
    }

    /* Cleanly quit the app from the home view (issue #57).  Tizen exposes
     * this on the current-application object; window.close() is a fallback
     * for the emulator / desktop-preview environment where the tizen
     * namespace isn't present.  Player is stopped first so AVPlay isn't
     * left holding a decoder handle if the user quit mid-playback via
     * exitPlayer → home → BACK. */
    function exitApp() {
        if (typeof Debug !== 'undefined') Debug.action('exit-app');
        try { Player.stop(); } catch (e) {}
        try {
            if (typeof tizen !== 'undefined' && tizen.application) {
                tizen.application.getCurrentApplication().exit();
                return;
            }
        } catch (e) {
            if (typeof Debug !== 'undefined') Debug.warn('tizen.application.exit failed: ' + (e.message || e));
        }
        try { window.close(); } catch (e) {}
    }

    /* ── OSD show/hide ────────────────────────────────────────────── */
    var osdHideTimer = null;
    function showOSD(visible) {
        var wasHidden = document.getElementById('osd-bottom').classList.contains('hidden');
        document.getElementById('osd-top').classList.toggle('hidden', !visible);
        document.getElementById('osd-bottom').classList.toggle('hidden', !visible);
        if (visible) {
            UI.refreshFocusables();
            // Auto-focus the play-pause button when the OSD first appears, so
            // Up/Down navigation has an anchor and ENTER activates something.
            if (wasHidden) {
                var pp = document.getElementById('btn-playpause');
                if (pp) UI.focusOn(pp);
            }
        }
    }
    function scheduleOSDHide() {
        clearTimeout(osdHideTimer);
        osdHideTimer = setTimeout(function () { showOSD(false); }, 5000);
    }
    function flashOSD() { showOSD(true); scheduleOSDHide(); }

    /* ── Fast seeking / scrub mode (issue: percentage-based seeking) ──
     * Left/Right and RW/FF no longer fire a real seek per press.  They move
     * a preview position along the progress bar, and the seek is committed
     * only after the keys go quiet for a moment (or instantly on OK).  Held
     * or rapid presses accelerate from the familiar 10 s step up to
     * duration-relative jumps (1–2 % of the file), so crossing a 3-hour
     * movie takes seconds while a couple of taps still nudge by 10 s.
     * BACK cancels a scrub without seeking.  Files with no known duration
     * (live streams) keep the old immediate fixed-step seek. */
    var scrub = { active: false, waiting: false, pos: 0, dir: 0, steps: 0, timer: null, commitAt: 0 };
    var SCRUB_COMMIT_MS = 600;   // quiet time before the preview position is seeked
    // AVPlay's seekTo is asynchronous: getCurrentTime() keeps reporting the
    // PRE-seek playhead until the pipeline flushes — seconds, on SMB/network
    // streams.  So after committing we keep painting the preview position
    // (scrub.waiting) until a progress sample lands near the target, with a
    // hard timeout in case the seek silently fails.
    var SCRUB_SETTLE_TOL_MS = 4000;
    var SCRUB_SETTLE_MAX_MS = 10000;

    function scrubStepSize(n, durMs, baseMs) {
        // n = consecutive steps in one direction within this scrub session.
        // A session ends after SCRUB_COMMIT_MS of silence, so slow discrete
        // presses never accelerate — only holds / rapid taps do.
        var ms;
        if      (n <= 3)  ms = 10000;
        else if (n <= 8)  ms = 30000;
        else if (n <= 15) ms = Math.max(60000,  durMs * 0.01);
        else              ms = Math.max(120000, durMs * 0.02);
        return Math.max(baseMs, ms);
    }

    function scrubStep(dir, baseMs) {
        var dur = Player.duration() || lastProgress.duration;
        if (!dur || dur <= 0) {              // duration unknown → seek directly
            Player.seekRel(dir * baseMs);
            flashOSD();
            return;
        }
        if (!scrub.active) {
            scrub.active = true;
            // If a committed seek is still in flight, currentTime() is stale
            // (pre-seek) — continue from the target we already committed to.
            if (!scrub.waiting)
                scrub.pos = Player.currentTime() || lastProgress.time;
            scrub.dir    = 0;
            scrub.steps  = 0;
        }
        if (dir !== scrub.dir) { scrub.dir = dir; scrub.steps = 0; }
        scrub.steps++;
        scrub.pos = Math.max(0, Math.min(dur - 1000,
                        scrub.pos + dir * scrubStepSize(scrub.steps, dur, baseMs)));
        updateProgress(scrub.pos, dur);
        updateScrubUI(true, scrub.pos);
        // Pin the OSD while scrubbing; the hide timer restarts on commit.
        showOSD(true);
        clearTimeout(osdHideTimer);
        clearTimeout(scrub.timer);
        scrub.timer = setTimeout(commitScrub, SCRUB_COMMIT_MS);
    }

    function commitScrub() {
        if (!scrub.active) return;
        clearTimeout(scrub.timer);
        scrub.active = false;
        scrub.steps  = 0;
        scrubSeekTo(scrub.pos);
        updateScrubUI(false);
        flashOSD();
    }

    /* Seek and keep painting `ms` on the bar until the seek completes.
     * Shared by scrub commits and 0-9 jumps.  Completion comes from
     * Player.seekTo's callback — AVPlay lands on a keyframe, possibly tens
     * of seconds from the target, so distance-to-target can't detect it
     * (SCRUB_SETTLE_* in onprogress remain as backstops in case a firmware
     * never fires the callback).  The seq token keeps a late callback from
     * an overridden seek from unfreezing a newer one still in flight. */
    function scrubSeekTo(ms) {
        scrub.pos      = ms;
        scrub.waiting  = true;
        scrub.commitAt = Date.now();
        scrub.seq      = (scrub.seq || 0) + 1;
        var seq = scrub.seq;
        Player.seekTo(ms, function () {
            if (seq !== scrub.seq || !scrub.waiting) return;
            scrub.waiting = false;
            if (!scrub.active)
                updateProgress(Player.currentTime(), Player.duration() || lastProgress.duration);
        });
        updateProgress(ms, Player.duration() || lastProgress.duration);
    }

    function cancelScrub(restoreBar) {
        clearTimeout(scrub.timer);
        scrub.active = false;
        scrub.steps  = 0;
        updateScrubUI(false);
        if (restoreBar) {
            // A still-settling earlier commit means the bar should show its
            // target, not the stale pre-seek playhead.
            if (scrub.waiting) updateProgress(scrub.pos, Player.duration() || lastProgress.duration);
            else               updateProgress(lastProgress.time, lastProgress.duration);
            flashOSD();
        }
    }

    /* Full reset — leaving the player or starting a new file.  Unlike
     * cancelScrub this also drops the settle-wait, which would otherwise
     * suppress the next file's progress updates. */
    function resetScrub() {
        cancelScrub(false);
        scrub.waiting  = false;
        scrub.commitAt = 0;
    }

    function updateScrubUI(on, posMs) {
        document.getElementById('progress-fill').classList.toggle('scrubbing', !!on);
        var delta = document.getElementById('time-scrub-delta');
        if (!delta) return;
        if (!on) { delta.classList.add('hidden'); return; }
        var d = posMs - lastProgress.time;
        delta.textContent = (d < 0 ? '−' : '+') + fmtTime(Math.abs(d));
        delta.classList.remove('hidden');
    }

    function installMediaSessionHandlers() {
        if (!('mediaSession' in navigator)) return;
        function ifPlaying(fn) {
            return function () { if (state.view === 'player') { fn(); flashOSD(); } };
        }
        var pairs = [
            ['play',          ifPlaying(function () { Player.play(); })],
            ['pause',         ifPlaying(function () { Player.pause(); })],
            ['stop',          ifPlaying(function () { exitPlayer(); })],
            ['seekbackward',  ifPlaying(function () { Player.seekRel(-30000); })],
            ['seekforward',   ifPlaying(function () { Player.seekRel( 30000); })],
            ['previoustrack', ifPlaying(function () { handlePrev(); })],
            ['nexttrack',     ifPlaying(function () { playNext(false); })]
        ];
        for (var i = 0; i < pairs.length; i++) {
            try { navigator.mediaSession.setActionHandler(pairs[i][0], pairs[i][1]); } catch (e) {}
        }
    }

    function showSpinner(msg) {
        var sp = document.getElementById('spinner');
        sp.querySelector('.spinner-text').textContent = msg || I18n.t('common.loading');
        sp.classList.remove('hidden');
    }
    function hideSpinner() { document.getElementById('spinner').classList.add('hidden'); }

    /* kind 'codec': the message is our own (and so translated), and the
     * codec hint below can't be matched out of its text. */
    function showError(msg, kind) {
        // Hide all sibling overlays so the error stays the only focusable thing
        document.getElementById('osd-top').classList.add('hidden');
        document.getElementById('osd-bottom').classList.add('hidden');
        document.getElementById('track-menu').classList.add('hidden');
        hideSpinner();
        clearInterval(openWatchdog);

        // Hint for opaque codec-not-supported errors
        var hint = '';
        var uri = state.playingUri || '';
        // AVPlay-failed-on-MKV is signalled with the "MKV_CODEC:" prefix from
        // player.js.  The old "MKV not supported" HTML5 message is kept in the
        // match for safety, but AVPlay DOES support the MKV container on these
        // TVs — a failure is a codec inside it, most often DTS/TrueHD audio.
        var isMkv = /^MKV_CODEC:/.test(msg) || /\.mkv($|\?)/i.test(uri) || /MKV not supported/i.test(msg);
        // Legacy containers that AVPlay opens but rejects fast on codec grounds
        // — DivX/Xvid AVI, WMV (VC-1/WMV9), FLV, old MPEG.  We see this as a
        // sub-second "Unknown error" from AVPlay after a clean network/SMB
        // transport.  No path forward in-app: TV's hardware decoder doesn't
        // know these codecs.
        var isLegacyContainer = /\.(avi|wmv|flv|rm|rmvb|mpe?g|vob|divx|asf)($|\?)/i.test(uri);

        if (isLegacyContainer) {
            var ext = (uri.match(/\.([a-z0-9]+)(?:[?#]|$)/i) || [,''])[1].toLowerCase();
            msg = I18n.t('err.legacyTitle', ext.toUpperCase());
            hint = I18n.t('err.legacyHint', ext.toUpperCase(), RELEASES_URL,
                          'ffmpeg -i input.' + ext + ' -c:v libx264 -preset fast -c:a aac -b:a 192k output.mp4');
        } else if (isMkv) {
            msg = I18n.t('err.mkvTitle');
            hint = I18n.t('err.mkvHint', RELEASES_URL, 'ffmpeg -i input.mkv -c:v copy -c:a ac3 -b:a 640k output.mkv');
        } else if (kind === 'codec' || /unknown error|not supported|invalid|stuck loading|unsupported source/i.test(msg)) {
            hint = I18n.t('err.codecHint', 'ffmpeg -i input.ext -c copy output.mp4');
        } else if (/connection|network|timeout/i.test(msg)) {
            hint = I18n.t('err.networkHint');
        }

        document.getElementById('error-title').textContent = msg;
        document.getElementById('error-hint').textContent  = hint;
        document.getElementById('error-overlay').classList.remove('hidden');

        UI.refreshFocusables();
        var btn = document.querySelector('#error-overlay .btn');
        if (btn) UI.focusOn(btn);
    }
    function hideError() {
        document.getElementById('error-overlay').classList.add('hidden');
    }

    function updatePlayPauseButton(state) {
        var btn = document.getElementById('btn-playpause');
        if (state === 'playing') btn.textContent = '⏸';
        else                     btn.textContent = '▶';
    }

    function updateProgress(timeMs, durMs) {
        document.getElementById('time-current').textContent  = fmtTime(timeMs);
        document.getElementById('time-duration').textContent = fmtTime(durMs);
        var pct = (durMs && durMs > 0) ? Math.min(100, (timeMs / durMs) * 100) : 0;
        document.getElementById('progress-fill').style.width = pct.toFixed(1) + '%';
    }

    function fmtTime(ms) {
        if (typeof ms !== 'number' || isNaN(ms) || ms < 0) return '00:00';
        var s = Math.floor(ms / 1000);
        var h = Math.floor(s / 3600); s -= h * 3600;
        var m = Math.floor(s / 60);   s -= m * 60;
        var p = function (n) { return n < 10 ? '0' + n : '' + n; };
        return (h ? p(h) + ':' : '') + p(m) + ':' + p(s);
    }

    /* ── Settings view ────────────────────────────────────────────── */
    function openSettings() {
        UI.showView('view-settings'); state.view = 'settings';
        refreshSettingsValues();
        renderPairingBlock();
        renderTvInfo();
    }
    function refreshSettingsValues() {
        document.getElementById('setting-ui-lang-value').textContent       = uiLanguageName(Settings.get('uiLanguage'));
        document.getElementById('setting-audio-lang-value').textContent    = LanguageList.nameFor(Settings.get('audioLang'));
        document.getElementById('setting-subtitle-lang-value').textContent = LanguageList.nameFor(Settings.get('subtitleLang'));
        document.getElementById('setting-repeat-mode-value').textContent   = I18n.t((Settings.get('repeatMode') === 'one') ? 'repeat.one' : 'common.off');
        document.getElementById('setting-auto-play-value').textContent     = I18n.t(Settings.get('autoPlay') ? 'common.on' : 'common.off');
        document.getElementById('setting-resume-mode-value').textContent   = resumeModeName(Settings.get('resumeMode'));
        document.getElementById('setting-shuffle-value').textContent       = I18n.t(Settings.get('shuffle') ? 'common.on' : 'common.off');
        document.getElementById('setting-aspect-mode-value').textContent   = AspectRatio.nameFor(Settings.get('aspectMode'));
        document.getElementById('setting-subtitle-size-value').textContent     = SubtitleStyle.nameForSize(Settings.get('subtitleSize'));
        document.getElementById('setting-subtitle-font-value').textContent     = SubtitleStyle.nameForFont(Settings.get('subtitleFont'));
        document.getElementById('setting-subtitle-position-value').textContent = SubtitleStyle.nameForPosition(Settings.get('subtitlePosition'));
        document.getElementById('setting-subtitle-bg-value').textContent       = SubtitleStyle.nameForBg(Settings.get('subtitleBg'));
        // Mirror repeat + aspect state to the OSD buttons if visible
        updateRepeatButton();
        updateAspectButton();
    }
    function renderTvInfo() {
        var box  = document.getElementById('tvinfo');
        var pInfo = TvInfo.getProductInfo();
        var codecs = TvInfo.getCodecs();
        var ua = TvInfo.getUA();

        // Kick off the async build query; we render placeholder rows first.
        TvInfo.getBuild(function (b) {
            var rows = [];
            function row(k, v) { rows.push('<div class="row"><div class="k">' + escapeHtml(k) + '</div><div class="v">' + escapeHtml(v || '—') + '</div></div>'); }
            row(I18n.t('tv.model'),        pInfo.realModel || b.model || '—');
            row(I18n.t('tv.marketingName'), pInfo.tvName    || b.buildDescription || '—');
            row(I18n.t('tv.firmware'),     pInfo.firmwareVersion || b.buildVersion || '—');
            row(I18n.t('tv.buildRelease'), b.buildReleaseDate || '—');
            row(I18n.t('tv.manufacturer'), b.manufacturer || '—');
            row('User-Agent',              ua);
            function codec(name, cls, label) {
                return '<div class="codec"><span class="name">' + escapeHtml(name) + '</span>' +
                       '<span class="status ' + cls + '">' + escapeHtml(label) + '</span></div>';
            }

            var codecHtml = '<h3>' + escapeHtml(I18n.t('tv.html5Codecs')) + '</h3><div class="codecs">';
            Object.keys(codecs).forEach(function (name) {
                var status = codecs[name];
                var cls = status === 'probably' ? 'ok' : status === 'maybe' ? 'maybe' : 'no';
                var label = status === 'probably' ? '✓ ' + I18n.t('tv.supported') :
                            status === 'maybe'    ? '? ' + I18n.t('tv.possibly') :
                                                    '✗ ' + I18n.t('tv.notSupported');
                codecHtml += codec(name, cls, label);
            });
            codecHtml += '</div>';

            codecHtml += '<h3>' + escapeHtml(I18n.t('tv.streaming')) + '</h3><div class="codecs">';
            codecHtml += codec('HLS / DASH', 'ok', '✓ ' + I18n.t('tv.supported'));
            codecHtml += codec('RTSP / RTMP', 'ok', '✓ ' + I18n.t('tv.supported'));
            codecHtml += codec(I18n.t('tv.usbFiles'), 'ok', '✓ ' + I18n.t('tv.viaHtml5'));
            codecHtml += codec(I18n.t('tv.mkv'), 'ok', '✓ ' + I18n.t('tv.viaAvplay'));
            codecHtml += codec(I18n.t('tv.dtsAudio'), 'no', '✗ ' + I18n.t('tv.cantDecode'));
            codecHtml += '</div>';

            box.innerHTML = rows.join('') + codecHtml;
        });
    }

    /* ── Picker (generic option list, used for settings choices) ──── */
    var pickerSetting = null;        // which setting we're editing
    function openPicker(title, options, currentValue, onPick) {
        document.getElementById('picker-title').textContent = title;
        var ul = document.getElementById('picker-options');
        ul.innerHTML = '';
        options.forEach(function (opt) {
            var li = document.createElement('li');
            li.tabIndex = 0;
            li.textContent = opt.name;
            if (opt.code === currentValue) li.classList.add('active');
            li.addEventListener('click', function () {
                onPick(opt.code);
                closePicker();
            });
            ul.appendChild(li);
        });
        document.getElementById('picker').classList.remove('hidden');
        UI.refreshFocusables();
        var first = document.querySelector('#picker .active') ||
                    document.querySelector('#picker li, #picker button');
        if (first) UI.focusOn(first);
    }
    function closePicker() {
        document.getElementById('picker').classList.add('hidden');
        pickerSetting = null;
        UI.refreshFocusables();
    }
    function openLangPicker(settingKey, title, options) {
        pickerSetting = settingKey;
        var cur = Settings.get(settingKey);
        openPicker(title, options, cur, function (val) {
            Settings.set(settingKey, val);
            refreshSettingsValues();
            UI.toast(I18n.t('toast.setTo', title, LanguageList.nameFor(val)));
        });
    }
    /* The app's own language.  Every language is listed by its own name, so
     * someone stuck in a language they can't read still finds theirs. */
    function uiLanguageName(code) {
        return code ? I18n.languageName(I18n.match(code))
                    : I18n.t('uiLang.followTv', I18n.languageName(I18n.current()));
    }
    function openUiLangPicker() {
        pickerSetting = 'uiLanguage';
        var opts = [{ code: '', name: uiLanguageName('') }].concat(I18n.languages());
        openPicker(I18n.t('settings.uiLang'), opts, Settings.get('uiLanguage'), function (val) {
            if (val === Settings.get('uiLanguage')) return;
            I18n.setLanguage(val);
        });
    }
    function openRepeatPicker() {
        pickerSetting = 'repeatMode';
        var cur = Settings.get('repeatMode');
        openPicker(I18n.t('settings.repeatMode'), [
            { code: 'off', name: I18n.t('common.off') },
            { code: 'one', name: I18n.t('repeat.current') }
        ], cur, function (val) {
            Settings.set('repeatMode', val);
            refreshSettingsValues();
            UI.toast(I18n.t('toast.repeat', I18n.t(val === 'one' ? 'common.on' : 'common.off')));
        });
    }
    /* Subtitle-appearance pickers — share the generic option list, then
     * re-apply the live style so changes show immediately on the overlay. */
    function openSubtitlePicker(settingKey, title, options) {
        pickerSetting = settingKey;
        var cur = Settings.get(settingKey);
        openPicker(title, options, cur, function (val) {
            Settings.set(settingKey, val);
            SubtitleStyle.apply();
            refreshSettingsValues();
            UI.toast(I18n.t('toast.updated', title));
        });
    }
    /* Playback-speed picker (issue #28 part 3).  Six rates from 0.5× to 2×,
     * applied via Player.setSpeed() which targets AVPlay's setSpeed on the
     * TV and HTMLVideoElement.playbackRate as the fallback.  Speed is
     * deliberately session-only — every Player.open() resets to 1× so a
     * binge-watch session doesn't accidentally play episode 2 at 1.5×
     * because episode 1 was. */
    function openSpeedPicker() {
        var cur = String(Player.getSpeed ? Player.getSpeed() : 1);
        /* On the AVPlay backend, non-1× rates silence audio (Samsung
         * hardware-decoder limitation — issue #49).  Note that inline in
         * the option labels so the user isn't blindsided by a mute the
         * moment they pick 1.5×. */
        var avplay = Player.getBackend && Player.getBackend() === 'avplay';
        var muteNote = avplay ? '  ' + I18n.t('speed.mutedNote') : '';
        openPicker(I18n.t('player.speed'), [
            { code: '0.5',  name: '0.5×' + muteNote },
            { code: '0.75', name: '0.75×' + muteNote },
            { code: '1',    name: I18n.t('speed.normalOption') },
            { code: '1.25', name: '1.25×' + muteNote },
            { code: '1.5',  name: '1.5×' + muteNote },
            { code: '2',    name: '2×' + muteNote }
        ], cur, function (val) {
            if (!Player.setSpeed(parseFloat(val))) {
                UI.toast(I18n.t('speed.unsupported'));
                return;
            }
            updateSpeedButton();
            var msg = I18n.t('toast.speed', val === '1' ? I18n.t('speed.normal') : val + '×');
            if (Player.isSpeedMuted && Player.isSpeedMuted())
                msg += ' — ' + I18n.t('speed.mutedToast');
            UI.toast(msg);
        });
    }
    function updateSpeedButton() {
        var btn = document.getElementById('btn-speed');
        if (!btn) return;
        var s = Player.getSpeed ? Player.getSpeed() : 1;
        // Compact label: "1×" / "1.5×" — no trailing zeros so "1.5×" not "1.50×".
        var label = (s === Math.floor(s) ? s : (Math.round(s * 100) / 100)) + '×';
        // 🔇 postfix when audio is silenced by the speed change so the OSD
        // makes the trade-off visible at a glance (issue #49).
        if (Player.isSpeedMuted && Player.isSpeedMuted()) label += ' 🔇';
        btn.textContent = label;
    }
    /* Video aspect (user request: "remove the black bars").  Unlike playback
     * speed this IS persisted — someone who wants a filled screen wants it
     * for every file, not just the one that's open.  Applying it mid-playback
     * is safe on both backends, so the OSD button and the settings row share
     * this one picker. */
    function openAspectPicker() {
        var cur = Settings.get('aspectMode');
        openPicker(I18n.t('settings.aspect'), AspectRatio.forList(), cur, function (val) {
            Settings.set('aspectMode', val);
            Player.applyAspect();
            updateAspectButton();
            refreshSettingsValues();
            UI.toast(I18n.t('toast.aspect', AspectRatio.nameFor(val)) + aspectToastNote());
        });
    }

    /* Fit / Fill / Wide all come out identical on a file whose frame already
     * matches the panel — the usual case, since most rips are 16:9 on a 16:9
     * TV — and any black bars on such a file are inside the picture, where
     * nothing AVPlay can do will reach them (settings.js says why).  Telling
     * the user that beats letting them cycle every mode looking for the one
     * that isn't broken. */
    function aspectToastNote() {
        if (typeof Player.describeAspect !== 'function') return '';
        var d;
        try { d = Player.describeAspect(); } catch (e) { return ''; }
        if (!d || !d.noop) return '';
        return ' — ' + I18n.t('aspect.noop');
    }
    function updateAspectButton() {
        var btn = document.getElementById('btn-aspect');
        if (!btn) return;
        var mode = Settings.get('aspectMode');
        btn.textContent = AspectRatio.shortFor(mode);
        // Highlight whenever the picture is NOT in the default fit mode, so
        // a cropped/stretched picture is never a mystery.
        btn.classList.toggle('aspect-on', AspectRatio.isKnown(mode) && mode !== 'fit');
    }
    function openAutoPlayPicker() {
        pickerSetting = 'autoPlay';
        var cur = Settings.get('autoPlay') ? 'on' : 'off';
        openPicker(I18n.t('settings.autoPlay'), [
            { code: 'off', name: I18n.t('common.off') },
            { code: 'on',  name: I18n.t('autoPlay.on') }
        ], cur, function (val) {
            Settings.set('autoPlay', val === 'on');
            refreshSettingsValues();
            UI.toast(I18n.t('toast.autoPlay', I18n.t(val === 'on' ? 'common.on' : 'common.off')));
        });
    }
    var RESUME_MODES = [
        { code: 'ask',    name: I18n.t('resume.askOption') },
        { code: 'always', name: I18n.t('resume.alwaysOption') },
        { code: 'never',  name: I18n.t('resume.neverOption') }
    ];
    function resumeModeName(code) {
        return I18n.t(code === 'always' ? 'resume.always' : code === 'never' ? 'resume.never' : 'resume.ask');
    }
    function openResumeModePicker() {
        pickerSetting = 'resumeMode';
        openPicker(I18n.t('settings.resume'), RESUME_MODES, Settings.get('resumeMode'), function (val) {
            Settings.set('resumeMode', val);
            refreshSettingsValues();
            UI.toast(I18n.t('toast.resume', resumeModeName(val)));
        });
    }
    /* ── Repeat toggle from the OSD ───────────────────────────────── */
    function toggleRepeat() {
        var next = Settings.get('repeatMode') === 'one' ? 'off' : 'one';
        Settings.set('repeatMode', next);
        updateRepeatButton();
        UI.toast(I18n.t('toast.repeat', I18n.t(next === 'one' ? 'common.on' : 'common.off')));
    }
    function updateRepeatButton() {
        var btn = document.getElementById('btn-repeat');
        if (!btn) return;
        btn.classList.toggle('repeat-on', Settings.get('repeatMode') === 'one');
    }

    /* ── Shuffle (issue #43) ──────────────────────────────────────────
     * Randomize playlist order for folder + recent playback.  Toggling
     * during playback re-shuffles the live playlist in place, keeping the
     * currently-playing item at index 0 so the current file isn't yanked
     * mid-play; turning it back off would ideally restore the alphabetical
     * order, but the app doesn't retain the pre-shuffle list — restoring
     * alphabetical requires re-entering the folder, which is a fair trade
     * for keeping the state minimal. */
    function openShufflePicker() {
        pickerSetting = 'shuffle';
        var cur = Settings.get('shuffle') ? 'on' : 'off';
        openPicker(I18n.t('settings.shuffle'), [
            { code: 'off', name: I18n.t('shuffle.offOption') },
            { code: 'on',  name: I18n.t('shuffle.onOption') }
        ], cur, function (val) {
            applyShuffle(val === 'on');
            refreshSettingsValues();
            UI.toast(I18n.t('toast.shuffle', I18n.t(val === 'on' ? 'common.on' : 'common.off')));
        });
    }
    function toggleShuffle() {
        var next = !Settings.get('shuffle');
        applyShuffle(next);
        UI.toast(I18n.t('toast.shuffle', I18n.t(next ? 'common.on' : 'common.off')));
    }
    function applyShuffle(on) {
        Settings.set('shuffle', !!on);
        updateShuffleButton();
        // If a playlist is live and shuffle just turned on, reshuffle
        // the remaining items around the currently-playing one.
        if (on && state.playlist.length > 1 && state.playlistIndex >= 0) {
            state.playlist = shufflePlaylist(state.playlist, state.playlistIndex);
            state.playlistIndex = 0;
            updateNextPrevButtons();
        }
    }
    function updateShuffleButton() {
        var btn = document.getElementById('btn-shuffle');
        if (!btn) return;
        btn.classList.toggle('shuffle-on', !!Settings.get('shuffle'));
    }

    /* ── Track menu ───────────────────────────────────────────────── */
    /* "Audio" / "Subtitle (23)" — the count is what tells a user with a
     * 20-track rip that the list they're looking at is complete and simply
     * scrolls, rather than truncated. */
    function setTrackSectionTitle(id, label, count) {
        var h = document.getElementById(id);
        if (h) h.textContent = count > 1 ? (label + ' (' + count + ')') : label;
    }
    /* Re-rendering while a track is being read out of the container must not
     * throw the cursor back to the active row — the user may be part way
     * down a 40-item list, and the progress label updates every few
     * seconds. */
    function focusedTrackRow() {
        var el = document.querySelector('#track-menu li.focused');
        var ul = el && el.parentNode;
        if (!ul || (ul.id !== 'audio-tracks' && ul.id !== 'subtitle-tracks')) return null;
        return { list: ul.id, index: [].indexOf.call(ul.children, el) };
    }
    function restoreTrackRowFocus(mark) {
        if (!mark) return false;
        var ul = document.getElementById(mark.list);
        var li = ul && ul.children[mark.index];
        if (!li) return false;
        UI.focusOn(li);
        return true;
    }
    function openTrackMenu() {
        var keepFocus = focusedTrackRow();
        var t = Player.getTracks();
        var aUL = document.getElementById('audio-tracks');
        var sUL = document.getElementById('subtitle-tracks');
        aUL.innerHTML = ''; sUL.innerHTML = '';
        setTrackSectionTitle('audio-tracks-title', I18n.t('tracks.audio'), t.audio.length);
        // Count only real, selectable tracks: not the synthetic "Off" row and
        // not the "+N can't be drawn" note.
        var subCount = 0;
        t.subtitle.forEach(function (tr) { if (!tr.off && !tr.muted) subCount++; });
        setTrackSectionTitle('subtitle-tracks-title', I18n.t('tracks.subtitle'), subCount);

        if (!t.audio.length) {
            aUL.innerHTML = '<li class="muted">' + escapeHtml(I18n.t('tracks.oneAudio')) + '</li>';
        } else {
            t.audio.forEach(function (tr) {
                var li = document.createElement('li');
                li.textContent = tr.name;
                if (tr.active) li.classList.add('active');
                li.addEventListener('click', function () {
                    Player.setAudioTrack(tr.index);
                    UI.toast(I18n.t('toast.audio', tr.name));
                    closeTrackMenu();
                });
                aUL.appendChild(li);
            });
        }

        // Subtitle list always has at least the "Off" entry from getTracks()
        t.subtitle.forEach(function (tr) {
            var li = document.createElement('li');
            li.textContent = tr.name;
            if (tr.active) li.classList.add('active');
            // Informational rows (e.g. "+3 embedded tracks this TV can't
            // draw") are shown but not selectable — .muted keeps them out of
            // the focus order too.
            if (tr.muted) { li.classList.add('muted'); sUL.appendChild(li); return; }
            li.addEventListener('click', function () {
                // The row, not just its index: a track AVPlay can't select
                // is read out of the container instead, and that path needs
                // the container's own track number.
                var how = Player.setSubtitleTrack(tr.off ? -1 : tr);
                // 'extracting' announces itself through onsubnotice — a
                // second toast here would only overwrite it.
                if (how !== 'extracting') {
                    UI.toast(I18n.t(how === null ? 'tracks.cantShow' : 'toast.subtitle', tr.name));
                }
                closeTrackMenu();
            });
            sUL.appendChild(li);
        });

        document.getElementById('track-menu').classList.remove('hidden');
        UI.refreshFocusables();
        // Where the user already was, if this is a re-render.  Otherwise the
        // currently-active track, else the first real (non-muted) track item,
        // else the Close button.
        if (restoreTrackRowFocus(keepFocus)) return;
        var first = document.querySelector('#track-menu .active') ||
                    document.querySelector('#track-menu .track-section li:not(.muted)') ||
                    document.querySelector('#track-menu button');
        if (first) UI.focusOn(first);
    }
    function closeTrackMenu() {
        document.getElementById('track-menu').classList.add('hidden');
        UI.refreshFocusables();
    }

    /* Type a digit from a remote number key (0-9) into the focused text field.
     * The TV's on-screen keyboard handles letters; the hardware number keys
     * arrive as key events that the browser doesn't insert on their own, so we
     * insert them ourselves (handy for IP / port / numeric entry). Returns true
     * if a field actually took the digit. */
    function typeDigitIntoField(digit) {
        var el = document.querySelector('.focused') || document.activeElement;
        if (!el || el.tagName !== 'INPUT') return false;
        var t = (el.type || 'text').toLowerCase();
        if (t !== 'text' && t !== 'password' && t !== 'search' && t !== 'tel' && t !== 'number') return false;
        var ch = String(digit);
        try {
            var s = el.selectionStart, e = el.selectionEnd;
            if (s != null && e != null) {
                el.value = el.value.slice(0, s) + ch + el.value.slice(e);
                el.selectionStart = el.selectionEnd = s + ch.length;
            } else { el.value += ch; }
        } catch (ex) { el.value += ch; }
        return true;
    }

    /* Number-key seek: digit n → n × 10 % of the duration.  Returns false
     * when an overlay owns the keys or the duration isn't known yet. */
    function seekToTenth(digit) {
        if (!document.getElementById('error-overlay').classList.contains('hidden') ||
            !document.getElementById('track-menu').classList.contains('hidden') ||
            !document.getElementById('picker').classList.contains('hidden')) return false;
        var dur = Player.duration() || lastProgress.duration;
        if (digit > 0 && !dur) return false;
        var target = digit ? Math.floor(dur * digit / 10) : 0;
        if (scrub.active) cancelScrub(false);
        Player.seekTo(target);
        updateProgress(target, dur || lastProgress.duration);
        flashOSD();
        UI.toast(digit ? I18n.t('player.jumped', digit * 10, fmtTime(target)) : I18n.t('player.restarted'));
        return true;
    }

    /* ── Global remote key dispatcher ─────────────────────────────── */
    function globalKeyHandler(code, ev) {
        var K = Remote.KEY;
        if (typeof Debug !== 'undefined') Debug.key('code=' + code + ' view=' + state.view);

        // Remote number buttons (0-9) type into a focused text field, so the
        // hardware keys work alongside the on-screen keyboard. Only consumes the
        // key when a text field actually took it, otherwise it falls through.
        if (code >= K.ZERO && code <= K.NINE && typeDigitIntoField(code - K.ZERO)) return true;

        // In the player, the number keys jump by tenths: 0 restarts, 1–9 go
        // to 10 %–90 % of the file (issue #78).  Only when nothing modal is
        // up, and only for files with a known duration (0 always works).
        if (code >= K.ZERO && code <= K.NINE && state.view === 'player' &&
            seekToTenth(code - K.ZERO)) return true;

        // URL input view: let typing flow through except on RETURN/Enter.
        if (state.view === 'url') {
            if (code === K.BACK) { backToHome(); return true; }
            if (code === K.ENTER && document.activeElement &&
                document.activeElement.id === 'url-input') {
                handleAction('open-current-url');
                return true;
            }
        }

        // When the error overlay is up, route ALL navigation/activation to it
        // (no seeking, no OSD flashing — the only thing on screen that matters
        // is the "Back to Home" button).
        var errorUp = !document.getElementById('error-overlay').classList.contains('hidden');

        // Track menu / settings picker open? Routes through normal focus.
        var trackMenuOpen = !document.getElementById('track-menu').classList.contains('hidden');
        var pickerOpen    = !document.getElementById('picker').classList.contains('hidden');
        // OSD currently visible? Determines whether keys navigate within OSD
        // or perform seek shortcuts.
        var osdVisible = !document.getElementById('osd-bottom').classList.contains('hidden');

        switch (code) {
            // Player view key mapping (issue #28 part 2 + fast seeking):
            //   Up/Down  → cycle between OSD buttons (no-op when OSD hidden,
            //              just brings it up)
            //   Left     → scrub backward (starts at 10 s, accelerates when
            //              held/tapped rapidly, up to 1–2 % of the duration)
            //   Right    → scrub forward, same acceleration
            //   FF/RW    → same scrub with a 30 s floor
            // Scrub steps only preview on the progress bar; the real seek is
            // committed after a short pause in input, or instantly on OK.
            // BACK during a scrub cancels it without seeking.
            case K.UP:
                if (state.view === 'player' && !errorUp && !trackMenuOpen) {
                    if (!osdVisible) { flashOSD(); return true; }
                    UI.moveFocusCyclic(-1);
                    flashOSD();
                    return true;
                }
                if (state.view === 'settings' && !pickerOpen) {
                    scrollSettingsIfNoFocusMove(-200, 'up');
                    return true;
                }
                UI.moveFocus('up');
                return true;
            case K.DOWN:
                if (state.view === 'player' && !errorUp && !trackMenuOpen) {
                    if (!osdVisible) { flashOSD(); return true; }
                    UI.moveFocusCyclic(+1);
                    flashOSD();
                    return true;
                }
                if (state.view === 'settings' && !pickerOpen) {
                    scrollSettingsIfNoFocusMove(+200, 'down');
                    return true;
                }
                UI.moveFocus('down');
                return true;
            case K.LEFT:
                if (state.view === 'player' && !errorUp && !trackMenuOpen) {
                    scrubStep(-1, 10000);
                    return true;
                }
                UI.moveFocus('left');  return true;
            case K.RIGHT:
                if (state.view === 'player' && !errorUp && !trackMenuOpen) {
                    scrubStep(+1, 10000);
                    return true;
                }
                UI.moveFocus('right'); return true;
            case K.ENTER:
                // In player view: OK activates the focused OSD button if the OSD
                // is up (so Stop / CC-Audio / etc. are reachable).  If the OSD
                // is hidden, OK toggles play/pause AND brings the OSD up —
                // matches YouTube-on-TV / Netflix, and gives users whose
                // remote's dedicated Play/Pause hard key isn't delivered to
                // the app (Smart Monitor M5 and friends — issues #42, #57)
                // a working way to pause without opening the OSD first.
                if (state.view === 'player' && !errorUp && !trackMenuOpen) {
                    if (scrub.active) { commitScrub(); return true; }
                    if (!osdVisible) { Player.togglePause(); flashOSD(); return true; }
                    if (!UI.activateFocused()) flashOSD();
                    return true;
                }
                UI.activateFocused();  return true;
            case K.BACK:
                if (pickerOpen)                 { closePicker();     return true; }
                if (trackMenuOpen)              { closeTrackMenu();  return true; }
                if (errorUp)                    { backToHome();      return true; }
                if (state.view === 'browse')    { browseUp();        return true; }
                if (state.view === 'player' && scrub.active) { cancelScrub(true); return true; }
                if (state.view === 'player')    { exitPlayer();      return true; }
                if (state.view === 'url')       { backToHome();      return true; }
                if (state.view === 'settings')  { backToHome();      return true; }
                /* Home view: explicitly exit the app rather than trusting the
                 * TV launcher to intercept an unhandled BACK — that fallback
                 * doesn't fire on Smart Monitors, leaving the user with no
                 * way out (issue #57). */
                if (state.view === 'home')      { exitApp();         return true; }
                return false;
            case K.PLAY:
            case K.PAUSE:
            case K.PLAYPAUSE:
                if (state.view === 'player') {
                    if (scrub.active) commitScrub();
                    Player.togglePause(); flashOSD(); return true;
                }
                return false;
            case K.STOP:
                if (state.view === 'player') { exitPlayer(); return true; }
                return false;
            case K.REWIND:
                if (state.view === 'player') { scrubStep(-1, 30000); return true; }
                return false;
            case K.FF:
                if (state.view === 'player') { scrubStep(+1, 30000); return true; }
                return false;
        }
        return false;
    }

    /* ── Auto-apply preferred audio + subtitle language ─────────────
     * Called after the player reaches state=PLAYING so the AVPlay/HTML5
     * track list is populated.  Finds the first track whose name (or, for
     * HTML5 external subs, lang tag) matches the preferred ISO code and
     * activates it.  Subtitle 'off' explicitly disables.  No-op if the
     * preference is empty (Auto). */
    /* Pick the audio track to play, balancing two goals:
     *   1. the user's preferred audio language (Settings → audioLang), and
     *   2. actually getting sound — Samsung TVs can't decode DTS/TrueHD, so a
     *      track flagged `unsupported` by Player.getTracks() plays silently.
     * Priority: preferred-language + decodable  >  any decodable  >  the
     * preferred-language track even if silent (at least it's the right
     * language).  Only switches when it improves on the current/default track,
     * and surfaces a toast so the user understands a silent file. */
    function chooseAudioTrack(tracks) {
        var audio = (tracks && tracks.audio) || [];
        if (!audio.length) return;

        var pref = (Settings.get('audioLang') || '').toLowerCase();
        function langMatches(t) {
            if (!pref) return false;
            // Shared with the subtitle picker: matches the language tag, the
            // ISO 639-2 spelling ('ger', 'vie'), the English name and the
            // endonym — see LanguageList.matchScore in settings.js.
            return LanguageList.matchScore(pref, t.lang, t.name) > 0;
        }
        function firstSupported(list) {
            for (var i = 0; i < list.length; i++) if (!list[i].unsupported) return list[i];
            return null;
        }

        var active = null;
        for (var i = 0; i < audio.length; i++) if (audio[i].active) { active = audio[i]; break; }

        var target = null;
        if (pref) {
            var matchSupported = null, matchAny = null;
            for (var j = 0; j < audio.length; j++) {
                if (!langMatches(audio[j])) continue;
                if (!matchAny) matchAny = audio[j];
                if (!audio[j].unsupported && !matchSupported) matchSupported = audio[j];
            }
            if (matchSupported)      target = matchSupported;          // ideal
            else if (matchAny)       target = firstSupported(audio) || matchAny;
        }
        // No preference (or none usable): only step in if the current track is
        // undecodable but a decodable one exists.
        if (!target && active && active.unsupported) target = firstSupported(audio);

        if (target && (!active || target.index !== active.index)) {
            Player.setAudioTrack(target.index);
            if (active && active.unsupported && !target.unsupported)
                UI.toast(target.codec && active.codec
                    ? I18n.t('audio.switched', target.codec, active.codec)
                    : I18n.t('audio.switchedGeneric'));
            if (typeof Debug !== 'undefined')
                Debug.player('chooseAudioTrack → ' + target.name +
                             ' (active was ' + (active ? active.name : 'none') + ')');
        }

        // If we still can't get a decodable track, tell the user why it's silent.
        var finalT = target || active;
        if (finalT && finalT.unsupported && !firstSupported(audio)) {
            UI.toast(I18n.t('audio.noneDecodable', finalT.codec || 'DTS/TrueHD'));
        }
    }

    var prefsAppliedFor = null;
    var subPrefSettled  = false;
    function applyLanguagePreferences() {
        // Only apply once per file to avoid clobbering manual selections
        if (prefsAppliedFor === state.playingUri) return;
        prefsAppliedFor = state.playingUri;
        subPrefSettled  = false;

        var prefSub   = Settings.get('subtitleLang');
        var tracks    = Player.getTracks();

        // Audio: honour the language preference, but never leave the user on a
        // track the TV can't decode (DTS/TrueHD) when a playable one exists.
        chooseAudioTrack(tracks);

        // Subtitle: 'off' explicit, '' auto (no action), code → match
        if (prefSub === 'off') {
            Player.setSubtitleTrack(-1);
            subPrefSettled = true;
            if (typeof Debug !== 'undefined') Debug.player('subtitle pref: off (silent)');
        } else if (prefSub) {
            applySubtitlePreference(prefSub, tracks);
        } else {
            subPrefSettled = true;
            adoptFileDefaultSubtitle(tracks);
        }
    }

    /* 'Auto (file default)': show the track the file itself marks default.
     * AVPlay opens with that track current, and used to leave it there:
     * the CC menu marked it selected, but the subtitle callback stays gated
     * until a track is selected through Player.setSubtitleTrack, so nothing
     * reached the screen until the user toggled it off and on (issue #73).
     * Select it the way the CC menu does, so what the menu says and what
     * the screen shows are the same thing. */
    function adoptFileDefaultSubtitle(tracks) {
        for (var j = 0; j < tracks.subtitle.length; j++) {
            var st = tracks.subtitle[j];
            if (st.off || st.muted || !st.avCurrent) continue;
            var how = Player.setSubtitleTrack(st);
            if (typeof Debug !== 'undefined')
                Debug.player('subtitle pref: auto → file default ' + st.name + ' (' + how + ')');
            return true;
        }
        if (typeof Debug !== 'undefined')
            Debug.player('subtitle pref: auto — file has no default subtitle track');
        return false;
    }

    /* Score every candidate and take the best.  External subs are reliable
     * on this firmware and embedded ones often aren't, so they win ties. */
    function applySubtitlePreference(prefSub, tracks) {
        var wantSub   = prefSub.toLowerCase();
        var bestMatch = null;
        var bestScore = 0;
        for (var j = 0; j < tracks.subtitle.length; j++) {
            var st = tracks.subtitle[j];
            if (st.off || st.muted) continue;

            var sc = LanguageList.matchScore(wantSub, st.lang, st.name);
            if (!sc) continue;
            if (st.type === 'AVPLAY_EXTERNAL' || st.type === 'HTML5_EXTERNAL') sc += 15;

            if (sc > bestScore) { bestScore = sc; bestMatch = st; }
        }
        if (bestMatch) {
            subPrefSettled = true;
            Player.setSubtitleTrack(bestMatch);
            if (typeof Debug !== 'undefined')
                Debug.player('applied subtitle pref ' + prefSub + ' → ' + bestMatch.name +
                             ' (score ' + bestScore + ')');
            return true;
        }
        if (typeof Debug !== 'undefined')
            Debug.player('subtitle pref ' + prefSub + ': no matching track in ' +
                         tracks.subtitle.map(function (x) { return x.name; }).join(' / '));
        return false;
    }

    /* The container's own track list is read after playback starts, so a
     * preferred language that only exists in the tail of a 40-track mux
     * becomes matchable a second or two late.  Retry then — but never over
     * the top of a subtitle that is already showing, which would undo a
     * choice the user just made by hand. */
    function retrySubtitlePreference() {
        if (subPrefSettled) return;
        if (prefsAppliedFor !== state.playingUri) return;
        var prefSub = Settings.get('subtitleLang');
        if (!prefSub || prefSub === 'off') { subPrefSettled = true; return; }
        var tracks = Player.getTracks();
        if (!tracks.subtitle.length || !tracks.subtitle[0].active) return;   // one is showing
        applySubtitlePreference(prefSub, tracks);
    }

    /* On the settings view, after the last focusable row there's a TV-info
     * panel that has no focusables.  Up/Down should:
     *   1. Try to move focus geometrically (noWrap = don't cyclic-fallback).
     *   2. If no element is in that direction, scroll the settings-content
     *      panel instead so the user can read past the bottom of the info.
     * Without noWrap the cyclic fallback would jump focus back to the
     * opposite end and never trigger the scroll. */
    function scrollSettingsIfNoFocusMove(dy, dir) {
        if (UI.moveFocus(dir, /*noWrap*/ true)) return;   // focus moved, done
        var c = document.querySelector('.settings-content');
        if (c) {
            if (c.scrollBy) c.scrollBy({ top: dy, behavior: 'smooth' });
            else            c.scrollTop += dy;
        }
    }

    /* ── Helpers ──────────────────────────────────────────────────── */
    function prettifyRootName(name) {
        if (!name) return I18n.t('root.unknown');
        if (/^removable.*/i.test(name)) return I18n.t('browse.usbTitle');
        if (/^usb/i.test(name)) return I18n.t('browse.usbTitle');
        if (name === 'downloads') return I18n.t('root.downloads');
        if (name === 'videos')    return I18n.t('root.videos');
        if (name === 'music')     return I18n.t('root.music');
        if (name === 'images')    return I18n.t('root.pictures');
        if (name === 'documents') return I18n.t('root.documents');
        return name.charAt(0).toUpperCase() + name.slice(1);
    }

    function escapeHtml(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    // Public hooks used by js/smb.js to hand SMB playback back to the app so it
    // reuses next/prev, auto-play, recent & watched tracking.
    window.VlcApp = {
        play: playFromList, home: backToHome, openSettings: openSettings,
        // server.js uses this to let the user choose when a LAN scan turns up
        // more than one transcode server.
        openPicker: openPicker
    };

    if (document.readyState === 'loading')
        document.addEventListener('DOMContentLoaded', init);
    else
        init();

})();
