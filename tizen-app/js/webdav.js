/* ============================================================================
 * WebDAV servers (issue #145), web side.
 * ----------------------------------------------------------------------------
 * A Nextcloud, a NAS's WebDAV server or a cloud drive, saved in Settings and
 * browsed from its own home tile.  The background service talks to the
 * server (see the WebDAV block in service.js): it can accept a home server's
 * self-signed certificate and answer a Digest challenge, which the page
 * can't, and it hands AVPlay the file as http://127.0.0.1:8127/dav/stream
 * with the credentials kept out of the URL — so a file opened here flows
 * through the app's normal play path and gets next/prev, auto-play, recents
 * and resume like any other.
 *
 * Servers live in their own localStorage list (Settings only persists its
 * fixed key set), each with a short random id that its stream URLs carry.
 * ==========================================================================*/

var WebDAV = (function () {

    var BASE = 'http://127.0.0.1:8127';
    var KEY  = 'vlctv_webdav_v1';

    function dbg(msg) { if (typeof Debug !== 'undefined' && Debug.send) Debug.send('DAV', msg); }

    /* ── saved servers ─────────────────────────────────────────────────── */
    function servers() {
        try {
            var l = JSON.parse(localStorage.getItem(KEY) || '[]');
            return Array.isArray(l) ? l.filter(function (s) { return s && s.id && s.url; }) : [];
        } catch (e) { return []; }
    }
    function setServers(l) {
        try { localStorage.setItem(KEY, JSON.stringify(l || [])); } catch (e) {}
    }
    function newId() { return Math.random().toString(36).slice(2, 10); }
    function serverById(id) {
        var l = servers();
        for (var i = 0; i < l.length; i++) if (l[i].id === id) return l[i];
        return null;
    }
    /* The address as it is stored: trimmed, http:// when no scheme was
     * typed (a NAS on the LAN), one trailing slash.  '' when it can't be
     * a server address. */
    function normalizeUrl(raw) {
        var u = String(raw == null ? '' : raw).trim().replace(/\s+/g, '');
        if (!u) return '';
        if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(u)) u = 'http://' + u;
        if (!/^https?:\/\/[^\/]+/i.test(u)) return '';
        return u.replace(/\/*$/, '/');
    }
    /* Addresses that are the same server: scheme and host case-free. */
    function sameUrl(a, b) {
        function key(u) {
            var m = /^(https?:\/\/[^\/]*)(.*)$/i.exec(String(u || ''));
            return m ? m[1].toLowerCase() + m[2].replace(/\/+$/, '') : String(u || '');
        }
        return key(a) === key(b);
    }
    function findServer(url, user) {
        var l = servers();
        for (var i = 0; i < l.length; i++)
            if (sameUrl(l[i].url, url) && String(l[i].user || '') === String(user || '')) return l[i].id;
        return null;
    }
    /* What a server is called in lists: its name, else its host. */
    function serverLabel(s) {
        if (!s) return '';
        if (s.name) return s.name;
        var m = /^https?:\/\/([^\/]+)/i.exec(s.url || '');
        return m ? m[1] : String(s.url || '');
    }

    /* ── the service ───────────────────────────────────────────────────── */
    function getJson(url, cb) {
        var x = new XMLHttpRequest();
        x.open('GET', url, true);
        x.timeout = 30000;
        x.onload = function () {
            try { cb(null, JSON.parse(x.responseText)); }
            catch (e) { cb(new Error('bad response')); }
        };
        x.onerror = function () { cb(new Error('service unreachable')); };
        x.ontimeout = function () { cb(new Error('timeout')); };
        x.send();
    }
    function postJson(url, body, cb) {
        var x = new XMLHttpRequest();
        x.open('POST', url, true);
        x.setRequestHeader('Content-Type', 'application/json');
        x.timeout = 30000;
        x.onload = function () {
            try { cb(null, JSON.parse(x.responseText)); }
            catch (e) { cb(new Error('bad response')); }
        };
        x.onerror = function () { cb(new Error('service unreachable')); };
        x.ontimeout = function () { cb(new Error('timeout')); };
        x.send(JSON.stringify(body || {}));
    }

    /* The service's reason, in the user's words where it has a name for
     * it: the certificate, the credentials, the address. */
    function reason(res, err) {
        if (err) return err.message;
        var code = res && res.code, text = (res && res.error) || 'failed';
        if (code === 'cert')     return I18n.t('dav.err.cert');
        if (code === 'auth')     return I18n.t('dav.err.auth');
        if (code === 'notfound') return I18n.t('dav.err.notFound');
        if (code === 'notdav')   return I18n.t('dav.err.notDav');
        if (code === 'host')     return I18n.t('dav.err.host');
        return text;
    }

    function connect(id, cb) {
        var s = serverById(id);
        if (!s) return cb(new Error(I18n.t('dav.serverGone')));
        if (typeof NetworkAccess !== 'undefined' &&
            !NetworkAccess.check(s.url, null, function () { connect(id, cb); }))
            return cb(NetworkAccess.refusal(NetworkAccess.hostOf(s.url)));
        dbg('connect -> ' + s.url + ' [' + id + '] user=' + (s.user || '(none)') + (s.insecure ? ' insecure' : ''));
        postJson(BASE + '/dav/connect', { id: id, url: s.url, user: s.user || '', pass: s.pass || '', insecure: !!s.insecure },
                 function (err, res) {
            if (err || !res.ok) {
                dbg('connect failed: ' + (err ? err.message : res.code + ' ' + res.error));
                return cb(new Error(reason(res, err)));
            }
            dbg('connect ok: auth=' + res.auth);
            cb(null);
        });
    }
    /* Make /dav/stream usable without going through the browser first — a
     * file opened from Recents after a restart finds the service down, or
     * up but never told about this server. */
    function ensureConnected(id, cb) {
        getJson(BASE + '/smb/ping', function (err, res) {
            if (!err && res && (res.dav || []).indexOf(id) >= 0) return cb(null);
            SMB.ensureService(function (e2) {
                if (e2) return cb(e2);
                connect(id, cb);
            });
        });
    }
    function list(id, path, cb) {
        getJson(BASE + '/dav/list?srv=' + encodeURIComponent(id) + '&path=' + encodeURIComponent(path || ''), function (err, res) {
            if (err || !res.ok) return cb(new Error(reason(res, err)));
            cb(null, res.entries || []);
        });
    }

    /* The URL handed to AVPlay; the service streams the file with Range
     * support, so seeking works. */
    function streamUrl(path, srv) {
        return BASE + '/dav/stream?srv=' + encodeURIComponent(srv) + '&path=' + encodeURIComponent(path);
    }
    function isStreamUrl(u) { return typeof u === 'string' && u.indexOf(BASE + '/dav/stream') === 0; }

    /* The URL we actually play: through a paired transcode server that knows
     * WebDAV (HLS, server-side decode of DTS/TrueHD and codecs the TV can't
     * handle), else straight off the service.  Browsing is identical either
     * way — only the bytes' origin changes. */
    function playableUrl(path, srv) {
        if (typeof TranscodeServer !== 'undefined' && TranscodeServer.isPaired() && TranscodeServer.davPlayUrl) {
            var u = TranscodeServer.davPlayUrl(path, serverById(srv));
            if (u) return u;
        }
        return streamUrl(path, srv);
    }
    /* The server a stream URL reads from, or null when it isn't one of ours. */
    function streamServerOf(u) {
        if (!isStreamUrl(u)) return null;
        var m = /[?&]srv=([^&]*)/.exec(u);
        return m ? decodeURIComponent(m[1]) : null;
    }

    /* ── browsing UI (reuses #view-browse, like the SMB browser) ───────── */
    var pathStack = [];
    var backHandler = null;
    var current = '';
    var pickingServer = false;

    function esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }
    function humanSize(n) {
        if (!n) return '';
        var u = ['B', 'KB', 'MB', 'GB', 'TB'], i = 0;
        while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
        return (i === 0 ? n : n.toFixed(1)) + ' ' + u[i];
    }
    function join(dir, name) { return (dir ? dir.replace(/\/+$/, '') : '') + '/' + name; }
    function ul() { return document.getElementById('browse-list'); }
    function head(title, path) {
        UI.showView('view-browse');
        document.getElementById('browse-title').textContent = title;
        document.getElementById('browse-path').textContent = path;
    }
    function message(icon, text) {
        ul().innerHTML = '<li><span class="icon">' + icon + '</span><span class="name">' + esc(text) + '</span></li>';
        UI.focusInList(ul());
    }

    function render(path, focusName) {
        var srv = current, s = serverById(srv) || {};
        head(path ? path.split('/').pop() : serverLabel(s), serverLabel(s) + (path || '/'));
        message('…', I18n.t('common.loading'));
        var stackHere = pathStack.slice();
        list(srv, path, function (err, entries) {
            if (current !== srv) return;   // left meanwhile
            if (err) {
                dbg('list ' + JSON.stringify(path || '/') + ' failed: ' + err.message);
                if (SMB.dumpServiceLogs) SMB.dumpServiceLogs('dav list');
                message('!', err.message);
                return;
            }
            var sidecars = SMB.siblingSubtitles(entries, path, srv, streamUrl);
            var artName = FileTypes.folderArt(entries.map(function (e) { return e.isDir ? '' : e.name; }));
            var art = artName ? streamUrl(join(path, artName), srv) : null;
            var filter = Settings.get('browseFilter'), showHidden = Settings.get('showHidden');
            entries = entries.filter(function (e) {
                return (showHidden || !FileTypes.isHidden(e.name)) && FileTypes.shown(filter, e.isDir ? 'dir' : FileTypes.kind(e.name));
            });
            dbg('list ' + JSON.stringify(path || '/') + ': ' + entries.length + ' shown');
            var playlist = entries
                .filter(function (e) { return !e.isDir && FileTypes.isPlayable(e.name); })
                .map(function (e) {
                    var audio = FileTypes.kind(e.name) === 'audio';
                    return { uri: playableUrl(join(path, e.name), srv), title: e.name, subtitles: sidecars[e.name] || [],
                             // Tags come off the server itself, not the box's HLS.
                             tagSrc: audio ? streamUrl(join(path, e.name), srv) : null, art: audio ? art : null };
                });
            var pictures = entries
                .filter(function (e) { return !e.isDir && FileTypes.kind(e.name) === 'image'; })
                .map(function (e) { return { uri: streamUrl(join(path, e.name), srv), title: e.name, size: e.size }; });
            function backHere(name) {
                return function (last) {
                    current = srv; pickingServer = false; pathStack = stackHere.slice();
                    setupBack(); render(path, (last && last.title) || name);
                };
            }

            var list_ = ul();
            list_.innerHTML = '';
            if (pathStack.length > 0 || servers().length > 1) {
                var up = document.createElement('li');
                up.dataset.dir = '1';
                up.innerHTML = '<span class="icon">↩</span><span class="name">..</span>';
                up.addEventListener('click', goUp);
                list_.appendChild(up);
            }
            var focus = null;
            entries.forEach(function (e) {
                var kind = e.isDir ? 'dir' : FileTypes.kind(e.name);
                var li = document.createElement('li');
                li.dataset.dir = e.isDir ? '1' : '0';
                if (kind === 'other') li.classList.add('unopenable');
                var subs = sidecars[e.name] || [];
                var subBadge = subs.length ? '<span class="meta">CC ×' + subs.length + '</span>' : '';
                li.innerHTML =
                    '<span class="icon">' + FileTypes.icon(kind) + '</span>' +
                    '<span class="name">' + esc(e.name) + '</span>' +
                    (e.isDir ? '<span class="fav-mark">♥</span>'
                             : subBadge + '<span class="meta">' + humanSize(e.size) + '</span>');
                if (e.isDir) {
                    var fav = { kind: 'webdav', srv: srv, path: join(path, e.name), name: e.name };
                    li.dataset.fav = JSON.stringify(fav);
                    if (typeof Favorites !== 'undefined' && Favorites.find(fav)) li.classList.add('is-fav');
                }
                if (focusName && e.name === focusName) focus = li;
                if (!e.isDir && FileTypes.isPlayable(e.name)) li.dataset.uri = playableUrl(join(path, e.name), srv);
                li.addEventListener('click', function () {
                    if (e.isDir) { pathStack.push(path); render(join(path, e.name)); return; }
                    if (openOther(kind, e)) return;
                    var uri = playableUrl(join(path, e.name), srv), idx = 0;
                    for (var i = 0; i < playlist.length; i++) if (playlist[i].uri === uri) { idx = i; break; }
                    teardownBack();
                    if (window.VlcApp && window.VlcApp.play) window.VlcApp.play('webdav', playlist, idx, null, backHere(e.name));
                });
                list_.appendChild(li);
            });
            if (!list_.children.length)
                list_.innerHTML = '<li><span class="icon">i</span><span class="name">' + esc(I18n.t('browse.empty')) + '</span></li>';

            if (window.VlcApp && window.VlcApp.markNowPlaying) window.VlcApp.markNowPlaying();
            UI.focusInList(list_, focus);

            /* A file that isn't for the player: the viewers, the playlist
             * reader, or a toast — the same hand-offs the SMB browser makes. */
            function openOther(kind, e) {
                var file = join(path, e.name);
                switch (kind) {
                    case 'video': case 'audio':
                        return false;
                    case 'image':
                        teardownBack();
                        Viewer.openImage(pictures,
                            pictures.findIndex(function (p) { return p.title === e.name; }), backHere(e.name));
                        return true;
                    case 'text':
                        teardownBack();
                        Viewer.openText({ title: e.name, src: streamUrl(file, srv), size: e.size }, backHere(e.name));
                        return true;
                    case 'playlist':
                        if (!window.VlcApp || !window.VlcApp.openPlaylist) return false;
                        teardownBack();
                        window.VlcApp.openPlaylist({
                            title:   e.name,
                            read:    function (cb) { Browser.readHead(streamUrl(file, srv), window.VlcApp.maxPlaylistBytes, cb); },
                            resolve: function (ref) {
                                if (/^(https?|rtsp|rtmp|mms|udp|rtp):/i.test(ref)) return ref;
                                if (/^[a-z][a-z0-9+.-]+:/i.test(ref)) return null;
                                var p = SMB.sharePath(path, ref);
                                return p ? playableUrl(p, srv) : null;
                            },
                            playAsStream: function () {
                                window.VlcApp.play('webdav', [{ uri: streamUrl(file, srv), title: e.name }], 0);
                            },
                            back:    backHere(e.name)
                        });
                        return true;
                }
                UI.toast(I18n.t('browse.cantOpen'));
                return true;
            }
        });
    }

    function goUp() {
        if (pickingServer) { exit(); return; }
        if (!pathStack.length) {
            if (!exitTo && servers().length > 1) { showServers(); return; }
            exit();
            return;
        }
        render(pathStack.pop());
    }
    /* Where Back from the root goes: the Servers list that opened it
     * (js/servers.js), else Home. */
    var exitTo = null;
    function exit() {
        teardownBack();
        var back = exitTo;
        exitTo = null;
        if (back) { back(); return; }
        if (window.VlcApp && window.VlcApp.home) window.VlcApp.home();
        else UI.showView('view-home');
    }
    function setupBack() {
        if (backHandler) return;
        backHandler = Remote.push(function (code) {
            if (code === Remote.KEY.BACK) { goUp(); return true; }
            return false;
        });
    }
    function teardownBack() {
        if (backHandler) { Remote.pop(backHandler); backHandler = null; }
    }

    /* Straight into the server when there is one, a list to pick from when
     * there are more.  Home offers the Servers list instead (js/servers.js);
     * this is what a start screen of "WebDAV" still opens. */
    function openBrowser() {
        exitTo = null;
        var l = servers();
        if (!l.length) {
            dbg('openBrowser: no server saved → sending to Settings');
            UI.toast(I18n.t('dav.addFirst'));
            if (window.VlcApp && window.VlcApp.openSettings) window.VlcApp.openSettings();
            return;
        }
        pathStack = [];
        setupBack();
        if (l.length > 1) { showServers(); return; }
        openServer(l[0].id);
    }
    function showServers() {
        pickingServer = true;
        pathStack = [];
        head(I18n.t('dav.title'), I18n.t('smb.pickServer'));
        var list_ = ul();
        list_.innerHTML = '';
        var focus = null;
        servers().forEach(function (s) {
            var li = document.createElement('li');
            li.dataset.dir = '1';
            li.innerHTML = '<span class="icon">📁</span><span class="name">' + esc(serverLabel(s)) + '</span>' +
                           (s.name ? '<span class="meta">' + esc(s.url) + '</span>' : '');
            li.addEventListener('click', function () { openServer(s.id); });
            list_.appendChild(li);
            if (s.id === current) focus = li;
        });
        UI.focusInList(list_, focus);
    }

    /* Connect to server `id` and list `path` on it ('' or absent: the
     * root), with the way up through the folders above it. */
    function openServer(id, path) {
        pickingServer = false;
        current = id;
        path = path || '';
        pathStack = SMB.parentPaths(path);
        head(I18n.t('dav.title'), I18n.t('common.connecting'));
        message('…', I18n.t('common.connecting'));
        dbg('openBrowser [' + id + ']' + (path ? ' ' + JSON.stringify(path) : ''));
        SMB.ensureService(function (err) {
            if (current !== id) return;
            if (err) { dbg('ensureService failed: ' + err.message); message('!', err.message); return; }
            connect(id, function (err2) {
                if (current !== id) return;
                if (err2) {
                    message('!', I18n.t('smb.connectFailed', err2.message));
                    if (SMB.dumpServiceLogs) SMB.dumpServiceLogs('dav connect failure');
                    return;
                }
                render(path);
            });
        });
    }
    /* A pinned folder from the Favorites tile, or a server from the Servers
     * list: straight into `path` on saved server `srv`, and Back from the
     * root goes to `back` when given.  false when that server is no longer
     * saved. */
    function openFolder(srv, path, back) {
        if (!serverById(srv)) return false;
        exitTo = back || null;
        setupBack();
        openServer(srv, path);
        return true;
    }

    /* ── the Settings form ─────────────────────────────────────────────── */
    var FORM_IDS = ['name', 'url', 'user', 'pass'];
    var editing = 'new';
    var insecureState = false;

    function paintInsecure() {
        var el = document.getElementById('dav-insecure-val');
        if (el) el.textContent = I18n.t(insecureState ? 'common.on' : 'common.off');
    }
    function paintEditing() {
        var val = document.getElementById('dav-server-val');
        var s = editing === 'new' ? null : serverById(editing);
        if (val) val.textContent = s ? serverLabel(s) : I18n.t('smb.newServer');
        var rm = document.getElementById('dav-remove');
        if (rm) rm.style.display = s ? '' : 'none';
    }
    /* Every field is set, so nothing from the server shown before lingers. */
    function editServer(id) {
        editing = id;
        var s = (id === 'new' ? null : serverById(id)) || {};
        FORM_IDS.forEach(function (k) {
            var el = document.getElementById('dav-' + k);
            if (el) el.value = s[k] != null ? s[k] : '';
        });
        insecureState = !!s.insecure;
        paintInsecure();
        paintEditing();
    }
    function readSettingsForm() {
        var s = {};
        FORM_IDS.forEach(function (k) {
            var el = document.getElementById('dav-' + k);
            s[k] = el ? el.value.trim() : '';
        });
        s.url = normalizeUrl(s.url);
        s.insecure = insecureState;
        return s;
    }
    /* Store what the form holds as the server being edited: the id it was
     * saved under, null for a duplicate, '' when the address is missing. */
    function saveServer(s) {
        if (!s.url) return '';
        var other = findServer(s.url, s.user);
        if (other !== null && other !== editing) return null;
        var l = servers();
        if (editing === 'new') { s.id = newId(); l.push(s); }
        else { s.id = editing; for (var i = 0; i < l.length; i++) if (l[i].id === editing) l[i] = s; }
        setServers(l);
        return s.id;
    }
    function removeServer(id) {
        setServers(servers().filter(function (s) { return s.id !== id; }));
        var left = servers();
        editServer(left.length ? left[0].id : 'new');
    }
    function refocus(id) {
        setTimeout(function () {
            var el = document.getElementById(id);
            if (el) UI.focusOn(el);
        }, 0);
    }
    function pickServer() {
        if (!window.VlcApp || !window.VlcApp.openPicker) return;
        var items = servers().map(function (s) { return { code: s.id, name: serverLabel(s) }; });
        items.push({ code: 'new', name: I18n.t('smb.addServer') });
        window.VlcApp.openPicker(I18n.t('smb.pickServer'), items, editing, function (code) {
            editServer(code);
            refocus('dav-server');
        });
    }
    function confirmRemove() {
        var s = serverById(editing);
        if (!s || !window.VlcApp || !window.VlcApp.openPicker) return;
        window.VlcApp.openPicker(I18n.t('smb.removeConfirm', serverLabel(s)), [
            { code: 'remove', name: I18n.t('smb.removeServer') },
            { code: 'keep',   name: I18n.t('common.cancel') }
        ], 'keep', function (code) {
            if (code === 'remove') {
                dbg('server removed: ' + s.url);
                removeServer(editing);
                UI.toast(I18n.t('smb.removed', serverLabel(s)));
            }
            refocus('dav-server');
        });
    }

    function wireSettingsForm() {
        var btn = document.getElementById('dav-save');
        if (!btn) return;
        var l = servers();
        editServer(l.length ? l[0].id : 'new');

        var serverBtn = document.getElementById('dav-server');
        if (serverBtn) serverBtn.addEventListener('click', pickServer);
        var removeBtn = document.getElementById('dav-remove');
        if (removeBtn) removeBtn.addEventListener('click', confirmRemove);
        var insecureBtn = document.getElementById('dav-insecure');
        if (insecureBtn) insecureBtn.addEventListener('click', function () { insecureState = !insecureState; paintInsecure(); });

        btn.addEventListener('click', function () {
            var s = readSettingsForm();
            var id = saveServer(s);
            if (id === null) { UI.toast(I18n.t('dav.duplicate')); return; }
            if (id === '')   { UI.toast(I18n.t('smb.hostMissing')); return; }
            editing = id;
            paintEditing();
            dbg('settings saved [' + id + ']: url=' + s.url + ' user=' + JSON.stringify(s.user || '') +
                ' pass=' + (s.pass ? s.pass.length + ' chars' : 'none') + (s.insecure ? ' insecure' : ''));
            UI.toast(I18n.t('dav.saved'));
        });
    }

    if (document.readyState === 'loading')
        document.addEventListener('DOMContentLoaded', wireSettingsForm);
    else
        wireSettingsForm();

    return {
        openBrowser:     openBrowser,
        openFolder:      openFolder,
        detach:          teardownBack,     // the player is coming up: its BACK now
        servers:         servers,
        serverById:      serverById,
        serverLabel:     serverLabel,
        streamUrl:       streamUrl,
        playableUrl:     playableUrl,      // exposed for the Node tests
        isStreamUrl:     isStreamUrl,
        streamServerOf:  streamServerOf,
        ensureConnected: ensureConnected,  // server.js, before a stream URL plays
        normalizeUrl:    normalizeUrl,     // exposed for the Node tests
        findServer:      findServer
    };
})();

// Ignored by the Tizen/browser build; lets Node tests drive the module.
if (typeof module !== 'undefined' && module.exports) module.exports = WebDAV;
