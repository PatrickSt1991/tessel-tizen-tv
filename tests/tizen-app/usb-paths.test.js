/* A USB drive is not mounted under the same name every time (issue #181):
 * what the app remembers about a file has to survive USBDriveB1 becoming
 * USBDriveA1. */
'use strict';

var assert = require('assert');
var test   = require('node:test');
var UsbPaths = require('../../tizen-app/js/usb-paths.js');

/* tizen.filesystem with USB drives on it.  Each drive is
 *   { label, mount, files: ['/Shows/a.mkv'], dirs: ['/Shows'], virtual }
 * `virtual` makes File.fullPath the virtual-root form, as some firmware
 * does.  `calls` lists every path asked for. */
function filesystem(drives, opts) {
    opts = opts || {};
    var calls = [];
    function node(d, rest, isDir) {
        return {
            isDirectory: isDir,
            fullPath: (d.virtual ? d.label : d.mount) + rest,
            toURI: function () { return 'file://' + d.mount + rest; }
        };
    }
    return {
        calls: calls,
        listStorages: function (ok, bad) {
            if (opts.hang) return;
            if (opts.fail) { bad(new Error('no')); return; }
            ok([{ label: 'internal0', type: 'INTERNAL', state: 'MOUNTED' }]
                .concat(drives.map(function (d) {
                    return { label: d.label, type: 'EXTERNAL', state: d.unmounted ? 'REMOVED' : 'MOUNTED' };
                })));
        },
        resolve: function (path, ok, bad) {
            calls.push(path);
            for (var i = 0; i < drives.length; i++) {
                var d = drives[i];
                if (path === d.label) { ok(node(d, '', true)); return; }
                if (path.indexOf(d.label + '/') !== 0) continue;
                var rest = path.slice(d.label.length);
                if ((d.files || []).indexOf(rest) >= 0) { ok(node(d, rest, false)); return; }
                if ((d.dirs || []).indexOf(rest) >= 0)  { ok(node(d, rest, true));  return; }
            }
            bad(new Error('NotFoundError'));
        }
    };
}
function relocate(fs, uris, ms) {
    return new Promise(function (done) { UsbPaths.relocate(fs, uris, done, ms); });
}
function exists(fs, uri, ms) {
    return new Promise(function (done) { UsbPaths.exists(fs, uri, done, ms); });
}

var A1 = { label: 'removable_sda1', mount: '/opt/media/USBDriveA1',
           files: ['/Series/Bleach/E43.mkv', '/Series/Bleach/E43.en.srt', '/Series/Bleach/[E09] [4K] Calamity.mkv'],
           dirs: ['/Series', '/Series/Bleach'] };

test('a path on a USB drive splits into its mount and its place on the drive', function () {
    assert.deepStrictEqual(UsbPaths.split('file:///opt/media/USBDriveB1/Series/a.mkv'),
        { scheme: 'file://', mount: '/opt/media/USBDriveB1', rest: '/Series/a.mkv' });
    assert.deepStrictEqual(UsbPaths.split('/opt/media/USBDriveA1/Series'),
        { scheme: '', mount: '/opt/media/USBDriveA1', rest: '/Series' });
    assert.deepStrictEqual(UsbPaths.split('removable_sda1/Series'),
        { scheme: '', mount: 'removable_sda1', rest: '/Series' });
    assert.deepStrictEqual(UsbPaths.split('/opt/media/USBDriveA1'),
        { scheme: '', mount: '/opt/media/USBDriveA1', rest: '' });
    ['http://nas/a.mkv', 'smb://nas/share/a.mkv', '/opt/usr/home/owner/content/a.mkv',
     'file:///opt/usr/home/owner/content/a.mkv', 'http://tv/opt/media/USBDriveA1/a.mkv', '', null, undefined]
        .forEach(function (p) { assert.strictEqual(UsbPaths.split(p), null, String(p)); });
});

test('the key of a USB file is the same under every mount, and everything else is its own key', function () {
    var k = UsbPaths.key('file:///opt/media/USBDriveB1/Series/a.mkv');
    assert.strictEqual(k, 'usb:/Series/a.mkv');
    assert.strictEqual(UsbPaths.key('file:///opt/media/USBDriveA1/Series/a.mkv'), k);
    assert.strictEqual(UsbPaths.key('/opt/media/USBDriveC2/Series/a.mkv'), k);
    assert.strictEqual(UsbPaths.key('removable_sdb1/Series/a.mkv'), k);
    assert.strictEqual(UsbPaths.key(k), k, 'a key is its own key');
    // A folder prefix still prefixes the keys of what is in the folder.
    assert.strictEqual(k.indexOf(UsbPaths.key('file:///opt/media/USBDriveA1/Series/')), 0);
    assert.strictEqual(UsbPaths.key('file:///opt/media/USBDriveA1/'), 'usb:/');
    assert.strictEqual(UsbPaths.key('http://nas/Series/a.mkv'), 'http://nas/Series/a.mkv');
    assert.strictEqual(UsbPaths.key('/Shows/Foo'), '/Shows/Foo', 'a share folder');
});

test('a map stored under full paths is folded onto keys, the newer entry winning', function () {
    var ts = function (v) { return v; };
    var plain = { 'http://nas/a.mkv': 5, 'usb:/b.mkv': 6 };
    assert.strictEqual(UsbPaths.foldKeys(plain, ts), plain, 'nothing to fold: the same object');
    assert.deepStrictEqual(UsbPaths.foldKeys({
        'file:///opt/media/USBDriveA1/a.mkv': 10,
        'file:///opt/media/USBDriveB1/a.mkv': 30,
        'usb:/a.mkv': 20,
        'file:///opt/media/USBDriveB1/b.mkv': 1,
        'http://nas/a.mkv': 5
    }, ts), { 'usb:/a.mkv': 30, 'usb:/b.mkv': 1, 'http://nas/a.mkv': 5 });
    assert.deepStrictEqual(UsbPaths.foldKeys({
        'file:///opt/media/USBDriveB1/a.mkv': 10, 'usb:/a.mkv': 20
    }, ts), { 'usb:/a.mkv': 20 }, 'an older full-path entry does not replace a newer key');
});

test('a file remembered under the mount the drive had last time is found under the one it has now', async function () {
    var fs = filesystem([A1]);
    var old = 'file:///opt/media/USBDriveB1/Series/Bleach/E43.mkv';
    var moves = await relocate(fs, [old, 'http://nas/a.mkv', old]);
    assert.deepStrictEqual(moves[old], { uri: 'file:///opt/media/USBDriveA1/Series/Bleach/E43.mkv',
        from: '/opt/media/USBDriveB1', to: '/opt/media/USBDriveA1', label: 'removable_sda1' });
    assert.deepStrictEqual(Object.keys(moves), [old]);
    assert.deepStrictEqual(fs.calls, ['removable_sda1', 'removable_sda1/Series/Bleach/E43.mkv'],
        'asked through the virtual root, once');
});

test('a file that is where it was, or nowhere, is left alone', async function () {
    var fs = filesystem([A1]);
    var here = 'file:///opt/media/USBDriveA1/Series/Bleach/E43.mkv';
    var gone = 'file:///opt/media/USBDriveB1/Series/Bleach/deleted.mkv';
    assert.deepStrictEqual(await relocate(fs, [here, gone]), {});
    // One drive, mounted where the file was: the file isn't asked for.
    assert.ok(fs.calls.indexOf('removable_sda1/Series/Bleach/E43.mkv') < 0);
    // A folder of that name is not the file.
    assert.deepStrictEqual(await relocate(fs, ['file:///opt/media/USBDriveB1/Series/Bleach']), {});
});

test('a list without USB files is answered at once, without asking the filesystem', function () {
    var fs = filesystem([A1]), answered = null;
    UsbPaths.relocate(fs, ['http://nas/a.mkv', 'https://x/y.m3u8'], function (m) { answered = m; });
    assert.deepStrictEqual(answered, {}, 'synchronously');
    assert.deepStrictEqual(fs.calls, []);
    UsbPaths.relocate(null, [], function (m) { answered = m; });
    assert.deepStrictEqual(answered, {});
});

test('two drives that swapped names: each file is found on the drive that has it', async function () {
    var films = { label: 'removable_sda1', mount: '/opt/media/USBDriveA1', files: ['/Films/f.mp4'] };
    var shows = { label: 'removable_sdb1', mount: '/opt/media/USBDriveB1', files: ['/Shows/s.mkv'] };
    var moves = await relocate(filesystem([films, shows]),
        ['file:///opt/media/USBDriveB1/Films/f.mp4', 'file:///opt/media/USBDriveA1/Shows/s.mkv']);
    assert.strictEqual(moves['file:///opt/media/USBDriveB1/Films/f.mp4'].uri, 'file:///opt/media/USBDriveA1/Films/f.mp4');
    assert.strictEqual(moves['file:///opt/media/USBDriveA1/Shows/s.mkv'].uri, 'file:///opt/media/USBDriveB1/Shows/s.mkv');
    // A file on both drives stays on the one it was played from.
    var both = [{ label: 'removable_sda1', mount: '/opt/media/USBDriveA1', files: ['/a.mkv'] },
                { label: 'removable_sdb1', mount: '/opt/media/USBDriveB1', files: ['/a.mkv'] }];
    assert.deepStrictEqual(await relocate(filesystem(both), ['file:///opt/media/USBDriveB1/a.mkv']), {});
});

test('a name with brackets and spaces is found, percent-encoded or not', async function () {
    var fs = filesystem([A1]);
    var plain = 'file:///opt/media/USBDriveB1/Series/Bleach/[E09] [4K] Calamity.mkv';
    var coded = 'file:///opt/media/USBDriveB1/Series/Bleach/%5BE09%5D%20%5B4K%5D%20Calamity.mkv';
    var moves = await relocate(fs, [plain, coded]);
    assert.strictEqual(moves[plain].uri, 'file:///opt/media/USBDriveA1/Series/Bleach/[E09] [4K] Calamity.mkv');
    assert.strictEqual(moves[coded].uri, moves[plain].uri);
    // A name that isn't valid percent-encoding is still just a name.
    assert.deepStrictEqual(await relocate(fs, ['file:///opt/media/USBDriveB1/100%.mkv']), {});
});

test('firmware whose File.fullPath is the virtual root still gives the real mount', async function () {
    var d = { label: 'removable_sda1', mount: '/opt/media/USBDriveA1', files: ['/a.mkv'], virtual: true };
    var list = await new Promise(function (done) { UsbPaths.drives(filesystem([d]), done); });
    assert.deepStrictEqual([list[0].label, list[0].fullPath, list[0].mount],
        ['removable_sda1', 'removable_sda1', '/opt/media/USBDriveA1']);
    var moves = await relocate(filesystem([d]), ['file:///opt/media/USBDriveB1/a.mkv']);
    assert.strictEqual(moves['file:///opt/media/USBDriveB1/a.mkv'].to, '/opt/media/USBDriveA1');
});

test('no drive, a drive that is not mounted, a filesystem that fails or never answers: nothing moves', async function () {
    var old = 'file:///opt/media/USBDriveB1/Series/Bleach/E43.mkv';
    assert.deepStrictEqual(await relocate(filesystem([]), [old]), {});
    var out = { label: A1.label, mount: A1.mount, files: A1.files, unmounted: true };
    assert.deepStrictEqual(await relocate(filesystem([out]), [old]), {});
    assert.deepStrictEqual(await relocate(filesystem([A1], { fail: true }), [old]), {});
    assert.deepStrictEqual(await relocate(null, [old]), {});
    assert.deepStrictEqual(await relocate({ listStorages: function () { throw new Error('x'); } }, [old]), {});
    // Never answering must not leave the caller waiting for ever.
    var calls = 0;
    await new Promise(function (done) {
        UsbPaths.relocate(filesystem([A1], { hang: true }), [old], function (m) {
            calls++;
            assert.deepStrictEqual(m, {});
            setTimeout(done, 30);
        }, 10);
    });
    assert.strictEqual(calls, 1);
});

test('whether a USB file is there: yes, no, or cannot tell', async function () {
    var fs = filesystem([A1]);
    assert.strictEqual(await exists(fs, 'file:///opt/media/USBDriveA1/Series/Bleach/E43.mkv'), true);
    assert.strictEqual(await exists(fs, 'file:///opt/media/USBDriveB1/Series/Bleach/E43.mkv'), true, 'on another mount, but there');
    assert.strictEqual(await exists(fs, 'file:///opt/media/USBDriveA1/Series/Bleach/E99.mkv'), false);
    assert.strictEqual(await exists(filesystem([]), 'file:///opt/media/USBDriveA1/a.mkv'), false, 'the drive is unplugged');
    assert.strictEqual(await exists(fs, 'http://nas/a.mkv'), null, 'not a USB file');
    assert.strictEqual(await exists(filesystem([A1], { fail: true }), 'file:///opt/media/USBDriveA1/a.mkv'), null);
    assert.strictEqual(await exists(filesystem([A1], { hang: true }), 'file:///opt/media/USBDriveA1/a.mkv', 10), null);
});

test('a pinned folder is found on the drive by its place on it', async function () {
    var fs = filesystem([A1]);
    var list = await new Promise(function (done) { UsbPaths.drives(fs, done); });
    var hit = await new Promise(function (done) {
        UsbPaths.locate(fs, list, '/opt/media/USBDriveB1/Series/Bleach', true, done);
    });
    assert.strictEqual(hit.file.fullPath, '/opt/media/USBDriveA1/Series/Bleach');
    assert.strictEqual(hit.drive.label, 'removable_sda1');
    // A file is not a folder, a missing folder is not found, and no drives is no answer.
    var miss = function (path, drives) {
        return new Promise(function (done) { UsbPaths.locate(fs, drives, path, true, done); });
    };
    assert.strictEqual(await miss('/opt/media/USBDriveB1/Series/Bleach/E43.mkv', list), null);
    assert.strictEqual(await miss('/opt/media/USBDriveB1/Films', list), null);
    assert.strictEqual(await miss('/opt/media/USBDriveB1/Series', null), null);
    assert.strictEqual(await miss('/opt/usr/home/owner/content/Films', list), null);
});

test('a Recently Played entry moves with its subtitles and cover; duplicates become one', function () {
    var move = { uri: 'file:///opt/media/USBDriveA1/S/a.mkv', from: '/opt/media/USBDriveB1',
                 to: '/opt/media/USBDriveA1', label: 'removable_sda1' };
    var moves = { 'file:///opt/media/USBDriveB1/S/a.mkv': move };
    var items = [
        { uri: 'http://nas/x.mkv', title: 'x' },
        { uri: 'file:///opt/media/USBDriveB1/S/a.mkv', title: 'a', art: 'file:///opt/media/USBDriveB1/S/cover.jpg',
          subtitles: [
              { name: 'a.en.srt', uri: 'file:///opt/media/USBDriveB1/S/a.en.srt', fullPath: '/opt/media/USBDriveB1/S/a.en.srt' },
              { name: 'a.nl.srt', uri: 'file:///opt/media/USBDriveB1/S/Subs/a.nl.srt', fullPath: 'removable_sdb1/S/Subs/a.nl.srt', dir: 'Subs' },
              { name: 'b.srt', uri: 'http://nas/b.srt', fullPath: '' }
          ] },
        { uri: 'file:///opt/media/USBDriveA1/S/a.mkv', title: 'a (older entry)' },
        { uri: 'file:///opt/media/USBDriveB1/S/gone.mkv', title: 'gone' }
    ];
    var before = JSON.stringify(items);
    var r = UsbPaths.relocateItems(items, moves);
    assert.strictEqual(JSON.stringify(items), before, 'the input is not touched');
    assert.strictEqual(r.changed, true);
    assert.deepStrictEqual(r.list.map(function (i) { return i.uri; }), [
        'http://nas/x.mkv', 'file:///opt/media/USBDriveA1/S/a.mkv', 'file:///opt/media/USBDriveB1/S/gone.mkv']);
    var a = r.list[1];
    assert.strictEqual(a.title, 'a', 'the more recent of the two entries');
    assert.strictEqual(a.art, 'file:///opt/media/USBDriveA1/S/cover.jpg');
    assert.deepStrictEqual(a.subtitles, [
        { name: 'a.en.srt', uri: 'file:///opt/media/USBDriveA1/S/a.en.srt', fullPath: '/opt/media/USBDriveA1/S/a.en.srt' },
        { name: 'a.nl.srt', uri: 'file:///opt/media/USBDriveA1/S/Subs/a.nl.srt', fullPath: 'removable_sda1/S/Subs/a.nl.srt', dir: 'Subs' },
        { name: 'b.srt', uri: 'http://nas/b.srt', fullPath: '' }
    ]);

    var same = UsbPaths.relocateItems(items, {});
    assert.strictEqual(same.changed, false);
    assert.deepStrictEqual(same.list, items);
});
