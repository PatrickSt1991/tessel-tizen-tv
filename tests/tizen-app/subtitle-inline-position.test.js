'use strict';

/* An SRT line can carry an ASS position tag: {\an8} puts a sign at the top
 * of the picture while the dialogue stays at the bottom, which is common in
 * anime releases.  The tag used to be stripped and the line painted with the
 * dialogue (issue #174).  It now picks the band the line is painted in,
 * whether the line came from a sidecar .srt, a track read out of the MKV, or
 * the TV's own decoder. */

var assert = require('assert');
var test   = require('node:test');

/* Just enough DOM for the overlay: classes, children, class lookup. */
function fakeEl() {
    var classes = {}, text = '';
    var el = {
        children: [],
        style: {},
        classList: {
            add:      function (c) { classes[c] = true; },
            remove:   function (c) { delete classes[c]; },
            contains: function (c) { return !!classes[c]; }
        },
        appendChild: function (c) { el.children.push(c); return c; },
        querySelectorAll: function (sel) {
            var want = sel.slice(1);
            return el.children.filter(function (c) {
                return (' ' + c.className + ' ').indexOf(' ' + want + ' ') >= 0;
            });
        },
        querySelector: function (sel) { return el.querySelectorAll(sel)[0] || null; }
    };
    Object.defineProperty(el, 'textContent', {
        get: function () { return text; },
        set: function (v) { text = String(v); el.children.length = 0; }
    });
    el.className = '';
    return el;
}

var overlay = fakeEl();
overlay.classList.add('hidden');
global.document = {
    getElementById: function (id) { return id === 'subtitle-overlay' ? overlay : null; },
    createElement:  function () { return fakeEl(); }
};
global.AssStyle = require('../../tizen-app/js/ass-style.js');
var Player = require('../../tizen-app/js/player.js');

function band(name) {
    return overlay.querySelector('.sub-band-' + name).children.map(function (l) {
        return l.textContent;
    });
}

test('an {\\an8} line from the TV decoder goes to the top, without the tag', function () {
    Player.showSubtitleText('{\\an8}MÉDICO A CARGO\r<br>DR. URYU ISHIDA\r', 2670);
    assert.deepEqual(band('top'), ['MÉDICO A CARGO\r\nDR. URYU ISHIDA']);
    assert.deepEqual(band('bottom'), []);
});

test('a line without a tag stays at the bottom', function () {
    Player.showSubtitleText('Hace tanto tiempo, Rukia.\r', 1418);
    assert.deepEqual(band('top'), []);
    assert.deepEqual(band('bottom'), ['Hace tanto tiempo, Rukia.']);
});

test('a sign and the dialogue under it show together, each in its own band', function () {
    Player.renderCues([
        { text: '{\\an8}RETADOR' },
        { text: '¿No es increíble Chad?' }
    ]);
    assert.deepEqual(band('top'), ['RETADOR']);
    assert.deepEqual(band('bottom'), ['¿No es increíble Chad?']);
});

test('{\\an5} is the middle band and {\\an7} is top left', function () {
    Player.renderCues([{ text: '{\\an5}Middle' }, { text: '{\\an7}Corner' }]);
    assert.deepEqual(band('middle'), ['Middle']);
    assert.deepEqual(band('top'), ['Corner']);
    assert.equal(overlay.querySelector('.sub-band-top').children[0].style.textAlign, 'left');
});

test('a band the cue was already given wins over a tag in its text', function () {
    Player.renderCues([{ text: '{\\an8}Sign', band: 'bottom' }]);
    assert.deepEqual(band('bottom'), ['Sign']);
});
