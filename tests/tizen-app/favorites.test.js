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

test('a WebDAV folder is kept by its server and path like a share folder (issue #145)', function () {
    var favs = Favorites.create(storage());
    var a = favs.add({ kind: 'webdav', srv: 'nc1', path: '/Films/Sci Fi', name: 'Sci Fi' });
    assert.deepStrictEqual([a.kind, a.srv, a.path, a.name], ['webdav', 'nc1', '/Films/Sci Fi', 'Sci Fi']);
    assert.strictEqual(favs.add({ kind: 'webdav', srv: 'nc1', path: '/Films/Sci Fi', name: 'Again' }).id, a.id);
    // The same path on an SMB server is another folder.
    assert.notStrictEqual(favs.add({ kind: 'smb', srv: 'nc1', path: '/Films/Sci Fi', name: 'Sci Fi' }).id, a.id);
    assert.strictEqual(favs.find({ kind: 'webdav', srv: 'nc1', path: '/Films/Sci Fi' }).id, a.id);
    assert.strictEqual(favs.find({ kind: 'webdav', srv: 'other', path: '/Films/Sci Fi' }), null);
    assert.strictEqual(favs.list().length, 2);
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

/* ── USB drives that change mount (issue #181) ─────────────────────── */
test('a USB folder is the same folder when the drive is mounted under another name', function () {
    var favs = Favorites.create(storage());
    var a = favs.add({ kind: 'usb', path: '/opt/media/USBDriveB1/Series/Bleach', root: 'removable_sdb1', rootPath: '/opt/media/USBDriveB1' });
    assert.strictEqual(favs.find({ kind: 'usb', path: '/opt/media/USBDriveA1/Series/Bleach' }).id, a.id);
    assert.strictEqual(favs.find({ kind: 'usb', path: 'removable_sda1/Series/Bleach' }).id, a.id, 'firmware with virtual full paths');
    assert.strictEqual(favs.add({ kind: 'usb', path: '/opt/media/USBDriveA1/Series/Bleach', name: 'Again' }).id, a.id);
    assert.strictEqual(favs.list().length, 1);
    assert.strictEqual(favs.find({ kind: 'usb', path: '/opt/media/USBDriveA1/Series' }), null, 'its parent is another folder');
    // A share folder is still compared by its exact path.
    favs.add({ kind: 'smb', srv: '', path: '/opt/media/USBDriveB1/x', name: 'x' });
    assert.strictEqual(favs.find({ kind: 'smb', srv: '', path: '/opt/media/USBDriveA1/x' }), null);
});

test('move() stores where a pinned USB folder was found, and only that', function () {
    var st = storage();
    var favs = Favorites.create(st);
    var a = favs.add({ kind: 'usb', path: '/opt/media/USBDriveB1/Series', name: 'My shows', root: 'removable_sdb1', rootPath: '/opt/media/USBDriveB1' });
    var s = favs.add({ kind: 'smb', srv: '', path: '/Shows', name: 'Shows' });

    var moved = favs.move(a.id, { path: '/opt/media/USBDriveA1/Series', root: 'removable_sda1', rootPath: '/opt/media/USBDriveA1' });
    assert.deepStrictEqual([moved.id, moved.name, moved.path, moved.root, moved.rootPath],
        [a.id, 'My shows', '/opt/media/USBDriveA1/Series', 'removable_sda1', '/opt/media/USBDriveA1']);
    assert.deepStrictEqual(st.json('vlctv_favorites_v1')[0], moved);

    // Without a root to go with it, the old root is dropped rather than kept.
    var bare = favs.move(a.id, { path: '/opt/media/USBDriveC1/Series' });
    assert.deepStrictEqual([bare.path, bare.root, bare.rootPath], ['/opt/media/USBDriveC1/Series', undefined, undefined]);

    assert.strictEqual(favs.move(s.id, { path: '/Other' }), null, 'a share folder does not move');
    assert.strictEqual(favs.move('nope', { path: '/x' }), null);
    assert.strictEqual(favs.move(a.id, { path: '' }), null);
    assert.strictEqual(favs.move(a.id, null), null);
    assert.strictEqual(favs.get(s.id).path, '/Shows');
    assert.strictEqual(favs.get(a.id).path, '/opt/media/USBDriveC1/Series');
});
