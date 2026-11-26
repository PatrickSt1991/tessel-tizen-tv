'use strict';

/* Tessel Lite (issue #192): the URL-only player for 2015 to 2017 sets. */

var assert = require('assert');
var test   = require('node:test');
var Core   = require('../../tizen-lite/js/core.js');

function storage(initial) {
    var store = initial || {};
    return {
        store: store,
        getItem: function (k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
        setItem: function (k, v) { store[k] = String(v); }
    };
}

test('an address typed without http:// gets it', function () {
    assert.strictEqual(Core.normalizeUrl('example.com/live.m3u8'), 'http://example.com/live.m3u8');
    assert.strictEqual(Core.normalizeUrl('  192.168.1.10:8080/a.mp4 '), 'http://192.168.1.10:8080/a.mp4');
});

test('an address with a scheme is left as typed', function () {
    assert.strictEqual(Core.normalizeUrl('https://example.com/a.mpd?x=1'), 'https://example.com/a.mpd?x=1');
    assert.strictEqual(Core.normalizeUrl('rtsp://cam.local/stream'), 'rtsp://cam.local/stream');
});

test('what is not an address comes back empty', function () {
    ['', '   ', null, undefined, 'two words', 'http://', 'http:///path', 'https://?q'].forEach(function (bad) {
        assert.strictEqual(Core.normalizeUrl(bad), '', JSON.stringify(bad));
    });
});

test('played addresses are kept newest first, each once, twenty at most', function () {
    var s = storage();
    Core.addRecent(s, 'http://a/1');
    Core.addRecent(s, 'http://a/2');
    assert.deepStrictEqual(Core.addRecent(s, 'http://a/1'), ['http://a/1', 'http://a/2']);
    for (var i = 0; i < 30; i++) Core.addRecent(s, 'http://b/' + i);
    var list = Core.readRecent(s);
    assert.strictEqual(list.length, Core.RECENT_MAX);
    assert.strictEqual(list[0], 'http://b/29');
});

test('an address can be taken off the list', function () {
    var s = storage();
    Core.addRecent(s, 'http://a/1');
    Core.addRecent(s, 'http://a/2');
    assert.deepStrictEqual(Core.removeRecent(s, 'http://a/2'), ['http://a/1']);
    assert.deepStrictEqual(Core.readRecent(s), ['http://a/1']);
});

test('a damaged list reads as empty instead of stopping the app', function () {
    var bad = {}; bad[Core.RECENT_KEY] = '{not json';
    assert.deepStrictEqual(Core.readRecent(storage(bad)), []);
    bad[Core.RECENT_KEY] = '{"a":1}';
    assert.deepStrictEqual(Core.readRecent(storage(bad)), []);
    bad[Core.RECENT_KEY] = '["http://a/1", 5, null, ""]';
    assert.deepStrictEqual(Core.readRecent(storage(bad)), ['http://a/1']);
    assert.deepStrictEqual(Core.readRecent({ getItem: function () { throw new Error('no storage'); } }), []);
});

test('times and progress', function () {
    assert.strictEqual(Core.formatTime(0), '0:00');
    assert.strictEqual(Core.formatTime(123000), '2:03');
    assert.strictEqual(Core.formatTime(3723000), '1:02:03');
    assert.strictEqual(Core.formatTime(-5), '0:00');
    assert.strictEqual(Core.percent(30000, 120000), 25);
    assert.strictEqual(Core.percent(500, 0), 0, 'a live stream has no length');
    assert.strictEqual(Core.percent(999999, 1000), 100);
});
