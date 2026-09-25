'use strict';

var assert = require('assert');
var test   = require('node:test');
var fs     = require('fs');
var vm     = require('vm');
var path   = require('path');

var SRC = fs.readFileSync(
    path.join(__dirname, '../../tizen-app/service/service.js'), 'utf8');

/* service.js opens sockets and starts listening the moment it is required, so
 * lift just the NT-status table and its helpers out of the source and run
 * those in a sandbox — same trick as smb-settings.test.js. */
function loadStatusHelpers() {
    var start = SRC.indexOf('var NT_STATUS = {');
    assert.notStrictEqual(start, -1, 'NT_STATUS table not found in service.js');
    var fn = SRC.indexOf('function ntText(', start);
    assert.notStrictEqual(fn, -1, 'ntText() not found in service.js');
    var end = SRC.indexOf('\n}\n', fn) + 3;

    var sandbox = { module: { exports: {} } };
    vm.runInNewContext(SRC.slice(start, end) +
        '\nmodule.exports = { NT_STATUS: NT_STATUS, ntHex: ntHex, ntName: ntName, ntText: ntText };',
        sandbox);
    return sandbox.module.exports;
}

var S = loadStatusHelpers();

test('a known status reads as words, with the code kept for bug reports', function () {
    // 0xc00000cc is what a wrong Share field looks like on the wire.
    assert.strictEqual(S.ntText(0xC00000CC),
        'no share with that name on the server (STATUS_BAD_NETWORK_NAME 0xc00000cc)');
});

test('the auth step no longer calls every failure a bad password', function () {
    // 0xc000000d is the server rejecting the message, not the credentials
    // (github issue #83) — it used to be logged as "Authentication failed".
    var text = S.ntText(0xC000000D);
    assert.match(text, /not the password/);
    assert.match(text, /STATUS_INVALID_PARAMETER 0xc000000d/);
    assert.match(S.ntText(0xC000006D), /wrong username or password/);
});

test('an unlisted status falls back to the bare hex', function () {
    assert.strictEqual(S.ntText(0xC0000225), '0xc0000225');
    assert.strictEqual(S.ntName(0xC0000225), '');
});

test('statuses that are part of a normal exchange stay unnamed', function () {
    // MORE_PROCESSING (NTLM round 1), NO_MORE_FILES (end of a listing) and
    // END_OF_FILE (end of a read) are all expected, so naming them in the log
    // would read like a failure.
    [0xC0000016, 0x80000006, 0xC0000011].forEach(function (st) {
        assert.strictEqual(S.ntName(st), '', 'unexpected name for ' + S.ntHex(st));
    });
});

test('every key matches the hex the lookup actually builds', function () {
    // A stray uppercase digit or a missing 0x would make an entry dead code.
    Object.keys(S.NT_STATUS).forEach(function (key) {
        var status = parseInt(key, 16);
        assert.strictEqual(S.ntHex(status), key, 'unreachable NT_STATUS key ' + key);
        assert.strictEqual(S.NT_STATUS[key].length, 2, 'bad entry for ' + key);
    });
});
