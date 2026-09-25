'use strict';

var assert = require('assert');
var test   = require('node:test');
var fs     = require('fs');
var path   = require('path');

var ROOT = path.join(__dirname, '../../tizen-app');
var I18n = require('../../tizen-app/js/i18n.js');
var en   = require('../../tizen-app/i18n/en.json');

function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }

/* Every key the app asks for: I18n.t('…') in the scripts, nameKey/shortKey
 * in the settings lists, and the data-i18n* attributes in the markup. */
function usedKeys() {
    var keys = {};
    fs.readdirSync(path.join(ROOT, 'js')).forEach(function (f) {
        var src = read('js/' + f);
        var re = /I18n\.t\(\s*'([^']+)'|(?:nameKey|shortKey):\s*'([^']+)'/g, m;
        while ((m = re.exec(src))) keys[m[1] || m[2]] = 'js/' + f;
        // I18n.t(cond ? 'a' : 'b') — both branches are keys.
        var tern = /I18n\.t\([^()']*\?\s*'([^']+)'\s*:\s*'([^']+)'/g;
        while ((m = tern.exec(src))) { keys[m[1]] = 'js/' + f; keys[m[2]] = 'js/' + f; }
    });
    var html = read('index.html');
    var re = /data-i18n(?:-fmt|-placeholder|-title|-alt|-aria-label)?="([^"]+)"/g, m;
    while ((m = re.exec(html))) keys[m[1]] = 'index.html';
    return keys;
}

test('every key the app uses has an English text', function () {
    var keys = usedKeys();
    var missing = Object.keys(keys).filter(function (k) { return !(k in en); });
    assert.deepStrictEqual(missing.map(function (k) { return k + ' (' + keys[k] + ')'; }), []);
});

/* Looser than usedKeys(): any quoted key anywhere in the code counts, which
 * covers keys picked by a nested ternary. */
test('en.json carries no keys the app no longer uses', function () {
    var src = read('index.html');
    fs.readdirSync(path.join(ROOT, 'js')).forEach(function (f) { src += read('js/' + f); });
    var stale = Object.keys(en).filter(function (k) {
        return src.indexOf("'" + k + "'") < 0 && src.indexOf('"' + k + '"') < 0;
    });
    assert.deepStrictEqual(stale, []);
});

test('t() fills {0}, {1} … in order and leaves an unfilled slot visible', function () {
    I18n._setTables({ a: 'Paired with {0} — sent it your share ({1})', b: 'Only {0}' }, null, 'en');
    assert.strictEqual(I18n.t('a', 'NAS', 'nas/Media'), 'Paired with NAS — sent it your share (nas/Media)');
    assert.strictEqual(I18n.t('b'), 'Only {0}');
});

test('a translation falls back to English per key, and a missing key shows itself', function () {
    I18n._setTables({ hello: 'Hello', bye: 'Bye' }, { hello: 'Hallo' }, 'nl-NL');
    assert.strictEqual(I18n.t('hello'), 'Hallo');
    assert.strictEqual(I18n.t('bye'), 'Bye');
    assert.strictEqual(I18n.t('nope.missing'), 'nope.missing');
});

test('match() maps TV and setting locales onto the offered languages', function () {
    assert.strictEqual(I18n.match('nl'), 'nl-NL');
    assert.strictEqual(I18n.match('nl_BE'), 'nl-NL');
    assert.strictEqual(I18n.match('pt-PT'), 'pt-PT');
    assert.strictEqual(I18n.match('pt'), 'pt-BR');
    assert.strictEqual(I18n.match('zh-TW'), 'zh-TW');
    assert.strictEqual(I18n.match('nb-NO'), 'no-NO');
    assert.strictEqual(I18n.match('en-US'), 'en');
    assert.strictEqual(I18n.match('xx'), 'en');
    assert.strictEqual(I18n.match(''), 'en');
});

/* The transcode server's setup page uses the same scheme with its own table. */
var SETUP = path.join(__dirname, '../../transcode-server/internal/web/static');
var setupEn = require('../../transcode-server/internal/web/static/i18n/en.json');

/* Both translation folders, each with its English source. */
var TABLES = [
    { dir: path.join(ROOT, 'i18n'), en: en },
    { dir: path.join(SETUP, 'i18n'), en: setupEn }
];

function translations(table) {
    return fs.readdirSync(table.dir).filter(function (f) { return f !== 'en.json' && /\.json$/.test(f); })
        .map(function (f) { return { file: f, strings: JSON.parse(fs.readFileSync(path.join(table.dir, f), 'utf8')) }; });
}

test('every placeholder in a translation exists in the English text', function () {
    TABLES.forEach(function (table) {
        translations(table).forEach(function (tr) {
            Object.keys(tr.strings).forEach(function (k) {
                var want = (String(table.en[k] || '').match(/\{\d+\}/g) || []).sort().join();
                var got  = (String(tr.strings[k]).match(/\{\d+\}/g) || []).sort().join();
                assert.strictEqual(got, want, tr.file + ': ' + k);
            });
        });
    });
});

test('a translation carries no keys English no longer has', function () {
    TABLES.forEach(function (table) {
        translations(table).forEach(function (tr) {
            var stale = Object.keys(tr.strings).filter(function (k) { return !(k in table.en); });
            assert.deepStrictEqual(stale, [], table.dir + '/' + tr.file);
        });
    });
});

/* The language menus list every language, so each one needs its file —
 * otherwise picking it quietly shows English. */
test('every offered language has a translation for the app and the setup page', function () {
    TABLES.forEach(function (table) {
        var missing = I18n.languages().map(function (l) { return l.code; }).filter(function (code) {
            return !fs.existsSync(path.join(table.dir, code + '.json'));
        });
        assert.deepStrictEqual(missing, [], table.dir);
    });
});

test('the setup page offers the same languages as the app', function () {
    var src = fs.readFileSync(path.join(SETUP, 'i18n.js'), 'utf8');
    var list = src.slice(src.indexOf('const LANGUAGES'), src.indexOf('];'));
    var codes = [], m, re = /\['([^']+)',/g;
    while ((m = re.exec(list))) codes.push(m[1]);
    assert.deepStrictEqual(codes, I18n.languages().map(function (l) { return l.code; }));
});

test('the setup page and its en.json agree on the keys', function () {
    var html = fs.readFileSync(path.join(SETUP, 'index.html'), 'utf8');
    var js   = fs.readFileSync(path.join(SETUP, 'app.js'), 'utf8') +
               fs.readFileSync(path.join(SETUP, 'i18n.js'), 'utf8');
    var used = {}, m;
    var re = /data-i18n(?:-fmt|-placeholder)?="([^"]+)"|I18n\.t\('([^']+)'|\bt\('([a-z]+\.[A-Za-z.]+)'/g;
    while ((m = re.exec(html + js))) used[m[1] || m[2] || m[3]] = true;
    assert.deepStrictEqual(Object.keys(used).filter(function (k) { return !(k in setupEn); }), []);
    var src = html + js;
    assert.deepStrictEqual(Object.keys(setupEn).filter(function (k) {
        return src.indexOf("'" + k + "'") < 0 && src.indexOf('"' + k + '"') < 0;
    }), []);
});
