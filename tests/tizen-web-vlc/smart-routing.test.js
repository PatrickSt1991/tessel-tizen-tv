'use strict';

var assert = require('assert');
var test   = require('node:test');
var fs     = require('fs');
var vm     = require('vm');
var path   = require('path');

var SRC = fs.readFileSync(
    path.join(__dirname, '../../tizen-web-vlc/js/server.js'), 'utf8');

var SERVER = 'http://192.168.1.20:8200';
var STREAM = 'http://127.0.0.1:8127/smb/stream?path=';
var RELAY  = 'http://192.168.1.50:8128';
var USB    = 'file:///opt/usr/media/USBDriveA1/Films/My%20Film.mkv';

/* server.js expects a browser, Settings and the SMB module; stub all three.
 * `probe` answers /api/probe: a function (path) → { status, body }. */
function loadServer(opts) {
    opts = opts || {};
    var store = {};
    store.vlctv_server_v1 = JSON.stringify({ url: SERVER, token: 'tok', name: 'box', api: 2 });
    var settings = { smartRouting: opts.smart !== false, localRelay: !!opts.relay };
    var requests = [];
    var connects = 0;

    function FakeXHR() {}
    FakeXHR.prototype.open = function (method, url) { this.url = url; };
    FakeXHR.prototype.setRequestHeader = function () {};
    FakeXHR.prototype.send = function () {
        // Only probes are counted; loading also reads /api/config for the
        // settings screen, which is not what these tests are about.
        if (this.url.indexOf('/api/probe') >= 0) requests.push(this.url);
        if (/\/api\/status$/.test(this.url) || /\/local\/enable$/.test(this.url)) {
            this.readyState = 4; this.status = 200;
            this.responseText = JSON.stringify(/status$/.test(this.url)
                ? { localRelay: opts.serverAcceptsUsb !== false, token: 'tok' }
                : { ok: true, url: RELAY });
            return this.onreadystatechange();
        }
        var m = /\/api\/probe\?(?:path|src)=([^&]*)/.exec(this.url);
        var r = m && opts.probe ? opts.probe(decodeURIComponent(m[1])) : { status: 404, body: '' };
        if (r === 'network') { this.readyState = 4; this.status = 0; return this.onerror(); }
        this.readyState = 4;
        this.status = r.status;
        this.responseText = typeof r.body === 'string' ? r.body : JSON.stringify(r.body);
        this.onreadystatechange();
    };

    var sandbox = {
        module: { exports: {} },
        Settings: { get: function (k) { return settings[k]; }, set: function (k, v) { settings[k] = v; } },
        Browser: { listRoots: function (cb) { cb(null, [{ fullPath: '/opt/usr/media/USBDriveA1' }]); } },
        SMB: {
            ensureService: function (cb) { cb(null); },
            streamUrl: function (p) { return STREAM + encodeURIComponent(p); },
            ensureConnected: function (cb) {
                connects++;
                cb(opts.smbDown ? new Error('share unreachable') : null);
            }
        },
        localStorage: {
            getItem: function (k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
            setItem: function (k, v) { store[k] = String(v); },
            removeItem: function (k) { delete store[k]; }
        },
        document: { readyState: 'complete', addEventListener: function () {}, getElementById: function () { return null; } },
        window: {},
        XMLHttpRequest: FakeXHR
    };
    vm.createContext(sandbox);
    vm.runInContext(SRC, sandbox);
    var TS = sandbox.module.exports;

    return {
        TS: TS,
        requests: requests,
        store: store,
        connects: function () { return connects; },
        resolve: function (uri) {
            var out = null;
            TS.resolvePlaybackUri(uri, function (u, route) { out = { url: u, route: route || null }; });
            assert.ok(out, 'resolver must call back synchronously with these stubs');
            return out;
        }
    };
}

function direct(isDirect, extra) {
    var body = { direct: isDirect, reason: isDirect ? 'remux only' : 'copy video, transcode audio dts→ac3',
                 video: 'h264', audio: isDirect ? 'aac' : 'dts', audioChannels: isDirect ? 2 : 6 };
    for (var k in extra || {}) body[k] = extra[k];
    return function () { return { status: 200, body: body }; };
}

test('with smart routing off, a share file keeps playing through the server untouched', function () {
    var t = loadServer({ smart: false, probe: direct(true) });
    var uri = t.TS.playUrl('Movies/a.mkv');
    var r = t.resolve(uri);
    assert.strictEqual(r.url, uri);
    assert.strictEqual(r.route, null);
    assert.strictEqual(t.requests.length, 0, 'no probe when the setting is off');
});

test('a file the server would only remux plays straight from the share, with the server as fallback', function () {
    var t = loadServer({ probe: direct(true) });
    var uri = t.TS.playUrl('Movies/Film (2020)/a b.mkv');
    var r = t.resolve(uri);
    assert.strictEqual(r.url, STREAM + encodeURIComponent('Movies/Film (2020)/a b.mkv'));
    assert.deepStrictEqual(JSON.parse(JSON.stringify(r.route)), { fallback: uri });
    assert.strictEqual(t.connects(), 1, 'the local smbproxy is readied before handing out its URL');
    assert.ok(/\/api\/probe\?path=Movies%2FFilm%20\(2020\)%2Fa%20b\.mkv&token=tok$/.test(t.requests[0]), t.requests[0]);
});

test('a file that needs transcoding still goes through the server', function () {
    var t = loadServer({ probe: direct(false) });
    var uri = t.TS.playUrl('Movies/dts.mkv');
    var r = t.resolve(uri);
    assert.strictEqual(r.url, uri);
    assert.strictEqual(r.route, null);
    assert.strictEqual(t.connects(), 0);
});

test('each file is probed once per app session', function () {
    var t = loadServer({ probe: direct(true) });
    t.resolve(t.TS.playUrl('Movies/a.mkv'));
    t.resolve(t.TS.playUrl('Movies/a.mkv'));
    t.resolve(t.TS.playUrl('Movies/b.mkv'));
    assert.strictEqual(t.requests.length, 2);
});

test('an older server without /api/probe is asked once, then left alone', function () {
    var t = loadServer({ probe: function () { return { status: 404, body: 'not found' }; } });
    var a = t.TS.playUrl('Movies/a.mkv');
    assert.strictEqual(t.resolve(a).url, a);
    assert.strictEqual(t.resolve(t.TS.playUrl('Movies/b.mkv')).url, t.TS.playUrl('Movies/b.mkv'));
    assert.strictEqual(t.requests.length, 1);
});

test('a failed probe or an unreachable share falls back to the server route', function () {
    var t = loadServer({ probe: function () { return 'network'; } });
    var uri = t.TS.playUrl('Movies/a.mkv');
    assert.strictEqual(t.resolve(uri).url, uri);

    var t2 = loadServer({ probe: function () { return { status: 502, body: 'probe failed: exit 1' }; } });
    assert.strictEqual(t2.resolve(uri).url, uri);

    var t3 = loadServer({ probe: function () { return { status: 200, body: { reason: 'no direct field' } }; } });
    assert.strictEqual(t3.resolve(uri).url, uri);

    var t4 = loadServer({ probe: direct(true), smbDown: true });
    assert.strictEqual(t4.resolve(uri).url, uri);
    assert.strictEqual(t4.resolve(uri).route, null);
});

test('a file direct play could not open goes through the server from then on, across restarts', function () {
    var t = loadServer({ probe: direct(true) });
    var uri = t.TS.playUrl('Movies/odd.mkv');
    assert.notStrictEqual(t.resolve(uri).url, uri);
    t.TS.markDirectFailed(uri);
    assert.strictEqual(t.resolve(uri).url, uri);

    // Survives in localStorage: a fresh load with the same store still knows.
    var saved = t.store.vlctv_direct_failed_v1;
    assert.deepStrictEqual(JSON.parse(saved), ['Movies/odd.mkv']);
    var t2 = loadServer({ probe: direct(true) });
    t2.store.vlctv_direct_failed_v1 = saved;
    assert.strictEqual(t2.resolve(uri).url, uri);
    assert.strictEqual(t2.requests.length, 0, 'no probe for a file already known to need the server');
    // Other files are unaffected.
    assert.notStrictEqual(t2.resolve(t2.TS.playUrl('Movies/fine.mkv')).url, t2.TS.playUrl('Movies/fine.mkv'));
});

test('URLs that are not share play URLs are not probed', function () {
    var t = loadServer({ probe: direct(true) });
    ['http://example.com/video.mp4',
     SERVER + '/play?src=' + encodeURIComponent('http://192.168.1.50:8128/local/stream?path=/x.mkv') + '&token=tok',
     STREAM + 'Movies%2Fa.mkv'
    ].forEach(function (u) {
        assert.strictEqual(t.resolve(u).url, u);
    });
    assert.strictEqual(t.requests.length, 0);
});

/* ── USB / internal storage, with "Play USB files through the server" on ── */

test('USB with smart routing off still goes through the relay, unprobed', function () {
    var t = loadServer({ smart: false, relay: true, probe: direct(true) });
    var r = t.resolve(USB);
    assert.ok(r.url.indexOf(SERVER + '/play?src=') === 0, r.url);
    assert.strictEqual(r.route, null);
    assert.strictEqual(t.requests.length, 0);
});

test('a USB file the server would only remux plays straight off the drive', function () {
    var t = loadServer({ relay: true, probe: direct(true) });
    var r = t.resolve(USB);
    assert.strictEqual(r.url, USB, 'direct is the file:// URI, as with the relay off');
    assert.ok(r.route && r.route.fallback.indexOf(SERVER + '/play?src=') === 0, 'server route kept as fallback');
    // The box is asked about the same relay URL /play would fetch.
    var q = /\/api\/probe\?src=([^&]*)&token=tok$/.exec(t.requests[0]);
    assert.ok(q, t.requests[0]);
    var src = decodeURIComponent(q[1]);
    assert.ok(src.indexOf(RELAY + '/local/stream?path=' + encodeURIComponent('/opt/usr/media/USBDriveA1/Films/My Film.mkv')) === 0, src);
    assert.ok(r.route.fallback.indexOf(encodeURIComponent(src)) > 0, 'probe and play name the same source');
    assert.strictEqual(t.connects(), 0, 'no SMB involved');
});

test('a USB file that needs transcoding goes through the relay', function () {
    var t = loadServer({ relay: true, probe: direct(false) });
    var r = t.resolve(USB);
    assert.ok(r.url.indexOf(SERVER + '/play?src=') === 0, r.url);
    assert.strictEqual(r.route, null);
});

test('a USB file that failed direct play goes through the relay from then on', function () {
    var t = loadServer({ relay: true, probe: direct(true) });
    assert.strictEqual(t.resolve(USB).url, USB);
    t.TS.markDirectFailed(USB);
    var r = t.resolve(USB);
    assert.ok(r.url.indexOf(SERVER + '/play?src=') === 0, r.url);
    assert.strictEqual(t.requests.length, 1, 'not probed again');
    assert.deepStrictEqual(JSON.parse(t.store.vlctv_direct_failed_v1), [USB]);
});

test('USB probe failure keeps the relay route; a relay that is off leaves USB direct as before', function () {
    var t = loadServer({ relay: true, probe: function () { return { status: 400, body: 'local relay is disabled' }; } });
    assert.ok(t.resolve(USB).url.indexOf(SERVER + '/play?src=') === 0);

    // Server refuses USB files: no relay, so the file plays directly, unprobed.
    var t2 = loadServer({ relay: true, serverAcceptsUsb: false, probe: direct(true) });
    var r2 = t2.resolve(USB);
    assert.strictEqual(r2.url, USB);
    assert.strictEqual(r2.route, null);
    assert.strictEqual(t2.requests.length, 0);

    // The USB setting off: smart routing has nothing to decide for USB.
    var t3 = loadServer({ relay: false, probe: direct(true) });
    assert.strictEqual(t3.resolve(USB).url, USB);
    assert.strictEqual(t3.requests.length, 0);
});
