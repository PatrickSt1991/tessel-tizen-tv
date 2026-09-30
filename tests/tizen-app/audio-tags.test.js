'use strict';

var assert = require('assert');
var test   = require('node:test');

global.TextDecode = require('../../tizen-app/js/text-decode.js');
var AudioTags = require('../../tizen-app/js/audio-tags.js');

/* Byte builders.  Buffers throughout; parse() gets a Uint8Array view. */
var B = Buffer.from, cat = Buffer.concat;
function be32(n) { var b = Buffer.alloc(4); b.writeUInt32BE(n); return b; }
function le32(n) { var b = Buffer.alloc(4); b.writeUInt32LE(n); return b; }
function be24(n) { return be32(n).subarray(1); }
function syncsafe(n) { return B([(n >> 21) & 127, (n >> 14) & 127, (n >> 7) & 127, n & 127]); }
function u8(buf) { return new Uint8Array(buf); }
var JPEG = B([0xFF, 0xD8, 0xFF, 0xE0, 1, 2, 3, 4]);
var PNG  = B([0x89, 0x50, 0x4E, 0x47, 9, 9]);

function id3(ver, frames) {
    var body = cat(frames.concat([Buffer.alloc(16)]));   // padding
    return cat([B('ID3'), B([ver, 0, 0]), syncsafe(body.length), body]);
}
function frame(ver, id, data) {
    var size = ver === 4 ? syncsafe(data.length) : be32(data.length);
    return cat([B(id), size, B([0, 0]), data]);
}
function text(enc, s) {
    if (enc === 1) return cat([B([1, 0xFF, 0xFE]), B(s, 'utf16le')]);
    if (enc === 3) return cat([B([3]), B(s, 'utf8'), B([0])]);
    return cat([B([0]), s]);   // s already a byte buffer
}
function apic(type, mime, pic) { return cat([B([0]), B(mime), B([0, type]), B('desc'), B([0]), pic]); }

test('ID3v2.3: UTF-16 text and the front cover preferred over other art', function () {
    var t = AudioTags.parse(u8(id3(3, [
        frame(3, 'TIT2', text(1, 'Звезда')),
        frame(3, 'TPE1', text(1, 'Кино')),
        frame(3, 'TALB', text(1, 'Группа крови')),
        frame(3, 'APIC', apic(0, 'image/png', PNG)),
        frame(3, 'APIC', apic(3, 'image/jpeg', JPEG))
    ])));
    assert.strictEqual(t.title, 'Звезда');
    assert.strictEqual(t.artist, 'Кино');
    assert.strictEqual(t.album, 'Группа крови');
    assert.strictEqual(t.picture.mime, 'image/jpeg');
    assert.deepStrictEqual(Buffer.from(t.picture.bytes), JPEG);
});

test('ID3v2.4: syncsafe frame sizes, UTF-8, and NUL-separated values', function () {
    var t = AudioTags.parse(u8(id3(4, [
        frame(4, 'TIT2', text(3, 'Song')),
        frame(4, 'TPE1', cat([B([3]), B('A'), B([0]), B('B'), B([0])]))
    ])));
    assert.strictEqual(t.title, 'Song');
    assert.strictEqual(t.artist, 'A / B');
});

test('ID3 "Latin-1" written by a Russian tagger is read as windows-1251', function () {
    var cp1251 = B([0xCF, 0xF0, 0xE8, 0xE2, 0xE5, 0xF2, 0x20, 0xEC, 0xE8, 0xF0]);   // Привет мир
    var t = AudioTags.parse(u8(id3(3, [frame(3, 'TIT2', text(0, cp1251))])));
    assert.strictEqual(t.title, 'Привет мир');
});

test('ID3v2.2: three-letter frames and PIC', function () {
    function f22(id, data) { return cat([B(id), be24(data.length), data]); }
    var t = AudioTags.parse(u8(id3(2, [
        f22('TT2', text(0, B('Old'))),
        f22('PIC', cat([B([0]), B('PNG'), B([3]), B([0]), PNG]))
    ])));
    assert.strictEqual(t.title, 'Old');
    assert.strictEqual(t.picture.mime, 'image/png');
});

test('an ID3 tag longer than the first read asks for the rest', function () {
    var whole = id3(3, [frame(3, 'TIT2', text(1, 'x')), frame(3, 'APIC', apic(3, 'image/jpeg', Buffer.alloc(5000)))]);
    var head = AudioTags.parse(u8(whole.subarray(0, 1024)));
    assert.strictEqual(head.need, whole.length);
    assert.strictEqual(AudioTags.parse(u8(whole)).title, 'x');
});

function vorbisComment(pairs) {
    var parts = [le32(4), B('test'), le32(pairs.length)];
    pairs.forEach(function (p) { var b = B(p, 'utf8'); parts.push(le32(b.length), b); });
    return cat(parts);
}
function flacPicture(type, mime, pic) {
    return cat([be32(type), be32(mime.length), B(mime), be32(0), be32(1), be32(1), be32(24), be32(0), be32(pic.length), pic]);
}
function flacBlock(type, last, data) { return cat([B([(last ? 0x80 : 0) | type]), be24(data.length), data]); }

test('FLAC: tags after a padding block are still found', function () {
    var file = cat([B('fLaC'),
        flacBlock(0, false, Buffer.alloc(34)),
        flacBlock(1, false, Buffer.alloc(9000)),
        flacBlock(6, false, flacPicture(3, 'image/png', PNG)),
        flacBlock(4, true, vorbisComment(['TITLE=Трек', 'artist=Группа', 'ALBUM=Альбом']))
    ]);
    var head = AudioTags.parse(u8(file.subarray(0, 4096)));
    assert.ok(head.need > 4096, 'asks to read past the padding');
    var t = AudioTags.parse(u8(file));
    assert.deepStrictEqual([t.title, t.artist, t.album, t.picture.mime], ['Трек', 'Группа', 'Альбом', 'image/png']);
});

/* Ogg pages carrying the given packets, split into 255-byte lacing. */
function ogg(packets, pageLimit) {
    var pages = [], segs = [], data = [];
    function flush() {
        if (!segs.length) return;
        pages.push(cat([B('OggS'), Buffer.alloc(22), B([segs.length]), B(segs), cat(data)]));
        segs = []; data = [];
    }
    packets.forEach(function (p) {
        for (var o = 0; ; o += 255) {
            var n = Math.min(255, p.length - o);
            segs.push(n); data.push(p.subarray(o, o + n));
            if (segs.length >= pageLimit) flush();
            if (n < 255) break;
        }
    });
    flush();
    return cat(pages);
}

test('Ogg Opus: a comment packet spread over pages, with a picture', function () {
    var pic = flacPicture(3, 'image/jpeg', JPEG).toString('base64');
    var file = ogg([cat([B('OpusHead'), Buffer.alloc(11)]),
                    cat([B('OpusTags'), vorbisComment(['TITLE=Long', 'ARTIST=' + 'x'.repeat(600), 'METADATA_BLOCK_PICTURE=' + pic])])], 2);
    var t = AudioTags.parse(u8(file));
    assert.strictEqual(t.title, 'Long');
    assert.strictEqual(t.artist.length, 600);
    assert.deepStrictEqual(Buffer.from(t.picture.bytes), JPEG);
    assert.ok(AudioTags.parse(u8(file.subarray(0, 200))).need, 'a cut-off packet asks for more');
});

test('Ogg Vorbis comment header', function () {
    var file = ogg([cat([B([1]), B('vorbis'), Buffer.alloc(23)]),
                    cat([B([3]), B('vorbis'), vorbisComment(['ALBUM=A', 'TITLE=T']), B([1])])], 10);
    var t = AudioTags.parse(u8(file));
    assert.deepStrictEqual([t.title, t.album], ['T', 'A']);
});

function atom(type, body) { return cat([be32(8 + body.length), B(type, 'latin1'), body]); }
function ilstItem(name, kind, payload) {
    return atom(name, atom('data', cat([be32(kind), be32(0), payload])));
}
function m4a(moovFirst) {
    var ilst = atom('ilst', cat([
        ilstItem('©nam', 1, B('Titel')),
        ilstItem('©ART', 1, B('Künstler')),
        ilstItem('covr', 14, PNG)
    ]));
    var moov = atom('moov', cat([atom('mvhd', Buffer.alloc(100)),
                                 atom('udta', atom('meta', cat([Buffer.alloc(4), atom('hdlr', Buffer.alloc(25)), ilst])))]));
    var ftyp = atom('ftyp', B('M4A \0\0\0\0'));
    var mdat = atom('mdat', Buffer.alloc(2000));
    return cat(moovFirst ? [ftyp, moov, mdat] : [ftyp, mdat, moov]);
}

test('M4A: iTunes tags and cover when moov comes first', function () {
    var t = AudioTags.parse(u8(m4a(true)));
    assert.deepStrictEqual([t.title, t.artist, t.picture.mime], ['Titel', 'Künstler', 'image/png']);
});

test('M4A with moov after the audio gives up quietly', function () {
    assert.deepStrictEqual(AudioTags.parse(u8(m4a(false).subarray(0, 1500))), {});
});

test('files without tags, or not audio at all', function () {
    assert.deepStrictEqual(AudioTags.parse(u8(B([0xFF, 0xFB, 0x90, 0x00, 1, 2, 3, 4, 5, 6, 7]))), {});
    assert.deepStrictEqual(AudioTags.parse(u8(B('hello world'))), {});
    assert.deepStrictEqual(AudioTags.parse(new Uint8Array(0)), {});
});
