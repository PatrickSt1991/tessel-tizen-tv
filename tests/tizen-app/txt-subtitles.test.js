'use strict';

/* Issue #165: Polish subtitles come as .txt files in MicroDVD, MPL2 or
 * TMPlayer form.  The Samsung player reads them; Tessel did not list a .txt
 * next to a video as a subtitle at all, and had no parser for the three
 * shapes.  The files are usually windows-1250 or ISO-8859-2 as well, which
 * the encoding guess read as windows-1252 ("co siê sta³o"). */

var assert = require('assert');
var test   = require('node:test');
var fs     = require('fs');
var vm     = require('vm');
var path   = require('path');
var I18n   = require('./helpers/i18n.js');

global.AssStyle = require('../../tizen-app/js/ass-style.js');
var Player     = require('../../tizen-app/js/player.js');
var TextDecode = require('../../tizen-app/js/text-decode.js');

function near(a, b, msg) { assert.ok(Math.abs(a - b) < 0.002, (msg || '') + ' ' + a + ' ~ ' + b); }

/* ── the three formats ───────────────────────────────────────────────── */

test('MicroDVD: frames at the header frame rate, | breaks lines, {y:i} tags go', function () {
    var cues = Player.parseTxtCues([
        '{1}{1}25',
        '{125}{200}{y:i}Nie wiem,|co się stało.',
        '{250}{}Dobranoc.',
        '{400}{450}Koniec.'
    ].join('\r\n'));
    assert.strictEqual(cues.length, 3);
    near(cues[0].start, 5);  near(cues[0].end, 8);
    assert.strictEqual(cues[0].text, 'Nie wiem,\nco się stało.');
    // A blank end runs to the next cue, at most four seconds.
    near(cues[1].start, 10); near(cues[1].end, 14);
    near(cues[2].start, 16); near(cues[2].end, 18);
});

test('MicroDVD without a frame-rate line assumes 23.976', function () {
    var cues = Player.parseTxtCues('{2398}{4796}Hello');
    assert.strictEqual(cues.length, 1);
    near(cues[0].start, 100.017);
    near(cues[0].end, 200.033);
});

test('MPL2: tenths of a second, a leading slash marks italics and is dropped', function () {
    var cues = Player.parseTxtCues([
        '[12][38]/Pierwsza linia|druga linia',
        '[40][]Trzecia'
    ].join('\n'));
    assert.strictEqual(cues.length, 2);
    near(cues[0].start, 1.2); near(cues[0].end, 3.8);
    assert.strictEqual(cues[0].text, 'Pierwsza linia\ndruga linia');
    near(cues[1].start, 4);   near(cues[1].end, 8);
});

test('TMPlayer: whole seconds, a line lasts until the next one, four seconds at most', function () {
    var cues = Player.parseTxtCues([
        '00:00:05:Pierwsza|linia',
        '0:00:07=Druga',
        '00:00:20,1=Trzecia',
        '00:00:20,2=ciąg dalszy',
        '00:00:30:Ostatnia'
    ].join('\n'));
    assert.strictEqual(cues.length, 4);
    near(cues[0].start, 5);  near(cues[0].end, 7);
    assert.strictEqual(cues[0].text, 'Pierwsza\nlinia');
    near(cues[1].start, 7);  near(cues[1].end, 11);
    assert.strictEqual(cues[2].text, 'Trzecia\nciąg dalszy');
    near(cues[2].start, 20); near(cues[2].end, 24);
    near(cues[3].start, 30); near(cues[3].end, 34);
});

test('an SRT renamed to .txt still parses as SRT', function () {
    var cues = Player.parseTxtCues('1\n00:00:01,000 --> 00:00:03,000\nHello\n\n2\n00:00:04,000 --> 00:00:06,000\nWorld\n');
    assert.strictEqual(cues.length, 2);
    near(cues[1].start, 4); near(cues[1].end, 6);
    assert.strictEqual(cues[1].text, 'World');
});

test('a .txt that is not a subtitle yields no cues', function () {
    assert.deepStrictEqual(Player.parseTxtCues('Some notes about the film.\nNothing timed.'), []);
});

/* ── listing a .txt next to a video ──────────────────────────────────── */

function loadSmb() {
    var sandbox = {
        module: { exports: {} },
        Debug:  { send: function () {} },
        I18n:   I18n,
        FileTypes: require('../../tizen-app/js/filetypes.js'),
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
function loadBrowser() {
    var sandbox = {
        module: { exports: {} },
        Debug: { player: function () {}, browse: function () {} },
        FileTypes: require('../../tizen-app/js/filetypes.js'),
        TextDecode: TextDecode
    };
    vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../../tizen-app/js/browser.js'), 'utf8'), sandbox);
    return sandbox.module.exports;
}

test('SMB and WebDAV listings pair a .txt with its video', function () {
    var SMB = loadSmb();
    var subs = SMB.siblingSubtitles([
        { name: 'Film.mkv', isDir: false, size: 1 },
        { name: 'Film.txt', isDir: false, size: 1 },
        { name: 'Film.pl.txt', isDir: false, size: 1 },
        { name: 'Readme.txt', isDir: false, size: 1 }
    ], '/x', { host: 'nas', share: 's' });
    // Joined: the sandbox's arrays have another realm's prototype.
    var got = subs['Film.mkv'].map(function (s) { return s.name + ':' + s.ext + ':' + s.lang; }).sort().join(' ');
    assert.strictEqual(got, 'Film.pl.txt:txt:pl Film.txt:txt:');
});

test('the USB browser counts a .txt as a subtitle', function () {
    var Browser = loadBrowser();
    assert.strictEqual(Browser.isSubtitle('Film.txt'), true);
    assert.strictEqual(Browser.isSubtitle('Film.TXT'), true);
    assert.strictEqual(Browser.isSubtitle('Film.sub'), false, 'VobSub stays out');
});

/* ── Polish code pages ───────────────────────────────────────────────── */

var CP1250 = { 'ą': 0xB9, 'ć': 0xE6, 'ę': 0xEA, 'ł': 0xB3, 'ń': 0xF1, 'ó': 0xF3, 'ś': 0x9C, 'ź': 0x9F, 'ż': 0xBF,
               'Ą': 0xA5, 'Ć': 0xC6, 'Ę': 0xCA, 'Ł': 0xA3, 'Ń': 0xD1, 'Ó': 0xD3, 'Ś': 0x8C, 'Ź': 0x8F, 'Ż': 0xAF };
var ISO2   = { 'ą': 0xB1, 'ć': 0xE6, 'ę': 0xEA, 'ł': 0xB3, 'ń': 0xF1, 'ó': 0xF3, 'ś': 0xB6, 'ź': 0xBC, 'ż': 0xBF,
               'Ą': 0xA1, 'Ć': 0xC6, 'Ę': 0xCA, 'Ł': 0xA3, 'Ń': 0xD1, 'Ó': 0xD3, 'Ś': 0xA6, 'Ź': 0xAC, 'Ż': 0xAF };
function encode(s, table) {
    var out = [];
    for (var i = 0; i < s.length; i++) {
        var ch = s.charAt(i);
        if (table[ch] !== undefined) out.push(table[ch]);
        else { var c = s.charCodeAt(i); assert.ok(c < 0x80, 'no byte for ' + ch); out.push(c); }
    }
    return new Uint8Array(out);
}
/* windows-1252: Latin-1 plus the few letters it keeps in 0x80..0x9F. */
var CP1252 = { 'œ': 0x9C, 'Œ': 0x8C, 'š': 0x9A, 'ž': 0x9E, 'Ÿ': 0x9F };
function cp1252(s) {
    var out = [];
    for (var i = 0; i < s.length; i++) {
        var ch = s.charAt(i), c = s.charCodeAt(i);
        if (CP1252[ch] !== undefined) out.push(CP1252[ch]);
        else { assert.ok(c < 0x100, 'no byte for ' + ch); out.push(c); }
    }
    return new Uint8Array(out);
}

var PL = '{1}{1}25\r\n{120}{180}Nie wiem, co się stało.|Zażółć gęślą jaźń.\r\n' +
         '{200}{260}Łódź, Śląsk, Źródło, Żaba.\r\n{300}{360}Proszę, dziękuję, do widzenia.\r\n';

test('a windows-1250 MicroDVD file decodes with its Polish letters', function () {
    var d = TextDecode.decode(encode(PL, CP1250));
    assert.strictEqual(d.encoding, 'WINDOWS-1250');
    assert.strictEqual(d.text, PL);
});

test('an ISO-8859-2 file is told apart from windows-1250', function () {
    var d = TextDecode.decode(encode(PL, ISO2));
    assert.strictEqual(d.encoding, 'ISO-8859-2');
    assert.strictEqual(d.text, PL);
});

var ES = '1\r\n00:00:01,000 --> 00:00:03,000\r\n¿Qué pasó? ¡No sé!\r\n\r\n' +
         '2\r\n00:00:04,000 --> 00:00:06,000\r\n¿Dónde está? ¿Y tú? ¡Vamos!\r\n';
var PT = '1\r\n00:00:01,000 --> 00:00:03,000\r\nNão são más ações, são boas intenções.\r\n';
var FR = '1\r\n00:00:01,000 --> 00:00:03,000\r\nMon cœur, où est la sœur? Très bien.\r\n';

test('Spanish, Portuguese and French files still read as windows-1252', function () {
    [ES, PT, FR].forEach(function (s) {
        var d = TextDecode.decode(cp1252(s));
        assert.strictEqual(d.encoding, 'WINDOWS-1252', s);
        assert.strictEqual(d.text, s);
    });
});
