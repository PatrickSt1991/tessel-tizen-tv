'use strict';

var assert = require('assert');
var test   = require('node:test');
var Backup = require('../../tizen-app/js/backup.js');

var NAS   = { host: 'nas', port: 445, share: 'Media', user: 'tv', pass: 'pw', domain: '', anonymous: false };
var OTHER = { id: 'k3j9x2ab', host: '192.168.1.5', port: 445, share: 'Films', user: 'tv', pass: 'pw2', domain: '', anonymous: false };
var BOX   = { url: 'http://192.168.1.20:8200', token: 'tok', name: 'box', api: 3 };
var SAVED = [{ id: 'q8w2e4r6', name: 'NASA Live', url: 'https://example.com/nasa.m3u8' }];

function storage(init) {
    var s = {};
    Object.keys(init || {}).forEach(function (k) { s[k] = JSON.stringify(init[k]); });
    return {
        getItem: function (k) { return k in s ? s[k] : null; },
        setItem: function (k, v) { s[k] = String(v); },
        json:    function (k) { return k in s ? JSON.parse(s[k]) : undefined; }
    };
}

function fullTv() {
    return storage({
        vlctv_settings_v1:  { uiLanguage: 'ru-RU', autoPlay: true, urlDropCode: 'abc123defg' },
        vlctv_smb_v1:       NAS,
        vlctv_smb_extra_v1: [OTHER],
        vlctv_server_v1:    BOX,
        vlctv_saved_v1:     SAVED,
        vlctv_debug_v1:     { enabled: false, host: '192.168.1.50', port: 9999 },
        vlctv_recent_v1:    [{ uri: 'http://127.0.0.1:8127/smb/stream?path=a.mkv', title: 'a.mkv' }],
        vlctv_watched_v1:   { 'x': 1 },
        vlctv_resume_v1:    { 'x': { pos: 1000, dur: 5000, ts: 1 } },
        vlctv_relay_key_v1: 'secret',
        vlctv_tv_locale_v1: 'ru-RU'
    });
}

test('a backup leaves SMB passwords out unless asked, and never carries the pairing code', function () {
    var b = Backup.build(fullTv(), { appVersion: '1.14.1', now: new Date('2026-10-01T12:00:00Z') });
    assert.strictEqual(b.format, 'tessel-backup');
    assert.strictEqual(b.tesselVersion, '1.14.1');
    assert.strictEqual(b.exportedAt, '2026-10-01T12:00:00.000Z');
    assert.strictEqual(b.passwords, false);
    assert.strictEqual(b.data.smb.pass, undefined);
    assert.strictEqual(b.data.smbExtra[0].pass, undefined);
    assert.strictEqual(b.data.smbExtra[0].id, 'k3j9x2ab');
    assert.strictEqual(b.data.settings.urlDropCode, undefined);
    assert.strictEqual(b.data.settings.uiLanguage, 'ru-RU');
    assert.deepStrictEqual(b.data.server, BOX);
    // Saved streams go along even when history stays home.
    assert.deepStrictEqual(b.data.saved, SAVED);
    assert.strictEqual(b.data.recent, undefined);
    assert.ok(JSON.stringify(b).indexOf('secret') < 0);

    var withPass = Backup.build(fullTv(), { passwords: true, history: true });
    assert.strictEqual(withPass.data.smb.pass, 'pw');
    assert.strictEqual(withPass.data.smbExtra[0].pass, 'pw2');
    assert.strictEqual(withPass.data.recent.length, 1);
    assert.deepStrictEqual(withPass.data.resume, { 'x': { pos: 1000, dur: 5000, ts: 1 } });
});

test('a fresh install gets everything back from a backup with passwords', function () {
    var b = Backup.parse(JSON.stringify(Backup.build(fullTv(), { passwords: true, history: true })));
    var fresh = storage({ vlctv_settings_v1: { urlDropCode: 'newtvcode1' } });
    Backup.restore(fresh, b);
    assert.deepStrictEqual(fresh.json('vlctv_smb_v1'), NAS);
    assert.deepStrictEqual(fresh.json('vlctv_smb_extra_v1'), [OTHER]);
    assert.deepStrictEqual(fresh.json('vlctv_server_v1'), BOX);
    assert.deepStrictEqual(fresh.json('vlctv_saved_v1'), SAVED);
    assert.strictEqual(fresh.json('vlctv_settings_v1').autoPlay, true);
    // The new install's own pairing code stays.
    assert.strictEqual(fresh.json('vlctv_settings_v1').urlDropCode, 'newtvcode1');
    assert.strictEqual(fresh.json('vlctv_recent_v1').length, 1);
    assert.strictEqual(fresh.json('vlctv_relay_key_v1'), undefined);
});

test('a restore without passwords keeps the ones this TV already has for the same server', function () {
    var b = Backup.parse(JSON.stringify(Backup.build(fullTv(), {})));
    var tv = storage({ vlctv_smb_v1: { host: 'NAS', port: 445, share: 'media', user: 'tv', pass: 'kept' },
                       vlctv_recent_v1: [{ uri: 'mine' }] });
    Backup.restore(tv, b);
    assert.strictEqual(tv.json('vlctv_smb_v1').pass, 'kept');
    assert.strictEqual(tv.json('vlctv_smb_v1').host, 'nas');
    assert.strictEqual(tv.json('vlctv_smb_extra_v1')[0].pass, undefined);
    // History wasn't in the backup, so this TV's own stays.
    assert.deepStrictEqual(tv.json('vlctv_recent_v1'), [{ uri: 'mine' }]);
});

test('parse refuses files that are not a backup, or come from a newer Tessel', function () {
    function code(text) { try { Backup.parse(text); return 'ok'; } catch (e) { return e.code; } }
    assert.strictEqual(code('not json'), 'notBackup');
    assert.strictEqual(code('{"format":"something-else","version":1,"data":{}}'), 'notBackup');
    assert.strictEqual(code('{"format":"tessel-backup","version":1}'), 'notBackup');
    assert.strictEqual(code('{"format":"tessel-backup","version":99,"data":{}}'), 'newer');
    // Saved again by a Windows editor, byte-order mark and all.
    assert.strictEqual(code('﻿{"format":"tessel-backup","version":1,"data":{}}'), 'ok');
});

test('a debug log export is named after the moment it was made (issue #126)', function () {
    assert.strictEqual(Backup.logFileName(new Date(2026, 9, 2, 8, 7)), 'tessel-log-20261002-0807.txt');
});

/* ── writing to the stick (issue #126: files vanished with the stick) ── */

/* A fake tizen.filesystem: openFile() hands out a handle that records what
 * is done to it; resolve(path) answers with the size the "stick" reports. */
function fakeFs(opts) {
    opts = opts || {};
    var calls = [];
    var fs = {
        resolve: function (loc, ok, bad) {
            calls.push('resolve ' + loc);
            if (opts.resolveFails) { bad(new Error('not found')); return; }
            if (loc === 'removable1') {
                ok({ resolve: function (name) {
                    return { openStream: function (mode, okS) {
                        okS({ write: function (t) { calls.push('stream.write ' + t.length); },
                              close: function () { calls.push('stream.close'); } });
                    } };
                } });
                return;
            }
            ok({ fileSize: 'size' in opts ? opts.size : opts.written });
        }
    };
    if (!opts.noOpenFile) fs.openFile = function (p, mode) {
        calls.push('openFile ' + mode + ' ' + p);
        var h = {
            writeString: function (t) { opts.written = Buffer.byteLength(t, 'utf8'); calls.push('writeString'); },
            close:       function () { calls.push('close'); }
        };
        if (!opts.noFlush) h.flush = function () { calls.push('flush'); };
        if (!opts.noSync)  h.sync  = function () { calls.push('sync'); };
        return h;
    };
    return { fs: fs, calls: calls };
}
function withFs(fake, fn) {
    global.tizen = { filesystem: fake.fs };
    try { fn(); } finally { delete global.tizen; }
}
var STICK = { name: 'removable1', fullPath: '/opt/media/USBDriveA1' };

test('a file is flushed and synced to the stick before the handle closes, then looked up again', function () {
    var fake = fakeFs(), result;
    withFs(fake, function () {
        Backup.writeFile(STICK, 'tessel-backup.json', '{"a":"ё"}', function (err, p) { result = [err, p]; });
    });
    assert.deepStrictEqual(fake.calls, [
        'openFile w /opt/media/USBDriveA1/tessel-backup.json',
        'writeString', 'flush', 'sync', 'close',
        'resolve /opt/media/USBDriveA1/tessel-backup.json'
    ]);
    assert.deepStrictEqual(result, [null, '/opt/media/USBDriveA1/tessel-backup.json']);
});

test('firmware whose handle has no flush/sync still writes and closes', function () {
    var fake = fakeFs({ noFlush: true, noSync: true }), result;
    withFs(fake, function () {
        Backup.writeFile(STICK, 'x.txt', 'hello', function (err) { result = err; });
    });
    assert.deepStrictEqual(fake.calls.slice(1, 3), ['writeString', 'close']);
    assert.strictEqual(result, null);
});

test('a file the stick reports as empty is a failure, not a success toast', function () {
    var fake = fakeFs({ size: 0 }), result;
    withFs(fake, function () {
        Backup.writeFile(STICK, 'x.txt', 'hello', function (err) { result = err; });
    });
    assert.ok(result instanceof Error, 'expected an error');
    assert.match(result.message, /empty/);
});

test('a write the TV cannot look up again is taken on trust', function () {
    var fake = fakeFs({ resolveFails: true }), result;
    withFs(fake, function () {
        Backup.writeFile(STICK, 'x.txt', 'hello', function (err) { result = err; });
    });
    assert.strictEqual(result, null);
});

test('older firmware without openFile() falls back to a FileStream and still verifies', function () {
    var fake = fakeFs({ noOpenFile: true, size: 5 }), result;
    withFs(fake, function () {
        Backup.writeFile(STICK, 'x.txt', 'hello', function (err, p) { result = [err, p]; });
    });
    assert.deepStrictEqual(fake.calls, [
        'resolve removable1', 'stream.write 5', 'stream.close',
        'resolve /opt/media/USBDriveA1/x.txt'
    ]);
    assert.deepStrictEqual(result, [null, '/opt/media/USBDriveA1/x.txt']);
});

/* ── where a backup can go: USB sticks and SMB servers (issue #132) ──── */

var SHARE = { id: 'k3j9x2ab', host: 'nas', share: 'Media' };
function withPlaces(opts, fn) {
    opts = opts || {};
    var calls = [];
    global.Browser = { listRoots: function (cb) { cb(null, opts.roots || []); } };
    global.SMB = {
        servers:     function () { return opts.servers || []; },
        serverLabel: function (c) { return '\\\\' + c.host + '\\' + c.share; },
        writeText:   function (id, p, text, cb) { calls.push('write ' + id + ' ' + p + ' ' + text.length); cb(opts.writeErr || null, text.length); },
        readText:    function (id, p, cb) { calls.push('read ' + id + ' ' + p); cb(opts.readErr || null, opts.text || ''); }
    };
    global.I18n = { t: function (k) { return k; } };
    try { fn(calls); } finally { delete global.Browser; delete global.SMB; delete global.I18n; }
}

test('the places a backup can go are the sticks first, then every SMB server', function (t, done) {
    withPlaces({ roots: [STICK, { name: 'internal0', fullPath: '/opt/usr' }], servers: [SHARE, { id: '', host: '10.0.0.2', share: 'Films' }] }, function () {
        Backup.destinations(function (list) {
            assert.deepStrictEqual(list.map(function (d) { return d.kind; }), ['usb', 'smb', 'smb']);
            assert.strictEqual(Backup.destLabel(list[1]), '\\\\nas\\Media');
            assert.strictEqual(Backup.destPath(list[1], 'tessel-backup.json'), '\\\\nas\\Media\\tessel-backup.json');
            assert.strictEqual(Backup.destPath(list[0], 'tessel-backup.json'), '/opt/media/USBDriveA1/tessel-backup.json');
            done();
        });
    });
});

test('a backup written to a share goes to the top of that share through the service, and is read back from there', function (t, done) {
    withPlaces({ servers: [SHARE], text: '{"format":"tessel-backup"}' }, function (calls) {
        Backup.saveTo({ kind: 'smb', server: SHARE }, 'tessel-backup.json', 'hello', function (err, p) {
            assert.ifError(err);
            assert.strictEqual(p, '\\\\nas\\Media\\tessel-backup.json');
            Backup.readFrom({ kind: 'smb', server: SHARE }, 'tessel-backup.json', function (e2, text) {
                assert.ifError(e2);
                assert.strictEqual(text, '{"format":"tessel-backup"}');
                assert.deepStrictEqual(calls, ['write k3j9x2ab /tessel-backup.json 5', 'read k3j9x2ab /tessel-backup.json']);
                done();
            });
        });
    });
});

test('a share that will not take the file reports the error with the path', function (t, done) {
    withPlaces({ servers: [SHARE], writeErr: new Error('open "/tessel-backup.json": STATUS_ACCESS_DENIED') }, function () {
        Backup.saveTo({ kind: 'smb', server: SHARE }, 'tessel-backup.json', 'x', function (err, p) {
            assert.ok(/ACCESS_DENIED/.test(err.message));
            assert.strictEqual(p, '\\\\nas\\Media\\tessel-backup.json');
            done();
        });
    });
});
