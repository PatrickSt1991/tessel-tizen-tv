'use strict';

/* Tessel Lite runs on the WebKit of a 2015 set (Tizen 2.3).  Nothing there can
 * be tried on a desk, so this keeps out what that engine does not know: syntax
 * after ES5, the newer DOM calls, and the CSS the full app is built on. */

var assert = require('assert');
var test   = require('node:test');
var fs     = require('fs');
var path   = require('path');

var DIR = path.join(__dirname, '../../tizen-lite');
function read(rel) { return fs.readFileSync(path.join(DIR, rel), 'utf8'); }

/* Comments and string contents out, so a word in a sentence is not taken for code. */
function codeOnly(src) {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/(^|[^:\\])\/\/[^\n]*/g, '$1')
        .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
        .replace(/"(?:[^"\\\n]|\\.)*"/g, '""');
}

var JS = ['js/core.js', 'js/app.js'];

var NOT_IN_JS = [
    [/=>/, 'arrow function'],
    [/\b(let|const)\s+[A-Za-z_$[{]/, 'let / const'],
    [/`/, 'template literal'],
    [/\bclass\s+[A-Za-z_$]/, 'class'],
    [/\b(async|await)\b/, 'async / await'],
    [/\bfor\s*\([^)]*\bof\b/, 'for...of'],
    [/\.\.\./, 'spread / rest'],
    [/\bPromise\b/, 'Promise'],
    [/\bfetch\s*\(/, 'fetch'],
    [/\b(Map|Set|Symbol|WeakMap)\b/, 'Map / Set / Symbol'],
    [/\.(includes|startsWith|endsWith|padStart|repeat|find|findIndex|closest|matches|remove|append|prepend)\s*\(/, 'a method newer than the engine'],
    [/\bObject\.(assign|entries|values)\b/, 'Object.assign / entries / values'],
    [/\bArray\.from\b/, 'Array.from'],
    [/\.classList\b/, 'classList (kept out: its two-argument toggle is missing there)'],
    [/\.dataset\b/, 'dataset'],
    [/\b(URL|URLSearchParams|TextDecoder|TextEncoder)\b/, 'URL / TextDecoder']
];

JS.forEach(function (file) {
    test(file + ' is ES5 and uses nothing newer than a 2015 set has', function () {
        var code = codeOnly(read(file));
        NOT_IN_JS.forEach(function (rule) {
            var m = rule[0].exec(code);
            assert.ok(!m, file + ': ' + rule[1] + ' near "' + (m ? code.substr(Math.max(0, m.index - 30), 70).replace(/\s+/g, ' ') : '') + '"');
        });
    });
});

test('the stylesheet uses nothing newer than a 2015 set has', function () {
    var css = read('css/lite.css').replace(/\/\*[\s\S]*?\*\//g, ' ');
    [
        [/var\(\s*--/, 'custom property'],
        [/(^|[\s;{])--[a-z]/i, 'custom property'],
        [/display\s*:\s*(inline-)?(grid|flex)/, 'grid / flexbox'],
        [/\bgrid-|(^|[\s;{])gap\s*:/, 'grid / gap'],
        [/\bcalc\(|\bmin\(|\bmax\(|\bclamp\(/, 'calc / min / max / clamp'],
        [/\d(vw|vh|vmin|vmax|rem)\b/, 'viewport or rem unit'],
        [/object-fit|backdrop-filter|inset\s*:|aspect-ratio/, 'a newer property'],
        [/:(focus-visible|focus-within|is|where|has)\b/, 'a newer selector'],
        [/(^|[\s;{])(transform|transition|animation)\s*:/, 'unprefixed transform / transition / animation'],
        [/@supports|@media/, 'at-rule that would hide a missing feature']
    ].forEach(function (rule) {
        var m = rule[0].exec(css);
        assert.ok(!m, rule[1] + ' near "' + (m ? css.substr(Math.max(0, m.index - 30), 70).replace(/\s+/g, ' ') : '') + '"');
    });
});

test('the page loads Samsung\'s API file and the scripts, in that order, and nothing else', function () {
    var html = read('index.html');
    var srcs = [], re = /<script[^>]*\bsrc="([^"]+)"/g, m;
    while ((m = re.exec(html))) srcs.push(m[1]);
    assert.deepStrictEqual(srcs, ['$WEBAPIS/webapis/webapis.js', 'js/core.js', 'js/app.js']);
    assert.ok(!/<script(?![^>]*\bsrc=)/.test(html), 'no inline script');
    assert.ok(/<object id="player-object" type="application\/avplayer">/.test(html), 'the element AVPlay draws in');
});

test('the package is its own app and installs from Tizen 2.3 on', function () {
    var xml = read('config.xml');
    var full = fs.readFileSync(path.join(DIR, '../tizen-app/config.xml'), 'utf8');
    var pkg = /package="([^"]+)"/.exec(xml)[1];
    assert.ok(/^[A-Za-z0-9]{10}$/.test(pkg), 'a package id is ten letters or digits: ' + pkg);
    assert.notStrictEqual(pkg, /package="([^"]+)"/.exec(full)[1], 'not the full app\'s package, or it would replace it');
    assert.ok(new RegExp('<tizen:application id="' + pkg + '\\.[A-Za-z0-9]+"').test(xml));
    assert.ok(/required_version="2\.3"/.test(xml));
    assert.ok(/^\d+\.\d+\.\d+$/.test(/<widget[^>]*\bversion="([^"]+)"/.exec(xml)[1]));
    assert.ok(!/<tizen:service/.test(xml), 'no background service');
});
