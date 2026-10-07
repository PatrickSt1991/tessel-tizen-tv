'use strict';

/* The unicast sweep in GET /dlna/discover: every host gets its M-SEARCH, and
 * no socket carries more of them than its send buffer holds while ARP waits. */

var assert = require('assert');
var test   = require('node:test');
var fs     = require('fs');
var vm     = require('vm');
var path   = require('path');

var SRC = fs.readFileSync(path.join(__dirname, '../../tizen-app/service/service.js'), 'utf8');

/* Same loader as dlna.test.js, with the TV's one interface, a UDP stack that
 * records what each socket is asked to send, and timers that only run when
 * the test says so. */
function loadDiscovery(netmask) {
    var sockets = [], timers = [];
    var fakeHttp = { createServer: function () { return { listen: function () {} }; } };
    var fakeOs = { networkInterfaces: function () {
        return { eth0: [{ address: '192.168.0.118', netmask: netmask, family: 'IPv4', internal: false }] };
    } };
    var fakeDgram = { createSocket: function () {
        var sock = { sent: [], bound: null, closed: false,
            on: function () { return sock; },
            bind: function (port, address, cb) { sock.bound = address || '*'; (cb || address || port)(); },
            setBroadcast: function () {},
            send: function (msg, off, len, port, addr) { sock.sent.push(addr); },
            close: function () { sock.closed = true; } };
        sockets.push(sock);
        return sock;
    } };
    var sandbox = {
        module: { exports: {} },
        Buffer: Buffer, console: { log: function () {} },
        setTimeout: function (fn, ms) { timers.push({ fn: fn, ms: ms }); },
        clearTimeout: function () {},
        process: { on: function () {} },
        require: function (name) {
            if (name === 'http')  return fakeHttp;
            if (name === 'os')    return fakeOs;
            if (name === 'dgram') return fakeDgram;
            return require(name);
        }
    };
    vm.runInNewContext(SRC + '\nmodule.exports = { handleDlnaDiscover: handleDlnaDiscover, ' +
                       'DLNA_SWEEP_CHUNK: DLNA_SWEEP_CHUNK };', sandbox);
    return { svc: sandbox.module.exports, sockets: sockets, timers: timers };
}

function fakeRes() {
    var res = { status: 0, body: '',
        writeHead: function (code) { res.status = code; }, setHeader: function () {},
        end: function (b) { res.body = String(b || ''); } };
    return res;
}

function unicast(addr) { return /^192\.168\./.test(addr) && !/\.255$/.test(addr); }

test('a /24 sweep reaches every host, at most one chunk per socket per round', function () {
    var d = loadDiscovery('255.255.255.0');
    d.svc.handleDlnaDiscover({}, fakeRes());

    var reached = {}, perSocket = d.sockets.map(function (s) {
        var mine = s.sent.filter(unicast);
        mine.forEach(function (a) { reached[a] = (reached[a] || 0) + 1; });
        return mine.length;
    });
    assert.strictEqual(Object.keys(reached).length, 253, 'every host but the TV itself');
    assert.ok(Object.keys(reached).every(function (a) { return reached[a] === 1; }), 'once each per round');
    assert.ok(Math.max.apply(null, perSocket) <= d.svc.DLNA_SWEEP_CHUNK,
              'no socket sweeps more than ' + d.svc.DLNA_SWEEP_CHUNK + ': ' + perSocket.join(','));
    assert.ok(!reached['192.168.0.118'], 'not the TV');
});

test('the group and broadcast searches do not wait behind the sweep', function () {
    var d = loadDiscovery('255.255.255.0');
    d.svc.handleDlnaDiscover({}, fakeRes());
    d.sockets.forEach(function (s) {
        var mixed = s.sent.some(unicast) && s.sent.some(function (a) { return !unicast(a); });
        assert.ok(!mixed, 'a socket sends either the sweep or the group/broadcast, not both: ' + s.bound);
    });
    var group = d.sockets.filter(function (s) { return s.sent.indexOf('239.255.255.250') >= 0; });
    assert.strictEqual(group.length, 2, 'the unbound socket and the interface socket');
});

test('the repeat round re-sweeps, and the window closes every socket', function () {
    var d = loadDiscovery('255.255.255.0');
    var res = fakeRes();
    d.svc.handleDlnaDiscover({}, res);
    var before = d.sockets.reduce(function (n, s) { return n + s.sent.filter(unicast).length; }, 0);
    d.timers.filter(function (t) { return t.ms === 800; }).forEach(function (t) { t.fn(); });
    var after = d.sockets.reduce(function (n, s) { return n + s.sent.filter(unicast).length; }, 0);
    assert.strictEqual(after, before * 2);

    d.timers.filter(function (t) { return t.ms !== 800; }).forEach(function (t) { t.fn(); });
    assert.ok(d.sockets.every(function (s) { return s.closed; }));
    assert.deepStrictEqual(JSON.parse(res.body), { ok: true, servers: [] });
});

test('a subnet too large to sweep still searches the group and broadcast', function () {
    var d = loadDiscovery('255.255.0.0');
    d.svc.handleDlnaDiscover({}, fakeRes());
    assert.strictEqual(d.sockets.length, 2);
    assert.ok(d.sockets.every(function (s) { return !s.sent.some(function (a) { return /^192\.168\.\d+\.\d+$/.test(a) && !/255/.test(a); }); }));
});
