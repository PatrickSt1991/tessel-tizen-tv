'use strict';

var assert = require('assert');
var test   = require('node:test');
var fs     = require('fs');
var vm     = require('vm');
var path   = require('path');
var I18n   = require('./helpers/i18n.js');
var SubMatch = require('../../tizen-app/js/sub-match.js');

function sub(name, dir) { var s = { name: name }; if (dir) s.dir = dir; return s; }
function names(list) {
    return (list || []).map(function (s) { return (s.dir ? s.dir + '/' : '') + s.name + (s.loose ? '~' : ''); }).join(' ');
}

test('an episode number is read off both spellings, a picture size is not one', function () {
    assert.strictEqual(SubMatch.episode('Show.S01E02.1080p.mkv'), '1x2');
    assert.strictEqual(SubMatch.episode('show s1 e02.srt'), '1x2');
    assert.strictEqual(SubMatch.episode('Show 1x02 Title.srt'), '1x2');
    assert.strictEqual(SubMatch.episode('Film.1920x1080.x264.mkv'), '');
    assert.strictEqual(SubMatch.episode('Film.mkv'), '');
});

test('the strict rule is unchanged: exact name first, then dot-continued names', function () {
    var got = SubMatch.pair(['Movie.mkv', 'Other.mkv'],
        [sub('Movie.en.srt'), sub('Movie.srt'), sub('Other.srt'), sub('Movie 2.srt')]);
    assert.strictEqual(names(got['Movie.mkv']), 'Movie.srt Movie.en.srt');
    assert.strictEqual(names(got['Other.mkv']), 'Other.srt');
});

test('a folder with one video offers it every left-over subtitle, flagged loose', function () {
    var got = SubMatch.pair(['Film.2019.1080p.mkv'],
        [sub('Film.2019.1080p.nl.srt'), sub('English.srt'), sub('subs-fr.ass'), sub('readme.txt')]);
    assert.strictEqual(names(got['Film.2019.1080p.mkv']), 'Film.2019.1080p.nl.srt English.srt~ subs-fr.ass~',
                       'named ones first; a stray .txt is not taken for a subtitle');
});

test('a lone episode does not take another episode\'s subtitle', function () {
    var got = SubMatch.pair(['Show.S01E02.mkv'], [sub('show 1x02.srt'), sub('show 1x03.srt')]);
    assert.strictEqual(names(got['Show.S01E02.mkv']), 'show 1x02.srt~');
});

test('several videos: a left-over file goes to the video with its episode number, others to nobody', function () {
    var got = SubMatch.pair(['Show.S01E01.720p.mkv', 'Show.S01E02.720p.mkv', 'cover.mp3'],
        [sub('show - 1x01 - Pilot.srt'), sub('Show.S01E02.WEB.en.srt'), sub('English.srt')]);
    assert.strictEqual(names(got['Show.S01E01.720p.mkv']), 'show - 1x01 - Pilot.srt~');
    assert.strictEqual(names(got['Show.S01E02.720p.mkv']), 'Show.S01E02.WEB.en.srt~');
    assert.strictEqual(got['cover.mp3'], undefined, 'loose matching is for video only');
});

test('music keeps the strict rule only', function () {
    var got = SubMatch.pair(['Song.mp3'], [sub('Song.srt'), sub('Other.srt')]);
    assert.strictEqual(names(got['Song.mp3']), 'Song.srt');
});

test('withSubsFolder reads a Subs folder only when there is one and a video', function () {
    var calls = [];
    function lister(d, cb) { calls.push(d.name); cb(null, [{ name: '2_English.srt', isDir: false }]); }
    var a = [{ name: 'Film.mkv', isDir: false }, { name: 'Subs', isDir: true }];
    SubMatch.withSubsFolder(a, lister, function (e) {
        assert.strictEqual(e.subsFolder.name, 'Subs');
        assert.strictEqual(e.subsFolder.entries.length, 1);
    });
    var b = [{ name: 'Song.mp3', isDir: false }, { name: 'Subtitles', isDir: true }];
    SubMatch.withSubsFolder(b, lister, function (e) { assert.strictEqual(e.subsFolder, undefined); });
    var c = [{ name: 'Film.mkv', isDir: false }, { name: 'Extras', isDir: true }];
    SubMatch.withSubsFolder(c, lister, function (e) { assert.strictEqual(e.subsFolder, undefined); });
    assert.deepStrictEqual(calls, ['Subs']);
    // A Subs folder that cannot be read leaves the listing as it was.
    var d = [{ name: 'Film.mkv', isDir: false }, { name: 'subs', isDir: true }];
    SubMatch.withSubsFolder(d, function (x, cb) { cb(new Error('denied')); }, function (e) {
        assert.strictEqual(e.subsFolder, undefined);
    });
});

/* ── through the share browser ─────────────────────────────────────────── */

function loadSmb() {
    var sandbox = {
        module: { exports: {} },
        Debug:  { send: function () {} },
        I18n:   I18n,
        FileTypes: require('../../tizen-app/js/filetypes.js'),
        SubMatch: SubMatch,
        UI:     { toast: function () {} },
        localStorage: { getItem: function () { return null; }, setItem: function () {} },
        document: { readyState: 'complete', addEventListener: function () {}, getElementById: function () { return null; } },
        window: {},
        XMLHttpRequest: function () { this.open = function () {}; this.setRequestHeader = function () {}; this.send = function () {}; }
    };
    vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../../tizen-app/js/smb.js'), 'utf8'), sandbox);
    return sandbox.module.exports;
}

test('a share folder\'s Subs folder is offered to its one film, streamed from inside that folder', function () {
    var SMB = loadSmb();
    var entries = [{ name: 'Film.2019.mkv', isDir: false }, { name: 'Subs', isDir: true }];
    entries.subsFolder = { name: 'Subs', entries: [{ name: '2_English.srt', isDir: false }, { name: '5_Dutch.srt', isDir: false },
                                                   { name: 'English.idx', isDir: false }] };
    var got = SMB.siblingSubtitles(entries, '/Films/Film');
    var list = Array.from(got['Film.2019.mkv']);
    assert.strictEqual(names(list), 'Subs/2_English.srt~ Subs/5_Dutch.srt~');
    assert.strictEqual(list[0].uri, 'http://127.0.0.1:8127/smb/stream?path=' + encodeURIComponent('/Films/Film/Subs/2_English.srt'));
});
