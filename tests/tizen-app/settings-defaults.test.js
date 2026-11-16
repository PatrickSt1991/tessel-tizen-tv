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
function loadModules() {
    var sandbox = {
        module: { exports: {} },
        localStorage: { getItem: function () { return null; }, setItem: function () {} },
        navigator: { userAgent: 'test' },
        document:  { createElement: function () { return { canPlayType: function () { return ''; } }; } }
    };
    vm.createContext(sandbox);
    vm.runInContext(SRC, sandbox);
    return sandbox.module.exports;
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

test('dot-named files stay hidden unless switched on (issue #147)', function () {
    assert.strictEqual(loadSettings(null).get('showHidden'), false);
    assert.strictEqual(loadSettings({ showHidden: true }).get('showHidden'), true);
});

test('folders show the Play all rows unless switched off (issue #174)', function () {
    assert.strictEqual(loadSettings(null).get('folderPlayRows'), true);
    assert.strictEqual(loadSettings({ folderPlayRows: false }).get('folderPlayRows'), false);
    // A stored blob from before the setting existed gets the default.
    assert.strictEqual(loadSettings({ autoPlay: false }).get('folderPlayRows'), true);
});

test('the app opens on Home unless a start screen was chosen (issue #149)', function () {
    assert.strictEqual(loadSettings(null).get('startScreen'), 'home');
    assert.strictEqual(loadSettings({ startScreen: 'smb' }).get('startScreen'), 'smb');
    assert.strictEqual(loadSettings({ autoPlay: false }).get('startScreen'), 'home');
});

test('every start screen is a Home tile, and Home itself fires nothing', function () {
    var StartScreen = loadModules().StartScreen;
    var html = fs.readFileSync(path.join(__dirname, '../../tizen-app/index.html'), 'utf8');
    var tiles = {};
    var re = /<button class="tile" data-action="([^"]+)"/g, m;
    while ((m = re.exec(html))) tiles[m[1]] = true;
    assert.strictEqual(StartScreen.actionFor('home'), '');
    StartScreen.forList().forEach(function (s) {
        if (s.code === 'home') return;
        assert.ok(tiles[s.action], s.code + ' → ' + s.action + ' is not a Home tile');
    });
    assert.strictEqual(StartScreen.actionFor('servers'), 'browse-servers');
    // The tiles the Servers tile replaced (1.31.0) still open as chosen,
    // but aren't on offer any more.
    assert.strictEqual(StartScreen.actionFor('smb'), 'browse-smb');
    assert.strictEqual(StartScreen.actionFor('webdav'), 'browse-webdav');
    assert.strictEqual(StartScreen.actionFor('dlna'), 'browse-dlna');
    assert.strictEqual(StartScreen.forList().filter(function (s) { return /smb|dlna|webdav/.test(s.code); }).length, 0);
    // A value from a build that no longer has it falls back to Home.
    assert.strictEqual(StartScreen.actionFor('nope'), '');
});

test('subtitles are white and normal weight unless changed; yellow is on offer (issue #149)', function () {
    assert.strictEqual(loadSettings(null).get('subtitleColor'), 'white');
    assert.strictEqual(loadSettings(null).get('subtitleWeight'), 'normal');
    assert.strictEqual(loadSettings({ subtitleColor: 'yellow' }).get('subtitleColor'), 'yellow');
    var SubtitleStyle = loadModules().SubtitleStyle;
    var codes = SubtitleStyle.forColor().map(function (c) { return c.code; });
    assert.ok(codes.indexOf('yellow') >= 0, 'yellow missing from ' + codes);
    assert.strictEqual(SubtitleStyle.nameForColor('yellow'), 'Yellow');
    assert.strictEqual(SubtitleStyle.nameForWeight('bold'), 'Bold');
    // Unknown codes fall back to the first entry rather than throwing.
    assert.strictEqual(SubtitleStyle.nameForColor('purple'), 'White');
});

test('the Ko-fi banner shows until switched off', function () {
    assert.strictEqual(loadSettings(null).get('showSupport'), true);
    assert.strictEqual(loadSettings({ showSupport: false }).get('showSupport'), false);
});

test('video changes show controls by default and preserve an Off preference', function () {
    assert.strictEqual(loadSettings(null).get('showControlsOnVideoChange'), true);
    assert.strictEqual(loadSettings({ autoPlay: false }).get('showControlsOnVideoChange'), true);
    var s = loadSettings({ showControlsOnVideoChange: false });
    assert.strictEqual(s.get('showControlsOnVideoChange'), false);
    s.set('showControlsOnVideoChange', true);
    assert.strictEqual(s.get('showControlsOnVideoChange'), true);
});

test('video transitions respect the controls preference while initial opens and audio show controls', function () {
    var src = fs.readFileSync(path.join(__dirname, '../../tizen-app/js/app.js'), 'utf8');
    var decision = src.match(/showOpeningControls = !opts\.trackChange[^;]+;/)[0];
    [
        { change: true, audio: false, setting: false, expected: false },
        { change: true, audio: false, setting: true, expected: true },
        { change: false, audio: false, setting: false, expected: true },
        { change: true, audio: true, setting: false, expected: true }
    ].forEach(function (c) {
        var box = { opts: { trackChange: c.change }, isAudio: c.audio,
            Settings: { get: function () { return c.setting; } } };
        vm.runInNewContext(decision, box);
        assert.strictEqual(box.showOpeningControls, c.expected);
    });
});
