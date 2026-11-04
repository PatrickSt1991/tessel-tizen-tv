'use strict';

/* The proxy listens on every interface (Tizen 10 pages may not reach 127.0.0.1)
 * but answers only this TV: a peer that is not loopback or one of the TV's own
 * addresses gets 403 on every route, so the share credentials and streams the
 * SMB endpoints hold never become reachable from the LAN. */

var assert = require('assert');
var test   = require('node:test');
var fs     = require('fs');
var vm     = require('vm');
var path   = require('path');
var os     = require('os');

var SRC = fs.readFileSync(path.join(__dirname, '../../tizen-app/service/service.js'), 'utf8');

function loadHandler() {
    var handler = null;
    var fakeHttp = { createServer: function (fn) { handler = fn; return { listen: function () {}, on: function () {} }; } };
    var sandbox = {
        module: { exports: {} },
        Buffer: Buffer, console: console,
        setTimeout: setTimeout, clearTimeout: clearTimeout,
        process: { on: function () {} },
        require: function (name) { return name === 'http' ? fakeHttp : require(name); }
    };
    vm.runInNewContext(SRC, sandbox);
    assert.ok(handler, 'service registered a request handler');
    return handler;
}

function ask(handler, peer, url) {
    var out = { code: 0, body: '' };
    var req = { method: 'GET', url: url || '/smb/ping', headers: {}, socket: { remoteAddress: peer }, on: function () {} };
    var res = {
        writeHead: function (code) { out.code = code; },
        end: function (b) { out.body = b || ''; }
    };
    handler(req, res);
    return out;
}

function ownLanIp() {
    var ifs = os.networkInterfaces();
    for (var n in ifs) for (var i = 0; i < ifs[n].length; i++) {
        var a = ifs[n][i];
        if ((a.family === 'IPv4' || a.family === 4) && !a.internal) return a.address;
    }
    return null;
}

test('peer guard: loopback peers are answered', function () {
    var h = loadHandler();
    assert.strictEqual(ask(h, '127.0.0.1').code, 200);
    assert.strictEqual(ask(h, '::ffff:127.0.0.1').code, 200);
    assert.strictEqual(ask(h, '::1').code, 200);
});

test('peer guard: the TV\'s own LAN address is answered (Tizen 10 page talking to http://<tv ip>:8127)', function (t) {
    var ip = ownLanIp();
    if (!ip) return t.skip('no non-internal IPv4 interface on this host');
    assert.strictEqual(ask(loadHandler(), ip).code, 200);
});

test('peer guard: another host on the LAN gets 403 on every route', function () {
    var h = loadHandler();
    ['/smb/ping', '/smb/connect', '/smb/stream?path=%2Fa.mkv', '/discover', '/dav/list', '/local/enable', '/nope'].forEach(function (route) {
        var r = ask(h, '198.51.100.7', route);
        assert.strictEqual(r.code, 403, route + ' from a foreign peer');
        assert.strictEqual(r.body, 'Forbidden');
    });
    assert.strictEqual(ask(h, '::ffff:198.51.100.7').code, 403, 'IPv4-mapped form too');
    assert.strictEqual(ask(h, '').code, 403, 'no peer address at all');
});
