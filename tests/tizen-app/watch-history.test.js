'use strict';

var assert = require('assert');
var test   = require('node:test');
var WatchHistory = require('../../tizen-app/js/watch-history.js');

var MIN = 60000;

function storage(init) {
    var s = {};
    Object.keys(init || {}).forEach(function (k) { s[k] = JSON.stringify(init[k]); });
    return {
        getItem: function (k) { return k in s ? s[k] : null; },
        setItem: function (k, v) { s[k] = String(v); },
        json:    function (k) { return k in s ? JSON.parse(s[k]) : undefined; }
    };
}

/* A history whose clock advances one minute per call. */
function history(init) {
    var t = 1000 * MIN;
    var st = storage(init);
    var h = WatchHistory.create(st, function () { t += MIN; return t; });
    h.storage = st;
    return h;
}

test('a finished file is watched, loses its resume position and keeps the newest timestamp', function () {
    var h = history();
    h.saveResumePos('a', 20 * MIN, 40 * MIN);
    assert.strictEqual(h.resumePosFor('a'), 20 * MIN);
    h.markWatched('a');
    var first = h.storage.json(h.WATCHED_KEY).a;
    assert.ok(h.isWatched('a'));
    assert.strictEqual(h.resumePosFor('a'), 0);
    assert.deepStrictEqual(h.storage.json(h.RESUME_KEY), {});
    h.markWatched('a');
    assert.ok(h.storage.json(h.WATCHED_KEY).a > first, 'watching again moves the file to the front');
});

test('positions in the first 30 s are not kept, and a stop there drops the old one', function () {
    var h = history();
    h.saveResumePos('a', 20 * MIN, 40 * MIN);
    h.saveResumePos('a', 10000, 40 * MIN);
    assert.strictEqual(h.resumePosFor('a'), 0);
    h.saveResumePos('', 20 * MIN, 40 * MIN);
    assert.deepStrictEqual(h.storage.json(h.RESUME_KEY), {});
});

test('the maps keep the newest 500 watched marks and 200 positions', function () {
    var h = history();
    for (var i = 0; i < 520; i++) h.markWatched('w' + i);
    for (var j = 0; j < 210; j++) h.saveResumePos('r' + j, 5 * MIN, 40 * MIN);
    var w = h.storage.json(h.WATCHED_KEY), r = h.storage.json(h.RESUME_KEY);
    assert.strictEqual(Object.keys(w).length, 500);
    assert.ok(!w.w0 && !w.w19 && w.w20 && w.w519);
    assert.strictEqual(Object.keys(r).length, 200);
    assert.ok(!r.r0 && !r.r9 && r.r10 && r.r209);
});

test('unreadable storage reads as empty history', function () {
    var h = WatchHistory.create({ getItem: function () { return '{nope'; }, setItem: function () { throw new Error('full'); } });
    assert.strictEqual(h.isWatched('a'), false);
    assert.strictEqual(h.resumePosFor('a'), 0);
    h.markWatched('a');   // the failed write is swallowed
    assert.strictEqual(WatchHistory.create(null).isWatched('a'), false);
});

test('forget() drops marks and positions for the files named, and says how many had one', function () {
    var h = history();
    h.markWatched('e1'); h.markWatched('e2');
    h.saveResumePos('e3', 10 * MIN, 40 * MIN);
    h.markWatched('other');
    assert.strictEqual(h.forget(['e1', 'e2', 'e3', 'e4', '']), 3);
    assert.deepStrictEqual(Object.keys(h.storage.json(h.WATCHED_KEY)), ['other']);
    assert.deepStrictEqual(h.storage.json(h.RESUME_KEY), {});
    assert.strictEqual(h.forget(['e1']), 0);
    assert.strictEqual(h.snapshot().continueAt(['e1', 'e2', 'e3']), null);
});

test('forgetUnder() drops everything below a folder, subfolders included, and nothing else', function () {
    var h = history();
    var root = 'file:///media/usb/Show/';
    h.markWatched(root + 'Episode 1.mkv');                              // watched only
    h.saveResumePos(root + 'Episode 2.mkv', 10 * MIN, 40 * MIN);        // resume only
    h.markWatched(root + 'Season 2/Episode 1.mkv');
    h.saveResumePos(root + 'Season 2/Episode 1.mkv', 5 * MIN, 40 * MIN);   // both, counted once
    h.markWatched('file:///media/usb/Show-2/Episode 1.mkv');            // sibling with a similar name
    h.saveResumePos('file:///media/usb/Show-2/Episode 2.mkv', 10 * MIN, 40 * MIN);
    h.markWatched('file:///media/usb/Show.mkv');
    assert.deepStrictEqual(h.urisUnder(root).sort(),
        [root + 'Episode 1.mkv', root + 'Episode 2.mkv', root + 'Season 2/Episode 1.mkv']);
    assert.strictEqual(h.forgetUnder(root), 3);
    assert.deepStrictEqual(Object.keys(h.storage.json(h.WATCHED_KEY)).sort(),
        ['file:///media/usb/Show-2/Episode 1.mkv', 'file:///media/usb/Show.mkv']);
    assert.deepStrictEqual(Object.keys(h.storage.json(h.RESUME_KEY)), ['file:///media/usb/Show-2/Episode 2.mkv']);
    assert.strictEqual(h.forgetUnder(root), 0);
    assert.strictEqual(h.forgetUnder(''), 0);
    assert.strictEqual(Object.keys(h.storage.json(h.WATCHED_KEY)).length, 2);
});

test('a snapshot tells watched, progress and finished apart', function () {
    var h = history();
    h.markWatched('done');
    h.saveResumePos('half', 20 * MIN, 40 * MIN);
    h.saveResumePos('credits', 38 * MIN, 40 * MIN);
    h.saveResumePos('nodur', 20 * MIN, 0);
    var s = h.snapshot();
    assert.deepStrictEqual(s.state('done'),    { watched: true,  progress: null, finished: true,  lastTs: h.storage.json(h.WATCHED_KEY).done });
    assert.deepStrictEqual(s.state('half'),    { watched: false, progress: 0.5,  finished: false, lastTs: h.storage.json(h.RESUME_KEY).half.ts });
    assert.deepStrictEqual(s.state('credits'), { watched: false, progress: 0.95, finished: true,  lastTs: h.storage.json(h.RESUME_KEY).credits.ts });
    assert.deepStrictEqual(s.state('nodur'),   { watched: false, progress: null, finished: false, lastTs: h.storage.json(h.RESUME_KEY).nodur.ts });
    assert.deepStrictEqual(s.state('never'),   { watched: false, progress: null, finished: false, lastTs: 0 });
});

test('a position past the watched fraction counts as finished', function () {
    var h = history();
    assert.strictEqual(h.WATCHED_FRACTION, 0.9);
    h.saveResumePos('at',    108 * MIN, 120 * MIN);
    h.saveResumePos('under', 107 * MIN, 120 * MIN);
    var s = h.snapshot();
    assert.ok(s.state('at').finished);
    assert.ok(!s.state('under').finished);
});

test('a file watched before and started again is in progress, not finished', function () {
    var h = history();
    h.markWatched('a');
    h.saveResumePos('a', 10 * MIN, 40 * MIN);
    var st = h.snapshot().state('a');
    assert.ok(st.watched && !st.finished && st.progress === 0.25);
});

test('the folder continues at the most recent file, or after it once that is finished', function () {
    var h = history();
    var eps = ['e1', 'e2', 'e3', 'e4'];
    var s = h.snapshot();
    assert.strictEqual(s.continueAt(eps), null);
    assert.strictEqual(s.continueAt([]), null);

    h.markWatched('e1');
    h.saveResumePos('e2', 10 * MIN, 40 * MIN);
    assert.strictEqual(h.snapshot().continueAt(eps), 'e2', 'half-way through e2');

    h.markWatched('e2');
    assert.strictEqual(h.snapshot().continueAt(eps), 'e3', 'e2 finished, so the one after it');

    h.saveResumePos('e3', 38 * MIN, 40 * MIN);
    assert.strictEqual(h.snapshot().continueAt(eps), 'e4', 'stopped in the credits of e3');

    h.saveResumePos('e1', 10 * MIN, 40 * MIN);
    assert.strictEqual(h.snapshot().continueAt(eps), 'e1', 'the most recent play wins over list order');

    h.markWatched('e4');
    assert.strictEqual(h.snapshot().continueAt(eps), 'e4', 'nothing after the last row');
    assert.strictEqual(h.snapshot().continueAt(['e2', 'e3']), 'e3', 'only the rows listed count');
});

/* ── USB drives that change mount (issue #181) ─────────────────────── */
var B1 = 'file:///opt/media/USBDriveB1/Series/Bleach/';
var A1 = 'file:///opt/media/USBDriveA1/Series/Bleach/';

test('a USB file keeps its history when the drive is mounted under another name', function () {
    var h = history();
    h.markWatched(B1 + 'E41.mkv');
    h.saveResumePos(B1 + 'E42.mkv', 10 * MIN, 40 * MIN);

    assert.ok(h.isWatched(A1 + 'E41.mkv'));
    assert.strictEqual(h.resumePosFor(A1 + 'E42.mkv'), 10 * MIN);
    var s = h.snapshot();
    assert.ok(s.state(A1 + 'E41.mkv').finished);
    assert.strictEqual(s.state(A1 + 'E42.mkv').progress, 0.25);
    assert.strictEqual(s.continueAt([A1 + 'E41.mkv', A1 + 'E42.mkv', A1 + 'E43.mkv']), A1 + 'E42.mkv',
        'the uri handed in, not the key it is stored under');

    // Carrying on under the new mount updates the one entry there is.
    h.saveResumePos(A1 + 'E42.mkv', 20 * MIN, 40 * MIN);
    assert.strictEqual(h.resumePosFor(B1 + 'E42.mkv'), 20 * MIN);
    assert.deepStrictEqual(Object.keys(h.storage.json(h.RESUME_KEY)), ['usb:/Series/Bleach/E42.mkv']);
    h.markWatched(A1 + 'E42.mkv');
    assert.strictEqual(h.resumePosFor(B1 + 'E42.mkv'), 0);
    assert.deepStrictEqual(Object.keys(h.storage.json(h.WATCHED_KEY)).sort(),
        ['usb:/Series/Bleach/E41.mkv', 'usb:/Series/Bleach/E42.mkv']);
});

test('history stored under full paths by an older version still counts, the newest entry winning', function () {
    var init = {};
    init[WatchHistory.WATCHED_KEY] = {};
    init[WatchHistory.WATCHED_KEY][B1 + 'E41.mkv'] = 100;
    init[WatchHistory.WATCHED_KEY][A1 + 'E41.mkv'] = 300;
    init[WatchHistory.WATCHED_KEY]['http://nas/x.mkv'] = 200;
    init[WatchHistory.RESUME_KEY] = {};
    init[WatchHistory.RESUME_KEY][B1 + 'E43.mkv'] = { pos: 5 * MIN, dur: 40 * MIN, ts: 100 };
    init[WatchHistory.RESUME_KEY][A1 + 'E43.mkv'] = { pos: 9 * MIN, dur: 40 * MIN, ts: 50 };
    var h = history(init);

    assert.ok(h.isWatched(A1 + 'E41.mkv') && h.isWatched(B1 + 'E41.mkv') && h.isWatched('http://nas/x.mkv'));
    assert.strictEqual(h.snapshot().state(A1 + 'E41.mkv').lastTs, 300);
    assert.strictEqual(h.resumePosFor(A1 + 'E43.mkv'), 5 * MIN, 'the position saved last, whatever its mount');

    // The next write stores the maps under the new keys.
    h.markWatched('http://nas/y.mkv');
    assert.deepStrictEqual(Object.keys(h.storage.json(h.WATCHED_KEY)).sort(),
        ['http://nas/x.mkv', 'http://nas/y.mkv', 'usb:/Series/Bleach/E41.mkv']);
});

test('forgetting a USB file or folder works from either mount, old entries included', function () {
    var init = {};
    init[WatchHistory.WATCHED_KEY] = {};
    init[WatchHistory.WATCHED_KEY][B1 + 'E41.mkv'] = 100;
    init[WatchHistory.WATCHED_KEY]['file:///opt/media/USBDriveB1/Films/f.mkv'] = 100;
    var h = history(init);
    h.saveResumePos(A1 + 'E42.mkv', 10 * MIN, 40 * MIN);

    assert.strictEqual(h.urisUnder(A1).length, 2);
    assert.strictEqual(h.urisUnder('file:///opt/media/USBDriveC1/').length, 3, 'the whole drive');
    assert.strictEqual(h.forget([A1 + 'E41.mkv']), 1);
    assert.ok(!h.isWatched(B1 + 'E41.mkv'));
    assert.strictEqual(h.forgetUnder(B1), 1);
    assert.strictEqual(h.resumePosFor(A1 + 'E42.mkv'), 0);
    assert.ok(h.isWatched('file:///opt/media/USBDriveA1/Films/f.mkv'), 'another folder is untouched');
});

test('a file that is not on a USB drive is stored under its uri, as before', function () {
    var h = history();
    h.markWatched('http://192.168.1.2:8127/smb/stream?path=/opt/media/USBDriveA1/a.mkv');
    h.markWatched('file:///opt/usr/home/owner/content/a.mkv');
    assert.deepStrictEqual(Object.keys(h.storage.json(h.WATCHED_KEY)).sort(), [
        'file:///opt/usr/home/owner/content/a.mkv',
        'http://192.168.1.2:8127/smb/stream?path=/opt/media/USBDriveA1/a.mkv']);
});
