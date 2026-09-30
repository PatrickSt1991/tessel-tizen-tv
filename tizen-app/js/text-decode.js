/* Turn the raw bytes of a text file into a string, for the text viewer and
 * the playlist reader.
 *
 * Files on a NAS come from everywhere, so the encoding is guessed:
 *   1. a byte-order mark says it outright (UTF-8, UTF-16 LE/BE);
 *   2. otherwise, bytes that are valid UTF-8 are UTF-8;
 *   3. otherwise it is a legacy 8-bit file.  Cyrillic Windows files are
 *      common enough (issue #107) to be worth telling apart from Western
 *      ones: in windows-1251 the letters sit at 0xC0–0xFF, so a file whose
 *      high bytes are mostly there is read as 1251, anything else as 1252.
 *
 * A file with NUL bytes in its first few KB (and no UTF-16 mark) is binary;
 * decode() says so rather than painting noise. */

var TextDecode = (function () {
    var SNIFF = 8192;

    function hasDecoder(label) {
        if (typeof TextDecoder === 'undefined') return false;
        try { new TextDecoder(label); return true; } catch (e) { return false; }
    }

    function bomOf(b) {
        if (b.length >= 3 && b[0] === 0xEF && b[1] === 0xBB && b[2] === 0xBF) return { enc: 'utf-8', skip: 3 };
        if (b.length >= 2 && b[0] === 0xFF && b[1] === 0xFE) return { enc: 'utf-16le', skip: 2 };
        if (b.length >= 2 && b[0] === 0xFE && b[1] === 0xFF) return { enc: 'utf-16be', skip: 2 };
        return null;
    }

    function looksBinary(b) {
        var n = Math.min(b.length, SNIFF);
        for (var i = 0; i < n; i++) if (b[i] === 0) return true;
        return false;
    }

    /* Strict UTF-8 check that doesn't need TextDecoder's fatal mode.  A
     * sequence cut off by the end of the buffer is allowed: the viewer reads
     * big files only partly, and the cut can land inside a character. */
    function isUtf8(b) {
        var i = 0, n = b.length;
        while (i < n) {
            var c = b[i];
            if (c < 0x80) { i++; continue; }
            var need;
            if (c >= 0xC2 && c <= 0xDF) need = 1;
            else if (c >= 0xE0 && c <= 0xEF) need = 2;
            else if (c >= 0xF0 && c <= 0xF4) need = 3;
            else return false;
            for (var j = 1; j <= need; j++) {
                if (i + j >= n) return true;
                if ((b[i + j] & 0xC0) !== 0x80) return false;
            }
            i += need + 1;
        }
        return true;
    }

    function guessLegacy(b) {
        var high = 0, cyr = 0;
        for (var i = 0; i < b.length; i++) {
            if (b[i] < 0x80) continue;
            high++;
            if (b[i] >= 0xC0) cyr++;
        }
        return (high >= 8 && cyr / high > 0.6) ? 'windows-1251' : 'windows-1252';
    }

    /* Fallbacks for a WebView without TextDecoder (or without the label). */
    function manualUtf8(b) {
        var s = '';
        for (var i = 0; i < b.length; i += 4096)
            s += String.fromCharCode.apply(null, Array.prototype.slice.call(b, i, i + 4096));
        try { return decodeURIComponent(escape(s)); } catch (e) { return s; }
    }
    function manualLatin1(b) {
        var s = '';
        for (var i = 0; i < b.length; i += 4096)
            s += String.fromCharCode.apply(null, Array.prototype.slice.call(b, i, i + 4096));
        return s;
    }

    function run(enc, b) {
        if (hasDecoder(enc)) return new TextDecoder(enc).decode(b);
        return enc === 'utf-8' ? manualUtf8(b) : manualLatin1(b);
    }

    /* bytes: Uint8Array (or array of octets).
     * Returns { text, encoding } or { binary: true }. */
    function decode(bytes) {
        var b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
        var bom = bomOf(b);
        if (bom) return { text: run(bom.enc, b.subarray(bom.skip)), encoding: bom.enc.toUpperCase() };
        if (looksBinary(b)) return { binary: true };
        var enc = isUtf8(b) ? 'utf-8' : guessLegacy(b);
        return { text: run(enc, b), encoding: enc.toUpperCase() };
    }

    /* Windows (CRLF) and old-Mac (CR) line ends → LF.  CRLF first, or each
     * one would come out as two breaks. */
    function normalizeLineEndings(s) {
        return String(s).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    }

    return { decode: decode, normalizeLineEndings: normalizeLineEndings, isUtf8: isUtf8 };
})();

// Ignored by the Tizen/browser build; lets Node tests drive the module.
if (typeof module !== 'undefined' && module.exports) module.exports = TextDecode;
