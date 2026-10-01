/* saved-streams.js — the user's own named list of network URLs (issue #119).
 *
 * Recents fill themselves and roll over; this list only holds what the user
 * chose to keep, in the order they put it.  Each entry is
 *   { id, name, url }
 * and lives in localStorage under vlctv_saved_v1, which Settings → Backup
 * carries along with the settings.
 *
 * What kind of stream a URL is gets decided when it's opened, the same way a
 * typed URL is (Playlist.isPlaylistUrl and friends), so nothing about it is
 * stored here.
 *
 * ES5 on purpose, like the rest of the app. */

var SavedStreams = (function () {
    'use strict';

    var KEY = 'vlctv_saved_v1';

    function create(storage) {
        function list() {
            var raw = null;
            try { raw = storage && storage.getItem(KEY); } catch (e) {}
            var v = null;
            try { v = raw ? JSON.parse(raw) : []; } catch (e) {}
            if (!Array.isArray(v)) return [];
            return v.filter(function (s) { return s && typeof s.url === 'string' && s.url; });
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
        function findByUrl(url) {
            var items = list();
            for (var i = 0; i < items.length; i++) if (items[i].url === url) return items[i];
            return null;
        }
        /* Saving a URL that is already on the list doesn't add it twice: the
         * entry it already has is returned untouched. */
        function add(name, url) {
            url = String(url || '').trim();
            if (!url) return null;
            var items = list();
            var dup = findByUrl(url);
            if (dup) return dup;
            var item = { id: newId(items), name: String(name || '').trim() || url, url: url };
            items.push(item);
            write(items);
            return item;
        }
        function update(id, name, url) {
            url = String(url || '').trim();
            var items = list();
            var i = indexOf(items, id);
            if (i < 0 || !url) return null;
            items[i] = { id: id, name: String(name || '').trim() || url, url: url };
            write(items);
            return items[i];
        }
        function remove(id) {
            write(list().filter(function (s) { return s.id !== id; }));
        }
        /* One step up (-1) or down (+1); false at either end. */
        function move(id, delta) {
            var items = list();
            var i = indexOf(items, id), j = i + delta;
            if (i < 0 || j < 0 || j >= items.length) return false;
            var t = items[i]; items[i] = items[j]; items[j] = t;
            write(items);
            return true;
        }

        return { KEY: KEY, list: list, get: get, findByUrl: findByUrl, add: add,
                 update: update, remove: remove, move: move };
    }

    var api = create(typeof localStorage !== 'undefined' ? localStorage : null);
    api.create = create;
    return api;
})();

// Ignored by the Tizen/browser build; lets Node tests require these helpers.
if (typeof module !== 'undefined' && module.exports) module.exports = SavedStreams;
