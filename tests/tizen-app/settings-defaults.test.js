'use strict';

var assert = require('assert');
var test   = require('node:test');
var fs     = require('fs');
var vm     = require('vm');
var path   = require('path');

var SRC = fs.readFileSync(
    path.join(__dirname, '../../tizen-app/js/settings.js'), 'utf8');

/* settings.js reads localStorage as it loads; hand it a stored blob (or
 * none) and get the Settings object back. */
function loadSettings(stored) {
    var store = {};
    if (stored) store['vlctv_settings_v1'] = JSON.stringify(stored);
    var sandbox = {
        module: { exports: {} },
        localStorage: {
            getItem: function (k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
            setItem: function (k, v) { store[k] = String(v); }
        },
        navigator: { userAgent: 'test' },
        document:  { createElement: function () { return { canPlayType: function () { return ''; } }; } }
    };
    vm.createContext(sandbox);
    vm.runInContext(SRC, sandbox);
    return sandbox.module.exports.Settings;
}

test('a fresh install plays the next file automatically (issue #126)', function () {
    var s = loadSettings(null);
    assert.strictEqual(s.get('autoPlay'), true);
});

test('a TV that had auto-play switched off keeps it off', function () {
    var s = loadSettings({ autoPlay: false, repeatMode: 'off' });
    assert.strictEqual(s.get('autoPlay'), false);
});

test('a slideshow shows each picture for 5 seconds unless told otherwise', function () {
    assert.strictEqual(loadSettings(null).get('slideshowSeconds'), 5);
    assert.strictEqual(loadSettings({ slideshowSeconds: 30 }).get('slideshowSeconds'), 30);
});

test('a fresh install keeps a Recently Played list; a TV that switched it off stays off (issue #142)', function () {
    assert.strictEqual(loadSettings(null).get('recentHistory'), true);
    assert.strictEqual(loadSettings({ recentHistory: false }).get('recentHistory'), false);
    // A stored blob from before the setting existed gets the default.
    assert.strictEqual(loadSettings({ autoPlay: false }).get('recentHistory'), true);
});
