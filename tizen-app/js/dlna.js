/* ============================================================================
 * DLNA media servers (issue #131), web side.
 * ----------------------------------------------------------------------------
 * The background service finds the servers (SSDP needs UDP, which the page
 * can't send) and reads their folders; see the DLNA block in service.js.
 * Nothing is configured: the home tile searches the LAN, a single server
 * opens straight away, and more are offered as a list.
 *
 * What a server lists plays from the http URL it gives, straight into
 * AVPlay — so a file opened here flows through the app's normal play path
 * and gets next/prev, auto-play, recents and resume like any other.
 * A DLNA title often has no extension, so an entry's kind comes from the
 * server's own class for it (video / audio / image), not from its name.
 * ==========================================================================*/

var DLNA = (function () {

    var BASE = 'http://127.0.0.1:8127';

    function dbg(msg) { if (typeof Debug !== 'undefined' && Debug.send) Debug.send('DLNA', msg); }

    function request(method, url, body, timeout, cb) {
        var x = new XMLHttpRequest();
        x.open(method, url, true);
        if (body) x.setRequestHeader('Content-Type', 'application/json');
        x.timeout = timeout;
        x.onload = function () {
            try { cb(null, JSON.parse(x.responseText)); }
            catch (e) { cb(new Error('bad response')); }
        };
        x.onerror = function () { cb(new Error('service unreachable')); };
        x.ontimeout = function () { cb(new Error('timeout')); };
        x.send(body ? JSON.stringify(body) : null);
    }

    /* An entry's kind: the server's class, else the URL's extension. */
    function kindOf(e) {
        if (e.isDir) return 'dir';
        if (e.kind && e.kind !== 'other') return e.kind;
        return FileTypes.kind(String(e.url || '').split('?')[0].split('#')[0]);
    }
    function isPlayable(k) { return k === 'video' || k === 'audio'; }

    function esc(s) {
        return String(s).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }
    function humanSize(n) {
        if (!n) return '';
        var u = ['B', 'KB', 'MB', 'GB', 'TB'], i = 0;
        while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
        return (i ? n.toFixed(1) : n) + ' ' + u[i];
    }
    function clock(sec) {
        sec = Math.round(sec);
        var h = Math.floor(sec / 3600), m = Math.floor(sec / 60) % 60, s = sec % 60;
        return (h ? h + ':' + (m < 10 ? '0' : '') : '') + m + ':' + (s < 10 ? '0' : '') + s;
    }

    /* The folders' entries as the app's lists want them: the playlist for
     * the player, the pictures for the viewer. */
    function playlistOf(entries) {
        return entries.filter(function (e) { return isPlayable(kindOf(e)); }).map(function (e) {
            var audio = kindOf(e) === 'audio';
            return { uri: e.url, title: e.title, art: audio && e.art ? e.art : null, tagSrc: audio ? e.url : null };
        });
    }
    function picturesOf(entries) {
        return entries.filter(function (e) { return kindOf(e) === 'image'; })
                      .map(function (e) { return { uri: e.url, title: e.title, size: e.size }; });
    }

    /* ── state ─────────────────────────────────────────────────────────── */
    var found = [];          // the servers the last search found
    var server = null;       // the one being browsed
    var stack = [];          // folders above this one: [{ id, title }]
    var folder = null;       // this folder: { id, title }
    var backHandler = null;

    function list() { return document.getElementById('browse-list'); }
    function head(title, path) {
        UI.showView('view-browse');
        document.getElementById('browse-title').textContent = title;
        document.getElementById('browse-path').textContent = path;
    }
    function row(icon, name, meta) {
        var li = document.createElement('li');
        li.innerHTML = '<span class="icon">' + icon + '</span><span class="name">' + esc(name) + '</span>' +
                       (meta ? '<span class="meta">' + esc(meta) + '</span>' : '');
        return li;
    }
    function message(icon, text) {
        list().innerHTML = '';
        list().appendChild(row(icon, text));
        UI.refreshFocusables();
        UI.focusOn(list().firstElementChild);
    }

    /* ── searching ─────────────────────────────────────────────────────── */
    function openBrowser() {
        setupBack();
        search();
    }
    function search() {
        server = null; folder = null; stack = [];
        head(I18n.t('dlna.title'), I18n.t('dlna.searching'));
        message('…', I18n.t('dlna.searching'));
        SMB.ensureService(function (err) {
            if (err) { dbg('service did not start: ' + err.message); message('!', err.message); return; }
            request('GET', BASE + '/dlna/discover', null, 20000, function (err2, res) {
                if (err2 || !res || !res.ok) {
                    var why = err2 ? err2.message : (res && res.error) || 'search failed';
                    dbg('search failed: ' + why);
                    if (SMB.dumpServiceLogs) SMB.dumpServiceLogs('dlna search');
                    found = [];
                    showServers(why);
                    return;
                }
                found = res.servers || [];
                dbg('found ' + found.length + ' server(s): ' + found.map(function (s) { return s.name; }).join(', '));
                /* Pull the service's DLNA_ lines here too, not only on failure.
                 * A search that "succeeds" with the wrong servers is exactly the
                 * case where those lines are needed, and they are otherwise
                 * unreachable from off the TV. */
                if (SMB.dumpServiceLogs) SMB.dumpServiceLogs('dlna search');
                if (found.length === 1) openServer(found[0]);
                else showServers();
            });
        });
    }
    /* The servers found, or why there are none, with a way to look again. */
    function showServers(error) {
        server = null; folder = null; stack = [];
        head(I18n.t('dlna.title'), I18n.t('dlna.pickServer'));
        var ul = list();
        ul.innerHTML = '';
        var focus = null;
        found.forEach(function (s) {
            var li = row('📁', s.name);
            li.dataset.dir = '1';
            li.addEventListener('click', function () { openServer(s); });
            ul.appendChild(li);
        });
        if (!found.length) {
            var none = row('i', error ? I18n.t('dlna.searchFailed', error) : I18n.t('dlna.none'));
            ul.appendChild(none);
        }
        var again = row('↻', I18n.t('dlna.searchAgain'));
        again.addEventListener('click', search);
        ul.appendChild(again);
        if (!found.length) focus = again;
        UI.refreshFocusables();
        UI.focusOn(focus || ul.firstElementChild);
    }

    /* ── browsing ──────────────────────────────────────────────────────── */
    function openServer(s) {
        server = s;
        stack = [];
        render({ id: '0', title: s.name });
    }
    function pathText() {
        return [server.name].concat(stack.slice(1).map(function (f) { return f.title; }),
                                    folder.id === '0' ? [] : [folder.title]).join(' / ');
    }

    function render(f, focusTitle) {
        folder = f;
        head(f.title, pathText());
        message('…', I18n.t('common.loading'));
        var srv = server, here = f, above = stack.slice();
        request('POST', BASE + '/dlna/browse', { control: srv.control, id: f.id }, 30000, function (err, res) {
            if (server !== srv || folder !== here) return;   // left meanwhile
            if (err || !res || !res.ok) {
                var why = err ? err.message : (res && res.error) || 'browse failed';
                dbg('browse ' + JSON.stringify(here.id) + ' on ' + srv.name + ' failed: ' + why);
                if (SMB.dumpServiceLogs) SMB.dumpServiceLogs('dlna browse');
                message('!', why);
                return;
            }
            var filter = Settings.get('browseFilter');
            var entries = (res.entries || []).filter(function (e) { return FileTypes.shown(filter, kindOf(e)); });
            dbg('browse ' + JSON.stringify(here.id) + ': ' + entries.length + ' shown of ' + (res.entries || []).length);
            draw(entries, focusTitle, function backHere(title) {
                return function (last) {
                    server = srv; stack = above.slice();
                    setupBack();
                    render(here, (last && last.title) || title);
                };
            });
        });
    }

    function draw(entries, focusTitle, backHere) {
        var ul = list();
        ul.innerHTML = '';
        var playlist = playlistOf(entries), pictures = picturesOf(entries), focus = null;

        if (stack.length || found.length > 1) {
            var up = row('↩', '..');
            up.dataset.dir = '1';
            up.addEventListener('click', goUp);
            ul.appendChild(up);
        }
        entries.forEach(function (e) {
            var k = kindOf(e);
            var meta = e.isDir ? '' : e.duration ? clock(e.duration) : humanSize(e.size);
            var li = row(FileTypes.icon(k), e.title, meta);
            li.dataset.dir = e.isDir ? '1' : '0';
            if (k === 'other') li.classList.add('unopenable');
            if (isPlayable(k)) li.dataset.uri = e.url;
            if (focusTitle && e.title === focusTitle) focus = li;
            li.addEventListener('click', function () {
                if (e.isDir) { stack.push(folder); render({ id: e.id, title: e.title }); return; }
                if (k === 'image') {
                    teardownBack();
                    var pi = 0;
                    for (var j = 0; j < pictures.length; j++) if (pictures[j].uri === e.url) { pi = j; break; }
                    Viewer.openImage(pictures, pi, backHere(e.title));
                    return;
                }
                if (!isPlayable(k)) { UI.toast(I18n.t('browse.cantOpen')); return; }
                var idx = 0;
                for (var i = 0; i < playlist.length; i++) if (playlist[i].uri === e.url) { idx = i; break; }
                teardownBack();
                if (window.VlcApp && window.VlcApp.play) window.VlcApp.play('dlna', playlist, idx, null, backHere(e.title));
            });
            ul.appendChild(li);
        });
        if (!entries.length) ul.appendChild(row('i', I18n.t('browse.empty')));

        if (window.VlcApp && window.VlcApp.markNowPlaying) window.VlcApp.markNowPlaying();
        UI.refreshFocusables();
        UI.focusOn(focus || ul.firstElementChild);
    }

    function goUp() {
        if (!server) { exit(); return; }
        if (stack.length) { var child = folder; render(stack.pop(), child.title); return; }
        if (found.length > 1) { showServers(); return; }
        exit();
    }
    function exit() {
        teardownBack();
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

    return {
        openBrowser: openBrowser,
        detach:      teardownBack,
        kindOf:      kindOf,        // exposed for the Node tests
        playlistOf:  playlistOf     // exposed for the Node tests
    };
})();

// Ignored by the Tizen/browser build; lets Node tests drive the module.
if (typeof module !== 'undefined' && module.exports) module.exports = DLNA;
