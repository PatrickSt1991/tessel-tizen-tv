'use strict';

var assert = require('assert');
var test   = require('node:test');
var fs     = require('fs');
var vm     = require('vm');
var path   = require('path');
var crypto = require('crypto');

var SRC = fs.readFileSync(
    path.join(__dirname, '../../tizen-app/service/service.js'), 'utf8');

/* service.js starts listening the moment it runs, so hand it an http module
 * whose servers never bind, then reach in for SmbConnection. */
function loadService() {
    var fakeHttp = { createServer: function () { return { listen: function () {} }; } };
    var sandbox = {
        module: { exports: {} },
        Buffer: Buffer,
        console: console,
        setTimeout: setTimeout, clearTimeout: clearTimeout,
        process: { on: function () {} },
        require: function (name) { return name === 'http' ? fakeHttp : require(name); }
    };
    vm.runInNewContext(SRC + '\nmodule.exports = { SmbConnection: SmbConnection, SMB2: SMB2, NTLM_F: NTLM_F };',
        sandbox);
    return sandbox.module.exports;
}

var svc = loadService();
var FLAGS_SIGNED = 0x00000008;

/* A CHALLENGE_MESSAGE carrying an MsvAvTimestamp, so the client emits a MIC —
 * the same shape a Windows 11 server sends. */
function challengeMessage() {
    var ti = Buffer.alloc(12 + 4);
    ti.writeUInt16LE(0x0007, 0); ti.writeUInt16LE(8, 2);   // MsvAvTimestamp
    ti.writeUInt32LE(0x01DB2F00, 8);
    // trailing 4 zero bytes = MsvAvEOL
    var msg = Buffer.alloc(48 + ti.length);
    msg.write('NTLMSSP\0', 0, 'ascii');
    msg.writeUInt32LE(2, 8);
    msg.writeUInt32LE(svc.NTLM_F, 20);
    crypto.randomBytes(8).copy(msg, 24);
    msg.writeUInt16LE(ti.length, 40); msg.writeUInt16LE(ti.length, 42);
    msg.writeUInt32LE(48, 44);
    ti.copy(msg, 48);
    return msg;
}

function response(command, mid, status, body) {
    var h = Buffer.alloc(64);
    h.writeUInt32BE(0xFE534D42, 0);
    h.writeUInt16LE(64, 4);
    h.writeUInt32LE(status >>> 0, 8);
    h.writeUInt16LE(command, 12);
    h.writeUInt32LE(mid, 24);
    h.writeUInt32LE(0x1234, 40);   // SessionId
    return Buffer.concat([h, body]);
}

/* Drive NEGOTIATE-less SESSION_SETUP against a server that demands signing,
 * capturing every SMB2 packet the client writes. */
function handshake() {
    var c = new svc.SmbConnection({ host: 'nas', share: 's', user: 'VASYA', pass: 'secret' });
    var sent = [];
    c.socket = { write: function (b) { sent.push(b.slice(4)); } };
    c.signing = true;    // what NEGOTIATE sets when the server requires signing

    var done = null;
    c._sessionSetup(function (err) { done = err || 'ok'; });

    var t2 = challengeMessage();
    var r1 = Buffer.alloc(8 + t2.length);
    r1.writeUInt16LE(9, 0);
    r1.writeUInt16LE(64 + 8, 4); r1.writeUInt16LE(t2.length, 6);
    t2.copy(r1, 8);
    c._dispatch(response(svc.SMB2.SESSION_SETUP, 0, 0xC0000016, r1));
    c._dispatch(response(svc.SMB2.SESSION_SETUP, 1, 0, Buffer.alloc(8)));
    return { conn: c, sent: sent, done: done };
}

test('the NTLM authenticate request goes out unsigned even when the server requires signing', function () {
    // Windows rejects a signed SESSION_SETUP with STATUS_INVALID_PARAMETER
    // (github issue #83): it has no session key yet to check it against.
    var h = handshake();
    assert.strictEqual(h.done, 'ok');
    assert.strictEqual(h.sent.length, 2);
    h.sent.forEach(function (pkt) {
        assert.strictEqual(pkt.readUInt16LE(12), svc.SMB2.SESSION_SETUP);
        assert.strictEqual(pkt.readUInt32LE(16) & FLAGS_SIGNED, 0);
        assert.ok(pkt.slice(48, 64).equals(Buffer.alloc(16)), 'signature field must stay zero');
    });
});

test('signing starts with the first request after the session is up', function () {
    var h = handshake();
    h.conn._send(svc.SMB2.TREE_CONNECT, Buffer.alloc(8), 1, function () {});
    var pkt = h.sent[2];
    assert.strictEqual(pkt.readUInt32LE(16) & FLAGS_SIGNED, FLAGS_SIGNED);

    var zeroed = Buffer.from(pkt); zeroed.fill(0, 48, 64);
    var want = crypto.createHmac('sha256', h.conn.signKey).update(zeroed).digest().slice(0, 16);
    assert.ok(pkt.slice(48, 64).equals(want), 'TREE_CONNECT carries a valid HMAC-SHA256 signature');
});

test('NTLM messages offer SIGN, 128 and 56 like a Windows client does', function () {
    var h = handshake();
    var t1 = h.sent[0].slice(64 + 24);
    var t3 = h.sent[1].slice(64 + 24);
    assert.strictEqual(t1.toString('ascii', 0, 8), 'NTLMSSP\0');
    [0x00000010, 0x20000000, 0x80000000].forEach(function (bit) {
        assert.ok((t1.readUInt32LE(12) & bit) >>> 0, 'type1 lacks 0x' + bit.toString(16));
        assert.ok((t3.readUInt32LE(60) & bit) >>> 0, 'type3 lacks 0x' + bit.toString(16));
    });
});
