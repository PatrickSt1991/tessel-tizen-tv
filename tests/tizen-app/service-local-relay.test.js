'use strict';

/* The LAN listener that serves TV-local files to the transcode server: armed
 * over loopback, then answers only a request with the key and a path under one
 * of the armed roots, and says why when it refuses. */

var assert = require('assert');
var test   = require('node:test');
var fs     = require('fs');
var vm     = require('vm');
var path   = require('path');
var os     = require('os');

var SRC = fs.readFileSync(path.join(__dirname, '../../tizen-app/service/service.js'), 'utf8');
var KEY = '0123456789abcdef0123456789abcdef';

function load() {
    var handlers = [];
    var fakeHttp = { createServer: function (fn) {
        handlers.push(fn);
        return { listen: function (p, h, cb) { if (typeof cb === 'function') cb(); }, on: function () {}, close: function () {} };
    } };
    var sandbox = {
        module: { exports: {} },
        Buffer: Buffer, console: { log: function () {} },
        setTimeout: setTimeout, clearTimeout: clearTimeout,
        process: { on: function () {} },
        require: function (name) { return name === 'http' ? fakeHttp : require(name); }
    };
    vm.runInNewContext(SRC, sandbox);
    return handlers;
}

function call(handler, method, url, body) {
    var out = { code: 0, body: '' };
    var listeners = {};
    var req = { method: method, url: url, headers: {}, socket: { remoteAddress: '127.0.0.1' },
                on: function (ev, fn) { listeners[ev] = fn; } };
    var res = { writeHead: function (code) { out.code = code; }, end: function (b) { out.body = String(b || ''); } };
    handler(req, res);
    if (body !== undefined) { listeners.data(JSON.stringify(body)); listeners.end(); }
    return out;
}

function arm(handlers, roots) {
    var r = call(handlers[0], 'POST', '/local/enable', { key: KEY, roots: roots });
    assert.strictEqual(r.code, 200, r.body);
    return handlers[handlers.length - 1];   // the LAN listener it just opened
}

function stream(lan, p, key) {
    return call(lan, 'HEAD', '/local/stream?path=' + encodeURIComponent(p) + '&key=' + (key || KEY));
}

function logs(handlers) {
    return JSON.parse(call(handlers[0], 'GET', '/smb/debug/logs').body).logs.join('\n');
}

test('a file under an armed root is served; key, root and traversal are each enforced', function () {
    var dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-'));
    var root = dir.replace(/\\/g, '/');
    if (root.charAt(0) !== '/') return;   // the service only deals in POSIX paths
    fs.writeFileSync(path.join(dir, 'a b.mkv'), 'x');
    var h = load();
    var lan = arm(h, ['file://' + root + '/', 'removable_sda1']);

    assert.strictEqual(stream(lan, root + '/a b.mkv').code, 200);
    assert.strictEqual(stream(lan, root + '/a b.mkv', 'wrong-key-wrong-key-wrong-key-00').code, 403);
    assert.strictEqual(stream(lan, root + '/../etc/passwd').code, 403);
    assert.strictEqual(stream(lan, '/etc/passwd').code, 403);
    var missing = stream(lan, root + '/gone.mkv');
    assert.strictEqual(missing.code, 404);
    assert.ok(/ENOENT/.test(missing.body), missing.body);
});

test('a refusal is written to the service log with the path and the roots it was checked against', function () {
    var h = load();
    var lan = arm(h, ['/opt/usr/home/owner/media/Videos']);
    assert.strictEqual(stream(lan, '/opt/media/USBDriveA1/file.mkv').code, 403);
    var l = logs(h);
    assert.ok(/LOCAL_REJECT/.test(l) && /USBDriveA1\/file\.mkv/.test(l) && /media\/Videos/.test(l), l);
    stream(lan, '/opt/media/USBDriveA1/file.mkv', 'wrong-key-wrong-key-wrong-key-00');
    assert.ok(/LOCAL_BAD_KEY/.test(logs(h)));
});

test('only real paths are armed: a virtual root name is dropped, and none at all is an error', function () {
    var h = load();
    var r = call(h[0], 'POST', '/local/enable', { key: KEY, roots: ['removable_sda1', 'videos'] });
    assert.strictEqual(r.code, 400);
    assert.ok(/no usable roots/.test(r.body), r.body);
});
