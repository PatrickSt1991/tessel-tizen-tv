/* usb-paths.js — a USB file's place on its drive, apart from where the TV
 * mounted the drive this time (issue #181).
 *
 * The TV names a drive after the device node it got: /opt/media/USBDriveA1
 * (virtual root removable_sda1) one day, /opt/media/USBDriveB1
 * (removable_sdb1) the next, with the drive in the same port.  Everything
 * the app remembers about a USB file was stored under the full path, so
 * after such a change Recently Played opened files that were no longer
 * there, and watched marks, resume positions and pinned folders stopped
 * matching.
 *
 * Two things fix that, both here:
 *   key()       the path without its mount: what history is stored under
 *               and what two paths are compared by,
 *   relocate()  where a remembered file is now, asked of the drives that
 *               are plugged in.
 *
 * Only the two path shapes Samsung TVs are known to use are recognised;
 * any other path is left exactly as it is.
 *
 * ES5 on purpose, like the rest of the app. */

var UsbPaths = (function () {
    'use strict';

    // file:///opt/media/USBDriveA1/Shows/a.mkv, with or without the scheme…
    var REAL    = /^(file:\/\/)?(\/opt\/media\/USBDrive[^\/]*)(\/.*)?$/;
    // …and the virtual-root form some firmware reports as File.fullPath.
    var VIRTUAL = /^()(removable[^\/]*)(\/.*)?$/;

    /* { scheme, mount, rest } for a path on a USB drive, or null.
     * '/opt/media/USBDriveA1/Shows/a.mkv' → mount '/opt/media/USBDriveA1',
     * rest '/Shows/a.mkv'. */
    function split(path) {
        var p = String(path || '');
        var m = REAL.exec(p) || VIRTUAL.exec(p);
        return m ? { scheme: m[1] || '', mount: m[2], rest: m[3] || '' } : null;
    }
    /* The path without its mount ('usb:/Shows/a.mkv'); any other path or
     * URL unchanged.  A folder prefix keeps its trailing slash, so prefix
     * matching works on keys as it does on paths. */
    function key(path) {
        var s = split(path);
        return s ? 'usb:' + s.rest : path;
    }
    /* A stored map with every key passed through key().  Maps written
     * before this module existed (or restored from an older backup) hold
     * full paths; where two entries end up under one key the newer one,
     * by tsOf(value), is kept.  Returns the same object when nothing
     * needed changing. */
    function foldKeys(map, tsOf) {
        var out = null;
        Object.keys(map).forEach(function (k) {
            var nk = key(k);
            if (nk === k) return;
            if (!out) {
                out = {};
                Object.keys(map).forEach(function (x) { if (key(x) === x) out[x] = map[x]; });
            }
            if (!(nk in out) || (tsOf(map[k]) || 0) > (tsOf(out[nk]) || 0)) out[nk] = map[k];
        });
        return out || map;
    }

    /* Call cb once: with what `run` reports, or with `fallback` when that
     * takes longer than ms.  A filesystem call that never answers must not
     * leave a list unable to play. */
    function guarded(ms, fallback, cb, run) {
        var done = false;
        var timer = setTimeout(function () { finish(fallback); }, ms);
        function finish(v) {
            if (done) return;
            done = true;
            clearTimeout(timer);
            cb(v);
        }
        try { run(finish); } catch (e) { finish(fallback); }
    }

    function withoutSlash(p) { return String(p || '').replace(/\/+$/, ''); }

    /* The USB drives plugged in now, in the order the TV lists them:
     * cb([{ label, dir, fullPath, mount }]), or cb(null) when the TV
     * wouldn't say.  `label` is the virtual root ('removable_sda1'),
     * `mount` the real path ('/opt/media/USBDriveA1') when the firmware
     * gives one. */
    function drives(fs, cb) {
        if (!fs || typeof fs.listStorages !== 'function') { cb(null); return; }
        try {
            fs.listStorages(function (storages) {
                var labels = (storages || [])
                    .filter(function (s) { return s && s.type === 'EXTERNAL' && s.state === 'MOUNTED'; })
                    .map(function (s) { return s.label; });
                var out = [];
                (function next(i) {
                    if (i >= labels.length) { cb(out); return; }
                    resolve(fs, labels[i], function (dir) {
                        if (dir) {
                            var real = null;
                            try { real = split(typeof dir.toURI === 'function' ? dir.toURI() : ''); } catch (e) {}
                            if (!real || !real.scheme) real = split(dir.fullPath);
                            out.push({ label: labels[i], dir: dir, fullPath: dir.fullPath,
                                       mount: real && real.mount.charAt(0) === '/' ? withoutSlash(real.mount) : null });
                        }
                        next(i + 1);
                    });
                })(0);
            }, function () { cb(null); });
        } catch (e) { cb(null); }
    }
    function resolve(fs, path, cb) {
        try { fs.resolve(path, function (f) { cb(f || null); }, function () { cb(null); }, 'r'); }
        catch (e) { cb(null); }
    }

    /* Find `path` on the plugged-in drives by its place on the drive, the
     * drive it was last seen on first.  wantDir picks a folder rather than
     * a file.  cb({ uri, file, drive }) or cb(null).
     *
     * Each drive is asked through its virtual root, the one form every
     * firmware resolves (a bare /opt/media/… path doesn't everywhere). */
    function locate(fs, list, path, wantDir, cb) {
        var s = split(path);
        if (!s || !s.rest || !list || !list.length) { cb(null); return; }
        var order = list.filter(function (d) { return d.mount === s.mount || d.label === s.mount; })
            .concat(list.filter(function (d) { return d.mount !== s.mount && d.label !== s.mount; }));
        // A URI may carry %20 where the filesystem wants a space.
        var rests = [s.rest];
        try {
            var plain = decodeURIComponent(s.rest);
            if (plain !== s.rest) rests.push(plain);
        } catch (e) {}
        var tries = [];
        order.forEach(function (d) { rests.forEach(function (r) { tries.push({ drive: d, rest: r }); }); });
        (function next(i) {
            if (i >= tries.length) { cb(null); return; }
            var t = tries[i];
            resolve(fs, t.drive.label + t.rest, function (f) {
                if (!f || !!f.isDirectory !== !!wantDir) { next(i + 1); return; }
                var uri = null;
                try { if (typeof f.toURI === 'function') uri = f.toURI(); } catch (e) {}
                if (!uri && t.drive.mount) uri = 'file://' + t.drive.mount + t.rest;
                cb({ uri: uri, file: f, drive: t.drive });
            });
        })(0);
    }

    var RELOCATE_TIMEOUT_MS = 2500;

    /* Where the remembered files `uris` are now.  cb(moves): for each uri
     * whose file was found somewhere else,
     *   moves[uri] = { uri, from, to, label }
     * — its new URI, the old and new mount paths and the drive's virtual
     * root.  A file that is where it was, one that can't be found and
     * anything that isn't a USB file are left out.
     *
     * Calls back synchronously when no uri is a USB file, so a list of
     * streams doesn't wait for the filesystem. */
    function relocate(fs, uris, cb, timeoutMs) {
        var seen = {}, todo = [];
        (uris || []).forEach(function (u) {
            var s = split(u);
            if (!s || !s.scheme || !s.rest || seen[u]) return;
            seen[u] = true;
            todo.push(u);
        });
        if (!todo.length) { cb({}); return; }
        guarded(timeoutMs || RELOCATE_TIMEOUT_MS, {}, cb, function (finish) {
            drives(fs, function (list) {
                var moves = {};
                if (!list || !list.length) { finish(moves); return; }
                (function next(i) {
                    if (i >= todo.length) { finish(moves); return; }
                    var uri = todo[i], s = split(uri);
                    // One drive, mounted where this file was: nowhere else
                    // to look, so don't spend a filesystem call on it.
                    if (list.length === 1 && list[0].mount === s.mount) { next(i + 1); return; }
                    locate(fs, list, uri, false, function (hit) {
                        if (hit && hit.uri && hit.uri !== uri) {
                            var now = split(hit.uri);
                            moves[uri] = { uri: hit.uri, from: s.mount,
                                           to: now && now.scheme ? withoutSlash(now.mount) : hit.drive.mount,
                                           label: hit.drive.label };
                        }
                        next(i + 1);
                    });
                })(0);
            });
        });
    }

    /* Whether the USB file `uri` can be found on a plugged-in drive:
     * cb(true / false), or cb(null) when it isn't a USB file or the TV
     * wouldn't say. */
    function exists(fs, uri, cb, timeoutMs) {
        var s = split(uri);
        if (!s || !s.rest) { cb(null); return; }
        guarded(timeoutMs || RELOCATE_TIMEOUT_MS, null, cb, function (finish) {
            drives(fs, function (list) {
                if (!list) { finish(null); return; }
                locate(fs, list, uri, false, function (hit) { finish(!!hit); });
            });
        });
    }

    /* `path` (a URI, a full path or a virtual-root path) carried over to
     * the mount a file moved to; unchanged when it isn't on the old one. */
    function remount(path, move) {
        var s = split(path);
        if (!s || !move) return path;
        if (s.mount === move.from && move.to) return s.scheme + move.to + s.rest;
        if (!s.scheme && s.mount.charAt(0) !== '/' && move.label) return move.label + s.rest;
        return path;
    }

    /* Recently Played entries ({ uri, subtitles: [{ uri, fullPath }], art })
     * with `moves` applied: the file, the subtitle files beside it and its
     * cover picture all follow the drive.  Two entries that turn out to be
     * the same file become one, the more recent (first) kept.
     * Returns { list, changed }. */
    function relocateItems(items, moves) {
        var changed = false, seen = {}, out = [];
        (items || []).forEach(function (item) {
            var move = item && moves[item.uri];
            if (move) {
                changed = true;
                var moved = {};
                for (var k in item) moved[k] = item[k];
                moved.uri = move.uri;
                if (typeof item.art === 'string') moved.art = remount(item.art, move);
                if (item.subtitles) {
                    moved.subtitles = item.subtitles.map(function (sub) {
                        var c = {};
                        for (var j in sub) c[j] = sub[j];
                        if (c.uri)      c.uri      = remount(c.uri, move);
                        if (c.fullPath) c.fullPath = remount(c.fullPath, move);
                        return c;
                    });
                }
                item = moved;
            }
            if (item && seen[item.uri]) { changed = true; return; }
            if (item) seen[item.uri] = true;
            out.push(item);
        });
        return { list: out, changed: changed };
    }

    return {
        split: split, key: key, foldKeys: foldKeys,
        drives: drives, locate: locate, relocate: relocate, exists: exists,
        remount: remount, relocateItems: relocateItems
    };
})();

// Ignored by the Tizen/browser build; lets Node tests require these helpers.
if (typeof module !== 'undefined' && module.exports) module.exports = UsbPaths;
