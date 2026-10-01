/* Back up and restore Tessel's own data as tessel-backup.json on a USB stick
 * (issue #115).
 *
 * Everything Tessel remembers lives in localStorage, and uninstalling the
 * app wipes it, so the backup has to leave the TV: the root of a USB stick
 * is the one place the app can write to that the user can carry to another
 * TV.  No new privilege is needed, filesystem.write and externalstorage are
 * already in config.xml for the USB browser.
 *
 * What goes in:
 *   - Settings, minus the cast pairing code.  A second TV restored from the
 *     same file would otherwise share the first TV's ntfy topic and grab the
 *     URLs meant for it.  Scanning the QR again is quick.
 *   - SMB servers.  Their passwords only when the user asks for them, since
 *     the file is plain JSON.  A restore without passwords keeps the password
 *     this TV already has for the same server, if it has one.
 *   - The transcode server.  Its token is no secret on the LAN (the box hands
 *     it out on /api/status without a login), so it always goes along.
 *   - The debug listener.
 *   - Recents, watched marks and resume positions, unless the user leaves
 *     them out.
 * What stays out: caches that rebuild themselves (the TV locale, the list of
 * files direct play failed on) and the relay secret, which is minted again
 * on first use.
 *
 * The SMB server ids are kept as they are: files on an added server carry
 * &srv=<id> in their URL, so recents and resume positions only line up with
 * their server again if the id survives the round trip.
 *
 * ES5 on purpose, like the rest of the app. */

var Backup = (function () {
    'use strict';

    var FILE_NAME = 'tessel-backup.json';
    var FORMAT    = 'tessel-backup';
    var VERSION   = 1;

    var KEYS = {
        settings: 'vlctv_settings_v1',
        smb:      'vlctv_smb_v1',
        smbExtra: 'vlctv_smb_extra_v1',
        server:   'vlctv_server_v1',
        debug:    'vlctv_debug_v1'
    };
    var HISTORY_KEYS = {
        recent:  'vlctv_recent_v1',
        watched: 'vlctv_watched_v1',
        resume:  'vlctv_resume_v1'
    };

    function log(m) { if (typeof Debug !== 'undefined' && Debug.send) Debug.send('BACKUP', m); }

    function readJson(storage, key) {
        var raw = null;
        try { raw = storage.getItem(key); } catch (e) {}
        if (raw == null) return undefined;
        try { return JSON.parse(raw); } catch (e) { return undefined; }
    }
    function writeJson(storage, key, value) {
        try { storage.setItem(key, JSON.stringify(value)); } catch (e) {}
    }
    function copy(o) { return JSON.parse(JSON.stringify(o)); }

    function withoutPass(server) {
        if (!server || typeof server !== 'object') return server;
        var c = copy(server);
        delete c.pass;
        return c;
    }

    /* The backup object for what `storage` holds now.
     * opts: { passwords, history, appVersion, now (Date) } */
    function build(storage, opts) {
        opts = opts || {};
        var data = {};

        var settings = readJson(storage, KEYS.settings);
        if (settings && typeof settings === 'object') {
            settings = copy(settings);
            delete settings.urlDropCode;
            data.settings = settings;
        }

        var smb = readJson(storage, KEYS.smb);
        if (smb && typeof smb === 'object')
            data.smb = opts.passwords ? smb : withoutPass(smb);
        var extra = readJson(storage, KEYS.smbExtra);
        if (Array.isArray(extra))
            data.smbExtra = opts.passwords ? extra : extra.map(withoutPass);

        var server = readJson(storage, KEYS.server);
        if (server && server.url) data.server = server;
        var debug = readJson(storage, KEYS.debug);
        if (debug && typeof debug === 'object') data.debug = debug;

        if (opts.history) {
            for (var k in HISTORY_KEYS) {
                var v = readJson(storage, HISTORY_KEYS[k]);
                if (v !== undefined) data[k] = v;
            }
        }

        return {
            format:        FORMAT,
            version:       VERSION,
            tesselVersion: opts.appVersion || '',
            exportedAt:    (opts.now || new Date()).toISOString(),
            passwords:     !!opts.passwords,
            data:          data
        };
    }

    function fail(code) { var e = new Error(code); e.code = code; return e; }

    /* Check a file's text is a backup this build can restore.  Throws an
     * Error whose .code is 'notBackup' or 'newer'. */
    function parse(text) {
        var b;
        try { b = JSON.parse(String(text || '').replace(/^﻿/, '')); } catch (e) { throw fail('notBackup'); }
        if (!b || b.format !== FORMAT || typeof b.version !== 'number' ||
            !b.data || typeof b.data !== 'object') throw fail('notBackup');
        if (b.version > VERSION) throw fail('newer');
        return b;
    }

    function lower(s) { return String(s || '').toLowerCase(); }
    function sameServer(a, b) {
        return lower(a.host) === lower(b.host) && lower(a.share) === lower(b.share) &&
               lower(a.user) === lower(b.user);
    }
    /* A server restored without its password takes the one this TV already
     * keeps for the same host, share and user. */
    function keepPass(server, current) {
        if (!server || typeof server !== 'object' || server.pass) return server;
        for (var i = 0; i < current.length; i++)
            if (current[i] && current[i].pass && sameServer(server, current[i])) {
                var c = copy(server);
                c.pass = current[i].pass;
                return c;
            }
        return server;
    }

    /* Write a parsed backup into `storage`.  Only what the backup carries is
     * replaced; the rest is left as it is. */
    function restore(storage, b) {
        var d = b.data;

        if (d.settings && typeof d.settings === 'object') {
            var settings = copy(d.settings);
            var current = readJson(storage, KEYS.settings) || {};
            // This TV's own pairing code, never another TV's (see the top).
            delete settings.urlDropCode;
            if (current.urlDropCode) settings.urlDropCode = current.urlDropCode;
            writeJson(storage, KEYS.settings, settings);
        }

        var known = [];
        var curSmb = readJson(storage, KEYS.smb);
        if (curSmb && typeof curSmb === 'object') known.push(curSmb);
        var curExtra = readJson(storage, KEYS.smbExtra);
        if (Array.isArray(curExtra)) known = known.concat(curExtra);

        if (d.smb && typeof d.smb === 'object') writeJson(storage, KEYS.smb, keepPass(d.smb, known));
        if (Array.isArray(d.smbExtra))
            writeJson(storage, KEYS.smbExtra, d.smbExtra.map(function (s) { return keepPass(s, known); }));

        if (d.server && d.server.url) writeJson(storage, KEYS.server, d.server);
        if (d.debug && typeof d.debug === 'object') writeJson(storage, KEYS.debug, d.debug);

        for (var k in HISTORY_KEYS)
            if (d[k] !== undefined) writeJson(storage, HISTORY_KEYS[k], d[k]);
    }

    /* ── the USB side ─────────────────────────────────────────────────── */

    function isUsb(root) { return /removable|usb/i.test(root.name); }

    function usbRoots(cb) {
        if (typeof Browser === 'undefined') { cb([]); return; }
        Browser.listRoots(function (err, roots) {
            cb(err ? [] : roots.filter(isUsb));
        });
    }

    function joinPath(dir, name) { return String(dir || '').replace(/\/+$/, '') + '/' + name; }

    /* Tizen 5.0+ has openFile(); older firmware only the File/FileStream
     * API the USB browser reads with.  Try the current one first and fall
     * back, the same way the MP4 reader does. */
    function writeText(root, text, cb) {
        var path = joinPath(root.fullPath, FILE_NAME);
        if (tizen.filesystem.openFile) {
            try {
                var h = tizen.filesystem.openFile(path, 'w');
                h.writeString(text);
                h.close();
                cb(null, path);
                return;
            } catch (e) {
                log('openFile write failed (' + e.message + '), trying the File API');
            }
        }
        try {
            tizen.filesystem.resolve(root.name, function (dir) {
                var f;
                try { f = dir.resolve(FILE_NAME); }
                catch (e) {
                    try { f = dir.createFile(FILE_NAME); } catch (e2) { cb(e2); return; }
                }
                f.openStream('w', function (s) {
                    try { s.write(text); s.close(); cb(null, path); }
                    catch (e) { try { s.close(); } catch (x) {} cb(e); }
                }, cb, 'UTF-8');
            }, cb, 'rw');
        } catch (e) { cb(e); }
    }

    function readText(root, cb) {
        var path = joinPath(root.fullPath, FILE_NAME);
        function modern() {
            if (!tizen.filesystem.openFile) { cb(new Error('no reader')); return; }
            try {
                var h = tizen.filesystem.openFile(path, 'r');
                var text = h.readString();
                h.close();
                cb(null, text);
            } catch (e) { cb(e); }
        }
        try {
            tizen.filesystem.resolve(path, function (f) {
                f.openStream('r', function (s) {
                    try { var text = s.read(s.bytesAvailable); s.close(); cb(null, text); }
                    catch (e) { try { s.close(); } catch (x) {} modern(); }
                }, function () { modern(); }, 'UTF-8');
            }, function (e) { cb(e); }, 'r');
        } catch (e) { cb(e); }
    }

    /* Every readable backup at the top of a USB stick:
     * cb([{ root, backup }], firstError) */
    function findBackups(roots, cb) {
        var found = [], firstErr = null, pending = roots.length;
        if (!pending) { cb(found, null); return; }
        roots.forEach(function (root) {
            readText(root, function (err, text) {
                if (!err) {
                    try { found.push({ root: root, backup: parse(text) }); }
                    catch (e) { if (!firstErr) firstErr = e; }
                }
                if (--pending === 0) cb(found, firstErr);
            });
        });
    }

    /* ── Settings rows ────────────────────────────────────────────────── */

    var includePasswords = false;
    var includeHistory   = true;

    function toast(m) { if (typeof UI !== 'undefined' && UI.toast) UI.toast(m); }
    function onOff(v) { return I18n.t(v ? 'common.on' : 'common.off'); }
    function driveLabel(root) { return I18n.t('browse.usbTitle') + ' (' + root.fullPath + ')'; }
    function pad(n) { return n < 10 ? '0' + n : '' + n; }
    function when(iso) {
        var d = new Date(iso);
        if (isNaN(d.getTime())) return '?';
        return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
               ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
    }
    function appVersion() {
        return (typeof TvInfo !== 'undefined' && TvInfo.getAppVersion) ? TvInfo.getAppVersion() : '';
    }
    function pick(title, options, onPick) {
        if (window.VlcApp && window.VlcApp.openPicker) window.VlcApp.openPicker(title, options, '', onPick);
    }

    function save(root) {
        var b = build(localStorage, { passwords: includePasswords, history: includeHistory,
                                      appVersion: appVersion() });
        writeText(root, JSON.stringify(b, null, 2), function (err, path) {
            if (err) {
                log('write to ' + root.fullPath + ' failed: ' + (err.message || err));
                toast(I18n.t('backup.saveFailed', err.message || String(err)));
                return;
            }
            log('saved ' + path + (b.passwords ? ' (with passwords)' : ''));
            toast(I18n.t(b.passwords ? 'backup.savedPasswords' : 'backup.saved', path));
        });
    }

    function startSave() {
        usbRoots(function (roots) {
            if (!roots.length) { toast(I18n.t('backup.noUsb')); return; }
            if (roots.length === 1) { save(roots[0]); return; }
            pick(I18n.t('backup.chooseDrive'), roots.map(function (r, i) {
                return { code: String(i), name: driveLabel(r) };
            }), function (i) { save(roots[+i]); });
        });
    }

    function startRestore() {
        usbRoots(function (roots) {
            if (!roots.length) { toast(I18n.t('backup.noUsb')); return; }
            findBackups(roots, function (found, err) {
                if (!found.length) {
                    if (!err) toast(I18n.t('backup.notFound'));
                    else toast(I18n.t(err.code === 'newer' ? 'backup.err.newer' : 'backup.err.notBackup'));
                    return;
                }
                pick(I18n.t('backup.restoreTitle'), found.map(function (f, i) {
                    return { code: String(i),
                             name: I18n.t('backup.entry', when(f.backup.exportedAt),
                                          f.backup.tesselVersion || '?', driveLabel(f.root)) };
                }), function (i) {
                    restore(localStorage, found[+i].backup);
                    log('restored from ' + found[+i].root.fullPath);
                    toast(I18n.t('backup.restored'));
                    // Every module read its storage at start-up, so start
                    // again rather than chase each one.  Soon, before any
                    // of them writes its old copy back.
                    setTimeout(function () { location.reload(); }, 1200);
                });
            });
        });
    }

    function wireSettings() {
        var passBtn = document.getElementById('backup-pass');
        if (!passBtn) return;
        var passVal = document.getElementById('backup-pass-val');
        var histBtn = document.getElementById('backup-history');
        var histVal = document.getElementById('backup-history-val');
        function paint() {
            passVal.textContent = onOff(includePasswords);
            histVal.textContent = onOff(includeHistory);
        }
        paint();
        passBtn.addEventListener('click', function () { includePasswords = !includePasswords; paint(); });
        histBtn.addEventListener('click', function () { includeHistory = !includeHistory; paint(); });
        document.getElementById('backup-save').addEventListener('click', startSave);
        document.getElementById('backup-restore').addEventListener('click', startRestore);
    }
    if (typeof document !== 'undefined') {
        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wireSettings);
        else wireSettings();
    }

    return { FILE_NAME: FILE_NAME, build: build, parse: parse, restore: restore };
})();

// Ignored by the Tizen/browser build; lets Node tests require these helpers.
if (typeof module !== 'undefined' && module.exports) module.exports = Backup;
