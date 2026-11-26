/* ============================================================================
 * SMB client glue (web side).
 * ----------------------------------------------------------------------------
 * Talks to the hybrid <tizen:service> ("smbproxy") over localhost HTTP. The
 * service does the actual SMB2; here we just launch it, hand it credentials,
 * browse folders, and turn a chosen file into an http://127.0.0.1 stream URL
 * that AVPlay can play — which means it flows through the app's normal
 * playFromList() path and inherits next/prev, auto-play, recent and watched
 * tracking for free.
 *
 * Credentials live in their own localStorage blob (Settings only persists its
 * fixed key set, so we don't try to smuggle SMB creds through it).
 *
 * More than one server (#101): the first stays in CREDS_KEY exactly as before,
 * and servers added after it go in EXTRA_KEY, each with a short random id.
 * Files on the first server keep the URLs they always had, so recents, resume
 * positions and smart-routing memory saved before stay valid; files on an
 * added server carry &srv=<id> (smbproxy) or &host=…&share=… (transcode box).
 * An older app build just goes on seeing the first server.
 * ==========================================================================*/

var SMB = (function () {

    var BASE = 'http://127.0.0.1:8127';
    var CREDS_KEY = 'vlctv_smb_v1';
    var EXTRA_KEY = 'vlctv_smb_extra_v1';
    var tvIp = '';

    function platformMajor() {
        try {
            if (typeof tizen !== 'undefined' && tizen.systeminfo && tizen.systeminfo.getCapability) {
                return parseInt(tizen.systeminfo.getCapability('http://tizen.org/feature/platform.version'), 10) || 0;
            }
        } catch (e) {}
        return 0;
    }

    /* Tizen 9 and later start a web service through the Service class of the wrt:service module.
     * Dynamic import via module script ensures older TVs run none of this and start as before.
     * loadWrtService is the import alone, without the version check: ensureService falls back
     * on it when a TV below 9 accepts the old launch and then never runs the service, which is
     * what a late-2026 firmware for Tizen 8.0 sets does (issue #188). */
    var wrtTried = false, wrtWaiting = null;
    function loadWrtService(cb) {
        if (typeof window !== 'undefined' && window.tesselService) return cb();
        if (wrtWaiting) { wrtWaiting.push(cb); return; }   // the import is still on its way
        if (wrtTried) return cb();       // the module script is added once; a failed import stays failed
        wrtTried = true;
        wrtWaiting = [cb];
        var done = false;
        function once() {
            if (done) return;
            done = true;
            if (typeof window !== 'undefined' && window.removeEventListener) {
                window.removeEventListener('tessel-wrt-service', once);
            }
            var waiting = wrtWaiting;
            wrtWaiting = null;
            for (var i = 0; i < waiting.length; i++) waiting[i]();
        }
        try {
            if (typeof document === 'undefined' || !document.createElement || !document.body) return once();
            var s = document.createElement('script');
            if (!('noModule' in s)) return once();   // an engine without module scripts would never run it
            if (typeof window !== 'undefined' && window.addEventListener) {
                window.addEventListener('tessel-wrt-service', once);
            }
            setTimeout(once, 3000);
            s.type = 'module';
            s.text = "import { Service } from 'wrt:service'; window.tesselService = Service; window.dispatchEvent(new Event('tessel-wrt-service'));";
            s.onerror = once;
            document.body.appendChild(s);
        } catch (e) {
            once();
        }
    }
    /* Which way of starting brought the service up on this TV, when it was not the one
     * its Tizen version starts with (issue #191).  Without it such a TV waits four
     * seconds on the first way every time the service has to be started.  Only the
     * exception is stored, so a TV that behaves as its version says keeps nothing. */
    var WAY_KEY = 'vlctv_service_way_v1';
    function defaultWay() { return platformMajor() >= 9 ? 'wrt' : 'legacy'; }
    function rememberedWay() {
        try {
            var w = localStorage.getItem(WAY_KEY);
            if (w === 'wrt' || w === 'legacy') return w;
        } catch (e) {}
        return '';
    }
    function rememberWay(way) {
        if (way !== 'wrt' && way !== 'legacy') return;
        try {
            if (way === defaultWay()) {
                if (localStorage.getItem(WAY_KEY) === null) return;
                localStorage.removeItem(WAY_KEY);
            } else {
                if (localStorage.getItem(WAY_KEY) === way) return;
                localStorage.setItem(WAY_KEY, way);
            }
            dbg('service start: remembering ' + way + ' as the way that works on this TV');
        } catch (e) {}
    }
    function withWrtService(cb) {
        if ((rememberedWay() || defaultWay()) !== 'wrt') return cb();
        loadWrtService(cb);
    }
    withWrtService(function () {});

    var rtcProbe = null;
    function findIpViaRtc() {
        if (typeof window === 'undefined' || rtcProbe) return;
        try {
            var RTCPC = window.RTCPeerConnection || window.webkitRTCPeerConnection || window.mozRTCPeerConnection;
            if (!RTCPC) return;
            var rtc = rtcProbe = new RTCPC({ iceServers: [] });
            rtc.createDataChannel('');
            rtc.createOffer().then(function (offer) {
                return rtc.setLocalDescription(offer);
            }).catch(function () {});
            rtc.onicecandidate = function (ice) {
                if (!ice || !ice.candidate || !ice.candidate.candidate) return;
                var m = /([0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3})/.exec(ice.candidate.candidate);
                if (m && m[1] && m[1] !== '0.0.0.0' && m[1].indexOf('127.') !== 0) {
                    var ip = m[1].trim();
                    if (!tvIp) {
                        tvIp = ip;
                        dbg('detected tvIp via WebRTC ICE: ' + tvIp);
                    }
                    try { rtc.close(); } catch (e) {}
                    rtcProbe = null;
                }
            };
        } catch (e) { rtcProbe = null; }
    }

    function readTvIp() {
        if (typeof webapis !== 'undefined' && webapis.network && typeof webapis.network.getIp === 'function') {
            try {
                var ip = webapis.network.getIp();
                if (ip && typeof ip === 'string' && ip !== '0.0.0.0' && !tvIp) {
                    tvIp = ip.trim();
                    dbg('detected tvIp via webapis.network: ' + tvIp);
                }
            } catch (e) {}
        }
        if (typeof tizen !== 'undefined' && tizen.systeminfo && typeof tizen.systeminfo.getPropertyValue === 'function') {
            ['ETHERNET_NETWORK', 'WIFI_NETWORK', 'NETWORK'].forEach(function (prop) {
                try {
                    tizen.systeminfo.getPropertyValue(prop, function (val) {
                        var ip = val && (val.ipAddress || val.ip);
                        if (ip && typeof ip === 'string' && ip !== '0.0.0.0' && !tvIp) {
                            tvIp = ip.trim();
                            dbg('detected tvIp via systeminfo ' + prop + ': ' + tvIp);
                        }
                    }, function () {});
                } catch (e) {}
            });
        }
        findIpViaRtc();
    }
    readTvIp();

    /* All SMB-side activity goes out through Debug under one tag, so it lands
     * in the DevTools console (and the PC listener, if one is configured) and
     * the connection flow is traceable end to end. */
    function dbg(msg) { if (typeof Debug !== 'undefined' && Debug.send) Debug.send('SMB', msg); }

    /* Pull the service's own ring-buffer log and forward it under the SMB tag.
     * The service is a separate process: its console is not the one DevTools
     * shows when the app is inspected, so this is the only way the NEGOTIATE /
     * auth / socket trail from inside it reaches the console (or the PC
     * listener).  Called at each step of the connection flow, not just after
     * a failure, and only the lines that arrived since the previous pull are
     * forwarded so the trail reads in order without repeats. */
    var lastSvcLine = null;
    function dumpServiceLogs(why) {
        getJson(BASE + '/smb/debug/logs', function (err, res) {
            if (err || !res || !res.logs) { dbg('service logs unavailable: ' + (err ? err.message : 'none')); return; }
            var logs = res.logs;
            var from = lastSvcLine === null ? -1 : logs.lastIndexOf(lastSvcLine);
            if (from < 0) from = Math.max(0, logs.length - 40) - 1;   // first pull, or ring buffer rolled past us
            if (from + 1 >= logs.length) { dbg('svc (no new lines' + (why ? ', ' + why : '') + ')'); return; }
            dbg('svc --- ' + (logs.length - from - 1) + ' line(s)' + (why ? ' after ' + why : '') + ' ---');
            for (var i = from + 1; i < logs.length; i++) dbg('svc ' + logs[i]);
            lastSvcLine = logs[logs.length - 1];
        });
    }

    /* ── credentials ───────────────────────────────────────────────────── */
    function getCreds() {
        try { return JSON.parse(localStorage.getItem(CREDS_KEY) || '{}'); }
        catch (e) { return {}; }
    }
    function setCreds(c) {
        try { localStorage.setItem(CREDS_KEY, JSON.stringify(c || {})); } catch (e) {}
    }

    /* Accept smb://host:port, //host/share, \\host\share, host:port, or a
     * bare host. Split the port out so it can reach the proxy (SmbConnection
     * only honours opts.port), and never leave a colon in host: net.connect
     * treats "ip:port" as a hostname and getaddrinfo ENOTFOUNDs it.  Windows
     * users type the share the way Explorer shows it, backslashes included,
     * so those count as separators too.  Whatever followed the host is
     * returned as `share` so the form can fall back on it when the Share
     * field was left empty. */
    function normalizeServer(raw) {
        var s = String(raw == null ? '' : raw).trim();
        s = s.replace(/\\/g, '/');                              // \\host\share → //host/share
        s = s.replace(/^smb:\/\//i, '').replace(/^\/+/, '');   // drop scheme + leading slashes
        var parts = s.split('/');
        s = parts[0];
        var share = (parts[1] || '').trim();
        var port = 0;
        var m = s.match(/^(\[[^\]]+\]|[^:]+):(\d+)$/);        // host:port (IPv6 in [])
        if (m) { s = m[1]; port = parseInt(m[2], 10); }
        s = s.replace(/^\[|\]$/g, '');                        // unwrap bare [ipv6]
        return { host: s, port: port, share: share };
    }
    function haveCreds() { var c = getCreds(); return !!(c.host && c.share); }

    /* ── more than one server ──────────────────────────────────────────── */
    function getExtra() {
        try {
            var l = JSON.parse(localStorage.getItem(EXTRA_KEY) || '[]');
            return Array.isArray(l) ? l : [];
        } catch (e) { return []; }
    }
    function setExtra(l) {
        try { localStorage.setItem(EXTRA_KEY, JSON.stringify(l || [])); } catch (e) {}
    }
    function newId() { return Math.random().toString(36).slice(2, 10); }

    /* Every usable server, the first one (id '') first. */
    function servers() {
        var out = [];
        if (haveCreds()) { var c = getCreds(); c.id = ''; out.push(c); }
        getExtra().forEach(function (x) { if (x.host && x.share) out.push(x); });
        return out;
    }
    function serverById(id) {
        if (!id) { var c = getCreds(); c.id = ''; return c; }
        var l = getExtra();
        for (var i = 0; i < l.length; i++) if (l[i].id === id) return l[i];
        return null;
    }
    function sameHost(a, b) {
        return String(a || '').replace(/^\[|\]$/g, '').toLowerCase() ===
               String(b || '').replace(/^\[|\]$/g, '').toLowerCase();
    }
    /* The id of the saved server at host with that share, or null.  Share
     * names compare case-insensitively, as SMB does. */
    function findServer(host, share) {
        var l = servers();
        for (var i = 0; i < l.length; i++)
            if (sameHost(l[i].host, host) && String(l[i].share).toLowerCase() === String(share || '').toLowerCase())
                return l[i].id;
        return null;
    }
    function serverLabel(c) { return '\\\\' + c.host + '\\' + c.share; }

    /* ── tiny XHR helpers (the service sets permissive CORS) ───────────────*/
    function getJson(url, cb, timeoutMs) {
        var x = new XMLHttpRequest();
        x.open('GET', url, true);
        x.timeout = timeoutMs || 15000;
        x.onload = function () {
            try { cb(null, JSON.parse(x.responseText)); }
            catch (e) { cb(new Error('bad response')); }
        };
        x.onerror = function () { cb(new Error('service unreachable')); };
        x.ontimeout = function () { cb(new Error('timeout')); };
        x.send();
    }
    function postJson(url, body, cb) {
        var x = new XMLHttpRequest();
        x.open('POST', url, true);
        x.setRequestHeader('Content-Type', 'application/json');
        x.timeout = 20000;
        x.onload = function () {
            try { cb(null, JSON.parse(x.responseText)); }
            catch (e) { cb(new Error('bad response')); }
        };
        x.onerror = function () { cb(new Error('service unreachable')); };
        x.ontimeout = function () { cb(new Error('timeout')); };
        x.send(JSON.stringify(body || {}));
    }

    function getCandidates() {
        if (!tvIp) readTvIp();           // once; the address does not change between ticks
        var c = [BASE, 'http://127.0.0.1:8127'];
        if (tvIp) c.push('http://' + tvIp + ':8127');
        c.push('http://localhost:8127');
        var out = [], seen = {};
        for (var i = 0; i < c.length; i++) {
            var url = c[i];
            if (url && !seen[url]) {
                seen[url] = true;
                out.push(url);
            }
        }
        return out;
    }

    /* ── launch the hybrid service, then wait for it to answer /smb/ping ──── */
    var OTHER_WAY_MS = 4000, AGAIN_MS = 12000, GIVE_UP_MS = 30000;
    function ensureService(cb) {
        // Don't start the service when Network access is 'none'.
        if (typeof NetworkAccess !== 'undefined' && NetworkAccess.level() === 'none')
            return cb(NetworkAccess.refusal(I18n.t('home.smb')));

        withWrtService(function () {
            var launchStatus = 'pending';
            var firstWay = '', lastWay = '', legacyTried = false;
            var remembered = rememberedWay();
            var appId = (typeof tizen !== 'undefined' && tizen.application && tizen.application.getCurrentApplication) ?
                tizen.application.getCurrentApplication().appInfo.id : 'madebypatk.vlcweb';
            var pkgId = appId.split('.')[0];
            var svcId = pkgId + '.smbproxy';

            // Tizen 9/10: start web service via Service class of wrt:service
            function startViaWrt() {
                var Svc = (typeof window !== 'undefined') ? window.tesselService : null;
                if (typeof Svc !== 'function') return false;
                try {
                    var started = new Svc(svcId).start();
                    lastWay = 'wrt';
                    if (started && typeof started.then === 'function') {
                        started.then(
                            function () { launchStatus = 'ok'; dbg('service started via wrt:service'); },
                            function (e) {
                                launchStatus = 'failed (' + (e && e.message || e) + ')';
                                dbg('wrt:service start error: ' + (e && e.message || e));
                                if (lastWay === 'wrt') lastWay = legacyTried ? 'legacy' : '';   // not the one to remember
                            }
                        );
                    } else {
                        launchStatus = 'ok';
                        dbg('service started via wrt:service');
                    }
                    return true;
                } catch (e) {
                    launchStatus = 'failed (' + (e && e.message || e) + ')';
                    dbg('wrt:service start threw: ' + (e && e.message || e));
                    return false;
                }
            }

            // Older Tizen (4 to 8): an app control, or a plain launch where that is refused
            function startLegacy() {
                if (typeof tizen === 'undefined' || !tizen.application) return;
                lastWay = 'legacy'; legacyTried = true;
                if (tizen.ApplicationControl && tizen.application.launchAppControl) {
                    try {
                        tizen.application.launchAppControl(
                            new tizen.ApplicationControl('http://tizen.org/appcontrol/operation/service'),
                            svcId,
                            function () { launchStatus = 'ok'; dbg('service launchAppControl ok'); },
                            function (e) {
                                dbg('launchAppControl failed, falling back to launch: ' + (e && e.message));
                                try {
                                    tizen.application.launch(svcId,
                                        function () { launchStatus = 'ok'; dbg('service launch ok'); },
                                        function (e2) { launchStatus = 'error: ' + (e2 && e2.message); dbg('service launch error: ' + (e2 && e2.message)); });
                                } catch (e3) { launchStatus = 'threw: ' + e3.message; dbg('service launch threw: ' + e3.message); }
                            }
                        );
                        return;
                    } catch (e) {
                        dbg('launchAppControl threw: ' + e.message);
                    }
                }
                try {
                    tizen.application.launch(svcId,
                        function () { launchStatus = 'ok'; dbg('service launch ok'); },
                        function (e) { launchStatus = 'error: ' + (e && e.message); dbg('service launch error: ' + (e && e.message)); });
                } catch (e) {
                    launchStatus = 'threw: ' + e.message;
                    dbg('service launch threw: ' + e.message);
                }
            }

            function launch() {
                dbg('launching service ' + svcId + (remembered ? ' (' + remembered + ' first, it worked here before)' : ''));
                // wrt:service whenever it is there, unless this TV is known to need the old launch
                if (remembered !== 'legacy' && startViaWrt()) { firstWay = 'wrt'; return; }
                firstWay = 'legacy';
                startLegacy();
            }

            /* Nothing answered after the first launch: start the service the way the first
             * launch did not.  A TV can report the old launch as accepted and still never
             * run the service (issue #188), so this does not look at launchStatus. */
            function launchOtherWay() {
                if (firstWay === 'wrt') {
                    dbg('no answer yet, launching service ' + svcId + ' the old way');
                    return startLegacy();
                }
                var wasOk = launchStatus === 'ok';
                loadWrtService(function () {
                    if (found) return;
                    if (typeof window !== 'undefined' && typeof window.tesselService === 'function') {
                        dbg('no answer yet, launching service ' + svcId + ' via wrt:service');
                        if (startViaWrt()) return;
                    } else {
                        dbg('no answer yet, and wrt:service is not available on this TV');
                    }
                    if (!wasOk) { dbg('launching service ' + svcId + ' again'); startLegacy(); }
                });
            }

            launch();

            /* The service may already be running from a previous open; poll either way.
             * Half a minute, by the clock: the first start after an install or a restart
             * of the TV is slow, and 7.5 s was too short for it on a 2019 set (TV-Store,
             * which starts its service the same way).  After 4 s the other way of
             * starting is tried, after 12 s the first one again, in case the TV dropped
             * the request. */
            var tries = 0;
            var found = false;
            var began = Date.now();
            var otherTried = false, againTried = false;
            (function poll() {
                var list = getCandidates();
                var left = list.length;
                var lastErr = null;
                list.forEach(function (base) {
                    getJson(base + '/smb/ping', function (err, res) {
                        if (found) return;
                        if (!err && res && res.ok) {
                            found = true;
                            if (BASE !== base) {
                                dbg('service ping ok on ' + base + ' (switched from ' + BASE + ') after ' + tries + ' tries');
                                BASE = base;
                            } else {
                                dbg('service ping ok on ' + base + ' after ' + tries + ' tries');
                            }
                            // Answered at once: it was running already, and no launch gets the credit.
                            if (tries > 0) rememberWay(lastWay);
                            return cb(null);
                        }
                        if (err) lastErr = err;
                        if (--left > 0) return;
                        if (found) return;
                        var waited = Date.now() - began;
                        ++tries;
                        if (!otherTried && waited >= OTHER_WAY_MS) { otherTried = true; launchOtherWay(); }
                        else if (!againTried && waited >= AGAIN_MS) { againTried = true; launch(); }
                        if (waited >= GIVE_UP_MS) {
                            dbg('service ping gave up after ' + tries + ' tries in ' + Math.round(waited / 1000) + ' s: ' +
                                (lastErr ? lastErr.message : 'unreachable') + ', launch ' + launchStatus);
                            explainNoService(svcId, list);
                            return cb(new Error('SMB service did not start'));
                        }
                        setTimeout(poll, 300);
                    }, 2000);
                });
            })();
        });
    }

    /* The service never answered.  Put what the page can find out about it in the debug
     * log: there is no shell on a retail TV, and "did not start" alone does not say
     * whether the TV lacks the service, never ran it, or runs it and blocks the page. */
    function explainNoService(svcId, list) {
        try {
            var ver = '?';
            try { ver = tizen.systeminfo.getCapability('http://tizen.org/feature/platform.version'); } catch (e) {}
            dbg('no service: platform ' + ver + ', tried ' + list.join(' ') +
                ', wrt:service ' + ((typeof window !== 'undefined' && typeof window.tesselService === 'function') ? 'available' : 'not available'));
            if (typeof tizen !== 'undefined' && tizen.application) {
                try {
                    var info = tizen.application.getAppInfo(svcId);
                    dbg('no service: ' + svcId + ' is installed' + (info && info.version ? ' (' + info.version + ')' : ''));
                } catch (e) {
                    dbg('no service: ' + svcId + ' is not installed: ' + (e && (e.name || e.message)));
                }
                try {
                    tizen.application.getAppsContext(function (ctxs) {
                        var running = false, n = ctxs ? ctxs.length : 0;
                        for (var i = 0; i < n; i++) if (ctxs[i] && ctxs[i].appId === svcId) running = true;
                        dbg('no service: ' + svcId + (running ? ' is' : ' is not') + ' among the ' + n + ' running apps');
                    }, function (e) { dbg('no service: running apps not readable: ' + (e && (e.name || e.message))); });
                } catch (e) {
                    dbg('no service: running apps not readable: ' + (e && (e.name || e.message)));
                }
            }
            // A request the page may send but not read: it succeeds whenever anything answers on the port.
            if (typeof fetch === 'function') {
                fetch(list[0] + '/smb/ping', { mode: 'no-cors', cache: 'no-store' }).then(
                    function () { dbg('no service: the port answers, so the service runs and the page is kept from reading it'); },
                    function (e) { dbg('no service: nothing answers on the port (' + (e && e.message || e) + ')'); });
            }
        } catch (e) {}
    }

    function connect(id, cb) {
        var c = serverById(id) || {};
        if (typeof NetworkAccess !== 'undefined' &&
            !NetworkAccess.check('smb://' + (c.host || ''), c.host, function () { connect(id, cb); }))
            return cb(NetworkAccess.refusal(c.host || I18n.t('home.smb')));
        dbg('connect -> ' + (c.host || '?') + '\\' + (c.share || '?') + (id ? ' [' + id + ']' : '') +
            ' user=' + (c.anonymous ? '(guest)' : (c.user || '(none)')));
        postJson(BASE + '/smb/connect', {
            id: id || '',
            host: c.host, share: c.share, user: c.user || '',
            pass: c.pass || '', domain: c.domain || '', port: c.port || 445,
            anonymous: !!c.anonymous
        }, function (err, res) {
            if (err) { dbg('connect transport error: ' + err.message); return cb(err); }
            if (!res.ok) { dbg('connect rejected: ' + (res.error || 'unknown')); return cb(new Error(res.error || 'connect failed')); }
            dbg('connect ok: dialect=' + res.dialect + ' signing=' + res.signing);
            cb(null, res);
        });
    }

    /* Make /smb/stream usable without going through the browser first — a
     * file opened from Recents after a restart finds the service down, or up
     * but never told which share to read.  Leaves a live connection alone:
     * /smb/connect drops and rebuilds it.  id picks the server ('' = first). */
    function ensureConnected(id, cb) {
        id = id || '';
        getJson(BASE + '/smb/ping', function (err, res) {
            if (!err && res && (res.servers || []).indexOf(id) >= 0) return cb(null);
            ensureService(function (e2) {
                if (e2) return cb(e2);
                connect(id, function (e3) { cb(e3 || null); });
            });
        });
    }

    /* The disk shares a server offers, asked of it with the credentials
     * given — not the saved ones, so the form can look before saving. */
    function listShares(c, cb) {
        dbg('list shares on ' + (c.host || '?') + ':' + (c.port || 445) +
            ' user=' + (c.anonymous ? '(guest)' : (c.user || '(none)')));
        postJson(BASE + '/smb/shares', {
            host: c.host, user: c.user || '', pass: c.pass || '',
            domain: c.domain || '', port: c.port || 445, anonymous: !!c.anonymous
        }, function (err, res) {
            if (err) return cb(err);
            if (!res.ok) return cb(new Error(res.error || 'share list failed'));
            dbg('server lists ' + (res.shares || []).length + ' share(s)');
            cb(null, res.shares || []);
        });
    }

    /* A small text file on server `id`, written or read whole: the backup
     * and the debug log (issue #132).  Both bring the connection up first,
     * so they work straight after a restart. */
    function writeText(id, path, text, cb) {
        ensureConnected(id, function (err) {
            if (err) return cb(err);
            postJson(BASE + '/smb/write' + (id ? '?srv=' + encodeURIComponent(id) : ''),
                     { path: path, text: text }, function (e2, res) {
                if (e2) return cb(e2);
                if (!res.ok) return cb(new Error(res.error || 'write failed'));
                dbg('wrote ' + path + (id ? ' [' + id + ']' : '') + ': ' + res.size + ' bytes on the share');
                cb(null, res.size);
            });
        });
    }
    function readText(id, path, cb) {
        ensureConnected(id, function (err) {
            if (err) return cb(err);
            var x = new XMLHttpRequest();
            x.open('GET', streamUrl(path, id), true);
            x.timeout = 20000;
            x.onload = function () {
                if (x.status === 200) cb(null, x.responseText);
                else cb(new Error(x.status === 404 ? 'not found' : (x.responseText || 'HTTP ' + x.status)));
            };
            x.onerror = function () { cb(new Error('service unreachable')); };
            x.ontimeout = function () { cb(new Error('timeout')); };
            x.send();
        });
    }

    function list(path, cb) {
        getJson(BASE + '/smb/list?path=' + encodeURIComponent(path || '') + srvParam(current), function (err, res) {
            if (err) return cb(err);
            if (!res.ok) return cb(new Error(res.error || 'list failed'));
            cb(null, res.entries || []);
        });
    }

    function srvParam(id) { return id ? '&srv=' + encodeURIComponent(id) : ''; }

    /* The URL handed to AVPlay. The service streams the file with Range
     * support, so seeking works.  srv names an added server; the first
     * server's URLs carry nothing, as they always have. */
    function streamUrl(path, srv) {
        return BASE + '/smb/stream?path=' + encodeURIComponent(path) + srvParam(srv);
    }

    /* The server a stream URL reads from ('' = first), or null when it isn't
     * one of ours. */
    function streamServerOf(u) {
        if (!isStreamUrl(u)) return null;
        var m = /[?&]srv=([^&]*)/.exec(u);
        return m ? decodeURIComponent(m[1]) : '';
    }
    function isStreamUrl(u) {
        if (typeof u !== 'string') return false;
        if (u.indexOf(BASE + '/smb/stream') === 0) return true;
        if (u.indexOf('http://127.0.0.1:8127/smb/stream') === 0) return true;
        if (u.indexOf('http://localhost:8127/smb/stream') === 0) return true;
        if (tvIp && u.indexOf('http://' + tvIp + ':8127/smb/stream') === 0) return true;
        return /^http:\/\/(?:127\.0\.0\.1|localhost|\d+\.\d+\.\d+\.\d+):8127\/smb\/stream/.test(u);
    }

    /* The URL we actually play. If a transcode server is paired, route through
     * it (HLS, server-side decode of DTS/TrueHD and codecs the TV can't handle);
     * otherwise stream the file straight from the localhost smbproxy as before.
     * Browsing is identical either way — only the bytes' origin changes. */
    function playableUrl(path, srv) {
        if (typeof TranscodeServer !== 'undefined' && TranscodeServer.isPaired()) {
            // An added server is named to the box by host and share; the first
            // one isn't, so its URLs stay what they were.  playUrl says null
            // when the box is too old to know more than one share.
            var u = TranscodeServer.playUrl(path, srv ? serverById(srv) : null);
            if (u) return u;
        }
        return streamUrl(path, srv);
    }

    /* ── browsing UI (reuses #view-browse, like the USB browser) ───────────*/
    var pathStack = [];     // breadcrumb of folder paths, '' === share root
    var folder = '';        // path of the folder listed
    var backHandler = null;
    var current = '';       // id of the server being browsed ('' = first)
    var pickingServer = false;  // showing the server list rather than a share

    function humanSize(n) {
        if (!n) return '';
        var u = ['B', 'KB', 'MB', 'GB', 'TB'], i = 0;
        while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
        return (i === 0 ? n : n.toFixed(1)) + ' ' + u[i];
    }
    function esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }
    function isPlayable(name) { return FileTypes.isPlayable(name); }
    /* Text subtitle formats the player can paint, .txt (MicroDVD / MPL2 /
     * TMPlayer, issue #165) included.  Image subs (.sub/.idx, .sup) are left
     * out on purpose; same list as the USB browser. */
    function isSubtitle(name) {
        return /\.(srt|vtt|ass|ssa|smi|sami|txt)$/i.test(name);
    }
    function join(dir, name) { return (dir ? dir.replace(/\/+$/, '') : '') + '/' + name; }

    /* Where an entry of a playlist that sits in folder `dir` of the share
     * points, as a share path ('/Music/01.mp3').  Relative entries are the
     * folder's; a leading slash is the share's root.  null for what can't
     * be on this share: a drive letter or a \\server\share path written by
     * a desktop player, or '..' past the root. */
    function sharePath(dir, ref) {
        var r = String(ref || '').replace(/\\/g, '/');
        if (!r || /^[a-z]:\//i.test(r) || r.indexOf('//') === 0) return null;
        var parts = (r.charAt(0) === '/' ? r : (dir || '') + '/' + r).split('/');
        var out = [];
        for (var i = 0; i < parts.length; i++) {
            var p = parts[i];
            if (!p || p === '.') continue;
            if (p === '..') { if (!out.length) return null; out.pop(); continue; }
            out.push(p);
        }
        return out.length ? '/' + out.join('/') : null;
    }
    function stem(name) {
        var dot = name.lastIndexOf('.');
        return dot < 0 ? name : name.slice(0, dot);
    }
    function ext(name) {
        var dot = name.lastIndexOf('.');
        return dot < 0 ? '' : name.slice(dot + 1).toLowerCase();
    }
    /* "Movie.en.srt" → "en", "Movie.eng.srt" → "eng", "Movie.srt" → "". */
    function langTag(name) {
        var parts = stem(name).split('.');
        if (parts.length < 2) return '';
        var last = parts[parts.length - 1];
        return /^[a-z]{2,3}$/i.test(last) ? last.toLowerCase() : '';
    }

    /* Pair every playable file in a folder listing with its subtitle files,
     * the same way the USB browser does (SubMatch): an exact stem match first
     * (Movie.srt for Movie.mp4, case-insensitive), then anything whose stem
     * continues the video's with a dot (Movie.en.srt), then the loose
     * matches, flagged `loose`.  A Subs folder read by listWithSubs
     * (entries.subsFolder) counts as part of the folder.
     * Returns { "Movie.mp4": [ { name, lang, ext, uri } ] }.  The uri always
     * goes through the smbproxy — a paired transcode server changes where the
     * video bytes come from, not where the .srt lives.  The WebDAV browser
     * lists the same way and passes its own urlOf (issue #145). */
    function siblingSubtitles(entries, dir, srv, urlOf) {
        urlOf = urlOf || streamUrl;
        var subs = [];
        function add(list, folder, tag, video) {
            list.forEach(function (e) {
                if (e.isDir || !isSubtitle(e.name)) return;
                var s = { name: e.name, lang: langTag(e.name), ext: ext(e.name), uri: urlOf(join(folder, e.name), srv) };
                if (tag) s.dir = tag;
                if (video) s.video = video;   // from that video's own folder in Subs
                subs.push(s);
            });
        }
        add(entries, dir);
        var sf = entries.subsFolder;
        if (sf) {
            add(sf.entries || [], join(dir, sf.name), sf.name);
            (sf.episodes || []).forEach(function (ep) {
                add(ep.entries || [], join(join(dir, sf.name), ep.name), sf.name, ep.video);
            });
        }
        return SubMatch.pair(
            entries.filter(function (e) { return !e.isDir && isPlayable(e.name); })
                   .map(function (e) { return e.name; }), subs);
    }

    /* list() plus the folder's Subs folder, when it has one and a video. */
    function listWithSubs(path, cb) {
        list(path, function (err, entries) {
            if (err) return cb(err);
            SubMatch.withSubsFolder(entries,
                function (names, done) { list(names.reduce(join, path), done); },
                function () { cb(null, entries); });
        });
    }

    /* One folder of server srv for FolderPlay: its subfolders and its
     * music, each track with the folder's cover picture. */
    function music(srv) {
        return function (path, cb) {
            getJson(BASE + '/smb/list?path=' + encodeURIComponent(path || '') + srvParam(srv), function (err, res) {
                if (err) return cb(err);
                if (!res.ok) return cb(new Error(res.error || 'list failed'));
                var entries = res.entries || [];
                var artName = FileTypes.folderArt(entries.map(function (e) { return e.isDir ? '' : e.name; }));
                var art = artName ? streamUrl(join(path, artName), srv) : null;
                var s = FolderPlay.split(entries);
                cb(null, {
                    dirs:   s.dirs.map(function (e) { return join(path, e.name); }),
                    tracks: s.audio.map(function (e) {
                        var p = join(path, e.name);
                        return { uri: playableUrl(p, srv), title: e.name, tagSrc: streamUrl(p, srv), art: art };
                    })
                });
            });
        };
    }

    function showError(msg) {
        var ul = document.getElementById('browse-list');
        if (ul) ul.innerHTML = '<li><span class="icon">!</span><span class="name">' + esc(msg) + '</span></li>';
    }

    function render(path, focusName) {
        folder = path || '';
        UI.showView('view-browse');
        document.getElementById('browse-title').textContent = path ? path.split('/').pop() : I18n.t('smb.title');
        var srv = serverById(current) || {};
        document.getElementById('browse-path').textContent = '\\\\' + (srv.host || '') + '\\' + (srv.share || '') + (path || '');
        var ul = document.getElementById('browse-list');
        ul.innerHTML = '<li><span class="icon">…</span><span class="name">' + esc(I18n.t('common.loading')) + '</span></li>';

        listWithSubs(path, function (err, entries) {
            ul.innerHTML = '';
            if (err) {
                dbg('list ' + JSON.stringify(path || '/') + ' failed: ' + err.message);
                dumpServiceLogs('list failure');
                showError(err.message);
                return;
            }

            // Playable files in this folder → the playlist for next/prev/auto-play,
            // each carrying the sidecar subtitles found next to it.
            var sidecars = siblingSubtitles(entries, path, current);
            var sidecarCount = Object.keys(sidecars).reduce(function (n, k) { return n + sidecars[k].length; }, 0);
            dbg('list ' + JSON.stringify(path || '/') + ': ' + entries.length + ' entries, ' +
                sidecarCount + ' sidecar subtitle(s) matched to ' + Object.keys(sidecars).length + ' video(s)');
            // The folder's cover picture, for music without art of its own —
            // looked up before the filter, which may hide pictures.
            var artName = FileTypes.folderArt(entries.map(function (e) { return e.isDir ? '' : e.name; }));
            var art = artName ? streamUrl(join(path, artName), current) : null;
            var filter = Settings.get('browseFilter'), showHidden = Settings.get('showHidden');
            entries = entries.filter(function (e) {
                return (showHidden || !FileTypes.isHidden(e.name)) && FileTypes.shown(filter, e.isDir ? 'dir' : FileTypes.kind(e.name));
            });
            var playlist = entries
                .filter(function (e) { return !e.isDir && isPlayable(e.name); })
                .map(function (e) {
                    return { uri: playableUrl(join(path, e.name), current), title: e.name, subtitles: sidecars[e.name] || [],
                             // Tags come off the share itself, not the transcode server's HLS.
                             tagSrc: FileTypes.kind(e.name) === 'audio' ? streamUrl(join(path, e.name), current) : null,
                             art:    FileTypes.kind(e.name) === 'audio' ? art : null };
                });
            // Pictures and text come straight off the smbproxy: the transcode
            // server only knows how to turn things into video.
            var pictures = entries
                .filter(function (e) { return !e.isDir && FileTypes.kind(e.name) === 'image'; })
                .map(function (e) { return { uri: streamUrl(join(path, e.name), current), title: e.name, size: e.size }; });
            var srv = current, stackHere = pathStack.slice();
            // Back to this folder from a viewer or the player — also after the
            // user left the share meanwhile (music playing on), which is why
            // the way up is restored too.
            function backHere(name) {
                return function (last) {
                    current = srv; pickingServer = false; pathStack = stackHere.slice();
                    setupBack(); render(path, (last && last.title) || name);
                };
            }

            // ".." row to go up (except at root, unless that leads back to the
            // server list).
            if (pathStack.length > 0 || servers().length > 1) {
                var up = document.createElement('li');
                up.dataset.dir = '1';
                up.innerHTML = '<span class="icon">↩</span><span class="name">..</span>';
                up.addEventListener('click', goUp);
                ul.appendChild(up);
            }

            var focus = null;
            entries.forEach(function (e) {
                var kind = e.isDir ? 'dir' : FileTypes.kind(e.name);
                var li = document.createElement('li');
                li.dataset.dir = e.isDir ? '1' : '0';
                if (kind === 'other') li.classList.add('unopenable');
                var subs = sidecars[e.name] || [];
                var subBadge = subs.length ? '<span class="meta">CC ×' + subs.length + '</span>' : '';
                li.innerHTML =
                    '<span class="icon">' + FileTypes.icon(kind) + '</span>' +
                    '<span class="name">' + esc(e.name) + '</span>' +
                    (e.isDir ? '<span class="fav-mark">♥</span>'
                             : subBadge + '<span class="meta">' + humanSize(e.size) + '</span>');
                // A folder row can be pinned to Favorites with ► (issue #140);
                // app.js reads what to pin off the row.
                if (e.isDir) {
                    var fav = { kind: 'smb', srv: current, path: join(path, e.name), name: e.name };
                    li.dataset.fav = JSON.stringify(fav);
                    if (typeof Favorites !== 'undefined' && Favorites.find(fav)) li.classList.add('is-fav');
                }
                if (focusName && e.name === focusName) focus = li;
                if (!e.isDir && isPlayable(e.name)) li.dataset.uri = playableUrl(join(path, e.name), current);
                li.addEventListener('click', function () {
                    if (e.isDir) {
                        pathStack.push(path);
                        render(join(path, e.name));
                        return;
                    }
                    if (openOther(kind, e)) return;
                    var uri = playableUrl(join(path, e.name), current);
                    var idx = 0;
                    for (var i = 0; i < playlist.length; i++) if (playlist[i].uri === uri) { idx = i; break; }
                    // Hand off to the player; release our Back handler so the
                    // player's own Back (exit) behaviour takes over.
                    teardownBack();
                    // Leaving the player comes back to this folder.
                    if (window.VlcApp && window.VlcApp.play) window.VlcApp.play('smb', playlist, idx, null, backHere(e.name));
                });
                ul.appendChild(li);
            });

            if (!ul.children.length)
                ul.innerHTML = '<li><span class="icon">i</span><span class="name">' + esc(I18n.t('browse.empty')) + '</span></li>';

            // Play all / Shuffle all, subfolders included (issue #159), on
            // top of the entries; focus stays where it would have been.
            if (entries.some(function (e) { return e.isDir; })) {
                focus = focus || ul.firstElementChild;
                FolderPlay.addRows(ul, ul.children[ul.children.length - entries.length], path, music(srv),
                    function (tracks) {
                        teardownBack();
                        if (window.VlcApp && window.VlcApp.play) window.VlcApp.play('smb', tracks, 0, null, backHere(null));
                    });
            }

            if (window.VlcApp && window.VlcApp.markNowPlaying) window.VlcApp.markNowPlaying();
            UI.focusInList(ul, focus);

            /* A file that isn't for the player: the viewers, the playlist
             * reader, or a toast.  Each hands the remote over (our Back
             * handler comes off) and gets this folder back on its way out.
             * false for video and audio, which play as before. */
            function openOther(kind, e) {
                var file = join(path, e.name);
                switch (kind) {
                    case 'video': case 'audio':
                        return false;
                    case 'image':
                        teardownBack();
                        Viewer.openImage(pictures,
                            pictures.findIndex(function (p) { return p.title === e.name; }), backHere(e.name));
                        return true;
                    case 'text':
                        teardownBack();
                        Viewer.openText({ title: e.name, src: streamUrl(file, srv), size: e.size }, backHere(e.name));
                        return true;
                    case 'playlist':
                        if (!window.VlcApp || !window.VlcApp.openPlaylist) return false;
                        teardownBack();
                        window.VlcApp.openPlaylist({
                            title:   e.name,
                            read:    function (cb) { Browser.readHead(streamUrl(file, srv), window.VlcApp.maxPlaylistBytes, cb); },
                            resolve: function (ref) {
                                // A stream URL of its own; a file: URL is a disk on
                                // whichever PC wrote the list.
                                if (/^(https?|rtsp|rtmp|mms|udp|rtp):/i.test(ref)) return ref;
                                if (/^[a-z][a-z0-9+.-]+:/i.test(ref)) return null;
                                var p = sharePath(path, ref);
                                return p ? playableUrl(p, srv) : null;
                            },
                            // HLS segments can't be found relative to a
                            // proxy URL; AVPlay gets the manifest and tries.
                            playAsStream: function () {
                                window.VlcApp.play('smb', [{ uri: streamUrl(file, srv), title: e.name }], 0);
                            },
                            back:    backHere(e.name)
                        });
                        return true;
                }
                UI.toast(I18n.t('browse.cantOpen'));
                return true;
            }
        });
    }

    function goUp() {
        if (pickingServer) { exit(); return; }
        if (!pathStack.length) {
            if (!exitTo && servers().length > 1) { showServers(); return; }
            exit();
            return;
        }
        render(pathStack.pop(), folder.split('/').pop());
    }
    /* Where Back from the share root goes: the Servers list that opened
     * it (js/servers.js), else Home. */
    var exitTo = null;
    function exit() {
        teardownBack();
        var back = exitTo;
        exitTo = null;
        if (back) { back(); return; }
        if (window.VlcApp && window.VlcApp.home) window.VlcApp.home();
        else UI.showView('view-home');
    }

    function setupBack() {
        if (backHandler) return;
        backHandler = Remote.push(function (code) {
            if (code === Remote.KEY.BACK) { goUp(); return true; }
            return false;   // arrows / Enter fall through to the app's focus system
        });
    }
    function teardownBack() {
        if (backHandler) { Remote.pop(backHandler); backHandler = null; }
    }

    /* Straight into the share when there is one server, a list to pick
     * from when there are more.  Home offers the Servers list instead
     * (js/servers.js); this is what a start screen of "SMB" still opens. */
    function openBrowser() {
        exitTo = null;
        var list = servers();
        if (!list.length) {
            var c0 = getCreds();
            dbg('openBrowser: no usable server saved (host=' + JSON.stringify(c0.host || '') +
                ' share=' + JSON.stringify(c0.share || '') + ') → sending to Settings');
            UI.toast(I18n.t('smb.addFirst'));
            if (window.VlcApp && window.VlcApp.openSettings) window.VlcApp.openSettings();
            return;
        }
        pathStack = [];
        setupBack();
        if (list.length > 1) { showServers(); return; }
        openServer(list[0].id);
    }

    function showServers() {
        pickingServer = true;
        pathStack = [];
        UI.showView('view-browse');
        document.getElementById('browse-title').textContent = I18n.t('smb.title');
        document.getElementById('browse-path').textContent = I18n.t('smb.pickServer');
        var ul = document.getElementById('browse-list');
        ul.innerHTML = '';
        var focus = null;
        servers().forEach(function (c) {
            var li = document.createElement('li');
            li.dataset.dir = '1';
            li.innerHTML = '<span class="icon">📁</span><span class="name">' + esc(serverLabel(c)) + '</span>';
            li.addEventListener('click', function () { openServer(c.id); });
            ul.appendChild(li);
            if (c.id === current) focus = li;
        });
        UI.focusInList(ul, focus);
    }

    /* The folders above `path` on a share, share root first: the way back
     * up from a folder opened directly, as Favorites does (issue #140). */
    function parentPaths(path) {
        var out = [], parts = String(path || '').split('/').filter(Boolean);
        var at = '';
        for (var i = 0; i < parts.length; i++) { out.push(at); at += '/' + parts[i]; }
        return out;
    }

    /* Connect to server `id` and list `path` on it ('' or absent: the share
     * root), with the way up through the folders above it. */
    function openServer(id, path) {
        pickingServer = false;
        current = id;
        path = path || '';
        UI.showView('view-browse');
        document.getElementById('browse-title').textContent = I18n.t('smb.title');
        document.getElementById('browse-path').textContent = I18n.t('common.connecting');
        document.getElementById('browse-list').innerHTML =
            '<li><span class="icon">…</span><span class="name">' + esc(I18n.t('common.connecting')) + '</span></li>';

        // Back is installed (by openBrowser) BEFORE the async work so it works
        // on the "connecting" and error screens too — otherwise Back falls
        // through to the app's global handler, which still thinks we're on the
        // home view and can't exit here.
        pathStack = parentPaths(path);

        dbg('openBrowser' + (id ? ' [' + id + ']' : '') + (path ? ' ' + JSON.stringify(path) : ''));
        ensureService(function (err) {
            if (err) { dbg('ensureService failed: ' + err.message); showError(err.message); return; }
            dumpServiceLogs('service start');
            connect(id, function (err2) {
                if (err2) {
                    showError(I18n.t('smb.connectFailed', err2.message));
                    dumpServiceLogs('connect failure');   // the service-side NEGOTIATE/auth/socket trail
                    return;
                }
                dumpServiceLogs('connect');
                render(path);
            });
        });
    }

    /* A pinned folder from the Favorites tile (issue #140), or a server
     * from the Servers list: straight into `path` on saved server `srv`,
     * and Back from the share root goes to `back` when given.  With `top`
     * the folder itself is as far up as Back goes: a pinned folder comes
     * out to Favorites, not to the folder it sits in (issue #183).  false
     * when that server is no longer saved, so the caller can say so. */
    function openFolder(srv, path, back, top) {
        var c = serverById(srv);
        if (!c || !c.host || !c.share) return false;
        exitTo = back || null;
        setupBack();
        openServer(srv, path);
        if (top) pathStack = [];
        return true;
    }

    /* Wire the Settings form (inputs + Save button) once the DOM is ready. */
    var FORM_IDS = ['host', 'port', 'share', 'user', 'pass', 'domain'];

    // Guest is a toggle button (not a checkbox): the D-pad's geometric nav
    // can't reliably land on a small right-aligned checkbox, but a full-width
    // row matches every other setting and gets focus cleanly.  Its state lives
    // out here so applyCreds() can repaint it when the settings arrive from
    // somewhere other than this form — e.g. copied off the transcode server.
    var anonState = false;
    function paintAnon() {
        var anonVal = document.getElementById('smb-anon-val');
        if (anonVal) anonVal.textContent = I18n.t(anonState ? 'common.on' : 'common.off');
    }

    /* Which server the form edits: '' the first, an added server's id, or
     * 'new' for one not saved yet. */
    var editing = '';

    /* Push a credentials object into the settings form. */
    function fillSettingsForm(c) {
        c = c || {};
        FORM_IDS.forEach(function (k) {
            var el = document.getElementById('smb-' + k);
            if (el && c[k] != null) el.value = c[k];
        });
        anonState = !!c.anonymous;
        paintAnon();
        paintEditing();
    }

    /* The "Server" row says which one the form holds; Remove only shows for a
     * saved one. */
    function paintEditing() {
        var val = document.getElementById('smb-server-val');
        var c = editing === 'new' ? null : serverById(editing);
        var saved = !!(c && c.host && c.share);
        if (val) val.textContent = saved ? serverLabel(c) : I18n.t('smb.newServer');
        var rm = document.getElementById('smb-remove');
        if (rm) rm.style.display = saved ? '' : 'none';
    }

    /* Every field is set, so nothing from the server shown before lingers. */
    function editServer(id) {
        editing = id;
        var c = (id === 'new' ? null : serverById(id)) || {};
        var full = { anonymous: !!c.anonymous };
        FORM_IDS.forEach(function (k) { full[k] = c[k] != null ? c[k] : ''; });
        fillSettingsForm(full);
    }

    /* Store credentials that came from elsewhere and reflect them in the form,
     * so the user can see what was filled in and correct it if needed.  They
     * are the first server's: that's what the transcode box's first share is,
     * and a copy of it among the added servers would be a duplicate. */
    function applyCreds(c) {
        setCreds(c);
        setExtra(getExtra().filter(function (x) {
            return !(sameHost(x.host, c.host) && String(x.share).toLowerCase() === String(c.share).toLowerCase());
        }));
        editServer('');
    }

    /* The transcode box's other shares: update the added server that matches
     * each one, or add it.  Returns how many were new. */
    function mergeServers(list) {
        var extra = getExtra(), added = 0;
        (list || []).forEach(function (c) {
            if (!c.host || !c.share) return;
            var id = findServer(c.host, c.share);
            if (id === '') return;   // that's the first server already
            var entry = {
                host: c.host, port: c.port || 445, share: c.share,
                user: c.user || '', pass: c.pass || '',
                domain: c.domain || '', anonymous: !!c.anonymous
            };
            for (var i = 0; i < extra.length; i++) {
                if (extra[i].id === id) { entry.id = id; extra[i] = entry; return; }
            }
            entry.id = newId();
            extra.push(entry);
            added++;
        });
        setExtra(extra);
        paintEditing();
        return added;
    }

    /* Store what the form holds as the server being edited.  A new server
     * becomes the first one while that slot is empty, so a single-server
     * setup looks exactly like it did before multiple servers.  cb-free:
     * returns the id it was saved under, or null for a duplicate. */
    function saveServer(nc) {
        var other = nc.host && nc.share ? findServer(nc.host, nc.share) : null;
        var target = editing === 'new' ? (haveCreds() ? 'new' : '') : editing;
        if (other !== null && other !== target) return null;
        if (target === '') { setCreds(nc); return ''; }
        // An added server without a host or share would be invisible
        // everywhere; keep what it had, and let Save say what's missing.
        if (!nc.host || !nc.share) return target;
        var extra = getExtra();
        if (target === 'new') {
            nc.id = newId();
            extra.push(nc);
        } else {
            nc.id = target;
            for (var i = 0; i < extra.length; i++) if (extra[i].id === target) extra[i] = nc;
        }
        setExtra(extra);
        return nc.id;
    }

    function removeServer(id) {
        if (id === '') setCreds({});
        else setExtra(getExtra().filter(function (x) { return x.id !== id; }));
        var left = servers();
        editServer(left.length ? left[0].id : '');
    }

    function pickServer() {
        if (!window.VlcApp || !window.VlcApp.openPicker) return;
        var items = servers().map(function (c) { return { code: c.id, name: serverLabel(c) }; });
        items.push({ code: 'new', name: I18n.t('smb.addServer') });
        window.VlcApp.openPicker(I18n.t('smb.pickServer'), items, editing, function (code) {
            editServer(code);
            refocus('smb-server');
        });
    }

    function confirmRemove() {
        var c = serverById(editing);
        if (!c || !c.host || !window.VlcApp || !window.VlcApp.openPicker) return;
        window.VlcApp.openPicker(I18n.t('smb.removeConfirm', serverLabel(c)), [
            { code: 'remove', name: I18n.t('smb.removeServer') },
            { code: 'keep',   name: I18n.t('common.cancel') }
        ], 'keep', function (code) {
            if (code === 'remove') {
                dbg('server removed: ' + serverLabel(c));
                removeServer(editing);
                UI.toast(I18n.t('smb.removed', serverLabel(c)));
            }
            refocus('smb-server');
        });
    }

    /* Back on the form once a picker has closed, rather than wherever the
     * D-pad focus was left. */
    function refocus(id) {
        setTimeout(function () {
            var el = document.getElementById(id);
            if (el) UI.focusOn(el);
        }, 0);
    }

    /* What the form holds right now, normalised the way Save stores it. */
    function readSettingsForm() {
        var nc = {};
        FORM_IDS.forEach(function (k) {
            var el = document.getElementById('smb-' + k);
            nc[k] = el ? el.value.trim() : '';
        });
        nc.anonymous = anonState;
        var sv = normalizeServer(nc.host);
        nc.host = sv.host;
        // Share precedence: explicit Share field > the path typed after the
        // host (smb://nas/Media, \\nas\Media) > nothing.
        if (!nc.share && sv.share) nc.share = sv.share;
        // Port precedence: explicit Port field > inline host:port > default.
        nc.port = parseInt(nc.port, 10) || sv.port || 445;
        return nc;
    }

    /* "Find shares": ask the server what it offers and let the user pick,
     * instead of guessing a share name on a TV remote. */
    var findingShares = false;
    function findShares() {
        if (findingShares) return;
        var c = readSettingsForm();
        if (!c.host) { UI.toast(I18n.t('smb.hostMissing')); return; }
        findingShares = true;
        UI.toast(I18n.t('smb.findingShares'));
        ensureService(function (err) {
            if (err) { findingShares = false; UI.toast(I18n.t('smb.sharesFailed', err.message)); return; }
            listShares(c, function (e2, shares) {
                findingShares = false;
                if (e2) {
                    UI.toast(I18n.t('smb.sharesFailed', e2.message));
                    dumpServiceLogs('share list failure');
                    return;
                }
                if (!shares.length) { UI.toast(I18n.t('smb.noShares')); return; }
                if (!window.VlcApp || !window.VlcApp.openPicker) return;
                window.VlcApp.openPicker(I18n.t('smb.pickShare'), shares.map(function (s) {
                    return { code: s.name, name: s.remark ? s.name + ' — ' + s.remark : s.name };
                }), c.share, function (name) {
                    var el = document.getElementById('smb-share');
                    if (el) el.value = name;
                    refocus('smb-find-shares');
                });
            });
        });
    }

    function wireSettingsForm() {
        var btn = document.getElementById('smb-save');
        if (!btn) return;
        editing = servers().length ? servers()[0].id : '';
        fillSettingsForm(serverById(editing));

        var serverBtn = document.getElementById('smb-server');
        if (serverBtn) serverBtn.addEventListener('click', pickServer);
        var removeBtn = document.getElementById('smb-remove');
        if (removeBtn) removeBtn.addEventListener('click', confirmRemove);

        var findBtn = document.getElementById('smb-find-shares');
        if (findBtn) findBtn.addEventListener('click', findShares);

        var anonBtn = document.getElementById('smb-anon');
        if (anonBtn) anonBtn.addEventListener('click', function () { anonState = !anonState; paintAnon(); });

        btn.addEventListener('click', function () {
            var hostEl = document.getElementById('smb-host');
            var typedHost = hostEl ? hostEl.value.trim() : '';
            var nc = readSettingsForm();
            var id = saveServer(nc);
            if (id === null) { UI.toast(I18n.t('smb.duplicate')); return; }
            editing = id;
            paintEditing();
            dbg('settings saved' + (id ? ' [' + id + ']' : '') + ': typed host=' + JSON.stringify(typedHost) +
                ' → host=' + JSON.stringify(nc.host) + ' port=' + nc.port +
                ' share=' + JSON.stringify(nc.share) +
                ' user=' + (nc.anonymous ? '(guest)' : JSON.stringify(nc.user || '')) +
                ' pass=' + (nc.pass ? nc.pass.length + ' chars' : 'none') +
                (nc.domain ? ' domain=' + JSON.stringify(nc.domain) : '') +
                (nc.host && nc.share ? '' : '  ** host and share are both required **'));
            UI.toast(I18n.t('smb.saved'));
            if (!nc.host || !nc.share)
                UI.toast(I18n.t(nc.host ? 'smb.shareMissing' : 'smb.hostMissing'));
        });
    }

    if (document.readyState === 'loading')
        document.addEventListener('DOMContentLoaded', wireSettingsForm);
    else
        wireSettingsForm();

    return {
        openBrowser:     openBrowser,
        openFolder:      openFolder,
        parentPaths:     parentPaths,       // exposed for the Node tests
        // The app's full player is coming up over this folder: its BACK
        // belongs to the player now.
        detach:          teardownBack,
        // Exposed for server.js: the local-file relay lives in the same
        // background service, so it needs the same launch-and-wait dance.
        ensureService:   ensureService,
        getCreds:        getCreds,
        setCreds:        setCreds,
        // Used by server.js when the share settings are copied off the
        // transcode server instead of typed in on the remote.
        applyCreds:      applyCreds,
        streamUrl:       streamUrl,
        // Used by server.js when smart routing plays a share file directly.
        ensureConnected: ensureConnected,
        dumpServiceLogs: dumpServiceLogs,
        normalizeServer: normalizeServer,   // exposed for the Node tests
        siblingSubtitles: siblingSubtitles, // exposed for the Node tests
        sharePath:       sharePath,         // exposed for the Node tests
        isStreamUrl:     isStreamUrl,
        // Used by server.js to tell the servers apart: which one a stream
        // URL reads from, which saved server a host and share are, and what
        // an added server's settings are.
        streamServerOf:  streamServerOf,
        findServer:      findServer,
        serverById:      serverById,
        servers:         servers,
        // Used by server.js to copy the transcode box's other shares down.
        mergeServers:    mergeServers,
        // Used by backup.js: a share as the place a backup goes (issue #132).
        serverLabel:     serverLabel,
        writeText:       writeText,
        readText:        readText,
        getBase:         function () { return BASE; },
        setBase:         function (b) { BASE = b; }
    };
})();

// Ignored by the Tizen/browser build; lets Node tests drive the module.
if (typeof module !== 'undefined' && module.exports) module.exports = SMB;
