'use strict';

/* Issue #162: a Portuguese .srt saved by a Windows tool is windows-1252,
 * and read as UTF-8 every accented letter came out as a replacement glyph.
 * The legacy-charset guess also mistook such a file for Russian, because
 * 1252's accented Latin letters share the 0xC0–0xFF range with 1251's
 * Cyrillic. */

var assert = require('assert');
var test   = require('node:test');
var fs     = require('fs');
var vm     = require('vm');
var path   = require('path');

var TextDecode = require('../../tizen-app/js/text-decode.js');

function latin1(s) { return new Uint8Array(Buffer.from(s, 'latin1')); }
function cp1251(s) {
    // Only the letters these tests need: Cyrillic а–я / А–Я sit at 0xE0–0xFF / 0xC0–0xDF.
    var out = [];
    for (var i = 0; i < s.length; i++) {
        var c = s.charCodeAt(i);
        if (c >= 0x430 && c <= 0x44F) out.push(c - 0x430 + 0xE0);
        else if (c >= 0x410 && c <= 0x42F) out.push(c - 0x410 + 0xC0);
        else out.push(c);
    }
    return new Uint8Array(out);
}

var PT = '1\r\n00:00:01,000 --> 00:00:03,000\r\nNão são más ações, são boas intenções.\r\n\r\n' +
         '2\r\n00:00:04,000 --> 00:00:06,000\r\nAmanhã à tarde, coração e emoção.\r\n';
var RU = '1\r\n00:00:01,000 --> 00:00:03,000\r\nПривет, мир. Это субтитры.\r\n\r\n' +
         '2\r\n00:00:04,000 --> 00:00:06,000\r\nДжон и Мэри идут в Hollywood.\r\n';

test('a Western subtitle file full of accents is windows-1252, not Cyrillic', function () {
    var d = TextDecode.decode(latin1(PT));
    assert.strictEqual(d.encoding, 'WINDOWS-1252');
    assert.strictEqual(d.text, PT);
});

test('a Russian subtitle file with timecodes and a Latin name is still windows-1251', function () {
    var d = TextDecode.decode(cp1251(RU));
    assert.strictEqual(d.encoding, 'WINDOWS-1251');
    assert.strictEqual(d.text, RU);
});

/* Browser.readSubtitleText end to end: the bytes of a sidecar served by the
 * smbproxy come back as text in the right encoding. */
function loadBrowser(xhrBody) {
    var src = fs.readFileSync(path.join(__dirname, '../../tizen-app/js/browser.js'), 'utf8');
    var logged = [];
    function FakeXhr() {
        var self = this;
        this.headers = {};
        this.open = function () {};
        this.setRequestHeader = function (k, v) { self.headers[k] = v; };
        this.getResponseHeader = function () { return null; };
        this.send = function () {
            self.status = 200;
            self.response = xhrBody.buffer.slice(xhrBody.byteOffset, xhrBody.byteOffset + xhrBody.byteLength);
            self.responseText = Buffer.from(xhrBody).toString('utf8');
            self.onload();
        };
    }
    var sandbox = {
        module: { exports: {} },
        Debug: { player: function (m) { logged.push(m); }, browse: function () {} },
        FileTypes: require('../../tizen-app/js/filetypes.js'),
        TextDecode: TextDecode,
        XMLHttpRequest: FakeXhr,
        Uint8Array: Uint8Array, ArrayBuffer: ArrayBuffer, Error: Error
    };
    vm.createContext(sandbox);
    vm.runInContext(src, sandbox);
    return { Browser: sandbox.module.exports, logged: logged };
}

test('a windows-1252 sidecar on a share is read as text with its accents', function (t, done) {
    var env = loadBrowser(latin1(PT));
    env.Browser.readSubtitleText({ uri: 'http://127.0.0.1:8127/file?x', name: 'Filme.pt.srt', ext: 'srt' },
        function (err, text) {
            assert.ifError(err);
            assert.strictEqual(text, PT);
            assert.ok(env.logged.some(function (m) { return /Filme\.pt\.srt.*WINDOWS-1252/.test(m); }),
                      'the encoding is logged: ' + env.logged.join(' | '));
            done();
        });
});

test('a UTF-8 sidecar with a byte-order mark still reads as before', function (t, done) {
    var body = new Uint8Array(Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from(PT, 'utf8')]));
    var env = loadBrowser(body);
    env.Browser.readSubtitleText({ uri: 'http://127.0.0.1:8127/file?x', name: 'Filme.srt', ext: 'srt' },
        function (err, text) {
            assert.ifError(err);
            assert.strictEqual(text, PT);
            done();
        });
});
