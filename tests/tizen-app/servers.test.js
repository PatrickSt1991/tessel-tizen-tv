'use strict';

var assert = require('assert');
var test   = require('node:test');
var fs     = require('fs');
var vm     = require('vm');
var path   = require('path');
var I18n   = require('./helpers/i18n.js');

var SRC = fs.readFileSync(path.join(__dirname, '../../tizen-app/js/servers.js'), 'utf8');

var NAS  = { id: '',     host: 'nas',  share: 'Media' };
var PC   = { id: 'pc1',  host: 'pc',   share: 'Films' };
var NC   = { id: 'nc1',  name: 'My Nextcloud', url: 'https://cloud.example.com/dav/' };
var MINI = { name: 'miniDLNA', control: 'http://192.168.1.10:8200/ctl' };

/* servers.js against fake SMB / WebDAV / DLNA modules, a fake list and a
 * fake remote.  What the fakes were asked to open lands in `opened`. */
function load(opts) {
    opts = opts || {};
    var opened = [], views = [], focused = null, handlers = [];
    var rows = [];
    function el() {
        var e = { textContent: '', dataset: {}, handlers: {}, children: [],
                  addEventListener: function (ev, fn) { this.handlers[ev] = fn; },
                  click: function () { this.handlers.click(); } };
        Object.defineProperty(e, 'innerHTML', {
            get: function () { return this._html || ''; },
            set: function (v) { this._html = v; if (v === '') rows.length = 0; }
        });
        return e;
    }
    var list = el();
    list.appendChild = function (li) { rows.push(li); };
    Object.defineProperty(list, 'firstElementChild', { get: function () { return rows[0] || null; } });
    var toggle = el();
    var sandbox = {
        module: { exports: {} },
        Debug: { send: function () {} },
        I18n: I18n,
        SMB: {
            servers:     function () { return opts.smb || []; },
            serverLabel: function (c) { return '\\\\' + c.host + '\\' + c.share; },
            openFolder:  function (id, p, back) {
                if (opts.smbGone === id) return false;
                opened.push({ kind: 'smb', id: id, path: p, back: back }); return true;
            }
        },
        WebDAV: {
            servers:     function () { return opts.dav || []; },
            serverLabel: function (s) { return s.name; },
            openFolder:  function (id, p, back) { opened.push({ kind: 'webdav', id: id, path: p, back: back }); return true; }
        },
        DLNA: {
            found:       function () { return opts.dlna || []; },
            openFound:   function (s, back) { opened.push({ kind: 'dlna', server: s, back: back }); },
            openBrowser: function (back) { opened.push({ kind: 'find', back: back }); }
        },
        UI: {
            showView: function (id) { views.push(id); },
            refreshFocusables: function () {},
            focusOn: function (e) { focused = e; },
            focusInList: function (l, e) { focused = e || l.firstElementChild; }
        },
        Remote: {
            KEY: { BACK: 10009 },
            push: function (fn) { handlers.unshift(fn); return fn; },
            pop:  function (fn) { var i = handlers.indexOf(fn); if (i >= 0) handlers.splice(i, 1); }
        },
        document: {
            createElement: function () { return el(); },
            getElementById: function (id) { return id === 'browse-list' ? list : el(); },
            querySelector: function (sel) { return /grp-smb/.test(sel) ? toggle : null; }
        },
        window: { VlcApp: { home: function () { views.push('home'); }, openSettings: function () { views.push('settings'); } } }
    };
    vm.createContext(sandbox);
    vm.runInContext(SRC + '\nvar S_ = Servers;', sandbox);
    return {
        S: sandbox.S_, opened: opened, views: views, handlers: handlers, toggle: toggle,
        rows:    function () { return rows.map(function (r) { return r.innerHTML.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(); }); },
        focused: function () { return focused; },
        row:     function (i) { return rows[i]; },
        back:    function () { return handlers.length && handlers[0](10009); }
    };
}

test('the list has every saved server, the DLNA servers found, a search row and a Settings row', function () {
    var t = load({ smb: [NAS, PC], dav: [NC], dlna: [MINI] });
    t.S.openBrowser();
    assert.deepStrictEqual(t.views, ['view-browse']);
    assert.deepStrictEqual(t.rows(), [
        '📁 \\\\nas\\Media SMB', '📁 \\\\pc\\Films SMB', '📁 My Nextcloud WebDAV', '📁 miniDLNA DLNA',
        '🔍 Find media servers', '+ Add a server'
    ]);
    assert.strictEqual(t.focused(), t.row(0));
    assert.deepStrictEqual(Array.from(t.S.all(), function (s) { return s.key; }),
                           ['smb:', 'smb:pc1', 'webdav:nc1', 'dlna:' + MINI.control]);
});

test('one saved server and nothing else opens straight away, and Back from it comes to the list', function () {
    var t = load({ dav: [NC] });
    t.S.openBrowser();
    assert.strictEqual(t.opened.length, 1);
    assert.strictEqual(t.opened[0].kind, 'webdav');
    assert.strictEqual(t.opened[0].id, 'nc1');
    assert.strictEqual(t.opened[0].path, '');
    assert.deepStrictEqual(t.views, [], 'no list shown');
    assert.strictEqual(t.handlers.length, 0, 'no Back handler of its own while the browser runs');
    t.opened[0].back();
    assert.deepStrictEqual(t.views, ['view-browse']);
    assert.strictEqual(t.focused(), t.row(0), 'the cursor is on the server just left');
    assert.strictEqual(t.handlers.length, 1);
});

test('with nothing saved the list still offers the search and Settings', function () {
    var t = load();
    t.S.openBrowser();
    assert.deepStrictEqual(t.rows(), ['🔍 Find media servers', '+ Add a server']);
    t.row(0).click();
    assert.strictEqual(t.opened[0].kind, 'find');
    t.opened[0].back();
    assert.strictEqual(t.focused(), t.row(0));
    t.row(1).click();
    assert.deepStrictEqual(t.views.slice(-1), ['settings']);
    assert.strictEqual(t.focused(), t.toggle, 'the cursor lands on the SMB section');
    assert.strictEqual(t.handlers.length, 0);
});

test('each kind opens its own browser, with the way back to the list', function () {
    var t = load({ smb: [NAS], dav: [NC], dlna: [MINI] });
    t.S.openBrowser();
    t.row(0).click();
    t.opened[0].back();
    t.row(1).click();
    t.opened[1].back();
    t.row(2).click();
    assert.deepStrictEqual(t.opened.map(function (o) { return o.kind; }), ['smb', 'webdav', 'dlna']);
    assert.strictEqual(t.opened[2].server, MINI);
    t.opened.forEach(function (o) { assert.strictEqual(typeof o.back, 'function'); });
    t.opened[2].back();
    assert.strictEqual(t.focused(), t.row(2));
});

test('a server removed meanwhile shows the list again instead of a dead end', function () {
    var t = load({ smb: [PC], smbGone: 'pc1' });
    t.S.openBrowser();
    assert.deepStrictEqual(t.views, ['view-browse']);
});

test('Back on the list goes Home and drops the handler', function () {
    var t = load({ smb: [NAS, PC] });
    t.S.openBrowser();
    assert.strictEqual(t.back(), true);
    assert.deepStrictEqual(t.views, ['view-browse', 'home']);
    assert.strictEqual(t.handlers.length, 0);
});
