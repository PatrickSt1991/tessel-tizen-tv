/* Read an M3U / M3U8 / PLS playlist (issue #110).
 *
 * Two very different files share the .m3u8 name:
 *   - an HLS manifest, which AVPlay plays itself.  It carries #EXT-X- tags
 *     (#EXT-X-TARGETDURATION, #EXT-X-STREAM-INF, …), and its entries are
 *     segments or variants, not things to pick from;
 *   - a channel or song list (the IPTV kind, or a music playlist saved by a
 *     desktop player), which AVPlay can't open at all.  Each entry is a
 *     stream or file of its own, optionally named by the #EXTINF line in
 *     front of it: `#EXTINF:-1 tvg-logo="…" group-title="News",Channel 1`.
 *
 * parse() tells them apart and hands back the entries of a list.  An entry's
 * reference is kept as written; the caller resolves relative ones, because
 * only it knows where the list came from (a URL, a USB folder, a share). */

var Playlist = (function () {

    function isHls(text) { return /^\s*#EXT-X-/m.test(text); }

    /* `tvg-logo="x" group-title="News"` → { 'tvg-logo': 'x', 'group-title': 'News' } */
    function attrs(s) {
        var out = {}, re = /([A-Za-z0-9_-]+)="([^"]*)"/g, m;
        while ((m = re.exec(s))) out[m[1].toLowerCase()] = m[2];
        return out;
    }

    /* The title after the first comma that isn't inside quotes. */
    function extinfTitle(s) {
        var q = false;
        for (var i = 0; i < s.length; i++) {
            if (s[i] === '"') q = !q;
            else if (s[i] === ',' && !q) return s.slice(i + 1).trim();
        }
        return '';
    }

    function parseM3u(text) {
        var entries = [], pending = null, group = '';
        text.split(/\r\n|\r|\n/).forEach(function (raw) {
            var line = raw.trim();
            if (!line) return;
            if (/^#EXTINF:/i.test(line)) {
                var body = line.slice(8);
                var a = attrs(body);
                pending = {
                    title: extinfTitle(body) || a['tvg-name'] || '',
                    group: a['group-title'] || '',
                    logo:  a['tvg-logo'] || ''
                };
                return;
            }
            // #EXTGRP: sets the group for the entry that follows.
            if (/^#EXTGRP:/i.test(line)) { group = line.slice(8).trim(); return; }
            if (line.charAt(0) === '#') return;
            var e = pending || { title: '', group: '', logo: '' };
            if (!e.group && group) e.group = group;
            e.ref = line;
            if (!e.title) e.title = baseName(line);
            entries.push(e);
            pending = null;
            group = '';
        });
        return entries;
    }

    /* [playlist] File1=… Title1=… */
    function parsePls(text) {
        var files = {}, titles = {};
        text.split(/\r\n|\r|\n/).forEach(function (raw) {
            var m = /^\s*(File|Title)(\d+)\s*=\s*(.*?)\s*$/i.exec(raw);
            if (!m) return;
            (m[1].toLowerCase() === 'file' ? files : titles)[m[2]] = m[3];
        });
        return Object.keys(files)
            .sort(function (a, b) { return a - b; })
            .map(function (n) {
                return { ref: files[n], title: titles[n] || baseName(files[n]), group: '', logo: '' };
            });
    }

    function baseName(ref) {
        var p = String(ref).split('?')[0].split('#')[0].replace(/\\/g, '/').replace(/\/+$/, '');
        var seg = p.split('/');
        var last = seg[seg.length - 1] || String(ref);
        try { return decodeURIComponent(last); } catch (e) { return last; }
    }

    /* → { hls: true } for a manifest AVPlay should get as it is, otherwise
     *   { entries: [{ ref, title, group, logo }] }. */
    function parse(text) {
        var s = String(text || '').replace(/^﻿/, '');
        if (isHls(s)) return { hls: true };
        if (/^\s*\[playlist\]/i.test(s)) return { entries: parsePls(s) };
        return { entries: parseM3u(s) };
    }

    /* Entry groups in first-seen order, with how many entries each has.
     * Entries without a group are counted under ''. */
    function groups(entries) {
        var order = [], count = {};
        entries.forEach(function (e) {
            var g = e.group || '';
            if (!(g in count)) { count[g] = 0; order.push(g); }
            count[g]++;
        });
        return order.map(function (g) { return { name: g, count: count[g] }; });
    }

    /* Is this URL a playlist to read first rather than hand to AVPlay?  The
     * extension says so, or an IPTV panel's `type=m3u` / `output=m3u8`
     * query, which is how most of them serve the list. */
    function isPlaylistUrl(url) {
        var s = String(url || '');
        if (/\.(m3u8?|pls)(?:[?#]|$)/i.test(s)) return true;
        return /^https?:/i.test(s) && /[?&](?:type|output)=m3u/i.test(s);
    }

    /* A relative reference against the URL the list was read from.  null
     * when it can't be resolved — a drive path (C:\Music\…) written by a
     * desktop player points at a disk the TV has never seen. */
    function resolveUrl(ref, base) {
        if (/^[a-z]:[\\\/]/i.test(ref)) return null;
        if (/^[a-z][a-z0-9+.-]+:/i.test(ref)) return ref;
        try { return new URL(ref.replace(/\\/g, '/'), base).href; }
        catch (e) { return null; }
    }

    /* Text as the playlist filter compares it (issues #122, #132): lower
     * case, without accents, and with the Cyrillic letters that look like
     * Latin ones read as those Latin ones.  A Russian keyboard on the TV
     * was seen typing "Белар" as Б, Latin e, л, Latin a, Latin p, which
     * matched no channel; folded, both sides spell the same.  The
     * lookalikes are the ones a layout could plausibly swap, upper case
     * included (Т, Н, М, В, К are only alike as capitals). */
    var LOOKALIKES = { 'а': 'a', 'в': 'b', 'е': 'e', 'к': 'k', 'м': 'm', 'н': 'h', 'о': 'o',
                       'р': 'p', 'с': 'c', 'т': 't', 'у': 'y', 'х': 'x',
                       'і': 'i', 'ј': 'j', 'ѕ': 's' };
    function foldText(s) {
        s = String(s).toLowerCase();
        try { s = s.normalize('NFD').replace(/[\u0300-\u036f]/g, ''); } catch (e) {}
        s = s.replace(/[авекмнорстухіјѕ]/g, function (c) { return LOOKALIKES[c]; });
        return s.trim();
    }

    return { parse: parse, groups: groups, isPlaylistUrl: isPlaylistUrl, resolveUrl: resolveUrl,
             foldText: foldText };
})();

// Ignored by the Tizen/browser build; lets Node tests drive the module.
if (typeof module !== 'undefined' && module.exports) module.exports = Playlist;
