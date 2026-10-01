'use strict';

var assert = require('assert');
var test   = require('node:test');
var Backup = require('../../tizen-app/js/backup.js');

var NAS   = { host: 'nas', port: 445, share: 'Media', user: 'tv', pass: 'pw', domain: '', anonymous: false };
var OTHER = { id: 'k3j9x2ab', host: '192.168.1.5', port: 445, share: 'Films', user: 'tv', pass: 'pw2', domain: '', anonymous: false };
var BOX   = { url: 'http://192.168.1.20:8200', token: 'tok', name: 'box', api: 3 };

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
