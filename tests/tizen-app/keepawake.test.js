'use strict';

var assert = require('assert');
var test   = require('node:test');
var fs     = require('fs');
var vm     = require('vm');
var path   = require('path');

/* KeepAwake talks to three TV APIs; each test gets fakes that record what
 * was asked of them, so the module is loaded afresh into a sandbox. */
function load(opts) {
    opts = opts || {};
    var calls = [], logs = [];
    var av = {
        open:        function (p) { calls.push('open ' + p); },
        setListener: function (l) { av.listener = l; calls.push('setListener'); },
        prepareAsync: function (ok, bad) {
            calls.push('prepareAsync');
            if (opts.prepareFails) bad(new Error('nope')); else ok();
        },
        prepare:     function () { calls.push('prepare'); },
        play:        function () { calls.push('play'); },
        stop:        function () { calls.push('stop'); },
        close:       function () { calls.push('close'); }
    };
    if (opts.noPrepareAsync) delete av.prepareAsync;
    var ac = {
        AppCommonScreenSaverState: { SCREEN_SAVER_ON: 'ON', SCREEN_SAVER_OFF: 'OFF' },
        setScreenSaver: function (state, ok) { calls.push('screensaver ' + state); ok(); }
    };
    var sandbox = {
        webapis:  opts.noAvplay ? { appcommon: ac } : { avplay: av, appcommon: ac },
        Debug:    { info: function (m) { logs.push(m); } },
        location: { href: 'file:///opt/usr/apps/madebypatk.vlcweb/res/wgt/index.html' },
        Player:   opts.player || { getBackend: function () { return 'none'; }, state: function () { return 'NONE'; } },
        module:   { exports: {} }
    };
    if (opts.power) {
        sandbox.tizen = { power: {
            request: function (r, s) { calls.push('power.request ' + r + ' ' + s); },
            release: function (r)    { calls.push('power.release ' + r); }
        } };
    }
    vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../../tizen-app/js/keepawake.js'), 'utf8'), sandbox);
    return { K: sandbox.KeepAwake, calls: calls, logs: logs, av: av };
}

test('the clip\'s path is next to index.html, as a plain path for AVPlay', function () {
    var t = load();
    assert.strictEqual(t.K.videoPath('file:///opt/usr/apps/madebypatk.vlcweb/res/wgt/index.html'),
                       '/opt/usr/apps/madebypatk.vlcweb/res/wgt/assets/keepawake.mp4');
    assert.strictEqual(t.K.videoPath('file:///opt/usr/apps/x/res/wgt/index.html?x=1#y'),
                       '/opt/usr/apps/x/res/wgt/assets/keepawake.mp4');
    // A percent-encoded folder comes out decoded, like Player.avplayUrl does.
    assert.strictEqual(t.K.videoPath('file:///opt/my%20apps/index.html'), '/opt/my apps/assets/keepawake.mp4');
    // Served over http (the emulator's inspector): the URL is kept as is.
    assert.strictEqual(t.K.videoPath('http://localhost:9000/index.html'), 'http://localhost:9000/assets/keepawake.mp4');
});

test('a hold turns the screensaver off and plays the hidden clip; release undoes both', function () {
    var t = load();
    t.K.hold('slideshow');
    assert.ok(t.K.isHeld());
    assert.deepStrictEqual(t.calls, ['screensaver OFF', 'close',
                                     'open /opt/usr/apps/madebypatk.vlcweb/res/wgt/assets/keepawake.mp4',
                                     'setListener', 'prepareAsync', 'play']);
    // The TV without the Power API is noted, not treated as a failure.
    assert.ok(t.logs.some(function (m) { return /no Power API/.test(m); }), t.logs.join('\n'));
    assert.ok(t.logs.some(function (m) { return /clip playing/.test(m); }), t.logs.join('\n'));

    t.calls.length = 0;
    t.K.release();
    assert.ok(!t.K.isHeld());
    assert.deepStrictEqual(t.calls, ['stop', 'close', 'screensaver ON']);
});

test('holding again with every picture re-asserts the switch but leaves the clip playing', function () {
    var t = load({ power: true });
    t.K.hold('slideshow');
    var afterFirst = t.calls.length;
    t.K.hold('slideshow');
    t.K.hold('slideshow');
    var again = t.calls.slice(afterFirst);
    assert.deepStrictEqual(again, ['power.request SCREEN SCREEN_NORMAL', 'screensaver OFF',
                                   'power.request SCREEN SCREEN_NORMAL', 'screensaver OFF']);
    // Only the first hold wrote to the log; the repeats are silent.
    assert.strictEqual(t.logs.filter(function (m) { return /screensaver off/.test(m); }).length, 1);
    t.K.release();
    assert.ok(t.calls.indexOf('power.release SCREEN') > afterFirst);
});

test('the clip starts over when it runs out, and stops being restarted after release', function () {
    var t = load();
    t.K.hold('slideshow');
    t.calls.length = 0;
    t.av.listener.onstreamcompleted();
    assert.deepStrictEqual(t.calls, ['stop', 'prepare', 'play']);
    t.K.release();
    t.calls.length = 0;
    t.av.listener.onstreamcompleted();
    assert.deepStrictEqual(t.calls, []);
});

test('a clip that will not play is logged once and not retried until the next hold', function () {
    var t = load({ prepareFails: true });
    t.K.hold('slideshow');
    t.K.hold('slideshow');
    assert.strictEqual(t.calls.filter(function (c) { return c === 'prepareAsync'; }).length, 1);
    assert.ok(t.logs.some(function (m) { return /prepareAsync failed: nope/.test(m); }), t.logs.join('\n'));
    // The screensaver switch is still asked each time; it is what's left.
    assert.strictEqual(t.calls.filter(function (c) { return c === 'screensaver OFF'; }).length, 2);
    t.K.release();
    t.K.hold('slideshow');
    assert.strictEqual(t.calls.filter(function (c) { return c === 'prepareAsync'; }).length, 2);
});

test('the player\'s own AVPlay session is left alone', function () {
    var t = load({ player: { getBackend: function () { return 'avplay'; }, state: function () { return 'PLAYING'; } } });
    t.K.hold('slideshow');
    assert.deepStrictEqual(t.calls, ['screensaver OFF']);
    assert.ok(t.logs.some(function (m) { return /player has AVPlay \(PLAYING\)/.test(m); }), t.logs.join('\n'));
    t.K.release();
    assert.deepStrictEqual(t.calls, ['screensaver OFF', 'screensaver ON']);
});

test('firmware without prepareAsync, or without AVPlay at all, still gets the screensaver switch', function () {
    var t = load({ noPrepareAsync: true });
    t.K.hold('slideshow');
    assert.ok(t.calls.indexOf('prepare') >= 0 && t.calls.indexOf('play') >= 0);

    var u = load({ noAvplay: true });
    u.K.hold('slideshow');
    assert.deepStrictEqual(u.calls, ['screensaver OFF']);
    assert.ok(u.logs.some(function (m) { return /no AVPlay/.test(m); }));
    u.K.release();
    assert.deepStrictEqual(u.calls, ['screensaver OFF', 'screensaver ON']);
});

test('the clip shipped with the app is a small H.264 MP4', function () {
    var clip = fs.readFileSync(path.join(__dirname, '../../tizen-app/assets/keepawake.mp4'));
    assert.ok(clip.length > 1000 && clip.length < 100 * 1024, 'size ' + clip.length);
    assert.strictEqual(clip.slice(4, 8).toString('latin1'), 'ftyp');
    assert.ok(clip.indexOf(Buffer.from('avc1', 'latin1')) > 0, 'no avc1 sample entry');
});
