/* media-info.js — reads and caches metadata from a file's container header:
 * duration, video codec and size, HDR, audio and subtitle tracks.  The
 * browser uses the duration for its length column.
 *
 * Cached in localStorage under vlctv_media_v1 as
 *   uri → { dur, video, audio, subs, size, mtime, ts }
 *     dur    ms, 0 when the header doesn't say
 *     video  { codec, width, height, hdr } or null; codec is the name a
 *            person knows ('HEVC'), hdr 'SDR' | 'HDR10' | 'HLG' | 'DV'
 *     audio  [{ codec, lang }] in file order
 *     subs   [{ codec, lang, name }] in file order
 * A record is valid while the file's size and modification time match.
 * A file on a USB drive is stored under its path on the drive
 * (UsbPaths.key), so the record outlives the drive being mounted under
 * another name (issue #181).
 * Settings → Backup skips it, since it can be rebuilt.  Files in
 * unsupported containers are stored with dur 0, so their folder isn't
 * probed again on each open; the player fills in the real duration once
 * the file plays.
 *
 * MP4: walk the top-level box headers to find moov (a moov after mdat
 * costs only a few 16-byte reads).  Read the whole moov if it is under
 * MOOV_MAX_BYTES, otherwise only its start, for mvhd.  Matroska/WebM: use
 * the header that MkvSubs.listTracks already reads.
 *
 * ES5 on purpose, like the rest of the app. */

var MediaInfo = (function () {
    'use strict';

    var KEY = 'vlctv_media_v1';
    var MAX = 2000;
    var MOOV_MAX_BYTES  = 4 * 1024 * 1024;   // a moov up to this size is read in full
    var MOOV_HEAD_BYTES = 4096;              // for a larger moov, read this much: enough for mvhd, its first child
    var MAX_TOP_BOXES   = 64;

    var MP4_EXTS = { mp4: 1, m4v: 1, m4a: 1, mov: 1 };
    var MKV_EXTS = { mkv: 1, webm: 1, mka: 1 };

    function ext(name) {
        var s = String(name || ''), i = s.lastIndexOf('.');
        return i < 0 ? '' : s.slice(i + 1).toLowerCase();
    }
    function mtimeOf(entry) {
        var m = entry.mtime;
        if (!m) return 0;
        return (typeof m === 'number' ? m : new Date(m).getTime()) || 0;
    }

    /* ── MP4 ────────────────────────────────────────────────────────── */

    /* Return the duration in ms from the mvhd in a moov body (or its first
     * MOOV_HEAD_BYTES).  Return 0 if mvhd is missing or its duration is 0,
     * as in fragmented files. */
    function moovDuration(buf) {
        var view = new DataView(buf), off = 0;
        while (off + 8 <= view.byteLength) {
            var size = view.getUint32(off);
            var type = String.fromCharCode(view.getUint8(off + 4), view.getUint8(off + 5),
                                           view.getUint8(off + 6), view.getUint8(off + 7));
            if (type === 'mvhd') {
                var b = off + 8;
                if (b >= view.byteLength) return 0;
                var version = view.getUint8(b);
                if (version === 0 && b + 20 <= view.byteLength)
                    return msOf(view.getUint32(b + 16), view.getUint32(b + 12));
                if (version === 1 && b + 32 <= view.byteLength)
                    return msOf(view.getUint32(b + 24) * 0x100000000 + view.getUint32(b + 28), view.getUint32(b + 20));
                return 0;
            }
            if (size < 8) return 0;
            off += size;
        }
        return 0;
    }
    function msOf(ticks, timescale) {
        return timescale > 0 && ticks > 0 ? Math.round(ticks * 1000 / timescale) : 0;
    }

    /* Convert tracks parsed by Mp4Subs into the record's video, audio and
     * subs fields. */
    function fromMp4Tracks(tracks, mp4) {
        var out = { video: null, audio: [], subs: [] };
        var hdr = mp4.describeHdr(tracks);
        for (var i = 0; i < tracks.length; i++) {
            var t = tracks[i];
            if (mp4.isVideoTrack(t)) {
                if (!out.video) out.video = { codec: mp4.codecName(t.video.codec), width: t.video.width || 0,
                                              height: t.video.height || 0, hdr: hdr ? hdr.kind : 'SDR' };
            } else if (t.handler === 'soun') {
                out.audio.push({ codec: mp4.codecName(t.codec), lang: langOf(t.lang) });
            } else if (t.handler === 'subt' || t.handler === 'sbtl' || t.handler === 'text') {
                out.subs.push({ codec: String(t.codec || ''), lang: langOf(t.lang), name: '' });
            }
        }
        return out;
    }

    function readMp4(reader, size, mp4, done) {
        var off = 0, boxes = 0;
        function next() {
            if (boxes++ > MAX_TOP_BOXES) { done(null, null); return; }
            mp4.readBoxHeader(reader, off, size, function (err, box) {
                if (err || !box) { done(err, null); return; }
                if (box.type !== 'moov') { off = box.end; next(); return; }
                var len = box.end - box.body, whole = len <= MOOV_MAX_BYTES;
                reader.readRange(box.body, whole ? len : MOOV_HEAD_BYTES, function (e, buf) {
                    if (e) { done(e, null); return; }
                    var info = { dur: moovDuration(buf) };
                    if (whole) {
                        var tracks = [];
                        try { tracks = mp4._parseMp4(buf); } catch (x) {}
                        var t = fromMp4Tracks(tracks, mp4);
                        info.video = t.video; info.audio = t.audio; info.subs = t.subs;
                    }
                    done(null, info);
                });
            });
        }
        next();
    }

    /* ── Matroska ───────────────────────────────────────────────────── */

    function fromMkvTracks(tracks, mkv) {
        var out = { video: null, audio: [], subs: [] };
        var hdr = mkv.describeHdr(tracks);
        for (var i = 0; i < tracks.length; i++) {
            var t = tracks[i];
            if (mkv.isVideoTrack(t)) {
                if (!out.video) out.video = { codec: mkv.codecName(t.codec), width: t.width || 0,
                                              height: t.height || 0, hdr: hdr ? hdr.kind : 'SDR' };
            } else if (mkv.isAudioTrack(t)) {
                out.audio.push({ codec: mkv.codecName(t.codec), lang: langOf(t.langIetf || t.lang) });
            } else if (mkv.isSubtitleTrack(t)) {
                out.subs.push({ codec: String(t.codec || ''), lang: langOf(t.langIetf || t.lang), name: String(t.name || '') });
            }
        }
        return out;
    }

    function readMkv(file, mkv, cb) {
        mkv.listTracks(file, function (err, tracks, layout) {
            if (err) { cb(err, null); return; }
            var info = fromMkvTracks(tracks || [], mkv);
            info.dur = (layout && layout.duration) || 0;
            cb(null, info);
        });
    }

    /* Return a language tag unchanged, or '' for 'und' (undetermined). */
    function langOf(s) {
        s = String(s || '');
        return s === 'und' ? '' : s;
    }

    /* ── Probe ──────────────────────────────────────────────────────── */

    /* Probe entry's header.  deps is { mp4: Mp4Subs, mkv: MkvSubs }.  Call
     * cb(err, info); info is null for unsupported containers. */
    function probe(entry, deps, cb) {
        var e = ext(entry.name);
        if (MP4_EXTS[e] && deps.mp4) {
            deps.mp4.openReader(entry.file, function (err, reader) {
                if (err) { cb(err, null); return; }
                function done(e2, info) {
                    try { if (reader.close) reader.close(); } catch (x) {}
                    cb(e2 || null, e2 ? null : info);
                }
                reader.getSize(function (e2, size) {
                    if (e2) { done(e2); return; }
                    readMp4(reader, size, deps.mp4, done);
                });
            });
        } else if (MKV_EXTS[e] && deps.mkv) {
            readMkv(entry.file, deps.mkv, cb);
        } else {
            cb(null, null);
        }
    }

    /* ── Cache ──────────────────────────────────────────────────────── */

    // UsbPaths is a global in the app; a Node test requires this file bare.
    var paths = typeof UsbPaths !== 'undefined' ? UsbPaths
              : (typeof require === 'function' ? require('./usb-paths.js') : null);
    /* A USB file is cached under its path on the drive, so the record
     * survives the TV mounting the drive under another name (issue #181). */
    function keyOf(uri) { return paths ? paths.key(uri) : uri; }

    function create(storage, deps, now) {
        now = now || function () { return Date.now(); };
        var map = null;   // parsed on first use, then kept in memory

        function load() {
            if (map) return map;
            try { map = JSON.parse(storage.getItem(KEY) || '{}') || {}; }
            catch (e) { map = {}; }
            // Records stored under full USB paths by older versions.
            if (paths) map = paths.foldKeys(map, function (r) { return r && r.ts; });
            return map;
        }
        function save() {
            try { storage.setItem(KEY, JSON.stringify(map)); } catch (e) {}
        }

        /* Return the cached record for a listing entry ({ uri, name, size,
         * mtime, file }), or null if it is missing or stale. */
        function get(entry) {
            var r = load()[keyOf(entry.uri)];
            return r && r.size === entry.size && r.mtime === mtimeOf(entry) ? r : null;
        }
        /* Merge info (any of dur, video, audio, subs) into the entry's
         * record, keeping the other fields. */
        function put(entry, info) {
            if (!entry || !entry.uri) return;
            var m = load(), r = get(entry) || { dur: 0, video: null, audio: [], subs: [] };
            info = info || {};
            if (info.dur !== undefined)   r.dur   = Math.max(0, Math.round(info.dur || 0));
            if (info.video !== undefined) r.video = info.video || null;
            if (info.audio !== undefined) r.audio = info.audio || [];
            if (info.subs !== undefined)  r.subs  = info.subs || [];
            r.size = entry.size; r.mtime = mtimeOf(entry); r.ts = now();
            m[keyOf(entry.uri)] = r;
            var keys = Object.keys(m);
            if (keys.length > MAX) {
                keys.sort(function (a, b) { return m[a].ts - m[b].ts; })
                    .slice(0, keys.length - MAX)
                    .forEach(function (k) { delete m[k]; });
            }
            save();
        }
        /* Like get(), but on a miss probe the file and cache the result.
         * Call cb(err, record). */
        function lookup(entry, cb) {
            var hit = get(entry);
            if (hit) { cb(null, hit); return; }
            probe(entry, deps, function (err, info) {
                if (err) { cb(err, null); return; }
                put(entry, info || { dur: 0 });
                cb(null, get(entry));
            });
        }

        return { KEY: KEY, get: get, put: put, lookup: lookup };
    }

    var api = create(typeof localStorage !== 'undefined' ? localStorage : null, {
        mp4: typeof Mp4Subs !== 'undefined' ? Mp4Subs : null,
        mkv: typeof MkvSubs !== 'undefined' ? MkvSubs : null
    });
    api.create = create;
    api.moovDuration = moovDuration;
    return api;
})();

// Ignored by the Tizen/browser build; lets Node tests require these helpers.
if (typeof module !== 'undefined' && module.exports) module.exports = MediaInfo;
