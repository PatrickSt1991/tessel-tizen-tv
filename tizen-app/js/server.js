/* server.js — pairing with, and routing playback through, the optional
 * Tessel transcode server companion (runs on the user's AM6b+ box).
 *
 * The idea: SMB browsing on the TV stays exactly as it is. The ONLY thing that
 * changes is where the bytes come from when you press play. If a transcode
 * server is paired, smb.js builds the playable URL from here
 * (http://<server>/play?path=…) instead of the localhost smbproxy stream — so
 * files the TV can't decode (DTS/TrueHD, heavy codecs) get transcoded on the box
 * and arrive as TV-friendly HLS. If nothing is paired, smb.js falls back to the
 * direct localhost stream and behaviour is unchanged.
 *
 * Pairing reuses the existing ntfy pairing code (UrlDrop.code()) but on a
 * separate "-srv" topic so it never collides with "Get URL from device". The
 * server posts its LAN URL + token there; we pull it once and store it.
 *
 * ES5 + XHR on purpose — safest on the Tizen 5.0 WebView.
 */
var TranscodeServer = (function () {
    'use strict';

    var STORE_KEY = 'vlctv_server_v1';
    var NTFY_BASE = 'https://ntfy.sh';
    var SVC_BASE  = 'http://127.0.0.1:8127';   // the smbproxy background service
    var RELAY_KEY = 'vlctv_relay_key_v1';      // random secret guarding the relay

    function log(m) { if (typeof Debug !== 'undefined' && Debug.net) Debug.net('[server] ' + m); }

    /* ── stored pairing ({url, token, name}) ───────────────────────────── */
    function get() {
        try { return JSON.parse(localStorage.getItem(STORE_KEY) || 'null'); }
        catch (e) { return null; }
    }
    function set(s) {
        try { localStorage.setItem(STORE_KEY, JSON.stringify(s || null)); } catch (e) {}
        // A different (or updated) server may decide differently.
        probeCache = {}; probeMissing = false;
    }
    function clear() { try { localStorage.removeItem(STORE_KEY); } catch (e) {} }
    function isPaired() { var s = get(); return !!(s && s.url); }

    /* Build the URL AVPlay should open for an SMB-relative path. The server
     * serves a live HLS manifest here (after transcoding/​remuxing as needed). */
    function playUrl(path) {
        var s = get();
        if (!s || !s.url) return null;
        var u = s.url.replace(/\/+$/, '') + '/play?path=' + encodeURIComponent(path);
        if (s.token) u += '&token=' + encodeURIComponent(s.token);
        return u;
    }

    /* ── local (USB / internal storage) relay ───────────────────────────────
     *
     * A USB drive is plugged into the TV, so the transcode box can't reach it
     * the way it reaches the SMB share — which is why USB files never got the
     * surround / unsupported-codec handling that share files get.  The fix is
     * to point the box back at us: the background service opens a small
     * read-only HTTP listener on the LAN, and we hand the box a /play?src=…
     * URL naming it.  The box fetches, transcodes, and streams HLS back.
     *
     * Two switches have to be on — this one, and "Accept USB / internal files
     * from the TV" on the server's setup page — because each side is opening
     * something it otherwise wouldn't.
     * ------------------------------------------------------------------- */
    var relay = null;        // { url } once the service is listening
    var relayPending = null; // callbacks waiting on an in-flight arm

    function relayEnabled() {
        return typeof Settings !== 'undefined' && !!Settings.get('localRelay');
    }

    /* One long random secret per TV, persisted so a restart doesn't invalidate
     * a relay the box is mid-stream on. */
    function relaySecret() {
        var k = '';
        try { k = localStorage.getItem(RELAY_KEY) || ''; } catch (e) {}
        if (k) return k;
        var bytes = new Uint8Array(16);
        if (window.crypto && window.crypto.getRandomValues) window.crypto.getRandomValues(bytes);
        else for (var i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
        for (var j = 0; j < bytes.length; j++) k += ('0' + bytes[j].toString(16)).slice(-2);
        try { localStorage.setItem(RELAY_KEY, k); } catch (e) {}
        return k;
    }

    function xhrPost(url, body, cb) {
        var done = false;
        function finish(err, res) { if (done) return; done = true; cb(err, res); }
        try {
            var x = new XMLHttpRequest();
            x.open('POST', url, true);
            x.timeout = 8000;
            x.setRequestHeader('Content-Type', 'application/json');
            x.onreadystatechange = function () {
                if (x.readyState !== 4) return;
                var parsed = null;
                try { parsed = JSON.parse(x.responseText || 'null'); } catch (e) {}
                if (x.status >= 200 && x.status < 300) finish(null, parsed);
                else finish(new Error((parsed && parsed.error) || ('HTTP ' + x.status)));
            };
            x.ontimeout = function () { finish(new Error('timeout')); };
            x.onerror = function () { finish(new Error('network')); };
            x.send(JSON.stringify(body || {}));
        } catch (e) { finish(e); }
    }

    /* Start (or re-key) the service's LAN listener. cb(relay|null) — null means
     * "play this file the normal way", never an error the user has to act on:
     * a relay that won't come up should cost surround, not playback. */
    function armRelay(cb) {
        if (relay) return cb(relay);
        if (!relayEnabled() || !isPaired()) return cb(null);
        if (typeof SMB === 'undefined' || !SMB.ensureService) return cb(null);
        if (typeof Browser === 'undefined' || !Browser.listRoots) return cb(null);

        if (relayPending) { relayPending.push(cb); return; }
        relayPending = [cb];
        function settle(r) {
            relay = r;
            var waiting = relayPending || [];
            relayPending = null;
            for (var i = 0; i < waiting.length; i++) waiting[i](r);
        }

        // Both ends have to be switched on. Checking the server first means a
        // user who only flipped the TV switch gets told so, instead of the box
        // rejecting every /play?src= with a 400 that surfaces as a dead player.
        serverAcceptsLocal(function (accepts) {
            if (!accepts) {
                log('relay: server has "accept USB files" turned off');
                return settle(null);
            }
            SMB.ensureService(function (err) {
                if (err) { log('relay: service unavailable — ' + err.message); return settle(null); }
                // The roots come from tizen.filesystem itself, so the service
                // ends up allowing exactly the drives the browser can see and
                // nothing else — no guessing at Tizen mount points.
                Browser.listRoots(function (e2, roots) {
                    if (e2 || !roots || !roots.length) { log('relay: no roots to share'); return settle(null); }
                    var paths = [];
                    for (var i = 0; i < roots.length; i++)
                        if (roots[i].fullPath) paths.push(roots[i].fullPath);
                    xhrPost(SVC_BASE + '/local/enable', { key: relaySecret(), roots: paths }, function (e3, res) {
                        if (e3 || !res || !res.ok || !res.url) {
                            log('relay: enable failed — ' + (e3 ? e3.message : 'no LAN address'));
                            return settle(null);
                        }
                        log('relay listening on ' + res.url + ' for ' + paths.length + ' root(s)');
                        settle({ url: res.url });
                    });
                });
            });
        });
    }

    /* Ask the paired box whether it will accept files from us. */
    function serverAcceptsLocal(cb) {
        var s = get();
        if (!s || !s.url) return cb(false);
        xhrGet(s.url.replace(/\/+$/, '') + '/api/status', function (err, text) {
            if (err) return cb(false);
            var st = null;
            try { st = JSON.parse(text || 'null'); } catch (e) {}
            cb(!!(st && st.localRelay));
        });
    }

    function disarmRelay() {
        relay = null;
        xhrPost(SVC_BASE + '/local/disable', {}, function () {});
    }

    /* The relay URL the box fetches a TV-local file from.
     *
     * tizen's File.toURI() percent-encodes, so decode once to recover the real
     * filesystem path before re-encoding it as a query value — otherwise a file
     * with a space in its name arrives at the service still encoded and
     * statSync misses it. */
    function localSrcUrl(fileUri) {
        if (!relay) return null;
        var path = String(fileUri || '').replace(/^file:\/\//, '');
        try { path = decodeURIComponent(path); } catch (e) {}
        if (!path) return null;
        return relay.url + '/local/stream?path=' + encodeURIComponent(path) +
               '&key=' + encodeURIComponent(relaySecret());
    }

    /* Wrap a TV-local path in a /play?src=… URL for the box. */
    function localPlayUrl(fileUri) {
        var s = get();
        var srcUrl = localSrcUrl(fileUri);
        if (!s || !s.url || !srcUrl) return null;
        var u = s.url.replace(/\/+$/, '') + '/play?src=' + encodeURIComponent(srcUrl);
        if (s.token) u += '&token=' + encodeURIComponent(s.token);
        return u;
    }

    function isLocalFileUri(u) { return typeof u === 'string' && u.indexOf('file://') === 0; }

    /* ── smart routing (issue #87) ──────────────────────────────────────────
     *
     * A paired server plays a file as an HLS remux carrying one audio track and
     * no subtitle streams — even a file the TV could open itself.  With Smart
     * routing on we ask the box first (/api/probe, which runs the same codec
     * decision /play would) and play a file it would only remux the way an
     * unpaired TV does: a share file through the local smbproxy, a USB file
     * straight off the drive.  Everything that goes wrong lands on the server
     * route: a probe that fails, a server too old to have /api/probe, and —
     * through app.js — a direct open that doesn't start, after which the file
     * is remembered and goes through the server from then on.
     *
     * A file is keyed by its share path, or by its file:// URI for USB.
     * ------------------------------------------------------------------- */
    var DIRECT_FAILED_KEY = 'vlctv_direct_failed_v1';
    var DIRECT_FAILED_MAX = 200;       // oldest forgotten first
    var PROBE_TIMEOUT_MS  = 8000;      // ffprobe over SMB on a small box
    var probeCache = {};               // file key -> probe answer, this app session
    var probeMissing = false;          // server answered 404: older than API 2

    function smartEnabled() {
        return typeof Settings !== 'undefined' && !!Settings.get('smartRouting');
    }

    /* The share path inside one of our /play?path=… URLs; null for anything
     * else, including the USB relay's /play?src=… form. */
    function sharePathOf(u) {
        if (!isPlayUrl(u)) return null;
        var m = /[?&]path=([^&]*)/.exec(u);
        if (!m) return null;
        try { return decodeURIComponent(m[1]); } catch (e) { return null; }
    }

    /* The key smart routing remembers a file by, for the URI app.js plays. */
    function smartKeyOf(uri) {
        var path = sharePathOf(uri);
        if (path !== null) return path;
        return isLocalFileUri(uri) ? uri : null;
    }

    function directFailedList() {
        try {
            var l = JSON.parse(localStorage.getItem(DIRECT_FAILED_KEY) || '[]');
            return Array.isArray(l) ? l : [];
        } catch (e) { return []; }
    }
    function directFailed(key) { return directFailedList().indexOf(key) >= 0; }

    /* app.js calls this when a file we sent direct never started playing. */
    function markDirectFailed(uri) {
        var key = smartKeyOf(uri);
        if (key === null) return;
        var l = directFailedList().filter(function (k) { return k !== key; });
        l.push(key);
        if (l.length > DIRECT_FAILED_MAX) l = l.slice(l.length - DIRECT_FAILED_MAX);
        try { localStorage.setItem(DIRECT_FAILED_KEY, JSON.stringify(l)); } catch (e) {}
        log('smart: ' + key + ' will play through the server from now on');
    }

    /* query is what names the file to the box: "path=…" or "src=…", the same
     * forms /play takes. */
    function probe(key, query, cb) {
        if (Object.prototype.hasOwnProperty.call(probeCache, key)) return cb(null, probeCache[key], true);
        var u = withToken('/api/probe?' + query);
        if (!u) return cb(new Error('not paired'));
        getJson(u, function (err, res) {
            if (err && /HTTP 404/.test(err.message)) probeMissing = true;
            if (err) return cb(err);
            if (typeof res.direct !== 'boolean') return cb(new Error('unexpected reply'));
            probeCache[key] = res;
            cb(null, res, false);
        }, PROBE_TIMEOUT_MS);
    }

    /* Decide one file's route.  r = { key, query, serverUrl, directUrl, ready }
     * where ready(cb) makes directUrl playable.  cb(openUrl, route):
     * route.fallback is set when openUrl bypasses the server — the URL to
     * retry through if the direct open fails. */
    function resolveSmart(r, cb) {
        function viaServer(why) {
            log('smart: ' + r.key + ' → server (' + why + ')');
            cb(r.serverUrl, null);
        }
        if (directFailed(r.key)) return viaServer('direct play failed here before');
        if (probeMissing) return viaServer('server has no /api/probe — update it');
        var t0 = Date.now();
        probe(r.key, r.query, function (err, res, cached) {
            var took = cached ? 'cached' : (Date.now() - t0) + ' ms';
            if (err) return viaServer('probe failed: ' + err.message);
            var codecs = (res.video || '?') + '/' + (res.audio || '?') +
                         (res.audioChannels ? ' ' + res.audioChannels + 'ch' : '');
            if (!res.direct) return viaServer(codecs + ', ' + res.reason + ', ' + took);
            r.ready(function (e2) {
                if (e2) return viaServer(e2.message);
                log('smart: ' + r.key + ' → direct (' + codecs + ', ' + took + ')');
                cb(r.directUrl, { fallback: r.serverUrl });
            });
        });
    }

    /* A share file: direct means the local smbproxy stream. */
    function resolveShare(uri, path, cb) {
        if (typeof SMB === 'undefined' || !SMB.streamUrl || !SMB.ensureConnected) {
            log('smart: ' + path + ' → server (no local SMB stream)');
            return cb(uri, null);
        }
        resolveSmart({
            key: path,
            query: 'path=' + encodeURIComponent(path),
            serverUrl: uri,
            directUrl: SMB.streamUrl(path),
            ready: function (done) {
                SMB.ensureConnected(function (e) {
                    done(e ? new Error('local SMB not ready: ' + e.message) : null);
                });
            }
        }, cb);
    }

    /* The one entry point app.js needs: given the URI we would have played,
     * call back with the URI we should actually open.  Falls back to the
     * original on every failure path, so this can only change which bytes
     * AVPlay reads — never whether it gets any. */
    function resolvePlaybackUri(uri, cb) {
        var sharePath = smartEnabled() ? sharePathOf(uri) : null;
        if (sharePath !== null) return resolveShare(uri, sharePath, cb);
        if (!isLocalFileUri(uri) || !relayEnabled() || !isPaired()) return cb(uri);
        armRelay(function (r) {
            if (!r) return cb(uri);
            var serverUrl = localPlayUrl(uri);
            if (!serverUrl) return cb(uri);
            if (!smartEnabled()) return cb(serverUrl);
            // The box probes through the relay, so it has to be armed first.
            // Direct is the file:// URI itself — how USB plays with the relay off.
            resolveSmart({
                key: uri,
                query: 'src=' + encodeURIComponent(localSrcUrl(uri)),
                serverUrl: serverUrl,
                directUrl: uri,
                ready: function (done) { done(null); }
            }, cb);
        });
    }

    /* Recognise our own play URLs so recent/watched tracking treats two routes
     * to the same file consistently. */
    function isPlayUrl(u) {
        var s = get();
        return !!(s && s.url && typeof u === 'string' && u.indexOf(s.url.replace(/\/+$/, '') + '/play') === 0);
    }

    /* ── discovery: find the box on the LAN instead of typing a code ────────
     *
     * The code dance (mint a code on the TV, read it off one screen, type it
     * into another, relay through a public ntfy topic) is a lot of ceremony for
     * two machines on the same switch — and it needs working internet to link
     * two devices that don't.  The background service knows this TV's address
     * and netmask, so it can just sweep the subnet and ask whoever answers
     * whether they're a transcode server.
     *
     * The code path below is kept as a fallback for networks where the TV can't
     * reach the box directly (client isolation, VLANs, a subnet too wide to
     * sweep).
     * ------------------------------------------------------------------- */
    var DEFAULT_PORT = 8200;

    /* "192.168.1.20", "192.168.1.20:8201", "http://box.lan:8200/" → a base URL. */
    function normalizeServerUrl(raw) {
        var t = String(raw == null ? '' : raw).trim();
        if (!t) return '';
        t = t.replace(/\/+$/, '');
        if (!/^https?:\/\//i.test(t)) t = 'http://' + t;
        // Add the default port only when the user didn't give one. The host may
        // be a bare IPv6 literal in brackets, so match the port at the end.
        if (!/:\d+$/.test(t)) t += ':' + DEFAULT_PORT;
        return t;
    }

    function getJson(url, cb, timeoutMs) {
        xhrGet(url, function (err, text) {
            if (err) return cb(err);
            var j = null;
            try { j = JSON.parse(text || 'null'); } catch (e) {}
            if (!j) return cb(new Error('unexpected reply'));
            cb(null, j);
        }, timeoutMs);
    }

    /* Sweep the LAN via the background service. cb(err, servers[]). */
    function findServers(cb) {
        if (typeof SMB === 'undefined' || !SMB.ensureService)
            return cb(new Error(I18n.t('srv.err.noService')));
        SMB.ensureService(function (err) {
            if (err) return cb(err);
            // A /24 sweep is ~250 TCP connects at 500 ms worst case, batched 48
            // at a time — a few seconds; a /22 is four times that. Well past the
            // default request timeout, so ask for a much longer one.
            getJson(SVC_BASE + '/discover', function (e2, res) {
                if (e2) return cb(e2);
                if (!res.ok) return cb(new Error(res.error || 'scan failed'));
                cb(null, res.servers || []);
            }, 45000);
        });
    }

    /* Confirm a URL really is a transcode server, then store the pairing. */
    function connectTo(url, cb) {
        var base = normalizeServerUrl(url);
        if (!base) return cb(new Error(I18n.t('srv.err.noAddress')));
        getJson(base + '/api/hello', function (err, hello) {
            // Distinguish "nothing there" from "something there, but not us" —
            // that's the difference between a typo in the address and a typo in
            // the port, and the user can only fix the one they're told about.
            if (err) {
                var answered = /^HTTP /.test(err.message) || err.message === 'unexpected reply';
                return cb(new Error(I18n.t(answered ? 'srv.err.notOurs' : 'srv.err.noAnswer', base)));
            }
            if (!hello || hello.app !== 'vlc-tv-transcode')
                return cb(new Error(I18n.t('srv.err.notOurs', base)));
            // The token lives on /api/status, not /api/hello — hello is the
            // unauthenticated probe and deliberately carries no secrets.
            getJson(base + '/api/status', function (e2, st) {
                if (e2) return cb(e2);
                set({
                    url: base, token: (st && st.token) || '',
                    name: hello.name || I18n.t('srv.section'), api: hello.api || 1
                });
                log('connected to ' + (hello.name || base) + ' @ ' + base);
                cb(null, {
                    url: base, name: hello.name || I18n.t('srv.section'),
                    canAdopt: !!hello.canAdopt, configured: !!hello.configured
                });
            });
        });
    }

    /* ── the box's own settings, driven from the TV ─────────────────────────
     *
     * Surround and the USB-relay permission live on the server but are decided
     * here: you're sitting in front of the TV when you notice the soundbar is
     * doing stereo, not in front of a laptop. The server applies only the keys
     * it's sent, so these patches can't disturb the share config.
     * ------------------------------------------------------------------- */
    var serverCfg = null;   // last /api/config we read; null = unknown

    /* Servers older than the discovery API replace their whole SMB block from
     * whatever body a config POST carries — so sending one a bare
     * {"surround":"eac3"} would wipe the user's share settings. They also have
     * no /api/hello, which makes them easy to spot. Check before driving
     * anything, and remember the answer on the pairing record so it costs one
     * request per pairing rather than one per press. */
    function serverApiVersion(cb) {
        var s = get();
        if (!s || !s.url) return cb(0);
        if (s.api) return cb(s.api);
        getJson(s.url + '/api/hello', function (err, hello) {
            var v = (!err && hello && hello.app === 'vlc-tv-transcode') ? (hello.api || 1) : 0;
            if (v) { s.api = v; set(s); }
            cb(v);
        });
    }

    function requireModernServer(cb) {
        serverApiVersion(function (v) {
            if (!v) return cb(new Error(I18n.t('srv.err.tooOld')));
            cb(null);
        });
    }

    function withToken(path) {
        var s = get();
        if (!s || !s.url) return null;
        var u = s.url + path;
        if (s.token) u += (path.indexOf('?') >= 0 ? '&' : '?') + 'token=' + encodeURIComponent(s.token);
        return u;
    }

    function loadServerConfig(cb) {
        var u = withToken('/api/config');
        if (!u) return cb(new Error('not paired'));
        requireModernServer(function (old) {
            if (old) return cb(old);
            getJson(u, function (err, cfg) {
                if (err) return cb(err);
                serverCfg = cfg;
                cb(null, cfg);
            });
        });
    }

    function patchServerConfig(patch, cb) {
        var u = withToken('/api/config');
        if (!u) return cb(new Error('not paired'));
        requireModernServer(function (old) {
            if (old) return cb(old);
            xhrPost(u, patch, function (err, res) {
                if (err) return cb(err);
                if (res && res.ok === false) return cb(new Error(res.error || 'the server declined'));
                // Keep the local copy in step rather than re-fetching one field.
                if (serverCfg) for (var k in patch) serverCfg[k] = patch[k];
                cb(null);
            });
        });
    }

    /* Send this TV's share settings to a box that hasn't got any. The mirror of
     * adoptShare: whoever already knows the share tells the other one, so it's
     * never typed twice. Deliberately never automatic when the server already
     * has a share configured — clobbering a working server config from a TV
     * that happens to hold something older would be a nasty surprise. */
    function pushShare(cb) {
        var c = (typeof SMB !== 'undefined' && SMB.getCreds) ? SMB.getCreds() : null;
        if (!c || !c.host || !c.share) return cb(new Error(I18n.t('srv.err.noTvShare')));
        patchServerConfig({
            host: c.host, port: c.port || 445, share: c.share,
            user: c.user || '', pass: c.pass || '',
            domain: c.domain || '', anonymous: !!c.anonymous
        }, function (err) {
            if (err) return cb(err);
            cb(null, c);
        });
    }

    /* Copy the share settings off the box, so they're typed once — there, with
     * a real keyboard — instead of six fields at a time on a remote.
     * cb(err, smb). A refusal here is never fatal: the user can still fill the
     * share in by hand. */
    function adoptShare(cb) {
        var s = get();
        if (!s || !s.url) return cb(new Error('not paired'));
        var u = s.url + '/api/adopt' + (s.token ? '?token=' + encodeURIComponent(s.token) : '');
        getJson(u, function (err, res) {
            if (err) return cb(err);
            if (!res.ok) return cb(new Error(res.error || 'the server declined'));
            var smb = res.smb || {};
            if (!smb.host || !smb.share) return cb(new Error(I18n.t('srv.err.noServerShare')));
            if (typeof SMB !== 'undefined' && SMB.applyCreds) {
                SMB.applyCreds({
                    host: smb.host, port: smb.port || 445, share: smb.share,
                    user: smb.user || '', pass: smb.pass || '',
                    domain: smb.domain || '', anonymous: !!smb.anonymous
                });
            }
            cb(null, smb);
        });
    }

    /* ── pairing: pull the server's announcement off the -srv topic ─────── */
    function topic() {
        var code = (typeof UrlDrop !== 'undefined' && UrlDrop.code) ? UrlDrop.code() : '';
        return 'vlctv-' + code + '-srv';
    }

    function xhrGet(url, cb, timeoutMs) {
        var done = false;
        function finish(err, text) { if (done) return; done = true; cb(err, text); }
        try {
            var x = new XMLHttpRequest();
            x.open('GET', url, true);
            x.timeout = timeoutMs || 10000;
            x.onreadystatechange = function () {
                if (x.readyState !== 4) return;
                if (x.status >= 200 && x.status < 300) finish(null, x.responseText);
                else finish(new Error('HTTP ' + x.status));
            };
            x.ontimeout = function () { finish(new Error('timeout')); };
            x.onerror = function () { finish(new Error('network')); };
            x.send();
        } catch (e) { finish(e); }
    }

    /* ntfy poll returns newline-delimited JSON events; take the message body of
     * the last "message" event and JSON.parse it into the announcement. */
    function parseLatestAnnounce(text) {
        var lines = String(text || '').split('\n'), latest = null;
        for (var i = 0; i < lines.length; i++) {
            var ln = lines[i].trim();
            if (!ln) continue;
            var ev = null;
            try { ev = JSON.parse(ln); } catch (e) { continue; }
            if (ev && ev.event === 'message' && ev.message) latest = ev.message;
        }
        if (!latest) return null;
        try {
            var ann = JSON.parse(latest);
            // Wire-type bumped from "transcode-server" → "vlc-tv-transcode-server"
            // alongside the binary rename.  Accept both for one release cycle so
            // users still paired with an older server keep working after the TV
            // app upgrades; can drop the legacy alias next stable.
            if (ann && ann.url &&
                (ann.type === 'vlc-tv-transcode-server' || ann.type === 'transcode-server'))
                return ann;
        } catch (e) {}
        return null;
    }

    /* Pull the announcement and store it. cb(err, announce). */
    function pair(cb) {
        var url = NTFY_BASE + '/' + encodeURIComponent(topic()) + '/json?poll=1';
        log('pair GET ' + url);
        xhrGet(url, function (err, text) {
            if (err) return cb(err);
            var ann = parseLatestAnnounce(text);
            if (!ann) return cb(new Error(I18n.t('srv.err.noAnnounce')));
            // No api field here: the ntfy announcement predates it, so the
            // first thing that needs to drive this server will probe for it.
            set({ url: ann.url, token: ann.token || '', name: ann.name || I18n.t('srv.section') });
            log('paired with ' + ann.name + ' @ ' + ann.url);
            cb(null, ann);
        });
    }

    /* ── Settings UI wiring ─────────────────────────────────────────────── */
    function paintStatus() {
        var el = document.getElementById('srv-status-val');
        if (!el) return;
        var s = get();
        el.textContent = s && s.url ? (s.name || I18n.t('srv.paired')) + ' · ' + s.url : I18n.t('srv.notPaired');
    }

    function paintSmart() {
        var el = document.getElementById('srv-smart-val');
        if (el) el.textContent = I18n.t(smartEnabled() ? 'common.on' : 'common.off');
    }

    function paintRelay() {
        var el = document.getElementById('srv-local-val');
        if (el) el.textContent = I18n.t(relayEnabled() ? 'common.on' : 'common.off');
    }

    /* `format` is the product name, the same in every language; the picker
     * and the settings row add the translated note around it. */
    var SURROUND_FORMATS = { eac3: 'Dolby Digital Plus 5.1', ac3: 'Dolby Digital 5.1' };
    function surroundOptions() {
        return [
            { code: 'off',  name: I18n.t('srv.surround.off') },
            { code: 'eac3', name: I18n.t('srv.surround.eac3', SURROUND_FORMATS.eac3) },
            { code: 'ac3',  name: I18n.t('srv.surround.ac3', SURROUND_FORMATS.ac3) }
        ];
    }
    function paintSurround() {
        var el = document.getElementById('srv-surround-val');
        if (!el) return;
        if (!isPaired())  { el.textContent = '—'; return; }
        if (!serverCfg)   { el.textContent = '—'; return; }
        var code = serverCfg.surround || 'off';
        el.textContent = code === 'eac3' ? I18n.t('srv.surround.eac3', SURROUND_FORMATS.eac3)
                       : SURROUND_FORMATS[code] || I18n.t('common.off');
    }

    /* Finish a successful connect: get the share settings agreed between the two
     * ends, then report. Whichever side already knows the share tells the other,
     * so it's typed once — and neither direction failing is fatal, because the
     * pairing that matters already succeeded.
     *
     *   server has a share  → copy it down (adopt)
     *   server has none, TV does → send it up (push)
     *   neither             → say so; the user fills it in somewhere
     */
    function afterConnect(srv) {
        paintStatus();
        var addr = document.getElementById('srv-addr');
        if (addr) addr.value = srv.url.replace(/^https?:\/\//, '');
        function toast(m) { if (typeof UI !== 'undefined' && UI.toast) UI.toast(m); }

        loadServerConfig(function () { paintSurround(); });

        if (srv.configured && srv.canAdopt) {
            adoptShare(function (err, smb) {
                if (err) {
                    // Usually the ten-minute window on the box has closed. Its
                    // error says what to do about it, so pass it through rather
                    // than flattening it to "didn't work".
                    log('adopt skipped: ' + err.message);
                    toast(I18n.t('srv.pairedAdoptFailed', srv.name, err.message));
                    return;
                }
                toast(I18n.t('srv.pairedAdopted', srv.name, smb.host + '/' + smb.share));
            });
            return;
        }
        if (!srv.configured) {
            pushShare(function (err, c) {
                if (err) {
                    log('push skipped: ' + err.message);
                    toast(I18n.t('srv.pairedNoShare', srv.name));
                    return;
                }
                toast(I18n.t('srv.pairedPushed', srv.name, c.host + '/' + c.share));
            });
            return;
        }
        toast(I18n.t('srv.pairedWith', srv.name));
    }

    function runDiscovery() {
        function toast(m) { if (typeof UI !== 'undefined' && UI.toast) UI.toast(m); }
        toast(I18n.t('srv.searching'));
        findServers(function (err, servers) {
            if (err) { toast(I18n.t('srv.searchFailed', err.message)); return; }
            if (!servers.length) {
                toast(I18n.t('srv.nothingFound'));
                return;
            }
            if (servers.length === 1) {
                connectTo(servers[0].url, function (e2, srv) {
                    if (e2) { toast(I18n.t('srv.connectFailed', e2.message)); return; }
                    afterConnect(srv);
                });
                return;
            }
            // More than one on the LAN — let the user say which.
            var opts = servers.map(function (sv) {
                return { code: sv.url, name: sv.name + '  ·  ' + sv.host };
            });
            if (!window.VlcApp || !window.VlcApp.openPicker) {
                toast(I18n.t('srv.foundMany', servers.length));
                return;
            }
            window.VlcApp.openPicker(I18n.t('srv.choose'), opts, '', function (url) {
                connectTo(url, function (e2, srv) {
                    if (e2) { toast(I18n.t('srv.connectFailed', e2.message)); return; }
                    afterConnect(srv);
                });
            });
        });
    }

    function wireSettings() {
        var pairBtn = document.getElementById('srv-pair');
        var unpairBtn = document.getElementById('srv-unpair');
        var localBtn = document.getElementById('srv-local');
        var smartBtn = document.getElementById('srv-smart');
        var findBtn = document.getElementById('srv-find');
        var connectBtn = document.getElementById('srv-connect');
        var addrInput = document.getElementById('srv-addr');
        var surroundBtn = document.getElementById('srv-surround');
        var pushBtn = document.getElementById('srv-push');
        var adoptBtn = document.getElementById('srv-adopt');
        paintStatus();
        paintRelay();
        paintSmart();
        paintSurround();

        var cur = get();
        if (addrInput && cur && cur.url) addrInput.value = cur.url.replace(/^https?:\/\//, '');
        if (isPaired()) loadServerConfig(function () { paintSurround(); });

        function toast(m) { if (typeof UI !== 'undefined' && UI.toast) UI.toast(m); }

        if (surroundBtn) surroundBtn.addEventListener('click', function () {
            if (!isPaired()) { toast(I18n.t('srv.pairFirst')); return; }
            if (!window.VlcApp || !window.VlcApp.openPicker) return;
            var current = (serverCfg && serverCfg.surround) || 'off';
            window.VlcApp.openPicker(I18n.t('srv.surround'), surroundOptions(), current, function (val) {
                patchServerConfig({ surround: val }, function (err) {
                    if (err) { toast(I18n.t('srv.changeFailed', err.message)); return; }
                    paintSurround();
                    toast(val === 'off' ? I18n.t('srv.surroundOff')
                                        : I18n.t('srv.surroundOn', SURROUND_FORMATS[val] || val));
                });
            });
        });

        if (adoptBtn) adoptBtn.addEventListener('click', function () {
            if (!isPaired()) { toast(I18n.t('srv.pairFirst')); return; }
            adoptShare(function (err, smb) {
                if (err) { toast(err.message); return; }
                toast(I18n.t('srv.adopted', smb.host + '/' + smb.share));
            });
        });

        if (pushBtn) pushBtn.addEventListener('click', function () {
            if (!isPaired()) { toast(I18n.t('srv.pairFirst')); return; }
            pushShare(function (err, c) {
                if (err) { toast(I18n.t('srv.pushFailed', err.message)); return; }
                toast(I18n.t('srv.pushed', c.host + '/' + c.share));
            });
        });

        if (findBtn) findBtn.addEventListener('click', runDiscovery);

        if (connectBtn) connectBtn.addEventListener('click', function () {
            var toast = function (m) { if (typeof UI !== 'undefined' && UI.toast) UI.toast(m); };
            var raw = addrInput ? addrInput.value : '';
            if (!String(raw).trim()) { toast(I18n.t('srv.typeAddress')); return; }
            toast(I18n.t('common.connecting'));
            connectTo(raw, function (err, srv) {
                if (err) { toast(err.message); return; }
                afterConnect(srv);
            });
        });
        if (smartBtn) smartBtn.addEventListener('click', function () {
            var on = !smartEnabled();
            Settings.set('smartRouting', on);
            probeCache = {}; probeMissing = false;   // a server update may have added /api/probe
            paintSmart();
            if (!on) { toast(I18n.t('srv.smartOff')); return; }
            if (!isPaired()) { toast(I18n.t('srv.smartUnpaired')); return; }
            toast(I18n.t('srv.smartOn'));
        });
        if (localBtn) localBtn.addEventListener('click', function () {
            var on = !relayEnabled();
            Settings.set('localRelay', on);
            paintRelay();
            if (!on) {
                disarmRelay();
                // Withdraw the permission too, so the box goes back to reading
                // only from the share rather than sitting there willing to
                // accept files nobody is going to send.
                if (isPaired()) patchServerConfig({ local_relay: false }, function () {});
                toast(I18n.t('srv.relayOff'));
                return;
            }
            if (!isPaired()) { toast(I18n.t('srv.pairFirst')); return; }
            // The box has to agree to accept files from us. Ask for that here
            // rather than making the user go and find the switch on its page.
            patchServerConfig({ local_relay: true }, function (err) {
                if (err) { toast(I18n.t('srv.refused', err.message)); return; }
                armRelay(function (r) {
                    toast(I18n.t(r ? 'srv.relayOn' : 'srv.relayFailed'));
                });
            });
        });
        if (pairBtn) pairBtn.addEventListener('click', function () {
            if (typeof UI !== 'undefined' && UI.toast) UI.toast(I18n.t('srv.pairSearching'));
            pair(function (err, ann) {
                if (err) { if (UI && UI.toast) UI.toast(I18n.t('srv.pairFailed', err.message)); return; }
                // Same follow-up as the LAN flow: the announcement doesn't say
                // whether the server will share its share settings, so just ask
                // — adoptShare reports a refusal as a footnote, not a failure.
                afterConnect({ url: get().url, name: (ann && ann.name) || I18n.t('srv.section'), canAdopt: true });
            });
        });
        if (unpairBtn) unpairBtn.addEventListener('click', function () {
            clear(); disarmRelay(); paintStatus();
            probeCache = {}; probeMissing = false;
            if (typeof UI !== 'undefined' && UI.toast) UI.toast(I18n.t('srv.removed'));
        });
    }

    if (document.readyState === 'loading')
        document.addEventListener('DOMContentLoaded', wireSettings);
    else
        wireSettings();

    return {
        get: get, set: set, clear: clear, isPaired: isPaired,
        playUrl: playUrl, isPlayUrl: isPlayUrl, pair: pair,
        resolvePlaybackUri: resolvePlaybackUri, markDirectFailed: markDirectFailed,
        findServers: findServers, connectTo: connectTo,
        adoptShare: adoptShare, pushShare: pushShare,
        loadServerConfig: loadServerConfig, patchServerConfig: patchServerConfig
    };
})();

// Ignored by the Tizen/browser build; lets Node tests drive the module.
if (typeof module !== 'undefined' && module.exports) module.exports = TranscodeServer;
