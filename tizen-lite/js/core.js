/* Tessel Lite: the parts that need no TV.
 *
 * Everything under tizen-lite/ runs on the WebKit of a 2015 set, so it is
 * written in ES5 and stays away from anything newer (tests/tizen-lite checks). */

var LiteCore = (function () {
    'use strict';

    var RECENT_KEY = 'tessel_lite_recent_v1';
    var RECENT_MAX = 20;

    /* What the user typed, as a URL AVPlay can open; '' when it is not one.
     * A remote makes typing slow, so "http://" may be left out. */
    function normalizeUrl(text) {
        var s = String(text === null || text === undefined ? '' : text).replace(/^\s+|\s+$/g, '');
        if (!s || /\s/.test(s)) return '';
        if (!/^[a-zA-Z][a-zA-Z0-9+.\-]*:\/\//.test(s)) s = 'http://' + s;
        // a scheme alone, or a host that starts with a slash, is not an address
        if (!/^[a-zA-Z][a-zA-Z0-9+.\-]*:\/\/[^\/?#]/.test(s)) return '';
        return s;
    }

    function readRecent(storage) {
        try {
            var list = JSON.parse(storage.getItem(RECENT_KEY) || '[]');
            if (Object.prototype.toString.call(list) !== '[object Array]') return [];
            var out = [];
            for (var i = 0; i < list.length; i++) {
                if (typeof list[i] === 'string' && list[i]) out.push(list[i]);
            }
            return out.slice(0, RECENT_MAX);
        } catch (e) {
            return [];
        }
    }

    function writeRecent(storage, list) {
        try { storage.setItem(RECENT_KEY, JSON.stringify(list)); } catch (e) {}
        return list;
    }

    /* Newest first, each URL once. */
    function addRecent(storage, url) {
        var list = readRecent(storage), out = [url];
        for (var i = 0; i < list.length; i++) if (list[i] !== url) out.push(list[i]);
        return writeRecent(storage, out.slice(0, RECENT_MAX));
    }

    function removeRecent(storage, url) {
        var list = readRecent(storage), out = [];
        for (var i = 0; i < list.length; i++) if (list[i] !== url) out.push(list[i]);
        return writeRecent(storage, out);
    }

    function two(n) { return (n < 10 ? '0' : '') + n; }

    /* Milliseconds as 1:02:03 or 2:03. */
    function formatTime(ms) {
        var total = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
        var h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
        return h > 0 ? h + ':' + two(m) + ':' + two(s) : m + ':' + two(s);
    }

    /* How far along, 0 to 100; 0 when the length is unknown (a live stream). */
    function percent(positionMs, durationMs) {
        if (!(durationMs > 0)) return 0;
        return Math.max(0, Math.min(100, (positionMs / durationMs) * 100));
    }

    return {
        RECENT_KEY: RECENT_KEY,
        RECENT_MAX: RECENT_MAX,
        normalizeUrl: normalizeUrl,
        readRecent: readRecent,
        addRecent: addRecent,
        removeRecent: removeRecent,
        formatTime: formatTime,
        percent: percent
    };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = LiteCore;
