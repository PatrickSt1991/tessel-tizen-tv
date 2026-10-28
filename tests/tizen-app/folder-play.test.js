'use strict';

var assert = require('assert');
var test   = require('node:test');
global.FileTypes = require('../../tizen-app/js/filetypes.js');
var FolderPlay = require('../../tizen-app/js/folder-play.js');

/* A share as { path: [entry names] }, a trailing slash marking a folder,
 * listed the way the browsers hand it to the walk.  async answers on a
 * later tick, as a real round trip does. */
function share(tree, opts) {
    opts = opts || {};
    var calls = [];
    function list(path, cb) {
        calls.push(path);
        function answer() {
            if (!(path in tree) || (opts.fail || []).indexOf(path) >= 0) return cb(new Error('cannot list ' + path));
            var s = FolderPlay.split(tree[path].map(function (n) {
                return { name: n.replace(/\/$/, ''), isDir: /\/$/.test(n) };
            }));
            cb(null, {
                dirs:   s.dirs.map(function (e) { return path + '/' + e.name; }),
                tracks: s.audio.map(function (e) { return path + '/' + e.name; })
            });
        }
        if (opts.sync) answer(); else setImmediate(answer);
    }
    return { list: list, calls: calls };
}

function walk(sh, root, limits) {
    return new Promise(function (resolve) {
        FolderPlay.walk(root, sh.list, null, function (err, tracks, info) {
            resolve({ err: err, tracks: tracks, info: info });
        }, limits);
    });
}

var MUSIC = {
    '/Music': ['Rock/', 'Jazz/', 'intro.mp3', 'cover.jpg'],
    '/Music/Rock': ['Pink Floyd/', 'Led Zeppelin/'],
    '/Music/Rock/Pink Floyd': ['The Wall/', 'Dark Side/'],
    '/Music/Rock/Pink Floyd/Dark Side': ['02. Breathe.mp3', '01. Speak to Me.mp3', 'folder.jpg'],
    '/Music/Rock/Pink Floyd/The Wall': ['01. In the Flesh.mp3'],
    '/Music/Rock/Led Zeppelin': ['IV/'],
    '/Music/Rock/Led Zeppelin/IV': ['01. Black Dog.mp3', 'booklet.pdf'],
    '/Music/Jazz': ['Kind of Blue/', '._So What.flac'],
    '/Music/Jazz/Kind of Blue': ['01. So What.flac', 'video.mkv']
};

test('the music under a folder comes out in tree order: its own files, then each subfolder by name', async function () {
    var r = await walk(share(MUSIC), '/Music');
    assert.strictEqual(r.err, null);
    assert.deepStrictEqual(r.tracks, [
        '/Music/intro.mp3',
        '/Music/Jazz/Kind of Blue/01. So What.flac',
        '/Music/Rock/Led Zeppelin/IV/01. Black Dog.mp3',
        '/Music/Rock/Pink Floyd/Dark Side/01. Speak to Me.mp3',
        '/Music/Rock/Pink Floyd/Dark Side/02. Breathe.mp3',
        '/Music/Rock/Pink Floyd/The Wall/01. In the Flesh.mp3'
    ]);
    assert.deepStrictEqual(r.info, { folders: 9, failed: 0, truncated: false });
});

test('video, pictures, documents and hidden files are left out', async function () {
    var r = await walk(share(MUSIC), '/Music/Jazz');
    assert.deepStrictEqual(r.tracks, ['/Music/Jazz/Kind of Blue/01. So What.flac']);
});

test('the same order whether listings answer at once or later', async function () {
    var a = await walk(share(MUSIC), '/Music');
    var b = await walk(share(MUSIC, { sync: true }), '/Music');
    assert.deepStrictEqual(b.tracks, a.tracks);
});

test('a folder that cannot be listed is skipped, the rest still plays', async function () {
    var r = await walk(share(MUSIC, { fail: ['/Music/Rock/Pink Floyd'] }), '/Music');
    assert.deepStrictEqual(r.tracks, [
        '/Music/intro.mp3',
        '/Music/Jazz/Kind of Blue/01. So What.flac',
        '/Music/Rock/Led Zeppelin/IV/01. Black Dog.mp3'
    ]);
    assert.strictEqual(r.info.failed, 1);
});

test('the folder itself not listing is an error', async function () {
    var r = await walk(share(MUSIC), '/Nope');
    assert.ok(r.err instanceof Error);
    assert.strictEqual(r.tracks, undefined);
});

test('the walk stops at the track limit and keeps the first tracks in order', async function () {
    var sh = share(MUSIC);
    var r = await walk(sh, '/Music', { maxTracks: 3, parallel: 1 });
    assert.deepStrictEqual(r.tracks, [
        '/Music/intro.mp3',
        '/Music/Jazz/Kind of Blue/01. So What.flac',
        '/Music/Rock/Led Zeppelin/IV/01. Black Dog.mp3'
    ]);
    assert.strictEqual(r.info.truncated, true);
    assert.ok(sh.calls.length < 9, 'stopped listing once it had enough: ' + sh.calls.length);
});

test('the walk goes no deeper than the depth limit (a link loop ends)', async function () {
    var loop = { '/L': ['a.mp3', 'L/'] };
    var sh = share(loop);
    // Every level lists like the one above it.
    var list = function (path, cb) { sh.list(path.replace(/(\/L)+$/, '/L'), cb); };
    var r = await new Promise(function (resolve) {
        FolderPlay.walk('/L', list, null, function (err, tracks, info) { resolve({ tracks: tracks, info: info }); },
                        { maxDepth: 4 });
    });
    assert.strictEqual(r.tracks.length, 5);
    assert.strictEqual(r.info.truncated, true);
});

test('progress counts tracks as folders come in; cancel stops everything', async function () {
    var seen = [], finished = false;
    await new Promise(function (resolve) {
        var cancel = FolderPlay.walk('/Music', share(MUSIC).list, function (n) {
            seen.push(n);
            if (seen.length === 3) { cancel(); setTimeout(resolve, 20); }
        }, function () { finished = true; });
    });
    assert.strictEqual(seen.length, 3);
    assert.strictEqual(finished, false);
});
