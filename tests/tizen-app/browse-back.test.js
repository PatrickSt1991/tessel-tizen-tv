/* Where Back goes from a local folder (issue #183): out of a pinned folder
 * to Favorites, from the top of a drive to the list of drives. */
'use strict';

var assert = require('assert');
var test   = require('node:test');
var Browser = require('../../tizen-app/js/browser.js');

var ROOT = '/opt/media/USBDriveA1';

test('the top of a drive goes to the list of drives, not to /opt/media', function () {
    // As resolve() names it, and as File.parent of a folder below it does.
    assert.strictEqual(Browser.upTarget(ROOT, ROOT, null), 'roots');
    assert.strictEqual(Browser.upTarget(ROOT + '/', ROOT, null), 'roots');
    assert.strictEqual(Browser.upTarget(ROOT, ROOT + '/', null), 'roots');
});

test('a folder below the top goes one folder up', function () {
    assert.strictEqual(Browser.upTarget(ROOT + '/Series', ROOT, null), 'parent');
    assert.strictEqual(Browser.upTarget(ROOT + '/Series/', ROOT, null), 'parent');
    // A drive whose name starts with this one's is another drive.
    assert.strictEqual(Browser.upTarget(ROOT + '0', ROOT, null), 'parent');
});

test('the pinned folder goes to Favorites, the folders inside it go up', function () {
    var pinned = ROOT + '/Series/Bleach';
    assert.strictEqual(Browser.upTarget(pinned, ROOT, pinned), 'favorites');
    assert.strictEqual(Browser.upTarget(pinned + '/', ROOT, pinned), 'favorites');
    assert.strictEqual(Browser.upTarget(pinned + '/Season 1/', ROOT, pinned), 'parent');
    // Without a virtual root on record (an older pin) it still does.
    assert.strictEqual(Browser.upTarget(pinned, null, pinned), 'favorites');
});

test('virtual-root paths, as some firmware reports them', function () {
    assert.strictEqual(Browser.upTarget('removable_sda1/', 'removable_sda1', null), 'roots');
    assert.strictEqual(Browser.upTarget('images', 'images', null), 'roots');
    assert.strictEqual(Browser.upTarget('removable_sda1/Shows', 'removable_sda1', 'removable_sda1/Shows'), 'favorites');
});

test('nothing known: one folder up, as before', function () {
    assert.strictEqual(Browser.upTarget('', '', ''), 'parent');
    assert.strictEqual(Browser.upTarget(undefined, null, null), 'parent');
    assert.strictEqual(Browser.upTarget(ROOT + '/Series', null, null), 'parent');
});
