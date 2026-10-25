'use strict';

var assert = require('assert');
var test   = require('node:test');
var UI     = require('../../tizen-app/js/ui.js');

/* Rows of 70 px in a list 700 px high: ten rows on screen. */
var ROW = 70, VIEW = 700;
function scrollFor(index, rows) {
    return UI.centredScrollTop(index * ROW, ROW, VIEW, rows * ROW);
}

test('centredScrollTop: a row mid-list is centred', function () {
    var top = scrollFor(50, 100);
    assert.equal(50 * ROW + ROW / 2 - top, VIEW / 2);
});

test('centredScrollTop: rows near the start leave the list at the top', function () {
    assert.equal(scrollFor(0, 100), 0);
    assert.equal(scrollFor(3, 100), 0);
    assert.equal(scrollFor(5, 100), ROW / 2);
});

test('centredScrollTop: rows near the end leave the list at the bottom', function () {
    var max = 100 * ROW - VIEW;
    assert.equal(scrollFor(99, 100), max);
    assert.equal(scrollFor(96, 100), max);
    assert.equal(scrollFor(94, 100), max - ROW / 2);
});

test('centredScrollTop: a list that fits does not scroll', function () {
    for (var i = 0; i < 6; i++) assert.equal(scrollFor(i, 6), 0);
    assert.equal(scrollFor(9, 10), 0);
});
