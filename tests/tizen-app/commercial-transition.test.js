'use strict';
var assert = require('assert');
var test = require('node:test');
var fs = require('fs');
var vm = require('vm');
var path = require('path');
var source = fs.readFileSync(path.join(__dirname, '../../tizen-app/js/player.js'), 'utf8');

function setup(unsupported) {
    var calls = [];
    function decoder(name) {
        return {
            close: function () { calls.push(name + ':close'); },
            stop: function () { calls.push(name + ':stop'); },
            pause: function () { calls.push(name + ':pause'); },
            play: function () { calls.push(name + ':play'); },
            open: function () { calls.push(name + ':open'); },
            getState: function () { return 'PLAYING'; },
            setVideoStillMode: function (v) { calls.push(name + ':still:' + v); },
            setDisplayRect: function () {},
            setDisplayMethod: function () {},
            setStreamingProperty: function (k) { calls.push(name + ':' + k); },
            setListener: function (cb) { this.events = cb; },
            prepareAsync: function (ok, bad) { this.ready = ok; this.failed = bad; }
        };
    }
    var first = decoder('first'), second = decoder('second'), allocations = 0;
    var box = {
        webapis: { avplay: first, avplaystore: { getPlayer: function () {
            allocations++;
            if (unsupported) throw new Error('not supported');
            return second;
        } } },
        window: { innerWidth: 1920, innerHeight: 1080 },
        document: { getElementById: function () { return null; } },
        setInterval: function () { return 1; }, clearInterval: function () {},
        setTimeout: function () {}, clearTimeout: function () {}
    };
    var instrumented = source.replace('    return {\n        setListener:',
        "    return {\n        hold: holdTransitionFrame, release: releaseTransitionFrame, avOpen: avOpen, useAV: function () { backend = BACKEND_AVPLAY; }, useHTML5: function () { backend = BACKEND_HTML5; },\n        setListener:");
    vm.runInNewContext(instrumented, box);
    box.Player.useAV();
    return { player: box.Player, first: first, second: second, calls: calls,
        box: box, allocations: function () { return allocations; } };
}

test('hold the previous decoder until the new video advances, then reuse it', function () {
    var env = setup();
    env.player.avOpen('https://example.com/first.mp4');
    env.first.ready();
    env.calls.length = 0;
    env.player.hold();
    env.player.avOpen('https://example.com/next.mp4');
    assert.ok(env.calls.includes('first:still:true'));
    assert.ok(env.calls.includes('second:PREBUFFER_MODE'));
    assert.ok(!env.calls.includes('first:close'));
    env.second.ready();
    env.second.events.oncurrentplaytime(0);
    assert.ok(!env.calls.includes('first:close'));
    env.second.events.oncurrentplaytime(100);
    assert.ok(env.calls.includes('first:stop'));
    assert.ok(env.calls.includes('first:close'));
    env.player.hold();
    assert.strictEqual(env.allocations(), 1);
});

test('old decoder events and canceled preparations cannot affect the next open', function () {
    var env = setup(), events = [];
    env.player.setListener('oncomplete', function () { events.push('complete'); });
    env.player.avOpen('https://example.com/first.mp4');
    var staleReady = env.first.ready;
    env.player.hold();
    env.player.avOpen('https://example.com/next.mp4');
    env.first.events.onstreamcompleted();
    staleReady();
    assert.deepStrictEqual(events, []);
    assert.ok(!env.calls.includes('first:play'));
    assert.ok(!env.calls.includes('second:play'));
    env.player.stop();
    env.second.ready();
    assert.ok(!env.calls.includes('second:play'));
    assert.ok(env.calls.includes('first:close'));
});

test('a preparation error releases the held frame and still reports the error', function () {
    var env = setup(), errors = [];
    env.player.avOpen('https://example.com/first.mp4');
    env.player.hold();
    env.player.setListener('onerror', function (msg) { errors.push(msg); });
    env.player.avOpen('https://example.com/next.mp4');
    env.second.failed({ message: 'bad file' });
    assert.ok(env.calls.includes('first:close'));
    assert.strictEqual(errors.length, 1);
});

test('TVs without parallel players continue opening normally', function () {
    var env = setup(true);
    env.player.avOpen('https://example.com/first.mp4');
    assert.doesNotThrow(function () { env.player.hold(); });
    env.player.avOpen('https://example.com/next.mp4');
    env.first.ready();
    assert.ok(env.calls.includes('first:play'));
});

test('Commercial mode hides opening and buffering text for video, while audio and normal playback retain it', function () {
    var app = fs.readFileSync(path.join(__dirname, '../../tizen-app/js/app.js'), 'utf8');
    var spinner = app.slice(app.indexOf('    function showSpinner(msg)'), app.indexOf('    /* kind \'codec\''));
    [true, false].forEach(function (mode) {
        [true, false].forEach(function (audio) {
            var hidden = true;
            var box = {
                state: { view: 'player', playingIsAudio: audio },
                Settings: { get: function () { return mode; } },
                I18n: { t: function (k) { return k; } },
                document: { getElementById: function () { return {
                    querySelector: function () { return {}; },
                    classList: { add: function () { hidden = true; }, remove: function () { hidden = false; } }
                }; } }
            };
            vm.runInNewContext(spinner, box);
            box.showSpinner('Abriendo');
            assert.strictEqual(hidden, mode && !audio);
        });
    });
});


test('HTML5 fallback holds a canvas frame until the replacement video advances', function () {
    var env = setup(), snapshot = null, drawn = false, paused = false;
    var video = { videoWidth: 1280, videoHeight: 720, style: { objectFit: 'cover' },
        pause: function () { paused = true; } };
    env.box.document = {
        getElementById: function (id) { return id === 'html5-video' ? video : null; },
        createElement: function () { return { style: {}, getContext: function () {
            return { drawImage: function (v) { assert.strictEqual(v, video); drawn = true; } };
        } }; },
        body: {
            insertBefore: function (canvas) { snapshot = canvas; canvas.parentNode = this; },
            removeChild: function () { snapshot = null; }
        }
    };
    env.player.useHTML5();
    env.player.hold();
    assert.ok(drawn && paused);
    assert.strictEqual(snapshot.width, 1280);
    assert.strictEqual(snapshot.style.objectFit, 'cover');
    env.player.useAV();
    env.player.avOpen('https://example.com/next.mp4');
    env.first.ready();
    assert.ok(snapshot);
    env.first.events.oncurrentplaytime(100);
    assert.strictEqual(snapshot, null);
});
