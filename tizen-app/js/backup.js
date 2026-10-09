/* Back up and restore Tessel's own data as tessel-backup.json on a USB stick
 * (issue #115) or at the top of an SMB share (issue #132).
 *
 * Everything Tessel remembers lives in localStorage, and uninstalling the
 * app wipes it, so the backup has to leave the TV.  The root of a USB stick
 * was the one place the app could write to that the user can carry to
 * another TV — until a 2024 set turned out to keep what apps write on a
 * stick only until the stick is pulled, flushed and synced or not.  A share
 * the TV already reads films from is the other place: the service's SMB
 * client writes the file there, and a second TV with the same server set up
 * restores from it.  No new privilege is needed, filesystem.write and
 * externalstorage are already in config.xml for the USB browser.
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
 *   - The streams saved on the URL screen (issue #119) and the folders
 *     pinned to Favorites (issue #140).
 *   - The debug listener.
 *   - Recents, watched marks and resume positions, unless the user leaves
 *     them out.
 * The same plumbing writes the debug log out as tessel-log-<when>.txt
 * (Settings → Debug logging → Save debug log, issue #126), so a problem can
 * be reported after the fact without a listener running.
 * What stays out: caches that rebuild themselves (the TV locale, the list of
 * files direct play failed on) and the relay secret, which is minted again
 * on first use.
 *
 * The SMB server ids are kept as they are: files on an added server carry
 * &srv=<id> in their URL and pinned folders name their server by it, so
 * recents, resume positions and favorites only line up with their server
 * again if the id survives the round trip.
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
        saved:    'vlctv_saved_v1',
        favorites: 'vlctv_favorites_v1',
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
        var saved = readJson(storage, KEYS.saved);
        if (Array.isArray(saved)) data.saved = saved;
        var favorites = readJson(storage, KEYS.favorites);
        if (Array.isArray(favorites)) data.favorites = favorites;
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
        if (Array.isArray(d.saved)) writeJson(storage, KEYS.saved, d.saved);
        if (Array.isArray(d.favorites)) writeJson(storage, KEYS.favorites, d.favorites);
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

    /* Write `text` as `name` at the top of the stick: cb(err, path).
     * Tizen 5.0+ has openFile(); older firmware only the File/FileStream
     * API the USB browser reads with.  Try the current one first and fall
     * back, the same way the MP4 reader does.
     *
     * A file that only sits in the TV's write cache is gone the moment the
     * stick is pulled, and nobody "safely removes" a stick from a TV: the
     * files 1.18.0 saved vanished with the stick (issue #126).  So the
     * handle is flushed and synced to the stick before it is closed, and
     * the file is then looked up again — its size on the stick is what the
     * log shows and what success means. */
    function writeFile(root, name, text, cb) {
        var path = joinPath(root.fullPath, name);
        var want = utf8Length(text);
        function fail(e) { cb(e, path); }
        function done(how) { verifyWrite(path, want, how, cb); }
        if (tizen.filesystem.openFile) {
            try {
                var h = tizen.filesystem.openFile(path, 'w'), how = 'openFile';
                h.writeString(text);
                if (typeof h.flush === 'function') { h.flush(); how += '+flush'; }
                if (typeof h.sync  === 'function') { h.sync();  how += '+sync'; }
                h.close();
                done(how);
                return;
            } catch (e) {
                log('openFile write failed (' + e.message + '), trying the File API');
            }
        }
        try {
            tizen.filesystem.resolve(root.name, function (dir) {
                var f;
                try { f = dir.resolve(name); }
                catch (e) {
                    try { f = dir.createFile(name); } catch (e2) { fail(e2); return; }
                }
                f.openStream('w', function (s) {
                    try { s.write(text); s.close(); done('FileStream'); }
                    catch (e) { try { s.close(); } catch (x) {} fail(e); }
                }, fail, 'UTF-8');
            }, fail, 'rw');
        } catch (e) { fail(e); }
    }
    function utf8Length(s) {
        try { return unescape(encodeURIComponent(String(s))).length; }
        catch (e) { return String(s).length; }
    }
    /* The file as the stick now has it.  Empty is a failure; a size the
     * TV can't report is taken on trust (older firmware), but logged. */
    function verifyWrite(path, want, how, cb) {
        function trust(m) { log('wrote ' + path + ' via ' + how + '; ' + m); cb(null, path); }
        try {
            tizen.filesystem.resolve(path, function (f) {
                var size = f.fileSize;
                if (typeof size !== 'number') { trust('size unknown'); return; }
                log('wrote ' + path + ' via ' + how + ': ' + size + ' bytes on the stick' +
                    (size === want ? '' : ' (expected ' + want + ')'));
                if (size === 0) cb(new Error('the file is empty on the stick'), path);
                else cb(null, path);
            }, function (e) { trust('could not look it up again: ' + (e && e.message || e)); }, 'r');
        } catch (e) { trust('could not look it up again: ' + (e && e.message || e)); }
    }

    /* ── where a file can go: USB sticks and SMB servers alike ─────────── */

    /* Every place a backup can be written to or read from, sticks first:
     * cb([{ kind: 'usb', root } | { kind: 'smb', server }]). */
    function destinations(cb) {
        usbRoots(function (roots) {
            var out = roots.map(function (r) { return { kind: 'usb', root: r }; });
            var servers = [];
            try { if (typeof SMB !== 'undefined' && SMB.servers) servers = SMB.servers() || []; } catch (e) {}
            servers.forEach(function (sv) { out.push({ kind: 'smb', server: sv }); });
            cb(out);
        });
    }
    function destLabel(d) {
        if (d.kind === 'usb') return driveLabel(d.root);
        return SMB.serverLabel(d.server);
    }
    /* The file's name for a toast: the stick's path, or \\host\share\name. */
    function destPath(d, name) {
        if (d.kind === 'usb') return joinPath(d.root.fullPath, name);
        return SMB.serverLabel(d.server) + '\\' + name;
    }
    /* Write `text` as `name` at the top of destination d: cb(err, path). */
    function saveTo(d, name, text, cb) {
        if (d.kind === 'usb') { writeFile(d.root, name, text, cb); return; }
        var path = destPath(d, name);
        SMB.writeText(d.server.id || '', '/' + name, text, function (err, size) {
            if (!err) log('wrote ' + path + ': ' + size + ' bytes on the share');
            cb(err, path);
        });
    }
    /* The text of `name` at the top of destination d: cb(err, text). */
    function readFrom(d, name, cb) {
        if (d.kind === 'usb') { readText(d.root, cb); return; }
        SMB.readText(d.server.id || '', '/' + name, cb);
    }
    /* One destination, asked for (under `title`) when there is a choice:
     * cb(d).  None at all: a toast, and cb isn't called. */
    function chooseDestination(title, cb) {
        destinations(function (list) {
            if (!list.length) { toast(I18n.t('backup.noDestination')); return; }
            if (list.length === 1) { cb(list[0]); return; }
            pick(title, list.map(function (d, i) {
                return { code: String(i), name: destLabel(d) };
            }), function (i) { cb(list[+i]); });
        });
    }
    /* Save `text` as `name` where the user says: cb(err, path). */
    function saveSomewhere(name, text, chooseTitle, cb) {
        chooseDestination(chooseTitle, function (d) { saveTo(d, name, text, cb); });
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

    function startSave() {
        var b = build(localStorage, { passwords: includePasswords, history: includeHistory,
                                      appVersion: appVersion() });
        saveSomewhere(FILE_NAME, JSON.stringify(b, null, 2), I18n.t('backup.chooseDrive'), function (err, path) {
            if (err) {
                log('write to ' + path + ' failed: ' + (err.message || err));
                toast(I18n.t('backup.saveFailed', err.message || String(err)));
                return;
            }
            log('saved ' + path + (b.passwords ? ' (with passwords)' : ''));
            toast(I18n.t(b.passwords ? 'backup.savedPasswords' : 'backup.saved', path));
        });
    }

    /* ── the debug log (issue #126) ───────────────────────────────────── */

    /* tessel-log-20261002-0817.txt: a name per export, so the logs of two
     * occurrences don't overwrite each other on the way to the developer. */
    function logFileName(now) {
        var d = now || new Date();
        return 'tessel-log-' + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) +
               '-' + pad(d.getHours()) + pad(d.getMinutes()) + '.txt';
    }
    function tvModel() {
        try {
            var p = TvInfo.getProductInfo();
            return [p.realModel, p.firmwareVersion].filter(Boolean).join(' / ');
        } catch (e) { return ''; }
    }
    function startLogExport() {
        if (typeof Debug === 'undefined' || !Debug.exportText) return;
        var text = Debug.exportText({
            'Tessel':     appVersion(),
            'TV':         tvModel(),
            'User-Agent': (typeof navigator !== 'undefined') ? navigator.userAgent : ''
        });
        saveSomewhere(logFileName(), text, I18n.t('dbg.chooseDrive'), function (err, path) {
            if (err) {
                log('log export to ' + path + ' failed: ' + (err.message || err));
                toast(I18n.t('dbg.exportFailed', err.message || String(err)));
                return;
            }
            log('debug log saved to ' + path);
            toast(I18n.t('dbg.exported', path));
        });
    }

    /* Restore: pick where from, read the file there, then confirm what it
     * is (when it was made, by which Tessel) before anything is replaced. */
    function startRestore() {
        chooseDestination(I18n.t('backup.chooseSource'), function (d) {
            readFrom(d, FILE_NAME, function (err, text) {
                if (err) {
                    log('no backup at ' + destPath(d, FILE_NAME) + ': ' + (err.message || err));
                    toast(I18n.t('backup.notFound', destLabel(d)));
                    return;
                }
                var b;
                try { b = parse(text); }
                catch (e) { toast(I18n.t(e.code === 'newer' ? 'backup.err.newer' : 'backup.err.notBackup')); return; }
                pick(I18n.t('backup.restoreTitle'), [{
                    code: '0',
                    name: I18n.t('backup.entry', when(b.exportedAt), b.tesselVersion || '?', destLabel(d))
                }], function () {
                    restore(localStorage, b);
                    log('restored from ' + destPath(d, FILE_NAME));
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
        var exportBtn = document.getElementById('dbg-export');
        if (exportBtn) exportBtn.addEventListener('click', startLogExport);
    }
    if (typeof document !== 'undefined') {
        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wireSettings);
        else wireSettings();
    }

    return { FILE_NAME: FILE_NAME, build: build, parse: parse, restore: restore,
             logFileName: logFileName, writeFile: writeFile,
             // The places a file can go, for the Node tests.
             destinations: destinations, destLabel: destLabel, destPath: destPath,
             saveTo: saveTo, readFrom: readFrom };
})();

// Ignored by the Tizen/browser build; lets Node tests require these helpers.
if (typeof module !== 'undefined' && module.exports) module.exports = Backup;
