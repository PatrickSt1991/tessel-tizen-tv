/* watch-history.js — tracks which files were watched and where playback
 * stopped.
 *
 * Two localStorage maps, both carried by Settings → Backup:
 *   vlctv_watched_v1   uri → when the file was last watched to the end (ms)
 *   vlctv_resume_v1    uri → { pos, dur, ts }, the position to continue from
 * A file counts as watched when it plays to the end or is stopped after
 * 90 % (app.js makes that call).  Marking a file watched also clears its
 * resume position.  Positions are checkpointed every few seconds while
 * playing and saved on exit / standby.
 *
 * A file on a USB drive is stored under its path on the drive, without the
 * mount (UsbPaths.key): the TV mounts the same drive as USBDriveA1 one day
 * and USBDriveB1 the next, and history kept under the full path was lost
 * every time it did (issue #181).  Callers pass the file's URI as before;
 * entries stored under full paths by older versions are folded in when the
 * maps are read.
 *
 * ES5 on purpose, like the rest of the app. */

var WatchHistory = (function () {
    'use strict';

    var WATCHED_KEY = 'vlctv_watched_v1';
    var RESUME_KEY  = 'vlctv_resume_v1';
    var WATCHED_MAX = 500;
    var RESUME_MAX  = 200;
    var RESUME_MIN_MS = 30000;   // positions in the first 30 s aren't worth resuming
    var WATCHED_FRACTION = 0.9;  // a file stopped past this fraction counts as watched

    // UsbPaths is a global in the app; a Node test requires this file bare.
    var paths = typeof UsbPaths !== 'undefined' ? UsbPaths
              : (typeof require === 'function' ? require('./usb-paths.js') : null);
    function keyOf(uri) { return paths && uri ? paths.key(uri) : uri; }
    function watchedTs(ts) { return ts; }
    function resumeTs(r) { return r && r.ts; }

    function create(storage, now) {
        now = now || function () { return Date.now(); };

        function read(key) {
            var m;
            try { m = JSON.parse(storage.getItem(key) || '{}') || {}; }
            catch (e) { return {}; }
            return paths ? paths.foldKeys(m, key === WATCHED_KEY ? watchedTs : resumeTs) : m;
        }
        function write(key, m) {
            try { storage.setItem(key, JSON.stringify(m)); } catch (e) {}
        }
        /* Drop the oldest entries once the map passes its cap. */
        function trim(m, max, tsOf) {
            var keys = Object.keys(m);
            if (keys.length <= max) return;
            keys.sort(function (a, b) { return tsOf(m[a]) - tsOf(m[b]); })
                .slice(0, keys.length - max)
                .forEach(function (k) { delete m[k]; });
        }

        function isWatched(uri) {
            return !!uri && !!read(WATCHED_KEY)[keyOf(uri)];
        }
        function markWatched(uri) {
            if (!uri) return;
            uri = keyOf(uri);
            clearResumePos(uri);   // a finished file starts from the beginning next time
            var w = read(WATCHED_KEY);
            w[uri] = now();
            trim(w, WATCHED_MAX, watchedTs);
            write(WATCHED_KEY, w);
        }

        function resumePosFor(uri) {
            var r = uri ? read(RESUME_KEY)[keyOf(uri)] : null;
            return (r && r.pos > RESUME_MIN_MS) ? r.pos : 0;
        }
        function saveResumePos(uri, timeMs, durMs) {
            if (!uri) return;
            uri = keyOf(uri);
            var m = read(RESUME_KEY);
            if (!timeMs || timeMs < RESUME_MIN_MS) {
                // Stopped near the start: drop any stale position.
                if (m[uri]) { delete m[uri]; write(RESUME_KEY, m); }
                return;
            }
            m[uri] = { pos: Math.floor(timeMs), dur: Math.floor(durMs || 0), ts: now() };
            trim(m, RESUME_MAX, resumeTs);
            write(RESUME_KEY, m);
        }
        function clearResumePos(uri) {
            if (!uri) return;
            uri = keyOf(uri);
            var m = read(RESUME_KEY);
            if (m[uri]) { delete m[uri]; write(RESUME_KEY, m); }
        }
        /* Remove the watched marks and resume positions of uris.  Return the
         * number of files that had either. */
        function forget(uris) {
            var w = read(WATCHED_KEY), r = read(RESUME_KEY), n = 0;
            for (var i = 0; i < uris.length; i++) {
                var u = keyOf(uris[i]);
                if (!w[u] && !r[u]) continue;
                n++;
                delete w[u]; delete r[u];
            }
            if (n) { write(WATCHED_KEY, w); write(RESUME_KEY, r); }
            return n;
        }
        /* Return the stored keys starting with prefix (a folder's uri plus
         * "/"): files with history in that folder or its subfolders.  What
         * comes back is for forget(); a USB file's key is not its URI. */
        function urisUnder(prefix) {
            prefix = keyOf(prefix);
            var w = read(WATCHED_KEY), r = read(RESUME_KEY), seen = {}, out = [];
            [w, r].forEach(function (m) {
                Object.keys(m).forEach(function (u) {
                    if (u.indexOf(prefix) !== 0 || seen[u]) return;
                    seen[u] = true; out.push(u);
                });
            });
            return out;
        }
        /* Forget every uri under prefix.  Return the number of files
         * removed. */
        function forgetUnder(prefix) {
            return prefix ? forget(urisUnder(prefix)) : 0;
        }

        /* Read both maps once and answer from that copy while a folder is
         * drawn. */
        function snapshot() {
            var w = read(WATCHED_KEY), r = read(RESUME_KEY);

            /* Return { watched, progress, finished, lastTs } for uri.
             * progress is 0..1, or null if unknown; lastTs is 0 if the file
             * was never played.  A resume entry is always newer than the
             * watched mark (markWatched deletes it), so when present it
             * determines progress and finished.  A position past
             * WATCHED_FRACTION counts as finished even without a watched
             * mark, e.g. when the TV was switched off during the credits. */
            function state(uri) {
                uri = keyOf(uri);
                var ts = w[uri] || 0, pos = r[uri] || null;
                var s = { watched: !!ts, progress: null, finished: !!ts && !pos,
                          lastTs: Math.max(ts, pos ? pos.ts || 0 : 0) };
                if (pos && pos.dur > 0) {
                    s.progress = Math.min(1, pos.pos / pos.dur);
                    s.finished = s.progress >= WATCHED_FRACTION;
                }
                return s;
            }

            /* Given a folder's playable uris in list order, return the one to
             * put the cursor on: the most recently played file, or the next
             * one if that file is finished.  Return null if none was played. */
            function continueAt(uris) {
                var best = -1, bestTs = 0;
                for (var i = 0; i < uris.length; i++) {
                    var ts = state(uris[i]).lastTs;
                    if (ts > bestTs) { bestTs = ts; best = i; }
                }
                if (best < 0) return null;
                if (state(uris[best]).finished && best + 1 < uris.length) best++;
                return uris[best];
            }

            return { state: state, continueAt: continueAt };
        }

        return {
            WATCHED_KEY: WATCHED_KEY, RESUME_KEY: RESUME_KEY,
            RESUME_MIN_MS: RESUME_MIN_MS, WATCHED_FRACTION: WATCHED_FRACTION,
            isWatched: isWatched, markWatched: markWatched,
            resumePosFor: resumePosFor, saveResumePos: saveResumePos, clearResumePos: clearResumePos,
            forget: forget, urisUnder: urisUnder, forgetUnder: forgetUnder, snapshot: snapshot
        };
    }

    var api = create(typeof localStorage !== 'undefined' ? localStorage : null);
    api.create = create;
    return api;
})();

// Ignored by the Tizen/browser build; lets Node tests require these helpers.
if (typeof module !== 'undefined' && module.exports) module.exports = WatchHistory;
