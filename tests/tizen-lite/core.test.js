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

/* An address sent from a phone: the same topic and page as the full app. */
test('the phone code is made once and kept', function () {
    var s = storage();
    var code = Core.dropCode(s);
    assert.ok(/^[a-z0-9]{10}$/.test(code), code);
    assert.strictEqual(Core.dropCode(s), code);
    assert.strictEqual(s.store[Core.DROP_KEY], code);
});

test('a damaged phone code is replaced', function () {
    var s = storage({ tessel_lite_drop_code: 'NOT a code' });
    assert.ok(/^[a-z0-9]{10}$/.test(Core.dropCode(s)));
});

test('a random source that gives short strings still fills the code', function () {
    var n = 0;
    var code = Core.dropCode(storage(), function () { n++; return 0.5; });   // "0.i" in base36: one character a turn
    assert.strictEqual(code.length, 10);
    assert.ok(n >= 10);
});

test('the poll address names the topic the phone page posts to', function () {
    assert.strictEqual(Core.dropPollUrl('abc123defg'), 'https://ntfy.sh/vlctv-abc123defg/json?poll=1');
});

test('the newest message in a poll is the address', function () {
    var body = [
        '{"id":"1","event":"open","topic":"vlctv-x"}',
        '{"id":"2","event":"message","message":"http://old.example/a.m3u8"}',
        'not json',
        '{"id":"3","event":"message","message":"  http://new.example/b.m3u8\\n"}',
        ''
    ].join('\n');
    assert.strictEqual(Core.parseDrop(body), 'http://new.example/b.m3u8');
});

test('a poll with no message gives nothing', function () {
    assert.strictEqual(Core.parseDrop(''), '');
    assert.strictEqual(Core.parseDrop(null), '');
    assert.strictEqual(Core.parseDrop('{"event":"open"}\n{"event":"message","message":5}'), '');
});

test('the poll address can be asked for over plain http', function () {
    assert.strictEqual(Core.dropPollUrl('abc123defg', true), 'http://ntfy.sh/vlctv-abc123defg/json?poll=1');
});
