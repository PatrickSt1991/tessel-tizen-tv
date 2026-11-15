'use strict';

/* A subtitle line delivered by the TV's own decoder (an embedded track the
 * app could not read out of the file itself) is taken down by a timer set
 * to the cue's duration.  The timer ran on while playback was paused, so
 * the line vanished a few seconds into the pause (issue #174).  pause() now
 * holds the timer with what is left of it and play() starts it again. */

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

function shown() { return !overlay.classList.contains('hidden'); }

test('a native cue is taken down when its duration is up', function (t) {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    Player.showSubtitleText('Hello', 3000);
    assert.equal(shown(), true);
    t.mock.timers.tick(2999);
    assert.equal(shown(), true);
    t.mock.timers.tick(1);
    assert.equal(shown(), false);
});

test('a cue on screen stays up for as long as playback is paused', function (t) {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    Player.showSubtitleText('Hello', 3000);
    t.mock.timers.tick(1000);
    Player.pause();
    t.mock.timers.tick(60000);
    assert.equal(shown(), true);
});

test('after resuming, the cue gets the rest of its time and no more', function (t) {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    Player.showSubtitleText('Hello', 3000);
    t.mock.timers.tick(1000);
    Player.pause();
    t.mock.timers.tick(60000);
    Player.play();
    t.mock.timers.tick(1999);
    assert.equal(shown(), true);
    t.mock.timers.tick(1);
    assert.equal(shown(), false);
});

test('a seek while paused takes the held cue down', function (t) {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    Player.showSubtitleText('Hello', 3000);
    Player.pause();
    Player.seekTo(120000);
    assert.equal(shown(), false);
    // Nothing left to fire on resume.
    Player.play();
    t.mock.timers.tick(10000);
    assert.equal(shown(), false);
});

test('a new cue while paused replaces the held one and is held itself on the next pause', function (t) {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    Player.showSubtitleText('One', 3000);
    Player.pause();
    Player.showSubtitleText('Two', 2000);
    Player.play();
    t.mock.timers.tick(1999);
    assert.equal(shown(), true);
    t.mock.timers.tick(1);
    assert.equal(shown(), false);
});
