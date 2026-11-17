/* favorites.js — folders the user pinned to the Favorites tile (issue #140).
 *
 * The next episode of a show sits in a folder several levels down a share;
 * a pinned folder opens that folder from the home screen in one step.  Each
 * entry is
 *   { id, kind: 'smb', name, srv, path }          a folder on a share
 *   { id, kind: 'webdav', name, srv, path }       a folder on a WebDAV server (#145)
 *   { id, kind: 'usb', name, path, root, rootPath } a folder on local storage
 * and lives in localStorage under vlctv_favorites_v1, which Settings → Backup
 * carries along with the settings.
 *
 * `srv` is the saved SMB server's id ('' for the first one) or the WebDAV
 * server's, `path` the folder below the root ('/Shows/Foo').  On USB `path`
 * is the folder's full path, `root` the Tizen virtual root it is on
 * (removable_…) and `rootPath` that root's full path, so the folder can be
 * opened again through the virtual-root form that every firmware resolves.
 * The TV doesn't mount a drive under the same name every time, so two USB
 * folders are the same folder when their paths on the drive are
 * (UsbPaths.key), and move() brings an entry up to date once the folder
 * has been found under its new mount (issue #181).
 *
 * ES5 on purpose, like the rest of the app. */

var Favorites = (function () {
    'use strict';

    var KEY = 'vlctv_favorites_v1';

    // UsbPaths is a global in the app; a Node test requires this file bare.
    var paths = typeof UsbPaths !== 'undefined' ? UsbPaths
              : (typeof require === 'function' ? require('./usb-paths.js') : null);
    function driveKey(path) { return paths ? paths.key(path) : path; }

    /* The same folder: on a server, the same server and path; on USB, the
     * same path on the drive, wherever the drive is mounted. */
    function onServer(kind) { return kind === 'smb' || kind === 'webdav'; }
    function isKind(kind) { return onServer(kind) || kind === 'usb'; }
    function same(a, b) {
        if (!a || !b || a.kind !== b.kind) return false;
        if (onServer(a.kind)) return String(a.srv || '') === String(b.srv || '') && a.path === b.path;
        return driveKey(a.path) === driveKey(b.path);
    }

    function create(storage) {
        function list() {
            var raw = null;
            try { raw = storage && storage.getItem(KEY); } catch (e) {}
            var v = null;
            try { v = raw ? JSON.parse(raw) : []; } catch (e) {}
            if (!Array.isArray(v)) return [];
            return v.filter(function (f) {
                return f && isKind(f.kind) && typeof f.path === 'string';
            });
        }
        function write(items) {
            try { storage.setItem(KEY, JSON.stringify(items)); } catch (e) {}
        }
        function indexOf(items, id) {
            for (var i = 0; i < items.length; i++) if (items[i].id === id) return i;
            return -1;
        }
        function newId(items) {
            var id;
            do { id = Math.random().toString(36).slice(2, 10); } while (indexOf(items, id) >= 0);
            return id;
        }

        function get(id) {
            var items = list();
            var i = indexOf(items, id);
            return i >= 0 ? items[i] : null;
        }
        /* The pinned entry for this folder, or null. */
        function find(folder) {
            var items = list();
            for (var i = 0; i < items.length; i++) if (same(items[i], folder)) return items[i];
            return null;
        }
        /* Pinning a folder that is already pinned doesn't add it twice: the
         * entry it already has is returned untouched. */
        function add(folder) {
            if (!folder || !isKind(folder.kind)) return null;
            if (typeof folder.path !== 'string' || !folder.path) return null;
            var items = list();
            var dup = find(folder);
            if (dup) return dup;
            var item = { id: newId(items), kind: folder.kind, path: folder.path,
                         name: String(folder.name || '').trim() || folder.path.split('/').pop() || folder.path };
            if (onServer(folder.kind)) item.srv = String(folder.srv || '');
            else {
                if (folder.root)     item.root     = String(folder.root);
                if (folder.rootPath) item.rootPath = String(folder.rootPath);
            }
            items.push(item);
            write(items);
            return item;
        }
        function remove(id) {
            write(list().filter(function (f) { return f.id !== id; }));
        }
        /* A pinned USB folder found under another mount: store where it is
         * now.  Returns the entry, or null when there is none to update. */
        function move(id, where) {
            var items = list();
            var i = indexOf(items, id);
            if (i < 0 || items[i].kind !== 'usb' || !where || typeof where.path !== 'string' || !where.path) return null;
            items[i].path = where.path;
            if (where.root && where.rootPath) {
                items[i].root = String(where.root);
                items[i].rootPath = String(where.rootPath);
            } else {
                delete items[i].root;
                delete items[i].rootPath;
            }
            write(items);
            return items[i];
        }

        return { KEY: KEY, list: list, get: get, find: find, add: add, remove: remove, move: move, same: same };
    }

    var api = create(typeof localStorage !== 'undefined' ? localStorage : null);
    api.create = create;
    return api;
})();

// Ignored by the Tizen/browser build; lets Node tests require these helpers.
if (typeof module !== 'undefined' && module.exports) module.exports = Favorites;
