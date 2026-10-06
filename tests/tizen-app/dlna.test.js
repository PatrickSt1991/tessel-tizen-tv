'use strict';

var assert = require('assert');
var test   = require('node:test');
var fs     = require('fs');
var vm     = require('vm');
var path   = require('path');

var SRC = fs.readFileSync(path.join(__dirname, '../../tizen-app/service/service.js'), 'utf8');

/* Same loader as smb-shares.test.js: servers that never bind.  `extra` lets a
 * test stand in for a module the code under test would otherwise talk to. */
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
    vm.runInNewContext(SRC + '\nmodule.exports = { parseSsdp: parseSsdp, ' +
        'parseDeviceDescription: parseDeviceDescription, parseDidl: parseDidl, ' +
        'parseBrowseReply: parseBrowseReply, browseRequest: browseRequest, xmlUnescape: xmlUnescape, ' +
        'ssdpSearchMessage: ssdpSearchMessage, ssdpSearchPlan: ssdpSearchPlan, ip4Broadcast: ip4Broadcast, ' +
        'mergeServers: mergeServers, startDlnaPassive: startDlnaPassive, passiveServers: passiveServers };',
        sandbox);
    return sandbox.module.exports;
}
var svc = loadService();
function plain(v) { return JSON.parse(JSON.stringify(v)); }

test('an SSDP answer gives its LOCATION; anything else is ignored', function () {
    var h = svc.parseSsdp('HTTP/1.1 200 OK\r\nCACHE-CONTROL: max-age=1810\r\nST: urn:schemas-upnp-org:device:MediaServer:1\r\n' +
                          'Location: http://192.168.1.10:8200/rootDesc.xml\r\n\r\n');
    assert.strictEqual(h.location, 'http://192.168.1.10:8200/rootDesc.xml');
    assert.strictEqual(svc.parseSsdp('M-SEARCH * HTTP/1.1\r\nST: ssdp:all\r\n\r\n'), null);
});

/* What miniDLNA serves at /rootDesc.xml, trimmed. */
var MINIDLNA_DESC =
    '<?xml version="1.0"?><root xmlns="urn:schemas-upnp-org:device-1-0"><specVersion><major>1</major></specVersion>' +
    '<device><deviceType>urn:schemas-upnp-org:device:MediaServer:1</deviceType>' +
    '<friendlyName>nas: minidlna</friendlyName><UDN>uuid:4d696e69-444c-164e-9d41-001e06aabbcc</UDN>' +
    '<serviceList>' +
    '<service><serviceType>urn:schemas-upnp-org:service:ConnectionManager:1</serviceType>' +
    '<controlURL>/ctl/ConnectionMgr</controlURL></service>' +
    '<service><serviceType>urn:schemas-upnp-org:service:ContentDirectory:1</serviceType>' +
    '<serviceId>urn:upnp-org:serviceId:ContentDirectory</serviceId><controlURL>/ctl/ContentDir</controlURL>' +
    '<eventSubURL>/evt/ContentDir</eventSubURL><SCPDURL>/ContentDir.xml</SCPDURL></service>' +
    '</serviceList></device></root>';

test('a device description names the server and its ContentDirectory control URL', function () {
    assert.deepStrictEqual(plain(svc.parseDeviceDescription(MINIDLNA_DESC, 'http://192.168.1.10:8200/rootDesc.xml')), {
        id: 'uuid:4d696e69-444c-164e-9d41-001e06aabbcc', name: 'nas: minidlna',
        control: 'http://192.168.1.10:8200/ctl/ContentDir'
    });
    // URLBase wins over the description's own address; a relative control URL without a slash too.
    var withBase = MINIDLNA_DESC.replace('<specVersion>', '<URLBase>http://10.0.0.5:9000/dms/</URLBase><specVersion>')
                                .replace('/ctl/ContentDir<', 'cd/control<');
    assert.strictEqual(svc.parseDeviceDescription(withBase, 'http://192.168.1.10:8200/x.xml').control,
                       'http://10.0.0.5:9000/dms/cd/control');
    // A router or a TV that answers the search but has no ContentDirectory is not a server.
    assert.strictEqual(svc.parseDeviceDescription(MINIDLNA_DESC.replace(/ContentDirectory/g, 'AVTransport'), 'http://x/'), null);
});

var DIDL =
    '<DIDL-Lite xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/" ' +
    'xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/">' +
    '<container id="64$0" parentID="64" restricted="1" searchable="1" childCount="12"><dc:title>Films &amp; Series</dc:title>' +
    '<upnp:class>object.container.storageFolder</upnp:class></container>' +
    '<item id="64$1" parentID="64" restricted="1"><dc:title>Беларусь — Документальный</dc:title>' +
    '<upnp:class>object.item.videoItem</upnp:class>' +
    '<res size="734003200" duration="1:32:05.000" protocolInfo="http-get:*:video/x-matroska:*">http://192.168.1.10:8200/MediaItems/23.mkv</res></item>' +
    '<item id="64$2" parentID="64" restricted="1"><dc:title>Track 01</dc:title><upnp:class>object.item.audioItem.musicTrack</upnp:class>' +
    '<upnp:albumArtURI dlna:profileID="JPEG_TN" xmlns:dlna="urn:schemas-dlna-org:metadata-1-0/">http://192.168.1.10:8200/AlbumArt/7-31.jpg</upnp:albumArtURI>' +
    '<res protocolInfo="rtsp-rtp-udp:*:audio/mpeg:*">rtsp://192.168.1.10/x</res>' +
    '<res size="5120000" protocolInfo="http-get:*:audio/mpeg:*">http://192.168.1.10:8200/MediaItems/31.mp3?a=1&amp;b=2</res></item>' +
    '<item id="64$3" parentID="64" restricted="1"><dc:title>Nothing to fetch</dc:title><upnp:class>object.item.videoItem</upnp:class></item>' +
    '</DIDL-Lite>';

test('DIDL-Lite becomes folders and playable items with their http resource', function () {
    assert.deepStrictEqual(plain(svc.parseDidl(DIDL)), [
        { id: '64$0', title: 'Films & Series', isDir: true, count: 12 },
        { id: '64$1', title: 'Беларусь — Документальный', isDir: false, kind: 'video',
          url: 'http://192.168.1.10:8200/MediaItems/23.mkv', size: 734003200, duration: 5525, art: '' },
        { id: '64$2', title: 'Track 01', isDir: false, kind: 'audio',
          url: 'http://192.168.1.10:8200/MediaItems/31.mp3?a=1&b=2', size: 5120000, duration: 0,
          art: 'http://192.168.1.10:8200/AlbumArt/7-31.jpg' }
    ]);
});

test('a Browse reply unescapes its Result once and pages by NumberReturned / TotalMatches', function () {
    var esc = DIDL.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    var reply = '<?xml version="1.0" encoding="utf-8"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body>' +
                '<u:BrowseResponse xmlns:u="urn:schemas-upnp-org:service:ContentDirectory:1"><Result>' + esc + '</Result>' +
                '<NumberReturned>3</NumberReturned><TotalMatches>450</TotalMatches><UpdateID>1</UpdateID></u:BrowseResponse></s:Body></s:Envelope>';
    var r = svc.parseBrowseReply(200, reply);
    assert.strictEqual(r.returned, 3);
    assert.strictEqual(r.total, 450);
    assert.strictEqual(r.entries.length, 3);
    assert.strictEqual(r.entries[0].title, 'Films & Series');

    var fault = '<s:Envelope><s:Body><s:Fault><faultstring>UPnPError</faultstring><detail><UPnPError>' +
                '<errorCode>701</errorCode><errorDescription>No such object</errorDescription></UPnPError></detail></s:Fault></s:Body></s:Envelope>';
    assert.strictEqual(svc.parseBrowseReply(500, fault).error, 'No such object');

    var req = svc.browseRequest('64$<1>&', 200, 200);
    assert.ok(req.indexOf('<ObjectID>64$&lt;1&gt;&amp;</ObjectID>') > 0, req);
    assert.ok(req.indexOf('<StartingIndex>200</StartingIndex>') > 0);
});

test('character references outside the BMP survive unescaping', function () {
    assert.strictEqual(svc.xmlUnescape('&#127909; &#x1F3A5; &lt;b&gt;'), '🎥 🎥 <b>');
});

/* ── web side ── */
function loadDlna() {
    var sandbox = {
        module: { exports: {} },
        FileTypes: require('../../tizen-app/js/filetypes.js')
    };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../tizen-app/js/dlna.js'), 'utf8'), sandbox);
    return sandbox.module.exports;
}

test('an entry\'s kind is the server\'s class, else the URL\'s extension', function () {
    var D = loadDlna();
    assert.strictEqual(D.kindOf({ isDir: true }), 'dir');
    assert.strictEqual(D.kindOf({ kind: 'video', title: 'No extension', url: 'http://x/a' }), 'video');
    assert.strictEqual(D.kindOf({ kind: 'other', title: 'Song', url: 'http://x/MediaItems/9.flac?x=1' }), 'audio');
    assert.strictEqual(D.kindOf({ kind: 'other', title: 'Thing', url: 'http://x/stream' }), 'other');
});

test('the player gets the folder\'s video and audio, music with its cover', function () {
    var D = loadDlna();
    var pl = plain(D.playlistOf([
        { isDir: true, title: 'Sub' },
        { kind: 'video', title: 'Film', url: 'http://s/1.mkv', art: 'http://s/a.jpg' },
        { kind: 'image', title: 'Pic', url: 'http://s/2.jpg' },
        { kind: 'audio', title: 'Song', url: 'http://s/3.mp3', art: 'http://s/c.jpg' }
    ]));
    assert.deepStrictEqual(pl, [
        { uri: 'http://s/1.mkv', title: 'Film', art: null, tagSrc: null },
        { uri: 'http://s/3.mp3', title: 'Song', art: 'http://s/c.jpg', tagSrc: 'http://s/3.mp3' }
    ]);
});

test('the M-SEARCH names the group and the target, however it travels', function () {
    var m = svc.ssdpSearchMessage('urn:schemas-upnp-org:device:MediaServer:1').toString('utf8');
    assert.ok(/^M-SEARCH \* HTTP\/1\.1\r\n/.test(m));
    assert.ok(m.indexOf('HOST: 239.255.255.250:1900\r\n') > 0);
    assert.ok(m.indexOf('MAN: "ssdp:discover"\r\n') > 0);
    assert.ok(m.indexOf('ST: urn:schemas-upnp-org:device:MediaServer:1\r\n') > 0);
    assert.ok(/\r\n\r\n$/.test(m));
});

test('a /24 is searched by multicast, broadcast and every host; a /16 by the first two only', function () {
    var plan = svc.ssdpSearchPlan([{ address: '192.168.0.118', netmask: '255.255.255.0' },
                                   { address: '10.0.0.5',      netmask: '255.255.0.0' }]);
    assert.strictEqual(plan.length, 2);
    assert.strictEqual(plan[0].broadcast, '192.168.0.255');
    assert.strictEqual(plan[0].hosts.length, 253);           // 254 minus ourselves
    assert.strictEqual(plan[0].hosts[0], '192.168.0.1');
    assert.ok(plan[0].hosts.indexOf('192.168.0.118') < 0);
    assert.ok(plan[0].hosts.indexOf('192.168.0.239') >= 0);  // the miniDLNA box of issue #131
    assert.strictEqual(plan[1].broadcast, '10.0.255.255');
    assert.strictEqual(plan[1].hosts.length, 0);
    assert.strictEqual(svc.ssdpSearchPlan([]).length, 0);
});

test('the broadcast address survives the high bit; junk gives nothing', function () {
    assert.strictEqual(svc.ip4Broadcast('192.168.1.37', '255.255.255.0'), '192.168.1.255');
    assert.strictEqual(svc.ip4Broadcast('172.16.5.9', '255.255.252.0'), '172.16.7.255');
    assert.strictEqual(svc.ip4Broadcast('fe80::1', '255.255.255.0'), '');
    assert.strictEqual(svc.ip4Broadcast('192.168.1.37', ''), '');
});

/* ── passive discovery: the servers a search cannot reach (issue #131) ── */
test('a search result and a remembered announcement become one list, by id', function () {
    var searched = [{ id: 'uuid:a', name: 'Zeta', control: 'http://a/ctl' }];
    var remembered = {
        'uuid:a': { id: 'uuid:a', name: 'Stale', control: 'http://a/old' },
        'uuid:b': { id: 'uuid:b', name: 'Alpha', control: 'http://b/ctl' }
    };
    assert.deepStrictEqual(plain(svc.mergeServers(searched, remembered)), [
        { id: 'uuid:b', name: 'Alpha', control: 'http://b/ctl' },
        { id: 'uuid:a', name: 'Zeta', control: 'http://a/ctl' }   // the search's copy, not the remembered one
    ]);
    assert.deepStrictEqual(plain(svc.mergeServers([], null)), []);
    assert.strictEqual(svc.mergeServers(null, remembered).length, 2);
});

test('passive discovery joins the group on each interface and resolves an announcement', function () {
    var requests = [], joins = [], ports = [], handlers = {};
    var httpStub = {
        createServer: function () { return { listen: function () {} }; },
        request: function (opts, onResponse) {
            requests.push(opts.host + ':' + opts.port + opts.path);
            var req = {
                setTimeout: function () { return req; },
                on: function () { return req; },
                abort: function () { return req; },
                end: function () {
                    var res = { statusCode: 200, on: function (ev, fn) {
                        if (ev === 'data') fn(Buffer.from(MINIDLNA_DESC));
                        if (ev === 'end') fn();
                        return res;
                    } };
                    onResponse(res);
                }
            };
            return req;
        }
    };
    var dgramStub = { createSocket: function () {
        var sock = {
            on: function (ev, fn) { handlers[ev] = fn; return sock; },
            bind: function (port, cb) { ports.push(port); cb(); return sock; },
            addMembership: function (group, address) { joins.push(group + ' ' + address); },
            close: function () {}
        };
        return sock;
    } };
    var passive = loadService({ http: httpStub, dgram: dgramStub });
    passive.startDlnaPassive([{ address: '192.168.0.118' }, { address: '10.0.0.5' }]);

    assert.deepStrictEqual(ports, [1900], 'binds the SSDP port');
    assert.deepStrictEqual(joins, ['239.255.255.250 192.168.0.118', '239.255.255.250 10.0.0.5'],
                       'joins the group on every interface');
    assert.strictEqual(typeof handlers.message, 'function');

    // miniDLNA's periodic announcement — the half that survives a network
    // which drops the client's own M-SEARCH.
    var announce = Buffer.from('NOTIFY * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\n' +
        'NT: urn:schemas-upnp-org:device:MediaServer:1\r\nNTS: ssdp:alive\r\n' +
        'LOCATION: http://192.168.1.10:8200/rootDesc.xml\r\n\r\n');
    handlers.message(announce, { address: '192.168.1.10' });

    var remembered = Object.keys(passive.passiveServers).map(function (k) { return passive.passiveServers[k]; });
    assert.deepStrictEqual(plain(remembered), [{ id: 'uuid:4d696e69-444c-164e-9d41-001e06aabbcc',
        name: 'nas: minidlna', control: 'http://192.168.1.10:8200/ctl/ContentDir' }]);
    assert.strictEqual(requests.length, 1, 'reads the announced description once');

    handlers.message(announce, { address: '192.168.1.10' });
    assert.strictEqual(requests.length, 1, 'a repeated announcement is not read again');
    assert.strictEqual(passive.mergeServers([], passive.passiveServers).length, 1,
                       'the announced server reaches the list a search returns');
});
