'use strict';

/* Starting the background service (issue #188): a Tizen 8.0 set whose firmware
 * accepts the old launch and then answers nothing on port 8127.  The page waits
 * half a minute, tries wrt:service on a TV below Tizen 9 as well, and says in
 * the debug log what it could find out when nothing ever answers. */

var assert = require('assert');
var test   = require('node:test');
var fs     = require('fs');
var vm     = require('vm');
var path   = require('path');
var I18n   = require('./helpers/i18n.js');

var SMB_SRC = fs.readFileSync(path.join(__dirname, '../../tizen-app/js/smb.js'), 'utf8');

/* opts.answers(env): whether the service answers a ping right now.
 * opts.modules: the engine runs module scripts; opts.wrt: the wrt:service import works.
 * Time is a counter that every timer moves on, so thirty seconds take no time. */
function setup(opts) {
    opts = opts || {};
    var env = { clock: 0, lines: [], appControls: [], wrtStarted: [], scripts: 0, store: opts.store || {} };
    var listeners = {};

    function later(fn, ms) { setImmediate(function () { env.clock += (ms || 0); fn(); }); return 0; }

    function FakeXHR() {}
    FakeXHR.prototype.open = function (m, url) { this.url = url; };
    FakeXHR.prototype.setRequestHeader = function () {};
    FakeXHR.prototype.send = function () {
        var self = this;
        setImmediate(function () {
            if (/\/smb\/ping$/.test(self.url) && opts.answers && opts.answers(env)) {
                self.responseText = JSON.stringify({ ok: true });
                return self.onload && self.onload();
            }
            if (self.onerror) self.onerror(new Error('refused'));
        });
    };

    var win = {
        addEventListener: function (n, f) { listeners[n] = f; },
        removeEventListener: function (n) { delete listeners[n]; },
        dispatchEvent: function (e) { if (listeners[e.type]) listeners[e.type](); }
    };
    function Service(id) {
        this.start = function () {
            env.wrtStarted.push(id);
            return opts.wrtRejects ? Promise.reject(new Error('refused')) : Promise.resolve();
        };
    }

    var sandbox = {
        module: { exports: {} },
        Debug: { send: function (tag, msg) { env.lines.push(msg); } },
        I18n: I18n,
        FileTypes: require('../../tizen-app/js/filetypes.js'),
        UI: { toast: function () {}, focusOn: function () {} },
        Settings: { get: function () { return false; } },
        localStorage: {
            getItem: function (k) { return Object.prototype.hasOwnProperty.call(env.store, k) ? env.store[k] : null; },
            setItem: function (k, v) { env.store[k] = String(v); },
            removeItem: function (k) { delete env.store[k]; }
        },
        document: {
            readyState: 'complete',
            addEventListener: function () {},
            getElementById: function () { return null; },
            createElement: function () { return opts.modules ? { noModule: false } : {}; },
            body: {
                appendChild: function (s) {
                    env.scripts++;
                    // a microtask: the import settles before the 3 s the page gives it, which is a timer here
                    Promise.resolve().then(function () {
                        if (opts.wrt) { win.tesselService = Service; win.dispatchEvent({ type: 'tessel-wrt-service' }); }
                        else if (s.onerror) s.onerror();
                    });
                }
            }
        },
        window: win,
        Event: function (type) { this.type = type; },
        Promise: Promise,
        XMLHttpRequest: FakeXHR,
        Date: { now: function () { return env.clock; } },
        tizen: {
            application: {
                getCurrentApplication: function () { return { appInfo: { id: 'madebypatk.vlcweb' } }; },
                launch: function (id, ok) { if (ok) ok(); },
                launchAppControl: function (ctrl, id, ok) { env.appControls.push(id); if (ok) ok(); },
                getAppInfo: function (id) { return { id: id, version: '1.37.7' }; },
                getAppsContext: function (ok) { ok([{ appId: 'madebypatk.vlcweb' }]); }
            },
            ApplicationControl: function (op) { this.operation = op; },
            systeminfo: {
                getCapability: function () { return opts.platform || '8.0'; },
                getPropertyValue: function () {}
            }
        },
        setTimeout: later,
        clearTimeout: function () {}
    };
    vm.createContext(sandbox);
    vm.runInContext(SMB_SRC, sandbox);
    env.SMB = sandbox.module.exports;
    return env;
}

/* ensureService calls back from inside an XHR handler that catches what its
 * callback throws, so a failed assertion has to reach done() by hand. */
function checked(done, fn) {
    return function () {
        try { fn.apply(null, arguments); } catch (e) { return done(e); }
    };
}

test('a service that takes ten seconds to come up is waited for', function (t, done) {
    var env = setup({ answers: function (e) { return e.clock >= 10000; } });
    env.SMB.ensureService(checked(done, function (err) {
        assert.ifError(err);
        assert.ok(env.clock >= 10000 && env.clock < 12000, 'answered at ' + env.clock + ' ms');
        assert.strictEqual(env.appControls[0], 'madebypatk.smbproxy');
        done();
    }));
});

test('Tizen 8: a launch the TV accepts and then ignores is followed by wrt:service', function (t, done) {
    var env = setup({ modules: true, wrt: true, answers: function (e) { return e.wrtStarted.length > 0; } });
    env.SMB.ensureService(checked(done, function (err) {
        assert.ifError(err);
        assert.deepStrictEqual(env.appControls, ['madebypatk.smbproxy'], 'the old launch came first');
        assert.deepStrictEqual(env.wrtStarted, ['madebypatk.smbproxy'], 'then wrt:service');
        assert.ok(env.clock >= 4000 && env.clock < 8000, 'second way after ' + env.clock + ' ms');
        done();
    }));
});

test('Tizen 8: nothing is imported while the first launch brings the service up', function (t, done) {
    var env = setup({ modules: true, wrt: true, answers: function (e) { return e.clock >= 2000; } });
    env.SMB.ensureService(checked(done, function (err) {
        assert.ifError(err);
        assert.strictEqual(env.scripts, 0, 'no module script added');
        assert.strictEqual(env.wrtStarted.length, 0);
        done();
    }));
});

test('an engine without module scripts gets no wrt:service import', function (t, done) {
    var env = setup({ modules: false, platform: '4.0', answers: function (e) { return e.clock >= 6000; } });
    env.SMB.ensureService(checked(done, function (err) {
        assert.ifError(err);
        assert.strictEqual(env.scripts, 0);
        done();
    }));
});

test('a service that never answers: half a minute, a second launch, and the reason in the log', function (t, done) {
    var env = setup({ modules: true, wrt: false, answers: function () { return false; } });
    env.SMB.ensureService(checked(done, function (err) {
        assert.ok(err);
        assert.strictEqual(err.message, 'SMB service did not start');
        assert.ok(env.clock >= 30000 && env.clock < 34000, 'gave up at ' + env.clock + ' ms');
        assert.strictEqual(env.scripts, 1, 'wrt:service was tried once');
        assert.strictEqual(env.appControls.length, 2, 'the old launch went out again');
        setImmediate(checked(done, function () {
            var log = env.lines.join('\n');
            assert.ok(/wrt:service is not available on this TV/.test(log), log);
            assert.ok(/gave up after \d+ tries in 3\d s: service unreachable, launch ok/.test(log), log);
            assert.ok(/no service: platform 8\.0, tried http:\/\/127\.0\.0\.1:8127/.test(log), log);
            assert.ok(/no service: madebypatk\.smbproxy is installed \(1\.37\.7\)/.test(log), log);
            assert.ok(/no service: madebypatk\.smbproxy is not among the 1 running apps/.test(log), log);
            done();
        }));
    }));
});

/* Issue #191: the way that brought the service up is kept, so the next start does
 * not spend four seconds on the one this TV ignores. */
var WAY_KEY = 'vlctv_service_way_v1';

test('Tizen 8: the way that worked is remembered, and comes first the next time', function (t, done) {
    var first = setup({ modules: true, wrt: true, answers: function (e) { return e.wrtStarted.length > 0; } });
    first.SMB.ensureService(checked(done, function (err) {
        assert.ifError(err);
        assert.strictEqual(first.store[WAY_KEY], 'wrt');

        var next = setup({ modules: true, wrt: true, store: first.store,
                           answers: function (e) { return e.wrtStarted.length > 0; } });
        next.SMB.ensureService(checked(done, function (err2) {
            assert.ifError(err2);
            assert.deepStrictEqual(next.wrtStarted, ['madebypatk.smbproxy']);
            assert.strictEqual(next.appControls.length, 0, 'the old launch was not needed');
            // the fake clock also counts the 3 s guard on the import, so: before the 4 s switch
            assert.ok(next.clock < 4000, 'answered after ' + next.clock + ' ms');
            assert.strictEqual(next.store[WAY_KEY], 'wrt');
            done();
        }));
    }));
});

test('a TV that starts the way its Tizen version says stores nothing', function (t, done) {
    var env = setup({ modules: true, wrt: true, answers: function (e) { return e.clock >= 2000; } });
    env.SMB.ensureService(checked(done, function (err) {
        assert.ifError(err);
        assert.deepStrictEqual(Object.keys(env.store), []);
        done();
    }));
});

test('a remembered way that stops working gives way to the other one, and is forgotten', function (t, done) {
    var store = {}; store[WAY_KEY] = 'wrt';
    var env = setup({ modules: true, wrt: true, store: store,
                      answers: function (e) { return e.appControls.length > 0; } });
    env.SMB.ensureService(checked(done, function (err) {
        assert.ifError(err);
        assert.deepStrictEqual(env.wrtStarted, ['madebypatk.smbproxy'], 'the remembered way came first');
        assert.deepStrictEqual(env.appControls, ['madebypatk.smbproxy'], 'then the old launch');
        assert.ok(!(WAY_KEY in env.store), 'back to what Tizen 8 starts with');
        done();
    }));
});

test('a wrt:service start the TV refuses is not remembered', function (t, done) {
    var env = setup({ modules: true, wrt: true, wrtRejects: true, answers: function (e) { return e.clock >= 8000; } });
    env.SMB.ensureService(checked(done, function (err) {
        assert.ifError(err);
        assert.strictEqual(env.wrtStarted.length, 1);
        assert.ok(!(WAY_KEY in env.store), JSON.stringify(env.store));
        done();
    }));
});

test('a service that was already running leaves the remembered way alone', function (t, done) {
    var store = {}; store[WAY_KEY] = 'wrt';
    var env = setup({ modules: true, wrt: false, store: store, answers: function () { return true; } });
    env.SMB.ensureService(checked(done, function (err) {
        assert.ifError(err);
        assert.strictEqual(env.store[WAY_KEY], 'wrt');
        done();
    }));
});
