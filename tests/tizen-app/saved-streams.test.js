'use strict';

var assert = require('assert');
var test   = require('node:test');
var SavedStreams = require('../../tizen-app/js/saved-streams.js');

function storage(init) {
    var s = {};
    Object.keys(init || {}).forEach(function (k) { s[k] = typeof init[k] === 'string' ? init[k] : JSON.stringify(init[k]); });
    return {
        getItem: function (k) { return k in s ? s[k] : null; },
        setItem: function (k, v) { s[k] = String(v); },
        json:    function (k) { return k in s ? JSON.parse(s[k]) : undefined; }
    };
}

test('a saved stream keeps its name and URL, in the order saved', function () {
    var st = storage();
    var list = SavedStreams.create(st);
    var a = list.add('  NASA Live ', ' https://example.com/nasa.m3u8 ');
    var b = list.add('Radio', 'http://stream.example.com/radio');
    assert.deepStrictEqual(list.list().map(function (s) { return [s.name, s.url]; }),
        [['NASA Live', 'https://example.com/nasa.m3u8'], ['Radio', 'http://stream.example.com/radio']]);
    assert.notStrictEqual(a.id, b.id);
    assert.deepStrictEqual(st.json('vlctv_saved_v1'), list.list());
});

test('saving a URL twice keeps the first entry, and a blank name falls back to the URL', function () {
    var list = SavedStreams.create(storage());
    var a = list.add('Mine', 'http://x/a.m3u');
    assert.strictEqual(list.add('Again', 'http://x/a.m3u').id, a.id);
    assert.strictEqual(list.list().length, 1);
    assert.strictEqual(list.add('   ', 'http://x/b.mp4').name, 'http://x/b.mp4');
    assert.strictEqual(list.add('No URL', '  '), null);
});

test('edit, move and remove', function () {
    var list = SavedStreams.create(storage());
    var a = list.add('A', 'http://a'), b = list.add('B', 'http://b'), c = list.add('C', 'http://c');
    list.update(b.id, 'Bee', 'http://bee');
    assert.deepStrictEqual(list.get(b.id), { id: b.id, name: 'Bee', url: 'http://bee' });
    assert.strictEqual(list.update(b.id, 'x', ''), null);
    assert.strictEqual(list.update('nope', 'x', 'http://x'), null);

    assert.strictEqual(list.move(c.id, -1), true);
    assert.strictEqual(list.move(a.id, -1), false);
    assert.deepStrictEqual(list.list().map(function (s) { return s.name; }), ['A', 'C', 'Bee']);
    assert.strictEqual(list.move(b.id, 1), false);

    list.remove(c.id);
    assert.deepStrictEqual(list.list().map(function (s) { return s.name; }), ['A', 'Bee']);
});

test('a broken or foreign value in storage reads as an empty list', function () {
    assert.deepStrictEqual(SavedStreams.create(storage({ vlctv_saved_v1: '{oops' })).list(), []);
    assert.deepStrictEqual(SavedStreams.create(storage({ vlctv_saved_v1: { a: 1 } })).list(), []);
    assert.deepStrictEqual(SavedStreams.create(storage({ vlctv_saved_v1: [null, { name: 'x' }, { id: 'k', name: 'ok', url: 'http://ok' }] })).list(),
        [{ id: 'k', name: 'ok', url: 'http://ok' }]);
});
