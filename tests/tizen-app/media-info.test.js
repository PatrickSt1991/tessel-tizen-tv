'use strict';

var assert = require('assert');
var test   = require('node:test');
var MediaInfo = require('../../tizen-app/js/media-info.js');
var Mp4Subs   = require('../../tizen-app/js/mp4-subs.js');
var MkvSubs   = require('../../tizen-app/js/mkv-subs.js');

var deps = { mp4: Mp4Subs, mkv: MkvSubs };

function storage(init) {
    var s = {};
    Object.keys(init || {}).forEach(function (k) { s[k] = JSON.stringify(init[k]); });
    return {
        getItem: function (k) { return k in s ? s[k] : null; },
        setItem: function (k, v) { s[k] = String(v); },
        json:    function (k) { return k in s ? JSON.parse(s[k]) : undefined; }
    };
}

/* ── byte builders ─────────────────────────────────────────────────── */
function bytes() {
    var out = [];
    for (var i = 0; i < arguments.length; i++) {
        var a = arguments[i];
        if (typeof a === 'string') for (var j = 0; j < a.length; j++) out.push(a.charCodeAt(j));
        else if (typeof a === 'number') out.push(a & 0xff);
        else out = out.concat(a);
    }
    return out;
}
function u32(v) { return [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff]; }
function u16(v) { return [(v >>> 8) & 0xff, v & 0xff]; }
function zeros(n) { var a = []; while (n-- > 0) a.push(0); return a; }
function buffer(arr) { return new Uint8Array(arr).buffer; }

/* MP4 */
function box(type, body) { return bytes(u32(8 + body.length), type, body); }
function mvhd0(timescale, duration) {               // version 0: ts @12, dur @16
    return box('mvhd', bytes(zeros(12), u32(timescale), u32(duration), zeros(80)));
}
function mvhd1(timescale, durHi, durLo) {           // version 1: ts @20, dur @24 (64-bit)
    return box('mvhd', bytes(1, zeros(19), u32(timescale), u32(durHi), u32(durLo), zeros(80)));
}
/* 'eng' packed as three 5-bit letters. */
function packedLang(l) { var v = ((l.charCodeAt(0) - 96) << 10) | ((l.charCodeAt(1) - 96) << 5) | (l.charCodeAt(2) - 96); return u16(v); }
function mdhd(lang) { return box('mdhd', bytes(zeros(12), u32(1000), u32(0), packedLang(lang), u16(0))); }
function hdlr(handler) { return box('hdlr', bytes(zeros(8), handler, zeros(13))); }
function visual(fourcc, w, h) {   // a sample entry 86 bytes long, width/height at 32/34
    return bytes(u32(86), fourcc, zeros(24), u16(w), u16(h), zeros(50));
}
function stsd(entry) { return box('stsd', bytes(zeros(4), u32(1), entry)); }
function plainEntry(fourcc) { return bytes(u32(16), fourcc, zeros(8)); }
function trak(handler, lang, entry) {
    return box('trak', bytes(box('tkhd', zeros(84)), box('mdia', bytes(mdhd(lang), hdlr(handler), box('minf', box('stbl', stsd(entry)))))));
}
function movie(dur, traks) { return box('moov', bytes(mvhd0(1000, dur), traks)); }
var MP4_TRACKS = bytes(trak('vide', 'und', visual('hvc1', 3840, 2160)), trak('soun', 'eng', plainEntry('ec-3')),
                       trak('soun', 'ger', plainEntry('mp4a')), trak('subt', 'eng', plainEntry('tx3g')));

/* Matroska; ids as written, sizes as 1- or 8-byte vints. */
function el(idBytes, body, unknownSize) {
    var n = body.length;
    var size = unknownSize ? [0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]
             : n < 127 ? [0x80 | n]
             : [0x01, 0, 0, 0, 0, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
    return bytes(idBytes, size, body);
}
function f64(v) { var b = Buffer.alloc(8); b.writeDoubleBE(v); return Array.prototype.slice.call(b); }
function f32(v) { var b = Buffer.alloc(4); b.writeFloatBE(v); return Array.prototype.slice.call(b); }
var EBML_HEAD = el([0x1A, 0x45, 0xDF, 0xA3], el([0x42, 0x82], bytes('matroska')));
function segment(children, unknownSize) { return el([0x18, 0x53, 0x80, 0x67], children, unknownSize); }
function info(children) { return el([0x15, 0x49, 0xA9, 0x66], children); }
function timecodeScale(ns) { return el([0x2A, 0xD7, 0xB1], u32(ns)); }
function duration(arr) { return el([0x44, 0x89], arr); }
function voidEl(n) { return el([0xEC], zeros(n)); }
function tracks(entries) { return el([0x16, 0x54, 0xAE, 0x6B], bytes.apply(null, entries)); }
function track(number, type, codec, extra) {
    return el([0xAE], bytes(el([0xD7], [number]), el([0x83], [type]), el([0x86], bytes(codec)), extra || []));
}
function lang(l) { return el([0x22, 0xB5, 0x9C], bytes(l)); }
function name(s) { return el([0x53, 0x6E], bytes(s)); }
function video(w, h, transfer) {
    return el([0xE0], bytes(el([0xB0], u16(w)), el([0xBA], u16(h)), transfer ? el([0x55, 0xB0], el([0x55, 0xBA], [transfer])) : []));
}
var MKV_TRACKS = tracks([track(1, 1, 'V_MPEGH/ISO/HEVC', video(1920, 1080, 16)), track(2, 2, 'A_EAC3', lang('eng')),
                         track(3, 17, 'S_TEXT/UTF8', bytes(lang('ger'), name('Forced')))]);
var MKV_FILE = bytes(EBML_HEAD, segment(bytes(el([0x11, 0x4D, 0x9B, 0x74], zeros(20)), voidEl(200),
                     info(bytes(timecodeScale(1000000), duration(f64(1425000.0)))), MKV_TRACKS, el([0x1F, 0x43, 0xB6, 0x75], zeros(50)))));

/* A reader over a byte array, counting the ranges it served. */
function reader(arr) {
    var data = new Uint8Array(arr);
    var r = {
        reads: [],
        getSize:   function (cb) { cb(null, data.length); },
        readRange: function (off, len, cb) {
            r.reads.push([off, len]);
            cb(null, data.slice(off, off + len).buffer);
        },
        close: function () { r.closed = true; }
    };
    return r;
}
function entry(name, file, size, mtime) {
    return { uri: 'file:///media/' + name, name: name, file: file, size: size === undefined ? 1000 : size, mtime: mtime || new Date(2026, 0, 1) };
}
function lookup(mi, e) {
    return new Promise(function (resolve) { mi.lookup(e, function (err, rec) { resolve({ err: err, rec: rec }); }); });
}
function media(rec) { return { dur: rec.dur, video: rec.video, audio: rec.audio, subs: rec.subs }; }

/* ── MP4 ───────────────────────────────────────────────────────────── */
test('an MP4 duration comes from mvhd, in either version', function () {
    assert.strictEqual(MediaInfo.moovDuration(buffer(mvhd0(1000, 2530000))), 2530000);
    assert.strictEqual(MediaInfo.moovDuration(buffer(bytes(box('udta', zeros(4)), mvhd0(90000, 90000 * 61)))), 61000);
    assert.strictEqual(MediaInfo.moovDuration(buffer(mvhd1(1000, 1, 0))), 0x100000000);
    assert.strictEqual(MediaInfo.moovDuration(buffer(mvhd0(1000, 0))), 0, 'fragmented files say 0');
    assert.strictEqual(MediaInfo.moovDuration(buffer(box('trak', zeros(4)))), 0);
    assert.strictEqual(MediaInfo.moovDuration(buffer(bytes(u32(3), 'mvhd'))), 0, 'a short box ends the walk');
});

test('an MP4 moov behind the media is found by box headers and read whole: duration and tracks', async function () {
    var file = bytes(box('ftyp', bytes('isom', zeros(4))), box('mdat', zeros(5000)), movie(1500000, MP4_TRACKS));
    var r = reader(file);
    var res = await lookup(MediaInfo.create(storage(), deps), entry('a.mp4', r));
    assert.strictEqual(res.err, null);
    assert.deepStrictEqual(media(res.rec), {
        dur: 1500000,
        video: { codec: 'HEVC', width: 3840, height: 2160, hdr: 'SDR' },
        audio: [{ codec: 'E-AC-3', lang: 'eng' }, { codec: 'AAC', lang: 'ger' }],
        subs:  [{ codec: 'tx3g', lang: 'eng', name: '' }]
    });
    assert.deepStrictEqual(r.reads.slice(0, 3), [[0, 16], [16, 16], [5024, 16]]);
    assert.strictEqual(r.reads[3][0], 5032);
    assert.ok(r.closed);
});

test('an MP4 without a moov, or with an unparsable one, is stored as unknown', async function () {
    var mi = MediaInfo.create(storage(), deps);
    var none = await lookup(mi, entry('a.m4v', reader(bytes(box('ftyp', zeros(8)), box('mdat', zeros(100))))));
    assert.deepStrictEqual(media(none.rec), { dur: 0, video: null, audio: [], subs: [] });
    var junk = await lookup(mi, entry('b.mp4', reader(bytes(box('moov', bytes(mvhd0(1000, 7000), box('trak', bytes(u32(3), 'xx'))))))));
    assert.strictEqual(junk.rec.dur, 7000);
    assert.strictEqual(junk.rec.video, null);
});

/* ── Matroska ──────────────────────────────────────────────────────── */
test('a Matroska header gives duration (Duration × TimecodeScale) and the tracks', async function () {
    var r = reader(MKV_FILE);
    var res = await lookup(MediaInfo.create(storage(), deps), entry('a.mkv', r));
    assert.strictEqual(res.err, null);
    assert.deepStrictEqual(media(res.rec), {
        dur: 1425000,
        video: { codec: 'HEVC', width: 1920, height: 1080, hdr: 'HDR10' },
        audio: [{ codec: 'E-AC-3', lang: 'eng' }],
        subs:  [{ codec: 'S_TEXT/UTF8', lang: 'ger', name: 'Forced' }]
    });
    // The header window, then the Tracks element out of it: nothing past the header.
    assert.strictEqual(r.reads.length, 2);
    assert.ok(r.reads.every(function (x) { return x[0] + x[1] <= 128 * 1024; }));
});

test('Matroska details: a float32 Duration, a 0.5 ms tick, no Duration, an unknown-size Segment', async function () {
    var mi = MediaInfo.create(storage(), deps);
    var scaled = await lookup(mi, entry('a.mkv', reader(bytes(EBML_HEAD, segment(bytes(info(bytes(duration(f32(60000.0)), timecodeScale(500000))), MKV_TRACKS))))));
    assert.strictEqual(scaled.rec.dur, 30000);
    var noDur = await lookup(mi, entry('b.mkv', reader(bytes(EBML_HEAD, segment(bytes(info(timecodeScale(1000000)), MKV_TRACKS))))));
    assert.strictEqual(noDur.rec.dur, 0);
    assert.strictEqual(noDur.rec.video.codec, 'HEVC');
    var live = await lookup(mi, entry('c.webm', reader(bytes(EBML_HEAD, segment(bytes(info(duration(f64(5000.0))), MKV_TRACKS), true)))));
    assert.strictEqual(live.rec.dur, 5000);
});

/* ── Cache ─────────────────────────────────────────────────────────── */
test('a record is cached by uri while size and mtime match', async function () {
    var st = storage(), r = reader(MKV_FILE);
    var mi = MediaInfo.create(st, deps);
    var e = entry('a.mkv', r, 777, new Date(2026, 5, 1));
    assert.strictEqual(mi.get(e), null);
    await lookup(mi, e);
    assert.strictEqual(mi.get(e).dur, 1425000);
    var reads = r.reads.length;
    var again = await lookup(MediaInfo.create(st, deps), e);
    assert.strictEqual(again.rec.dur, 1425000, 'from storage');
    assert.strictEqual(r.reads.length, reads, 'no read');

    assert.strictEqual(mi.get(entry('a.mkv', r, 778, new Date(2026, 5, 1))), null, 'another size is another file');
    assert.strictEqual(mi.get(entry('a.mkv', r, 777, new Date(2026, 5, 2))), null, 'so is another mtime');
    var rec = st.json(mi.KEY)[e.uri];
    assert.deepStrictEqual([rec.size, rec.mtime], [777, new Date(2026, 5, 1).getTime()]);
    assert.ok(rec.ts > 0);
});

test('an unparsed container is cached as unknown, so the folder is not probed again', async function () {
    var mi = MediaInfo.create(storage(), deps);
    var e = entry('a.avi', reader([]));
    var res = await lookup(mi, e);
    assert.deepStrictEqual(media(res.rec), { dur: 0, video: null, audio: [], subs: [] });
    assert.strictEqual(mi.get(e).dur, 0);
});

test('a reader error is reported and not cached', async function () {
    var mi = MediaInfo.create(storage(), { mp4: { openReader: function (f, cb) { cb(new Error('busy')); } }, mkv: MkvSubs });
    var e = entry('a.mp4', {});
    var res = await lookup(mi, e);
    assert.strictEqual(res.err.message, 'busy');
    assert.strictEqual(res.rec, null);
    assert.strictEqual(mi.get(e), null);
});

test('put() merges into a valid record: the player adds the duration without losing the tracks', async function () {
    var mi = MediaInfo.create(storage(), deps);
    var e = entry('a.mkv', reader(MKV_FILE));
    await lookup(mi, e);
    mi.put(e, { dur: 1425480 });
    assert.strictEqual(mi.get(e).dur, 1425480);
    assert.strictEqual(mi.get(e).video.codec, 'HEVC');
    var fresh = entry('b.avi', null, 5);
    mi.put(fresh, { dur: 99.6 });
    assert.deepStrictEqual(media(mi.get(fresh)), { dur: 100, video: null, audio: [], subs: [] });
    mi.put(null, { dur: 5 });   // nothing to key on
});

test('the cache keeps the newest 2000 records', function () {
    var t = 0, st = storage();
    var mi = MediaInfo.create(st, deps, function () { return ++t; });
    for (var i = 0; i < 2010; i++) mi.put(entry('f' + i + '.mkv', null, i), { dur: 1000 * i });
    var m = st.json(mi.KEY);
    assert.strictEqual(Object.keys(m).length, 2000);
    assert.ok(!m['file:///media/f0.mkv'] && !m['file:///media/f9.mkv'] && m['file:///media/f10.mkv']);
    assert.strictEqual(mi.get(entry('f2009.mkv', null, 2009)).dur, 2009000);
});

test('a missing or broken store reads as empty and swallows failed writes', function () {
    var mi = MediaInfo.create({ getItem: function () { return '{'; }, setItem: function () { throw new Error('full'); } }, deps);
    var e = entry('a.mkv', null, 1);
    assert.strictEqual(mi.get(e), null);
    mi.put(e, { dur: 10 });
    assert.strictEqual(mi.get(e).dur, 10, 'kept in memory for this run');
    assert.strictEqual(MediaInfo.create(null, deps).get(e), null);
});

test('a USB file keeps its record when the drive is mounted under another name (issue #181)', function () {
    function usb(mount) {
        return { uri: 'file:///opt/media/' + mount + '/Series/a.mkv', name: 'a.mkv', file: null, size: 500, mtime: new Date(2026, 0, 1) };
    }
    var st = storage();
    var mi = MediaInfo.create(st, deps);
    mi.put(usb('USBDriveB1'), { dur: 1425000 });
    assert.strictEqual(mi.get(usb('USBDriveA1')).dur, 1425000);
    assert.deepStrictEqual(Object.keys(st.json(mi.KEY)), ['usb:/Series/a.mkv']);
    var other = usb('USBDriveA1'); other.size = 501;
    assert.strictEqual(mi.get(other), null, 'another size is still another file');

    // A record an older version stored under the full path is read too.
    var old = {};
    old['file:///opt/media/USBDriveB1/Series/a.mkv'] = { dur: 7000, video: null, audio: [], subs: [], size: 500, mtime: new Date(2026, 0, 1).getTime(), ts: 5 };
    var init = {}; init[MediaInfo.KEY] = old;
    assert.strictEqual(MediaInfo.create(storage(init), deps).get(usb('USBDriveA1')).dur, 7000);
});
