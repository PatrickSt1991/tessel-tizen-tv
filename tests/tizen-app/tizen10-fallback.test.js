'use strict';

var assert = require('assert');
var test   = require('node:test');
var fs     = require('fs');
var vm     = require('vm');
var path   = require('path');
var I18n   = require('./helpers/i18n.js');

var JS_DIR = path.join(__dirname, '../../tizen-app/js/');
var SMB_SRC = fs.readFileSync(path.join(JS_DIR, 'smb.js'), 'utf8');

function setupTestEnv(opts) {
    opts = opts || {};
    var store = {};
    var sent = [];
    var launched = [];
    var appControls = [];
    var wrtStarted = [];

    function FakeXHR() {
        this.timeout = 0;
        this.headers = {};
    }
    FakeXHR.prototype.open = function (method, url) { this.url = url; };
    FakeXHR.prototype.setRequestHeader = function (k, v) { this.headers[k] = v; };
    FakeXHR.prototype.send = function (body) {
        var self = this;
        var u = this.url;
        sent.push(u);
        // If simulated loopback refusal
        if (opts.blockLoopback && (u.indexOf('127.0.0.1') >= 0 || u.indexOf('localhost') >= 0)) {
            setTimeout(function () {
                if (self.onerror) self.onerror(new Error('net::ERR_CONNECTION_REFUSED'));
            }, 5);
            return;
        }
        if (/\/smb\/ping$/.test(u)) {
            setTimeout(function () {
                self.status = 200;
                self.responseText = JSON.stringify({ ok: true, connected: false, servers: [], dav: [] });
                if (self.onload) self.onload();
            }, 5);
            return;
        }
        if (/\/smb\/connect$/.test(u)) {
            setTimeout(function () {
                self.status = 200;
                self.responseText = JSON.stringify({ ok: true, dialect: 0x311, signing: false });
                if (self.onload) self.onload();
            }, 5);
            return;
        }
        setTimeout(function () {
            self.status = 404;
            self.responseText = 'not found';
            if (self.onload) self.onload();
        }, 5);
    };

    var sandbox = {
        module: { exports: {} },
        Debug: { send: function () {} },
        I18n: I18n,
        FileTypes: require('../../tizen-app/js/filetypes.js'),
        UI: { toast: function () {}, focusOn: function () {} },
        Settings: { get: function () { return false; } },
        localStorage: {
            getItem: function (k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
            setItem: function (k, v) { store[k] = String(v); },
            removeItem: function (k) { delete store[k]; }
        },
        document: {
            readyState: 'complete',
            addEventListener: function () {},
            getElementById: function () { return null; }
        },
        window: opts.wrtService ? {
            tesselService: function (id) {
                this.id = id;
                this.start = function () {
                    wrtStarted.push(id);
                    return Promise.resolve();
                };
            }
        } : {},
        Promise: Promise,
        XMLHttpRequest: FakeXHR,
        webapis: {
            network: {
                getIp: function () {
                    if (typeof opts.webapisIp === 'function') return opts.webapisIp();
                    if (opts.webapisIp !== undefined) return opts.webapisIp;
                    return '192.168.1.19';
                }
            }
        },
        tizen: {
            application: {
                getCurrentApplication: function () {
                    return { appInfo: { id: 'madebypatk.vlcweb' } };
                },
                launch: function (id, ok) { launched.push(id); if (ok) ok(); },
                launchAppControl: function (ctrl, id, ok) {
                    appControls.push({ ctrl: ctrl, id: id });
                    if (opts.failLaunchAppControl) throw new Error('app control not supported');
                    if (ok) ok();
                }
            },
            ApplicationControl: function (op) { this.operation = op; },
            systeminfo: {
                getPropertyValue: function (prop, ok) {
                    if (prop === 'NETWORK' || prop === 'ETHERNET_NETWORK') {
                        var ip = (opts.systeminfoIp !== undefined) ? opts.systeminfoIp : '192.168.1.19';
                        if (ip) ok({ ipAddress: ip });
                    }
                }
            }
        },
        setTimeout: setTimeout,
        clearTimeout: clearTimeout
    };

    vm.createContext(sandbox);
    vm.runInContext(SMB_SRC, sandbox);
    return {
        SMB: sandbox.module.exports,
        sent: sent,
        launched: launched,
        appControls: appControls,
        wrtStarted: wrtStarted
    };
}

test('Tizen 10: ensureService falls back from loopback to TV LAN IP when loopback is blocked', function (t, done) {
    var env = setupTestEnv({ blockLoopback: true, webapisIp: '192.168.1.19' });
    var smb = env.SMB;

    assert.strictEqual(smb.getBase(), 'http://127.0.0.1:8127', 'starts with loopback base URL');

    smb.ensureService(function (err) {
        assert.ifError(err);
        var base = smb.getBase();
        assert.strictEqual(base, 'http://192.168.1.19:8127', 'locked in TV LAN IP base URL');

        var url = smb.streamUrl('/movies/test.mkv');
        assert.strictEqual(url, 'http://192.168.1.19:8127/smb/stream?path=%2Fmovies%2Ftest.mkv', 'streamUrl uses locked LAN IP');
        assert.strictEqual(smb.isStreamUrl(url), true, 'recognises stream URL on LAN IP');
        assert.strictEqual(smb.isStreamUrl('http://127.0.0.1:8127/smb/stream?path=a.mkv'), true, 'still recognises legacy loopback stream URL');

        assert.strictEqual(env.appControls.length, 1, 'called launchAppControl for service');
        assert.strictEqual(env.appControls[0].id, 'madebypatk.smbproxy');
        done();
    });
});

test('Tizen 10: ensureService uses wrt:service Service class when window.tesselService is present', function (t, done) {
    var env = setupTestEnv({ wrtService: true, blockLoopback: false });
    var smb = env.SMB;

    smb.ensureService(function (err) {
        assert.ifError(err);
        assert.strictEqual(env.wrtStarted.length, 1, 'started service via wrt:service');
        assert.strictEqual(env.wrtStarted[0], 'madebypatk.smbproxy', 'correct service id passed to Service constructor');
        assert.strictEqual(env.appControls.length, 0, 'did not call legacy launchAppControl');
        done();
    });
});

test('Tizen 10: ensureService discovers LAN IP dynamically on tick 2 or 3 without hardcoded IP', function (t, done) {
    var callCount = 0;
    var env = setupTestEnv({
        blockLoopback: true,
        systeminfoIp: null,
        webapisIp: function () {
            callCount++;
            return callCount >= 2 ? '192.168.1.77' : null;
        }
    });
    var smb = env.SMB;

    smb.ensureService(function (err) {
        assert.ifError(err);
        assert.strictEqual(smb.getBase(), 'http://192.168.1.77:8127', 'picked up dynamically resolved IP on subsequent tick');
        done();
    });
});

test('scripts/bundle-service.js produces a clean single-file bundle for service/service.js', function () {
    var execFileSync = require('child_process').execFileSync;
    var outPath = path.join(require('os').tmpdir(), 'tessel-bundle-check-' + process.pid + '.js');
    execFileSync(process.execPath, [path.join(__dirname, '../../scripts/bundle-service.js'), outPath], { cwd: path.join(__dirname, '../..') });

    var content = fs.readFileSync(outPath, 'utf8');
    fs.unlinkSync(outPath);

    assert.ok(content.includes('Tessel service, bundled by scripts/bundle-service.js'), 'bundle banner present');
    assert.ok(content.includes('0.0.0.0'), 'service binds to 0.0.0.0');
    assert.ok(content.includes('Access-Control-Allow-Private-Network'), 'CORS private network header present');

    // Verify bundle runs in a sandbox where native nodeRequire rejects any relative path
    var loadedCoreMods = [];
    var fakeNodeRequire = function (id) {
        if (typeof id === 'string' && (id.slice(0, 2) === './' || id.slice(0, 3) === '../')) {
            throw new Error('Relative require escaped the bundle: ' + id);
        }
        loadedCoreMods.push(id);
        if (id === 'http') {
            return {
                createServer: function () {
                    return {
                        listen: function () {},
                        on: function () {},
                        close: function () {}
                    };
                }
            };
        }
        return require(id);
    };

    var sandbox = {
        require: fakeNodeRequire,
        module: { exports: {} },
        Buffer: Buffer,
        console: console,
        setTimeout: setTimeout,
        clearTimeout: clearTimeout,
        process: { on: function () {}, env: {}, pid: 'test' }
    };
    vm.createContext(sandbox);
    // Should run completely without attempting to require any local file from the disk
    vm.runInContext(content, sandbox);
    assert.ok(loadedCoreMods.includes('http'), 'loaded core http module');
    assert.ok(loadedCoreMods.includes('crypto'), 'loaded core crypto module');
});
