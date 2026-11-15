'use strict';

/* The Play all / Shuffle all rows sit on top of every folder that has
 * subfolders.  Someone who only browses video can switch them off in
 * Settings (issue #174); FolderPlay.addRows is the one place all three
 * browsers (USB, SMB, WebDAV) go through, so that is where the setting is
 * read. */

var assert = require('assert');
var test   = require('node:test');

global.FileTypes = require('../../tizen-app/js/filetypes.js');
global.I18n = { t: function (k) { return k; } };
global.document = {
    createElement: function () {
        return { className: '', innerHTML: '', addEventListener: function () {} };
    }
};
var FolderPlay = require('../../tizen-app/js/folder-play.js');

function fakeList() {
    var rows = [];
    return { rows: rows, insertBefore: function (li) { rows.push(li); } };
}
function withSetting(value, fn) {
    global.Settings = { get: function (k) { return k === 'folderPlayRows' ? value : undefined; } };
    try { fn(); } finally { delete global.Settings; }
}

test('addRows puts both rows in when the setting is on', function () {
    var ul = fakeList();
    withSetting(true, function () { FolderPlay.addRows(ul, null, '/', function () {}, function () {}); });
    assert.equal(ul.rows.length, 2);
    assert.ok(/folderPlay\.playAll/.test(ul.rows[0].innerHTML));
    assert.ok(/folderPlay\.shuffleAll/.test(ul.rows[1].innerHTML));
});

test('addRows adds nothing when the setting is off', function () {
    var ul = fakeList();
    withSetting(false, function () { FolderPlay.addRows(ul, null, '/', function () {}, function () {}); });
    assert.equal(ul.rows.length, 0);
});

test('addRows still works where there is no Settings object', function () {
    var ul = fakeList();
    FolderPlay.addRows(ul, null, '/', function () {}, function () {});
    assert.equal(ul.rows.length, 2);
});
