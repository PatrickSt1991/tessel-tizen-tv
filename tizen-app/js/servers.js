/* ============================================================================
 * The Servers tile: every server in one list.
 * ----------------------------------------------------------------------------
 * Home used to give SMB shares, DLNA media servers and WebDAV servers a tile
 * each — eight tiles in a row, each squeezed to fit.  This list stands in
 * for all three: the SMB and WebDAV servers saved in Settings, the DLNA
 * servers the last search found, a row that searches the LAN, and a row
 * that goes to Settings to add a server.
 *
 * One saved server and nothing else opens straight away, as its own tile
 * did; Back from its root comes here, so the search and Settings rows stay
 * one press away.  The browsing itself is still smb.js, webdav.js and
 * dlna.js: each takes a `back` to return to instead of Home.
 * ==========================================================================*/

var Servers = (function () {

    function dbg(msg) { if (typeof Debug !== 'undefined' && Debug.send) Debug.send('SERVERS', msg); }

    function esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    var KIND_LABEL = { smb: 'SMB', webdav: 'WebDAV', dlna: 'DLNA' };

    /* Every server the list offers, saved ones first.  `key` tells them
     * apart so the cursor can come back to the one just left. */
    function all() {
        var out = [];
        if (typeof SMB !== 'undefined') SMB.servers().forEach(function (c) {
            out.push({ kind: 'smb', key: 'smb:' + c.id, id: c.id, name: SMB.serverLabel(c) });
        });
        if (typeof WebDAV !== 'undefined') WebDAV.servers().forEach(function (s) {
            out.push({ kind: 'webdav', key: 'webdav:' + s.id, id: s.id, name: WebDAV.serverLabel(s) });
        });
        if (typeof DLNA !== 'undefined' && DLNA.found) DLNA.found().forEach(function (s) {
            out.push({ kind: 'dlna', key: 'dlna:' + s.control, server: s, name: s.name });
        });
        return out;
    }

    var backHandler = null;
    var last = null;         // the key of the server opened last, for the cursor

    function ul() { return document.getElementById('browse-list'); }
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

    /* Entry point from the home tile. */
    function openBrowser() {
        var l = all();
        dbg('openBrowser: ' + l.length + ' server(s)');
        if (l.length === 1) { open(l[0]); return; }
        show();
    }

    /* The list.  Also where the browsers come back to. */
    function show() {
        setupBack();
        head(I18n.t('home.servers'), I18n.t('smb.pickServer'));
        var list = ul();
        list.innerHTML = '';
        var focus = null;
        all().forEach(function (s) {
            var li = row('📁', s.name, KIND_LABEL[s.kind]);
            li.dataset.dir = '1';
            li.addEventListener('click', function () { open(s); });
            list.appendChild(li);
            if (s.key === last) focus = li;
        });
        var find = row('🔍', I18n.t('servers.find'));
        find.dataset.dir = '1';
        find.addEventListener('click', function () { open({ kind: 'find', key: 'find' }); });
        list.appendChild(find);
        if (last === 'find') focus = find;
        var add = row('+', I18n.t('servers.add'));
        add.addEventListener('click', addServer);
        list.appendChild(add);
        UI.focusInList(list, focus);
    }

    /* Hand over to the browser for `s`.  Our Back goes first: the browser
     * installs its own, and the app's player takes over from that one.
     * Leaving a stale handler underneath would make Back on Home, reached
     * from the player, come back here. */
    function open(s) {
        last = s.key;
        teardownBack();
        dbg('open ' + s.key);
        switch (s.kind) {
            case 'smb':    if (!SMB.openFolder(s.id, '', show)) show(); break;
            case 'webdav': if (!WebDAV.openFolder(s.id, '', show)) show(); break;
            case 'dlna':   DLNA.openFound(s.server, show); break;
            case 'find':   DLNA.openBrowser(show); break;
        }
    }

    /* Settings, with the cursor on the SMB section so the server sections
     * are in view. */
    function addServer() {
        teardownBack();
        if (!(window.VlcApp && window.VlcApp.openSettings)) return;
        window.VlcApp.openSettings();
        var t = document.querySelector('.settings-section-toggle[data-toggle="grp-smb"]');
        if (t) UI.focusOn(t);
    }

    function exit() {
        teardownBack();
        if (window.VlcApp && window.VlcApp.home) window.VlcApp.home();
        else UI.showView('view-home');
    }
    function setupBack() {
        if (backHandler) return;
        backHandler = Remote.push(function (code) {
            if (code === Remote.KEY.BACK) { exit(); return true; }
            return false;
        });
    }
    function teardownBack() {
        if (backHandler) { Remote.pop(backHandler); backHandler = null; }
    }

    return {
        openBrowser: openBrowser,
        all:         all          // exposed for the Node tests
    };
})();

// Ignored by the Tizen/browser build; lets Node tests drive the module.
if (typeof module !== 'undefined' && module.exports) module.exports = Servers;
