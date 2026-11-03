/* The bundled service (scripts/bundle-service.js) starts and answers across all ways
 * the Tizen platform may load it:
 *   direct  - node <bundle> (direct invocation)
 *   module  - require()d by a host that calls s.onStart(), as legacy Tizen 4-8 does
 *   vm      - the Tizen 10 wrt-node wrapper (vm.runInThisContext, no __dirname, no module)
 *   wrt     - Tizen 9/10 with wrt:service Service class present
 */
'use strict';

var test   = require('node:test');
var assert = require('assert');
var fs     = require('fs');
var os     = require('os');
var path   = require('path');
var http   = require('http');
var cp     = require('child_process');

var root = path.join(os.tmpdir(), 'tessel-bundle-test-' + process.pid + '-' + Date.now());
var svcDir = path.join(root, 'service'), cwd = path.join(root, 'elsewhere');
[root, svcDir, cwd].forEach(function (d) { try { fs.mkdirSync(d, { recursive: true }); } catch (e) {} });
var bundle = path.join(svcDir, 'index.js');
cp.execFileSync(process.execPath, [path.join(__dirname, '../../scripts/bundle-service.js'), bundle], { cwd: path.join(__dirname, '../..') });

function getPing(cb) {
    var req = http.get({ host: '127.0.0.1', port: 8127, path: '/smb/ping' }, function (res) {
        var b = '';
        res.on('data', function (d) { b += d; });
        res.on('end', function () { cb(null, res.statusCode, b, res.headers); });
    });
    req.on('error', function (e) { cb(e); });
}

function testHost(hostScript, cb) {
    var args;
    if (hostScript) {
        var h = path.join(root, 'host-' + Math.random().toString(36).slice(2, 8) + '.js');
        fs.writeFileSync(h, hostScript);
        args = [h, bundle];
    } else {
        args = [bundle];
    }

    var child = cp.spawn(process.execPath, args, { cwd: cwd, stdio: ['ignore', 'ignore', 'pipe'] });
    var stderr = '';
    child.stderr.on('data', function (d) { stderr += d; });

    var tries = 0;
    (function poll() {
        getPing(function (err, code, body, headers) {
            if (err || code !== 200) {
                if (++tries > 60 || child.exitCode !== null) {
                    child.kill();
                    return cb(new Error('no /smb/ping: ' + (err ? err.message : code) + (stderr ? '\n' + stderr : '')));
                }
                return setTimeout(poll, 100);
            }
            var parsed = null;
            try { parsed = JSON.parse(body); } catch (e) {}
            assert.ok(parsed && parsed.ok, 'expected { ok: true }');
            assert.strictEqual(headers['access-control-allow-origin'], '*', 'CORS allow origin');
            assert.strictEqual(headers['access-control-allow-private-network'], 'true', 'CORS PNA');
            child.on('exit', function () { cb(null); });
            child.kill();
        });
    })();
}

test('bundle: direct execution (node <bundle>) starts HTTP proxy on 8127', function (t, done) {
    testHost(null, function (err) {
        assert.ifError(err);
        done();
    });
});

test('bundle: legacy Tizen 4-8 module host with onStart() starts HTTP proxy on 8127', function (t, done) {
    var host = "var s = require(process.argv[2]); if (typeof s.onStart !== 'function' || typeof s.onRequest !== 'function') { console.error('no lifecycle hooks'); process.exit(5); } s.onStart();";
    testHost(host, function (err) {
        assert.ifError(err);
        done();
    });
});

test('bundle: Tizen 10 vm wrapper (vm.runInThisContext) starts HTTP proxy on 8127', function (t, done) {
    var host = "var fs = require('fs'); var script = fs.readFileSync(process.argv[2], 'utf8'); global.require = require('module').createRequire ? require('module').createRequire(process.cwd() + '/') : require; require('vm').runInThisContext(script);";
    testHost(host, function (err) {
        assert.ifError(err);
        done();
    });
});

test('bundle: Tizen 9/10 wrt:service Service class starts HTTP proxy on 8127', function (t, done) {
    var host = "var EventEmitter = require('events').EventEmitter; var mockWrt = { Service: function () { var self = this; EventEmitter.call(this); this.onStart = function (fn) { setTimeout(fn, 10); }; this.onRequest = function () {}; } }; require('util').inherits(mockWrt.Service, EventEmitter); var Module = require('module'); var origReq = Module.prototype.require; Module.prototype.require = function (id) { if (id === 'wrt:service') return mockWrt; return origReq.apply(this, arguments); }; var s = require(process.argv[2]);";
    testHost(host, function (err) {
        assert.ifError(err);
        done();
    });
});

