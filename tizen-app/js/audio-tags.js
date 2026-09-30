/* Title, artist, album and cover art out of the head of a music file, for
 * the now-playing card (issue #105).
 *
 * Every format keeps its tags at the front, so the player reads the first
 * bytes of the file and hands them here:
 *   - MP3: an ID3v2 tag (2.2, 2.3 or 2.4);
 *   - FLAC: the VORBIS_COMMENT and PICTURE metadata blocks;
 *   - Ogg Vorbis / Opus: the comment packet, with a picture in
 *     METADATA_BLOCK_PICTURE the way FLAC stores it;
 *   - M4A / MP4 audio: the iTunes-style moov/udta/meta/ilst atoms — when
 *     moov sits before the audio, which is how most taggers write it.
 *
 * Cover art is often hundreds of KB, more than the first read covers.
 * parse() then says how many bytes it wants ({ need: n }) and is called
 * again with more.  Anything it can't make sense of comes back as {}.
 *
 * ID3's "Latin-1" text is Windows-1251 in most Russian collections, and
 * UTF-8 in some taggers' output; it goes through TextDecode's guess rather
 * than being taken at its word. */

var AudioTags = (function () {
    var MAX_NEED = 4 * 1024 * 1024;   // no cover is worth more than this

    function u32be(b, o) { return ((b[o] << 24) >>> 0) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3]; }
    function u32le(b, o) { return ((b[o + 3] << 24) >>> 0) + (b[o + 2] << 16) + (b[o + 1] << 8) + b[o]; }
    function u24be(b, o) { return (b[o] << 16) + (b[o + 1] << 8) + b[o + 2]; }
    function syncsafe(b, o) { return (b[o] << 21) | (b[o + 1] << 14) | (b[o + 2] << 7) | b[o + 3]; }
    function ascii(b, o, n) { return String.fromCharCode.apply(null, Array.prototype.slice.call(b, o, o + n)); }

    function utf16(b, bigEndian) {
        var s = '';
        for (var i = 0; i + 1 < b.length; i += 2)
            s += String.fromCharCode(bigEndian ? (b[i] << 8) | b[i + 1] : b[i] | (b[i + 1] << 8));
        return s;
    }
    /* 8-bit text, one NUL-separated value at a time: ID3v2.4 lists several
     * artists that way, and a trailing NUL would otherwise read as binary. */
    function byteText(b) {
        var parts = [], start = 0;
        for (var i = 0; i <= b.length; i++) {
            if (i < b.length && b[i] !== 0) continue;
            if (i > start) {
                var d = TextDecode.decode(b.subarray(start, i));
                if (!d.binary && d.text) parts.push(d.text);
            }
            start = i + 1;
        }
        return parts.join('\u0000');
    }
    var legacy = byteText, utf8 = byteText;
    function clean(s) { return String(s || '').replace(/\u0000+$/, '').replace(/\u0000/g, ' / ').trim(); }

    /* ID3 text in encoding `enc` (0 Latin-1, 1 UTF-16+BOM, 2 UTF-16BE, 3 UTF-8). */
    function id3Text(enc, b) {
        if (enc === 1) {
            if (b.length >= 2 && b[0] === 0xFE && b[1] === 0xFF) return utf16(b.subarray(2), true);
            if (b.length >= 2 && b[0] === 0xFF && b[1] === 0xFE) return utf16(b.subarray(2), false);
            return utf16(b, false);
        }
        if (enc === 2) return utf16(b, true);
        if (enc === 3) return utf8(b);
        return legacy(b);
    }
    /* End of a NUL-terminated string starting at o: one NUL byte, or two on
     * an even boundary for UTF-16. */
    function strEnd(b, o, enc) {
        var wide = enc === 1 || enc === 2;
        for (var i = o; i < b.length; i += wide ? 2 : 1) {
            if (!wide && b[i] === 0) return i;
            if (wide && i + 1 < b.length && b[i] === 0 && b[i + 1] === 0) return i;
        }
        return b.length;
    }

    /* ── MP3: ID3v2 ───────────────────────────────────────────────────── */
    function parseId3(b) {
        var ver = b[3], flags = b[5];
        var size = syncsafe(b, 6) + 10;
        if (size > b.length) return size <= MAX_NEED ? { need: size } : {};
        var out = {}, pos = 10;
        var idLen = ver === 2 ? 3 : 4, hdrLen = ver === 2 ? 6 : 10;
        if (ver >= 3 && (flags & 0x40)) {   // extended header
            var ext = ver === 4 ? syncsafe(b, 10) : u32be(b, 10) + 4;
            pos += ext;
        }
        var names = ver === 2
            ? { TT2: 'title', TP1: 'artist', TAL: 'album', TP2: 'albumArtist' }
            : { TIT2: 'title', TPE1: 'artist', TALB: 'album', TPE2: 'albumArtist' };
        while (pos + hdrLen <= size) {
            var id = ascii(b, pos, idLen);
            if (!/^[A-Z0-9]+$/.test(id)) break;   // padding
            var len = ver === 2 ? u24be(b, pos + 3) : ver === 4 ? syncsafe(b, pos + 4) : u32be(b, pos + 4);
            var body = b.subarray(pos + hdrLen, Math.min(size, pos + hdrLen + len));
            pos += hdrLen + len;
            if (!body.length) continue;
            if (names[id]) {
                if (!out[names[id]]) out[names[id]] = clean(id3Text(body[0], body.subarray(1)));
            } else if (id === 'APIC' || id === 'PIC') {
                var pic = id3Picture(body, id === 'PIC');
                if (pic && (!out.picture || pic.type === 3)) out.picture = pic;
            }
        }
        return out;
    }
    function id3Picture(b, v22) {
        var enc = b[0], o = 1, mime;
        if (v22) {
            var fmt = ascii(b, 1, 3).toLowerCase();
            mime = fmt === 'png' ? 'image/png' : 'image/jpeg';
            o = 4;
        } else {
            var e = strEnd(b, 1, 0);
            mime = ascii(b, 1, e - 1).toLowerCase() || 'image/jpeg';
            if (mime.indexOf('/') < 0) mime = 'image/' + (mime === 'png' ? 'png' : 'jpeg');
            o = e + 1;
        }
        var type = b[o];
        var d = strEnd(b, o + 1, enc);
        var data = b.subarray(d + (enc === 1 || enc === 2 ? 2 : 1));
        return data.length ? { mime: mime, type: type, bytes: data } : null;
    }

    /* ── Vorbis comments (FLAC, Ogg) ──────────────────────────────────── */
    var VORBIS = { TITLE: 'title', ARTIST: 'artist', ALBUM: 'album', ALBUMARTIST: 'albumArtist' };
    function parseVorbisComment(b, o, out) {
        if (o + 4 > b.length) return;
        var vendor = u32le(b, o); o += 4 + vendor;
        if (o + 4 > b.length) return;
        var n = u32le(b, o); o += 4;
        for (var i = 0; i < n && o + 4 <= b.length; i++) {
            var len = u32le(b, o); o += 4;
            var s = utf8(b.subarray(o, o + len)); o += len;
            var eq = s.indexOf('=');
            if (eq < 0) continue;
            var key = s.slice(0, eq).toUpperCase(), val = s.slice(eq + 1);
            if (VORBIS[key] && !out[VORBIS[key]]) out[VORBIS[key]] = clean(val);
            else if (key === 'METADATA_BLOCK_PICTURE' && !out.picture) {
                var pb = base64(val);
                if (pb) { var p = flacPicture(pb, 0); if (p) out.picture = p; }
            }
        }
    }
    function flacPicture(b, o) {
        if (o + 32 > b.length) return null;
        var type = u32be(b, o); o += 4;
        var ml = u32be(b, o); o += 4;
        var mime = ascii(b, o, ml).toLowerCase() || 'image/jpeg'; o += ml;
        var dl = u32be(b, o); o += 4 + dl;
        o += 16;                                   // width, height, depth, colours
        var len = u32be(b, o); o += 4;
        if (!len || o + len > b.length) return null;
        return { mime: mime, type: type, bytes: b.subarray(o, o + len) };
    }
    function base64(s) {
        try {
            var bin = typeof atob === 'function' ? atob(s) : Buffer.from(s, 'base64').toString('binary');
            var out = new Uint8Array(bin.length);
            for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
            return out;
        } catch (e) { return null; }
    }

    /* ── FLAC ─────────────────────────────────────────────────────────── */
    function parseFlac(b) {
        var out = {}, o = 4;
        while (o + 4 <= b.length) {
            var last = b[o] & 0x80, type = b[o] & 0x7F, len = u24be(b, o + 1);
            var end = o + 4 + len;
            if (end > b.length) {
                // The tags may still be after this block (padding often
                // comes first), so read past it unless it was the last.
                var want = (type === 4 || type === 6 || last) ? end : end + 65536;
                return want <= MAX_NEED ? merge(out, { need: want }) : out;
            }
            if (type === 4) parseVorbisComment(b, o + 4, out);
            else if (type === 6 && !out.picture) {
                var p = flacPicture(b, o + 4);
                if (p) out.picture = p;
            }
            if (last) return out;
            o = end;
        }
        // Ran out before the last block: its header, at least, is still to come.
        return o + 65536 <= MAX_NEED ? merge(out, { need: o + 65536 }) : out;
    }

    /* ── Ogg Vorbis / Opus ────────────────────────────────────────────── */
    /* Reassemble the second logical packet (the comment header) of the
     * first stream from the pages it's spread over. */
    function parseOgg(b) {
        var o = 0, packets = [], cur = [], curLen = 0;
        while (o + 27 <= b.length && packets.length < 2) {
            if (ascii(b, o, 4) !== 'OggS') return {};
            var nseg = b[o + 26], segs = o + 27, data = segs + nseg;
            if (data > b.length) break;
            for (var i = 0; i < nseg; i++) {
                var l = b[segs + i];
                if (data + l > b.length) return packets.length > 1 ? {} : needMore(b.length);
                cur.push(b.subarray(data, data + l)); curLen += l;
                data += l;
                if (l < 255) { packets.push(join(cur, curLen)); cur = []; curLen = 0; if (packets.length === 2) break; }
            }
            o = data;
        }
        if (packets.length < 2) return needMore(b.length);
        var p = packets[1], out = {};
        if (p.length > 7 && ascii(p, 1, 6) === 'vorbis' && p[0] === 3) parseVorbisComment(p, 7, out);
        else if (p.length > 8 && ascii(p, 0, 8) === 'OpusTags') parseVorbisComment(p, 8, out);
        return out;
    }
    /* Ogg gives no total up front; ask for double until the cap. */
    function needMore(have) {
        return have * 2 <= MAX_NEED ? { need: Math.max(have * 2, 65536) } : {};
    }
    function join(parts, len) {
        var out = new Uint8Array(len), o = 0;
        parts.forEach(function (p) { out.set(p, o); o += p.length; });
        return out;
    }

    /* ── M4A ──────────────────────────────────────────────────────────── */
    var ILST = { '©nam': 'title', '©ART': 'artist', '©alb': 'album', 'aART': 'albumArtist' };
    function parseMp4(b) {
        var o = 0;
        while (o + 8 <= b.length) {
            var size = u32be(b, o), type = ascii(b, o + 4, 4);
            if (size === 1 || size < 8) return {};   // 64-bit sizes are for mdat, which we never need
            if (type === 'moov') {
                if (o + size > b.length) return o + size <= MAX_NEED ? { need: o + size } : {};
                var out = {};
                var udta = child(b, o + 8, o + size, 'udta');
                var meta = udta && child(b, udta.start, udta.end, 'meta');
                var ilst = meta && child(b, meta.start + 4, meta.end, 'ilst');   // meta is a full box
                if (ilst) readIlst(b, ilst, out);
                return out;
            }
            o += size;
        }
        return {};
    }
    function child(b, start, end, want) {
        var o = start;
        while (o + 8 <= end) {
            var size = u32be(b, o);
            if (size < 8) return null;
            if (ascii(b, o + 4, 4) === want) return { start: o + 8, end: Math.min(end, o + size) };
            o += size;
        }
        return null;
    }
    function readIlst(b, ilst, out) {
        var o = ilst.start;
        while (o + 8 <= ilst.end) {
            var size = u32be(b, o), name = String.fromCharCode(b[o + 4]) + ascii(b, o + 5, 3);
            if (size < 8) return;
            var data = child(b, o + 8, o + size, 'data');
            if (data && data.end - data.start > 8) {
                var kind = u32be(b, data.start) & 0xFFFFFF;
                var payload = b.subarray(data.start + 8, data.end);
                if (ILST[name] && !out[ILST[name]]) out[ILST[name]] = clean(utf8(payload));
                else if (name === 'covr' && !out.picture)
                    out.picture = { mime: kind === 14 ? 'image/png' : 'image/jpeg', type: 3, bytes: payload };
            }
            o += size;
        }
    }

    function merge(a, b) { for (var k in b) a[k] = b[k]; return a; }

    /* bytes: the head of the file.  → { title, artist, album, albumArtist,
     * picture: { mime, type, bytes } } with whatever was found, plus
     * `need` when a longer head would find more. */
    function parse(bytes) {
        var b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
        try {
            if (b.length >= 10 && ascii(b, 0, 3) === 'ID3' && b[3] >= 2 && b[3] <= 4) return parseId3(b);
            if (b.length >= 4 && ascii(b, 0, 4) === 'fLaC') return parseFlac(b);
            if (b.length >= 4 && ascii(b, 0, 4) === 'OggS') return parseOgg(b);
            if (b.length >= 8 && ascii(b, 4, 4) === 'ftyp') return parseMp4(b);
        } catch (e) {}
        return {};
    }

    return { parse: parse };
})();

// Ignored by the Tizen/browser build; lets Node tests drive the module.
if (typeof module !== 'undefined' && module.exports) module.exports = AudioTags;
