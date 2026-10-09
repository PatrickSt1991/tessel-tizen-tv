'use strict';

var assert = require('assert');
var test   = require('node:test');
var Favorites = require('../../tizen-app/js/favorites.js');

function storage(init) {
    var s = {};
    Object.keys(init || {}).forEach(function (k) { s[k] = typeof init[k] === 'string' ? init[k] : JSON.stringify(init[k]); });
    return {
        getItem: function (k) { return k in s ? s[k] : null; },
        setItem: function (k, v) { s[k] = String(v); },
        json:    function (k) { return k in s ? JSON.parse(s[k]) : undefined; }
    };
}

test('a pinned share folder keeps its server and path, in the order pinned', function () {
    var st = storage();
    var favs = Favorites.create(st);
    var a = favs.add({ kind: 'smb', srv: '', path: '/Shows/Foo', name: ' Foo ' });
    var b = favs.add({ kind: 'smb', srv: 'k3j9x2ab', path: '/Films', name: 'Films' });
    assert.deepStrictEqual(favs.list().map(function (f) { return [f.kind, f.srv, f.path, f.name]; }),
        [['smb', '', '/Shows/Foo', 'Foo'], ['smb', 'k3j9x2ab', '/Films', 'Films']]);
    assert.notStrictEqual(a.id, b.id);
    assert.deepStrictEqual(st.json('vlctv_favorites_v1'), favs.list());
});

test('a USB folder remembers the virtual root it is on, and a blank name falls back to the folder', function () {
    var favs = Favorites.create(storage());
    var f = favs.add({ kind: 'usb', path: '/opt/media/USBDriveA1/Shows/Bar', root: 'removable_abc', rootPath: '/opt/media/USBDriveA1' });
    assert.strictEqual(f.name, 'Bar');
    assert.strictEqual(f.root, 'removable_abc');
    assert.strictEqual(f.rootPath, '/opt/media/USBDriveA1');
    assert.strictEqual(f.srv, undefined);
});

test('pinning the same folder twice keeps the first entry; another server is another folder', function () {
    var favs = Favorites.create(storage());
    var a = favs.add({ kind: 'smb', srv: '', path: '/Shows', name: 'Shows' });
    assert.strictEqual(favs.add({ kind: 'smb', srv: '', path: '/Shows', name: 'Again' }).id, a.id);
    assert.strictEqual(favs.list().length, 1);
    assert.notStrictEqual(favs.add({ kind: 'smb', srv: 'other', path: '/Shows', name: 'Shows' }).id, a.id);
    assert.strictEqual(favs.find({ kind: 'smb', srv: '', path: '/Shows' }).id, a.id);
    assert.strictEqual(favs.find({ kind: 'usb', path: '/Shows' }), null);
    assert.strictEqual(favs.find({ kind: 'smb', srv: '', path: '/Films' }), null);
});

test('remove, and what is refused', function () {
    var favs = Favorites.create(storage());
    var a = favs.add({ kind: 'smb', srv: '', path: '/A', name: 'A' });
    favs.add({ kind: 'usb', path: '/opt/media/USBDriveA1/B', name: 'B' });
    favs.remove(a.id);
    assert.deepStrictEqual(favs.list().map(function (f) { return f.name; }), ['B']);
    assert.strictEqual(favs.get(a.id), null);
    assert.strictEqual(favs.add({ kind: 'dlna', path: '/x', name: 'x' }), null);
    assert.strictEqual(favs.add({ kind: 'smb', srv: '', path: '', name: 'x' }), null);
    assert.strictEqual(favs.add(null), null);
});

test('a damaged list reads as empty rather than throwing', function () {
    assert.deepStrictEqual(Favorites.create(storage({ vlctv_favorites_v1: '{not json' })).list(), []);
    assert.deepStrictEqual(Favorites.create(storage({ vlctv_favorites_v1: { a: 1 } })).list(), []);
    var favs = Favorites.create(storage({ vlctv_favorites_v1: [null, { kind: 'x', path: '/a' }, { kind: 'usb', path: '/ok', id: 'q', name: 'ok' }] }));
    assert.deepStrictEqual(favs.list().map(function (f) { return f.path; }), ['/ok']);
    assert.deepStrictEqual(Favorites.create(null).list(), []);
});
