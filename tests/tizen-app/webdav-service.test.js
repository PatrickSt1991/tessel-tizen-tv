'use strict';

var assert = require('assert');
var test   = require('node:test');
var fs     = require('fs');
var vm     = require('vm');
var path   = require('path');
var crypto = require('crypto');

var SRC = fs.readFileSync(path.join(__dirname, '../../tizen-app/service/service.js'), 'utf8');

/* Same loader as dlna.test.js: servers that never bind.  `extra` stands in
 * for a module the code under test would otherwise talk to. */
function loadService(extra) {
    var fakeHttp = { createServer: function () { return { listen: function () {} }; } };
    var sandbox = {
        module: { exports: {} },
        Buffer: Buffer, console: console,
        setTimeout: setTimeout, clearTimeout: clearTimeout,
        process: { on: function () {} },
        require: function (name) {
            if (name === 'http') return (extra && extra.http) || fakeHttp;
            if (extra && extra[name]) return extra[name];
            return require(name);
        }
    };
    vm.runInNewContext(SRC + '\nmodule.exports = { parseMultistatus: parseMultistatus, davUrl: davUrl, davRoot: davRoot, ' +
        'parseAuthChallenge: parseAuthChallenge, digestAuthorization: digestAuthorization, davRequest: davRequest, ' +
        'davPropfind: davPropfind, davAuth: davAuth, davStatusError: davStatusError };', sandbox);
    return sandbox.module.exports;
}
var svc = loadService();
function plain(v) { return JSON.parse(JSON.stringify(v)); }
function md5(s) { return crypto.createHash('md5').update(s).digest('hex'); }

var NC = { id: 'nc', url: 'https://cloud.example.com/remote.php/dav/files/pat/', user: 'pat', pass: 'secret', insecure: false };

test('a path below the root becomes a URL segment by segment, a folder with its trailing slash', function () {
    assert.strictEqual(svc.davRoot('https://cloud.example.com/remote.php/dav/files/pat'), 'https://cloud.example.com/remote.php/dav/files/pat/');
    assert.strictEqual(svc.davRoot('ftp://x/'), '');
    assert.strictEqual(svc.davUrl(NC, '', true), NC.url);
    assert.strictEqual(svc.davUrl(NC, '/Films/Sci Fi/Blade Runner (1982).mkv', false),
        NC.url + 'Films/Sci%20Fi/Blade%20Runner%20(1982).mkv');
    assert.strictEqual(svc.davUrl(NC, '/Films/Sci Fi', true), NC.url + 'Films/Sci%20Fi/');
    assert.strictEqual(svc.davUrl(NC, 'Musik/Träume & Co', true), NC.url + 'Musik/Tr%C3%A4ume%20%26%20Co/');
});

var MULTISTATUS =
    '<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:s="http://sabredav.org/ns" xmlns:oc="http://owncloud.org/ns">' +
    '<d:response><d:href>/remote.php/dav/files/pat/Films/</d:href><d:propstat><d:prop>' +
    '<d:resourcetype><d:collection/></d:resourcetype><d:displayname>Films</d:displayname></d:prop>' +
    '<d:status>HTTP/1.1 200 OK</d:status></d:propstat><d:propstat><d:prop><d:getcontentlength/></d:prop>' +
    '<d:status>HTTP/1.1 404 Not Found</d:status></d:propstat></d:response>' +
    '<d:response><d:href>/remote.php/dav/files/pat/Films/Sci%20Fi/</d:href><d:propstat><d:prop>' +
    '<d:resourcetype><d:collection/></d:resourcetype><d:displayname>Sci Fi</d:displayname></d:prop>' +
    '<d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>' +
    '<d:response><d:href>/remote.php/dav/files/pat/Films/Tr%C3%A4ume%20%26%20Co.mkv</d:href><d:propstat><d:prop>' +
    '<d:resourcetype/><d:getcontentlength>734003200</d:getcontentlength><d:displayname>Tr&#228;ume &amp; Co.mkv</d:displayname></d:prop>' +
    '<d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>' +
    '<d:response><d:href>/remote.php/dav/files/pat/Films/alpha.srt</d:href><d:propstat><d:prop>' +
    '<d:resourcetype/><d:getcontentlength>8</d:getcontentlength></d:prop>' +
    '<d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>' +
    '</d:multistatus>';

test('a Nextcloud multistatus lists the folder\'s children, decoded, folders first, the folder itself left out', function () {
    var entries = svc.parseMultistatus(MULTISTATUS, NC.url + 'Films/');
    assert.deepStrictEqual(plain(entries), [
        { name: 'Sci Fi', isDir: true, size: 0 },
        { name: 'alpha.srt', isDir: false, size: 8 },
        { name: 'Träume & Co.mkv', isDir: false, size: 734003200 }
    ]);
});

test('Apache\'s shape is read too: full-URL hrefs, lp1: props, a default namespace, no displayname', function () {
    var xml = '<D:multistatus xmlns:D="DAV:"><D:response xmlns:lp1="DAV:">' +
        '<D:href>http://nas.local:5005/media/</D:href><D:propstat><D:prop><lp1:resourcetype><D:collection/></lp1:resourcetype></D:prop>' +
        '<D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>' +
        '<D:response xmlns:lp1="DAV:"><D:href>http://nas.local:5005/media/a.mp4</D:href><D:propstat><D:prop>' +
        '<lp1:resourcetype/><lp1:getcontentlength>42</lp1:getcontentlength></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>' +
        '</D:multistatus>';
    assert.deepStrictEqual(plain(svc.parseMultistatus(xml, 'http://nas.local:5005/media/')), [{ name: 'a.mp4', isDir: false, size: 42 }]);
    var plainNs = '<multistatus xmlns="DAV:"><response><href>/dav/</href><propstat><prop><resourcetype><collection/></resourcetype></prop></propstat></response>' +
        '<response><href>/dav/Sub/</href><propstat><prop><resourcetype><collection/></resourcetype></prop></propstat></response></multistatus>';
    assert.deepStrictEqual(plain(svc.parseMultistatus(plainNs, 'http://h/dav/')), [{ name: 'Sub', isDir: true, size: 0 }]);
});

test('a 401 names its schemes; a Digest response is computed the RFC way', function () {
    var ch = svc.parseAuthChallenge('Basic realm="dav", Digest realm="WebDAV", nonce="abc123", qop="auth", opaque="xyz", algorithm=MD5');
    assert.strictEqual(ch.basic, true);
    assert.deepStrictEqual(plain(ch.digest), { realm: 'WebDAV', nonce: 'abc123', qop: 'auth', opaque: 'xyz', algorithm: 'MD5' });
    assert.strictEqual(svc.parseAuthChallenge('Basic realm="x"').digest, null);
    assert.strictEqual(svc.parseAuthChallenge('Bearer realm="x"').basic, false);

    var h = svc.digestAuthorization(ch.digest, 'PROPFIND', '/dav/', 'tv', 'pw', 1, 'cn0nce');
    var ha1 = md5('tv:WebDAV:pw'), ha2 = md5('PROPFIND:/dav/');
    var want = md5(ha1 + ':abc123:00000001:cn0nce:auth:' + ha2);
    assert.ok(h.indexOf('Digest username="tv", realm="WebDAV", nonce="abc123", uri="/dav/", response="' + want + '"') === 0, h);
    assert.ok(/qop=auth, nc=00000001, cnonce="cn0nce", opaque="xyz"/.test(h), h);

    // RFC 2069 style: no qop.
    var h2 = svc.digestAuthorization({ realm: 'r', nonce: 'n' }, 'GET', '/f', 'u', 'p', 1, 'c');
    assert.ok(h2.indexOf('response="' + md5(md5('u:r:p') + ':n:' + md5('GET:/f')) + '"') > 0, h2);
    assert.ok(h2.indexOf('qop=') < 0);
});

/* A fake http/https whose request() answers from `script`: each call gets
 * ({ method, path, headers }) and returns { status, headers, body }. */
function fakeWeb(script) {
    var calls = [];
    function request(opts, onRes) {
        var call = { method: opts.method, host: opts.host, port: opts.port, path: opts.path, headers: opts.headers,
                     rejectUnauthorized: opts.rejectUnauthorized };
        calls.push(call);
        var reply = script(call, calls.length);
        var handlers = {}, req = {
            setTimeout: function () {}, abort: function () {},
            on: function (ev, fn) { handlers[ev] = fn; },
            end: function (body) {
                call.body = body;
                setImmediate(function () {
                    if (reply.error) return handlers.error(reply.error);
                    var rh = {}, res = {
                        statusCode: reply.status, headers: reply.headers || {},
                        resume: function () {}, pipe: function () {},
                        on: function (ev, fn) { rh[ev] = fn; }
                    };
                    onRes(res);
                    setImmediate(function () {
                        if (rh.data && reply.body) rh.data(Buffer.from(reply.body));
                        if (rh.end) rh.end();
                    });
                });
            }
        };
        return req;
    }
    return { calls: calls, mod: { request: request, createServer: function () { return { listen: function () {} }; } } };
}

test('nothing is sent until the server asks; Basic is then remembered for the next request', function (t, done) {
    var web = fakeWeb(function (c) {
        if (!c.headers.Authorization) return { status: 401, headers: { 'www-authenticate': 'Basic realm="dav"' } };
        assert.strictEqual(c.headers.Authorization, 'Basic ' + Buffer.from('pat:secret').toString('base64'));
        return { status: 207, body: MULTISTATUS };
    });
    var s = loadService({ https: web.mod });
    s.davPropfind(NC, '/Films', 1, function (err, entries) {
        assert.ifError(err);
        assert.strictEqual(entries.length, 3);
        assert.strictEqual(web.calls.length, 2);
        assert.strictEqual(web.calls[0].method, 'PROPFIND');
        assert.strictEqual(web.calls[0].headers.Depth, '1');
        assert.strictEqual(web.calls[0].rejectUnauthorized, true);
        assert.strictEqual(web.calls[0].port, 443);
        s.davPropfind(NC, '/Films', 1, function (e2) {
            assert.ifError(e2);
            assert.strictEqual(web.calls.length, 3);
            assert.ok(web.calls[2].headers.Authorization, 'the scheme is remembered');
            done();
        });
    });
});

test('a Digest challenge is answered, and a wrong password is said so once', function (t, done) {
    var web = fakeWeb(function (c) {
        var a = c.headers.Authorization || '';
        if (a.indexOf('Digest ') !== 0) return { status: 401, headers: { 'www-authenticate': 'Digest realm="WebDAV", nonce="n1", qop="auth"' } };
        var m = /response="([0-9a-f]+)"/.exec(a), cn = /cnonce="([^"]+)"/.exec(a)[1];
        var want = md5(md5('pat:WebDAV:secret') + ':n1:00000001:' + cn + ':auth:' + md5('PROPFIND:' + c.path));
        return m[1] === want ? { status: 207, body: MULTISTATUS } : { status: 401, headers: { 'www-authenticate': 'Digest realm="WebDAV", nonce="n2", qop="auth"' } };
    });
    var s = loadService({ https: web.mod });
    s.davPropfind(NC, '', 0, function (err) {
        assert.ifError(err);
        assert.strictEqual(web.calls.length, 2);
        var wrong = { id: 'w', url: NC.url, user: 'pat', pass: 'nope' };
        s.davPropfind(wrong, '', 0, function (e2) {
            assert.strictEqual(e2.code, 'auth');
            assert.strictEqual(web.calls.length, 4, 'one challenge, one answer, then give up');
            done();
        });
    });
});

test('a redirect is followed, but the credentials stay home', function (t, done) {
    var web = fakeWeb(function (c, n) {
        if (c.host === 'nas.local' && !c.headers.Authorization) return { status: 401, headers: { 'www-authenticate': 'Basic realm="x"' } };
        if (c.host === 'nas.local') return { status: 302, headers: { location: 'http://elsewhere.example/dav/' } };
        assert.strictEqual(c.host, 'elsewhere.example');
        assert.strictEqual(c.headers.Authorization, undefined);
        return { status: 207, body: '<d:multistatus xmlns:d="DAV:"></d:multistatus>' };
    });
    var s = loadService({ http: web.mod });
    s.davPropfind({ id: 'n', url: 'http://nas.local:5005/dav/', user: 'tv', pass: 'pw' }, '', 0, function (err, entries) {
        assert.ifError(err);
        assert.deepStrictEqual(plain(entries), []);
        assert.strictEqual(web.calls[0].port, '5005');
        done();
    });
});

test('what went wrong gets a name the app can translate', function (t, done) {
    assert.strictEqual(svc.davStatusError(404).code, 'notfound');
    assert.strictEqual(svc.davStatusError(403).code, 'auth');
    assert.strictEqual(svc.davStatusError(405).code, 'notdav');
    assert.strictEqual(svc.davStatusError(200).code, 'notdav');   // a web page answered, not a DAV server
    assert.strictEqual(svc.davStatusError(500).code, 'other');
    var certErr = new Error('self signed certificate'); certErr.code = 'DEPTH_ZERO_SELF_SIGNED_CERT';
    var web = fakeWeb(function (c) {
        return c.rejectUnauthorized ? { error: certErr } : { status: 207, body: '<d:multistatus xmlns:d="DAV:"/>' };
    });
    var s = loadService({ https: web.mod });
    s.davPropfind({ id: 'a', url: 'https://nas.local/' }, '', 0, function (err) {
        assert.strictEqual(err.code, 'cert');
        s.davPropfind({ id: 'a', url: 'https://nas.local/', insecure: true }, '', 0, function (e2) {
            assert.ifError(e2);
            var dns = new Error('getaddrinfo ENOTFOUND'); dns.code = 'ENOTFOUND';
            var s2 = loadService({ https: fakeWeb(function () { return { error: dns }; }).mod });
            s2.davPropfind({ id: 'b', url: 'https://nowhere.invalid/' }, '', 0, function (e3) {
                assert.strictEqual(e3.code, 'host');
                done();
            });
        });
    });
});

/* Issue #170: on Tizen 5.5 Buffer.from(str, 'utf8') throws "utf8 is not a
 * function", which killed Basic auth.  Run the code with a Buffer that throws
 * on any string encoding, like the TV's. */
function tvBuffer() {
    function TvBuffer() { return Buffer.apply(null, arguments); }
    TvBuffer.alloc = Buffer.alloc; TvBuffer.concat = Buffer.concat; TvBuffer.isBuffer = Buffer.isBuffer;
    TvBuffer.from = function (data, enc) {
        if (enc !== undefined) throw new TypeError(enc + ' is not a function');
        return Buffer.from(data);
    };
    return TvBuffer;
}
function loadOnTv() {
    var sandbox = {
        module: { exports: {} }, Buffer: tvBuffer(), console: console,
        setTimeout: setTimeout, clearTimeout: clearTimeout, process: { on: function () {} },
        require: function (name) {
            if (name === 'http') return { createServer: function () { return { listen: function () {} }; } };
            return require(name);
        }
    };
    vm.runInNewContext(SRC + '\nmodule.exports = { davAuthorization: davAuthorization, davAuth: davAuth, ' +
        'utf8Bytes: utf8Bytes, base64: base64 };', sandbox);
    return sandbox.module.exports;
}

test('Basic auth header is built without Buffer string encodings (issue #170)', function () {
    var tv = loadOnTv();
    var srv = { id: 'rc', url: 'https://dav.example.com/', user: 'gsör', pass: 'p@ss:wörd 😀' };
    tv.davAuth.rc = { scheme: 'basic' };
    assert.strictEqual(tv.davAuthorization(srv, 'PROPFIND', '/'),
        'Basic ' + Buffer.from('gsör:p@ss:wörd 😀', 'utf8').toString('base64'));
    srv.pass = '';
    assert.strictEqual(tv.davAuthorization(srv, 'PROPFIND', '/'), 'Basic ' + Buffer.from('gsör:').toString('base64'));
});

test('utf8Bytes and base64 match Node for every padding length', function () {
    var tv = loadOnTv();
    ['', 'a', 'ab', 'abc', 'abcd', 'Träume', '日本語', '😀x', '\ud800'].forEach(function (s) {
        var mine = tv.utf8Bytes(s);
        assert.deepStrictEqual(Array.from(mine), Array.from(Buffer.from(s, 'utf8')), s);
        assert.strictEqual(tv.base64(mine), Buffer.from(s, 'utf8').toString('base64'), s);
    });
});
