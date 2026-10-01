'use strict';

var assert = require('assert');
var test   = require('node:test');
var fs     = require('fs');
var vm     = require('vm');
var path   = require('path');

var FileTypes  = require('../../tizen-app/js/filetypes.js');
var TextDecode = require('../../tizen-app/js/text-decode.js');
var Playlist   = require('../../tizen-app/js/playlist.js');
var I18n       = require('./helpers/i18n.js');

function bytes(arr) { return new Uint8Array(arr); }
function utf8(s) { return new Uint8Array(Buffer.from(s, 'utf8')); }

/* ── FileTypes (issue #109) ─────────────────────────────────────────── */

test('a music folder\'s cover picture is found by the names players use', function () {
    assert.strictEqual(FileTypes.folderArt(['01 - Song.flac', 'Folder.JPG', 'cover.png']), 'cover.png');
    assert.strictEqual(FileTypes.folderArt(['01.mp3', 'front.jpg', 'back.jpg']), 'front.jpg');
    assert.strictEqual(FileTypes.folderArt(['AlbumArtSmall.jpg', 'AlbumArt_{1234}_Large.jpg']),
                       'AlbumArt_{1234}_Large.jpg');
    // Only pictures the TV can show, and not just any picture in the folder.
    assert.strictEqual(FileTypes.folderArt(['cover.heic', 'IMG_0001.jpg', 'cover.txt']), null);
    assert.strictEqual(FileTypes.folderArt([]), null);
});

test('files are sorted into what opens them', function () {
    assert.strictEqual(FileTypes.kind('Movie.MKV'), 'video');
    assert.strictEqual(FileTypes.kind('01 - Song.flac'), 'audio');
    assert.strictEqual(FileTypes.kind('IMG_0001.JPG'), 'image');
    assert.strictEqual(FileTypes.kind('Movie.en.srt'), 'text');
    assert.strictEqual(FileTypes.kind('release.nfo'), 'text');
    assert.strictEqual(FileTypes.kind('channels.m3u'), 'playlist');
    assert.strictEqual(FileTypes.kind('live.m3u8'), 'playlist');
    assert.strictEqual(FileTypes.kind('setup.exe'), 'other');
    assert.strictEqual(FileTypes.kind('README'), 'other');
    // Chromium can't decode these, so they aren't offered as pictures.
    assert.strictEqual(FileTypes.kind('photo.heic'), 'other');
    assert.strictEqual(FileTypes.kind('scan.tiff'), 'other');
});

test('only video and audio go to the player', function () {
    assert.ok(FileTypes.isPlayable('a.mp4'));
    assert.ok(FileTypes.isPlayable('a.opus'));
    assert.ok(!FileTypes.isPlayable('a.jpg'));
    assert.ok(!FileTypes.isPlayable('a.m3u'));
});

test('"Videos and music only" lists what the browsers always listed', function () {
    ['dir', 'video', 'audio', 'playlist'].forEach(function (k) { assert.ok(FileTypes.shown('media', k), k); });
    ['image', 'text', 'other'].forEach(function (k) { assert.ok(!FileTypes.shown('media', k), k); });
    ['dir', 'video', 'image', 'text', 'other'].forEach(function (k) { assert.ok(FileTypes.shown('all', k), k); });
});

/* ── TextDecode (issue #107) ────────────────────────────────────────── */

test('UTF-8 with and without a byte-order mark', function () {
    assert.deepStrictEqual(TextDecode.decode(utf8('héllo')), { text: 'héllo', encoding: 'UTF-8' });
    var bom = new Uint8Array([0xEF, 0xBB, 0xBF].concat(Array.from(utf8('hi'))));
    assert.deepStrictEqual(TextDecode.decode(bom), { text: 'hi', encoding: 'UTF-8' });
});

test('UTF-16 is read from its byte-order mark', function () {
    var le = bytes([0xFF, 0xFE, 0x68, 0x00, 0x69, 0x00]);
    assert.deepStrictEqual(TextDecode.decode(le), { text: 'hi', encoding: 'UTF-16LE' });
});

test('a Cyrillic Windows file is read as windows-1251, a Western one as 1252', function () {
    // "Привет, мир" in windows-1251
    var cyr = bytes([0xCF, 0xF0, 0xE8, 0xE2, 0xE5, 0xF2, 0x2C, 0x20, 0xEC, 0xE8, 0xF0]);
    assert.deepStrictEqual(TextDecode.decode(cyr), { text: 'Привет, мир', encoding: 'WINDOWS-1251' });
    // "café naïve" in windows-1252
    var west = bytes([0x63, 0x61, 0x66, 0xE9, 0x20, 0x6E, 0x61, 0xEF, 0x76, 0x65]);
    assert.deepStrictEqual(TextDecode.decode(west), { text: 'café naïve', encoding: 'WINDOWS-1252' });
});

test('a file read only partly may end half-way through a character', function () {
    var cut = utf8('abc€').subarray(0, 5);   // € is three bytes; keep two
    assert.strictEqual(TextDecode.decode(cut).encoding, 'UTF-8');
});

test('binary files are recognised, not painted', function () {
    assert.deepStrictEqual(TextDecode.decode(bytes([0x89, 0x50, 0x4E, 0x47, 0x00, 0x01])), { binary: true });
});

test('Windows and old-Mac line ends become one break each', function () {
    assert.strictEqual(TextDecode.normalizeLineEndings('a\r\nb\rc\nd'), 'a\nb\nc\nd');
});

/* ── Playlist (issue #110) ──────────────────────────────────────────── */

test('an HLS manifest is left for AVPlay', function () {
    assert.deepStrictEqual(Playlist.parse('#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:6\n#EXTINF:6.0,\nseg0.ts\n'),
                           { hls: true });
    assert.deepStrictEqual(Playlist.parse('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000\nlow/index.m3u8\n'),
                           { hls: true });
});

test('an IPTV list becomes channels with names and groups', function () {
    var text = '\uFEFF#EXTM3U\r\n' +
        '#EXTINF:-1 tvg-id="one" tvg-logo="http://x/1.png" group-title="News",Channel One\r\n' +
        'http://example.com/one.m3u8\r\n' +
        '#EXTINF:-1 tvg-name="Two, HD" group-title="Sport",Two, HD\r\n' +
        '#EXTVLCOPT:http-user-agent=Foo\r\n' +
        'http://example.com/two\r\n' +
        '#EXTGRP:Kids\r\n' +
        'http://example.com/three.ts\r\n';
    assert.deepStrictEqual(Playlist.parse(text).entries, [
        { title: 'Channel One', group: 'News',  logo: 'http://x/1.png', ref: 'http://example.com/one.m3u8' },
        { title: 'Two, HD',     group: 'Sport', logo: '',               ref: 'http://example.com/two' },
        { title: 'three.ts',    group: 'Kids',  logo: '',               ref: 'http://example.com/three.ts' }
    ]);
});

test('a plain music list keeps its relative paths for the caller', function () {
    var e = Playlist.parse('01 - Intro.mp3\n# a comment\nCD2\\02 - Song.flac\n').entries;
    assert.deepStrictEqual(e.map(function (x) { return [x.ref, x.title]; }),
                           [['01 - Intro.mp3', '01 - Intro.mp3'], ['CD2\\02 - Song.flac', '02 - Song.flac']]);
});

test('PLS lists are read in their numbered order', function () {
    var e = Playlist.parse('[playlist]\nFile2=http://b\nTitle2=B\nFile1=http://a\nNumberOfEntries=2\n').entries;
    assert.deepStrictEqual(e.map(function (x) { return [x.ref, x.title]; }), [['http://a', 'a'], ['http://b', 'B']]);
});

test('groups come out in first-seen order with their counts', function () {
    assert.deepStrictEqual(
        Playlist.groups([{ group: 'B' }, { group: 'A' }, { group: 'B' }, { group: '' }]),
        [{ name: 'B', count: 2 }, { name: 'A', count: 1 }, { name: '', count: 1 }]);
});

test('playlist URLs are recognised by extension and by IPTV panel query', function () {
    assert.ok(Playlist.isPlaylistUrl('https://smolnp.github.io/IPTVru//IPTVru.m3u'));
    assert.ok(Playlist.isPlaylistUrl('https://x/live.m3u8?token=1'));
    assert.ok(Playlist.isPlaylistUrl('http://panel:8080/get.php?username=a&password=b&type=m3u_plus'));
    assert.ok(!Playlist.isPlaylistUrl('https://x/movie.mp4'));
    assert.ok(!Playlist.isPlaylistUrl('rtsp://cam/stream'));
});

test('relative entries resolve against the list, drive paths do not', function () {
    assert.strictEqual(Playlist.resolveUrl('seg/a.ts', 'https://h/p/list.m3u'), 'https://h/p/seg/a.ts');
    assert.strictEqual(Playlist.resolveUrl('rtsp://cam/1', 'https://h/list.m3u'), 'rtsp://cam/1');
    assert.strictEqual(Playlist.resolveUrl('Sub\\01.mp3', 'file:///opt/media/USB/Music/l.m3u'),
                       'file:///opt/media/USB/Music/Sub/01.mp3');
    assert.strictEqual(Playlist.resolveUrl('C:\\Music\\01.mp3', 'file:///opt/media/USB/l.m3u'), null);
});

/* ── SMB playlist entries ──────────────────────────────────────────── */

function loadSmb() {
    var sandbox = {
        module: { exports: {} },
        Debug:  { send: function () {} },
        I18n:   I18n,
        FileTypes: FileTypes,
        UI:     { toast: function () {} },
        localStorage: { getItem: function () { return null; }, setItem: function () {} },
        document: { readyState: 'complete', addEventListener: function () {}, getElementById: function () { return null; } },
        window: {},
        XMLHttpRequest: function () {}
    };
    vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../../tizen-app/js/smb.js'), 'utf8'), sandbox);
    return sandbox.module.exports;
}

test('a playlist on a share points into the same share', function () {
    var SMB = loadSmb();
    assert.strictEqual(SMB.sharePath('/Music/Album', '01.mp3'), '/Music/Album/01.mp3');
    assert.strictEqual(SMB.sharePath('/Music/Album', '..\\Other\\02.mp3'), '/Music/Other/02.mp3');
    assert.strictEqual(SMB.sharePath('/Music/Album', '/Films/a.mkv'), '/Films/a.mkv');
    assert.strictEqual(SMB.sharePath('', './a.mp3'), '/a.mp3');
    assert.strictEqual(SMB.sharePath('/Music', '../../a.mp3'), null);
    assert.strictEqual(SMB.sharePath('/Music', 'C:\\Music\\a.mp3'), null);
    assert.strictEqual(SMB.sharePath('/Music', '\\\\nas\\share\\a.mp3'), null);
});
