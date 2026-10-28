/* Play a folder with everything under it (issue #159).
 *
 * A folder that has subfolders gets two rows on top of its listing in the
 * USB, SMB and WebDAV browsers: "Play all" and "Shuffle all", subfolders
 * included.  Picking one walks the tree below it, collects the music, and
 * hands the lot to the normal play path, so next/prev, repeat, auto-play
 * and the shuffle setting work as they do for a single folder.
 *
 * The walk knows nothing about where the files live.  Each browser passes
 * list(node, cb), which lists one folder and answers
 * cb(err, { dirs: [node, …], tracks: [playlist item, …] }) with both in the
 * order they should play.  Tracks come out in tree order: a folder's own
 * files, then each subfolder in turn, so an album keeps its track order.
 *
 * A few folders are listed at once (each one is a round trip to the share),
 * a folder that can't be listed is skipped, and the walk stops at MAX_TRACKS
 * or MAX_DEPTH so a whole NAS (or a link loop on a USB stick) can't keep it
 * going for ever.  While it runs the remote is ours: Back cancels, the other
 * keys wait. */

var FolderPlay = (function () {

    var MAX_TRACKS = 5000;
    var MAX_DEPTH  = 16;
    var PARALLEL   = 3;

    /* Walk the tree under root.  progress(found) after every folder;
     * done(err, tracks, info) once, with info { folders, failed, truncated }.
     * err only when root itself can't be listed.  Returns cancel(), after
     * which neither is called again. */
    function walk(root, list, progress, done, limits) {
        limits = limits || {};
        var maxTracks = limits.maxTracks || MAX_TRACKS;
        var maxDepth  = limits.maxDepth  || MAX_DEPTH;
        var parallel  = limits.parallel  || PARALLEL;
        var top = { node: root, depth: 0, tracks: [], kids: [] };
        var stack = [top], busy = 0, found = 0, folders = 0, failed = 0;
        var truncated = false, cancelled = false, rootErr = null;

        function pump() {
            if (cancelled) return;
            while (busy < parallel && stack.length && !truncated) fetch(stack.pop());
            if (!busy) finish();
        }
        function fetch(rec) {
            busy++;
            list(rec.node, function (err, res) {
                busy--;
                if (cancelled) return;
                folders++;
                if (err) {
                    failed++;
                    if (rec === top) rootErr = err;
                } else {
                    rec.tracks = (res && res.tracks) || [];
                    found += rec.tracks.length;
                    if (found >= maxTracks) truncated = true;
                    var dirs = (res && res.dirs) || [];
                    if (rec.depth + 1 > maxDepth) { if (dirs.length) truncated = true; dirs = []; }
                    rec.kids = dirs.map(function (d) { return { node: d, depth: rec.depth + 1, tracks: [], kids: [] }; });
                    // Depth first: the first subfolder is listed next, so a
                    // walk cut short keeps whole albums from the top.
                    for (var i = rec.kids.length - 1; i >= 0; i--) stack.push(rec.kids[i]);
                }
                if (progress) progress(found);
                pump();
            });
        }
        function finish() {
            if (cancelled) return;
            cancelled = true;   // done() fires once
            if (rootErr) return done(rootErr);
            var out = [];
            (function flat(rec) {
                for (var i = 0; i < rec.tracks.length; i++) out.push(rec.tracks[i]);
                for (var k = 0; k < rec.kids.length; k++) flat(rec.kids[k]);
            })(top);
            if (out.length > maxTracks) { out.length = maxTracks; truncated = true; }
            done(null, out, { folders: folders, failed: failed, truncated: truncated });
        }

        pump();
        return function cancel() { cancelled = true; };
    }

    function shuffled(list) {
        var out = list.slice();
        for (var i = out.length - 1; i > 0; i--) {
            var j = Math.floor(Math.random() * (i + 1));
            var t = out[i]; out[i] = out[j]; out[j] = t;
        }
        return out;
    }

    /* Order a folder listing the way the USB browser does: by name,
     * case-insensitively. */
    function byName(a, b) {
        return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
    }

    /* What a browser's list() keeps of a folder's entries ({ name, isDir }):
     * the subfolders and the music, hidden ones only when they're shown. */
    function split(entries) {
        var showHidden = typeof Settings !== 'undefined' && Settings.get('showHidden');
        var dirs = [], audio = [];
        (entries || []).slice().sort(byName).forEach(function (e) {
            if (!showHidden && FileTypes.isHidden(e.name)) return;
            if (e.isDir) dirs.push(e);
            else if (FileTypes.kind(e.name) === 'audio') audio.push(e);
        });
        return { dirs: dirs, audio: audio };
    }

    function esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    /* Run the walk behind a row of the listing, which counts the tracks
     * found as it goes.  play(tracks) gets the music, shuffled if asked. */
    function start(li, root, list, shuffle, play) {
        var name = li.querySelector('.name'), label = name.textContent;
        var keys = null, cancel = null;
        function release() {
            if (keys) { Remote.pop(keys); keys = null; }
            name.textContent = label;
        }
        keys = Remote.push(function (code) {
            if (code === Remote.KEY.BACK) {
                if (cancel) cancel();
                release();
                UI.toast(I18n.t('folderPlay.cancelled'));
            }
            return true;
        });
        name.textContent = I18n.t('folderPlay.scanning', 0);
        cancel = walk(root, list, function (found) {
            name.textContent = I18n.t('folderPlay.scanning', found);
        }, function (err, tracks, info) {
            release();
            if (err) { UI.toast(err.message || String(err)); return; }
            if (typeof Debug !== 'undefined' && Debug.browse)
                Debug.browse('folder play: ' + tracks.length + ' track(s) in ' + info.folders + ' folder(s), ' +
                             info.failed + ' unreadable' + (info.truncated ? ', cut short' : ''));
            if (!tracks.length) { UI.toast(I18n.t('folderPlay.noMusic')); return; }
            if (info.truncated) UI.toast(I18n.t('folderPlay.truncated', tracks.length));
            play(shuffle ? shuffled(tracks) : tracks);
        });
    }

    /* Put the Play all / Shuffle all rows into ul, before `before` (null:
     * at the end).  list() as for walk(); play(tracks) starts the player. */
    function addRows(ul, before, root, list, play) {
        [['▶', 'folderPlay.playAll', false], ['🔀', 'folderPlay.shuffleAll', true]].forEach(function (r) {
            var li = document.createElement('li');
            li.className = 'folder-play';
            li.innerHTML = '<span class="icon">' + r[0] + '</span><span class="name">' + esc(I18n.t(r[1])) + '</span>';
            li.addEventListener('click', function () { start(li, root, list, r[2], play); });
            ul.insertBefore(li, before);
        });
    }

    return { walk: walk, split: split, addRows: addRows, MAX_TRACKS: MAX_TRACKS };
})();

// Ignored by the Tizen/browser build; lets Node tests require these helpers.
if (typeof module !== 'undefined' && module.exports) module.exports = FolderPlay;
