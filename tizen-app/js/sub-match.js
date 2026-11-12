/* Which subtitle files belong to which video in a folder.
 *
 * The strict rule is the one every player uses: Film.srt or Film.en.srt next
 * to Film.mkv.  Real folders are messier, so two looser rules catch what the
 * strict one leaves over, for video only:
 *
 *   - the folder holds one video: every left-over subtitle file is offered
 *     for it (Film.2019.1080p.mkv with English.srt);
 *   - several videos: a left-over file carrying the same episode number
 *     (S01E02, 1x02) as a video goes to that video.
 *
 * A folder named Subs or Subtitles next to the video is read as if its files
 * sat in the folder itself, the layout most downloads come in.
 *
 * A loosely matched entry is a copy flagged `loose`, so Auto can treat it
 * with more care than a file that carries the video's own name.  A .txt is
 * never matched loosely: readme.txt next to a film is not a subtitle. */

var SubMatch = (function () {
    function stem(name) {
        var dot = name.lastIndexOf('.');
        return dot < 0 ? name : name.slice(0, dot);
    }
    function ext(name) {
        var dot = name.lastIndexOf('.');
        return dot < 0 ? '' : name.slice(dot + 1).toLowerCase();
    }
    function isSubsDir(name) { return /^(subs?|subtitles?)$/i.test(String(name || '')); }
    // FileTypes is a global in the app; a Node test requires this file bare.
    var types = typeof FileTypes !== 'undefined' ? FileTypes
              : (typeof require === 'function' ? require('./filetypes.js') : null);
    function isVideo(name) { return !!types && types.kind(name) === 'video'; }

    /* "Show.S01E02.mkv" and "Show 1x02.srt" both give "1x2"; '' for none.
     * A picture size (1920x1080) is not an episode: the digits may not run
     * on either side. */
    function episode(name) {
        var m = /(?:^|[^a-z0-9])s(\d{1,2})[ ._-]?e(\d{1,3})(?![0-9])/i.exec(name) ||
                /(?:^|[^a-z0-9])(\d{1,2})x(\d{2,3})(?![0-9])/i.exec(name);
        return m ? (+m[1]) + 'x' + (+m[2]) : '';
    }

    function looseCopy(s) {
        var c = {};
        for (var k in s) c[k] = s[k];
        c.loose = true;
        return c;
    }

    /* names: the playable files of a folder; subs: its subtitle entries
     * ({ name, … }, those of a Subs folder included).
     * Returns { "Film.mkv": [entry, …] }: exact name first, then the ones
     * continuing it with a dot, then the loose ones. */
    function pair(names, subs) {
        var byStem = {}, order = [];
        subs.forEach(function (s) {
            var k = stem(s.name).toLowerCase();
            if (!byStem[k]) { byStem[k] = []; order.push(k); }
            byStem[k].push(s);
        });
        var out = {}, claimed = [];
        names.forEach(function (v) {
            var base = stem(v).toLowerCase();
            var list = (byStem[base] || []).slice();
            order.forEach(function (k) {
                if (k !== base && k.indexOf(base + '.') === 0)
                    byStem[k].forEach(function (s) { if (list.indexOf(s) < 0) list.push(s); });
            });
            list.forEach(function (s) { claimed.push(s); });
            if (list.length) out[v] = list;
        });

        var videos = names.filter(isVideo);
        if (!videos.length) return out;
        subs.forEach(function (s) {
            if (claimed.indexOf(s) >= 0 || ext(s.name) === 'txt') return;
            var ep = episode(s.name), to;
            if (videos.length === 1) {
                var own = episode(videos[0]);
                to = (ep && own && ep !== own) ? [] : videos;
            } else {
                to = ep ? videos.filter(function (v) { return episode(v) === ep; }) : [];
            }
            to.forEach(function (v) { (out[v] = out[v] || []).push(looseCopy(s)); });
        });
        return out;
    }

    /* A folder listing ([{ name, isDir }]) with a Subs folder and a video in
     * it gets that folder's listing hung on it as entries.subsFolder =
     * { name, entries }.  listFn(dirEntry, cb(err, entries)) does the read;
     * a failed read just leaves the Subs folder out. */
    function withSubsFolder(entries, listFn, done) {
        var d = null, video = false;
        for (var i = 0; i < entries.length; i++) {
            var e = entries[i];
            if (e.isDir) { if (!d && isSubsDir(e.name)) d = e; }
            else if (isVideo(e.name)) video = true;
        }
        if (!d || !video) { done(entries); return; }
        try {
            listFn(d, function (err, kids) {
                if (!err && kids) entries.subsFolder = { name: d.name, entries: kids };
                done(entries);
            });
        } catch (x) { done(entries); }
    }

    return { pair: pair, episode: episode, isSubsDir: isSubsDir, withSubsFolder: withSubsFolder };
})();

// Ignored by the Tizen/browser build; lets Node tests drive the module.
if (typeof module !== 'undefined' && module.exports) module.exports = SubMatch;
