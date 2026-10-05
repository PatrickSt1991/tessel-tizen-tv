'use strict';

var assert   = require('assert');
var test     = require('node:test');
var Playlist = require('../../tizen-app/js/playlist.js');

var fold = Playlist.foldText;
function finds(typed, title) { return fold(title).indexOf(fold(typed)) >= 0; }

test('case and accents are ignored', function () {
    assert.ok(finds('cafe', 'Café TV'));
    assert.ok(finds('SPORT', 'Eurosport 1'));
    assert.ok(finds('  news ', 'BBC News'));
});

test('Cyrillic typed with Latin lookalikes still finds the channel (issue #132)', function () {
    // What a Russian TV keyboard put in the field: Б, Latin e, л, Latin a, Latin p.
    var typed = 'Бeлap';
    assert.ok(finds(typed, 'Беларусь 24'));
    assert.ok(finds('Бе', 'Беларусь 24'));
    // Capitals that only look alike in upper case.
    assert.ok(finds('HTB', 'НТВ'));
    assert.ok(finds('KOMEДИЯ', 'Комедия'));
});

test('plain Cyrillic and plain Latin filters behave as before', function () {
    assert.ok(finds('спорт', 'Матч! Спорт'));
    assert.ok(finds('Ёлка', 'ёлка'));
    assert.ok(!finds('спорт', 'Кино'));
    assert.ok(!finds('news', 'Sky Sports'));
});
