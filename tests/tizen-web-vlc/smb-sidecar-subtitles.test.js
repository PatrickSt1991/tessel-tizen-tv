'use strict';

var assert = require('assert');
var test   = require('node:test');
var fs     = require('fs');
var vm     = require('vm');
var path   = require('path');

var SRC = fs.readFileSync(
    path.join(__dirname, '../../tizen-web-vlc/js/smb.js'), 'utf8');

/* Same sandbox as smb-settings.test.js: smb.js expects a browser, so give it
 * just enough of one to load and hand back its exports. */
function loadSmb() {
    var sandbox = {
        module: { exports: {} },
        Debug:  { send: function () {} },
        UI:     { toast: function () {} },
        localStorage: { getItem: function () { return null; }, setItem: function () {} },
        document: {
            readyState: 'complete',
            addEventListener: function () {},
            getElementById: function () { return null; }
        },
        window: {},
        XMLHttpRequest: function () {
            this.open = function () {}; this.setRequestHeader = function () {}; this.send = function () {};
        }
    };
    vm.createContext(sandbox);
    vm.runInContext(SRC, sandbox);
    return sandbox.module.exports;
}

var SMB = loadSmb();
var STREAM = 'http://127.0.0.1:8127/smb/stream?path=';

function file(name) { return { name: name, isDir: false, size: 1 }; }
function dir(name)  { return { name: name, isDir: true }; }
function plain(list) {
    // Objects come out of the vm context with that realm's prototypes, so
    // rebuild them here before a strict deep-equal looks at them.
    return Array.from(list || [], function (s) { return { name: s.name, lang: s.lang, ext: s.ext, uri: s.uri }; });
}

test('Movie.srt next to Movie.mp4 is found, case-insensitively, and streams via the smbproxy', function () {
    var subs = SMB.siblingSubtitles([file('Movie.mp4'), file('movie.SRT')], '/Films');
    assert.deepStrictEqual(plain(subs['Movie.mp4']), [
        { name: 'movie.SRT', lang: '', ext: 'srt', uri: STREAM + encodeURIComponent('/Films/movie.SRT') }
    ]);
});

test('language-tagged sidecars are picked up too, with the tag read off the name', function () {
    var subs = SMB.siblingSubtitles(
        [file('Movie.mkv'), file('Movie.srt'), file('Movie.en.srt'), file('Movie.nld.ass'), file('Movie.forced.srt')], '');
    var got = plain(subs['Movie.mkv']);
    assert.deepStrictEqual(got.map(function (s) { return s.name; }),
        ['Movie.srt', 'Movie.en.srt', 'Movie.nld.ass', 'Movie.forced.srt'], 'exact match first, then the tagged ones');
    assert.deepStrictEqual(got.map(function (s) { return s.lang; }), ['', 'en', 'nld', '']);
    assert.strictEqual(got[2].ext, 'ass');
    assert.strictEqual(got[0].uri, STREAM + encodeURIComponent('/Movie.srt'), 'share root joins as /name');
});

test('a subtitle for a different film, a folder, or an image-based sub does not attach', function () {
    var subs = SMB.siblingSubtitles([
        file('Movie.mp4'), file('Movie 2.srt'), file('Movies.srt'), file('Movie.sub'), file('Movie.idx'),
        dir('Movie.srt'), file('Other.mp4'), file('Other.en.srt')
    ], '/x');
    assert.strictEqual(subs['Movie.mp4'], undefined, 'nothing valid sits next to Movie.mp4');
    assert.deepStrictEqual(plain(subs['Other.mp4']).map(function (s) { return s.name; }), ['Other.en.srt']);
});

test('videos without a sidecar are simply absent from the map', function () {
    var subs = SMB.siblingSubtitles([file('Alone.mkv'), file('Notes.txt')], '/x');
    assert.deepStrictEqual(Object.keys(subs), []);
});
