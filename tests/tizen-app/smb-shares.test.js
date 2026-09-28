'use strict';

var assert = require('assert');
var test   = require('node:test');
var fs     = require('fs');
var vm     = require('vm');
var path   = require('path');

var SRC = fs.readFileSync(
    path.join(__dirname, '../../tizen-app/service/service.js'), 'utf8');

/* Same loader as smb-signing.test.js: servers that never bind. */
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
    vm.runInNewContext(SRC + '\nmodule.exports = { SmbConnection: SmbConnection, ' +
        'rpcShareEnumRequest: rpcShareEnumRequest, parseShareEnum: parseShareEnum, rpcSplit: rpcSplit };',
        sandbox);
    return sandbox.module.exports;
}

var svc = loadService();

/* Values built inside the vm context carry its Array/Object prototypes, which
 * deepStrictEqual counts as a difference; compare them as plain data. */
function plain(v) { return JSON.parse(JSON.stringify(v)); }

/* ── an NDR-encoded NetrShareEnum reply, the shape Samba and Windows send ── */
function u32(n) { var b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0, 0); return b; }
function ndrStr(s) {
    var chars = Buffer.from(s + '\0', 'utf16le');
    var n = chars.length / 2;
    var pad = Buffer.alloc((4 - (chars.length % 4)) % 4);
    return Buffer.concat([u32(n), u32(0), u32(n), chars, pad]);
}
function shareEnumStub(shares) {
    var parts = [u32(1), u32(1), u32(0x20000), u32(shares.length), u32(0x20004), u32(shares.length)];
    shares.forEach(function (s, i) {
        parts.push(u32(0x20008 + i * 8), u32(s.type), u32(s.remark === null ? 0 : 0x2000c + i * 8));
    });
    shares.forEach(function (s) {
        parts.push(ndrStr(s.name));
        if (s.remark !== null) parts.push(ndrStr(s.remark));
    });
    parts.push(u32(shares.length), u32(0x20100), u32(0), u32(0));   // total, resume ptr+value, WERROR
    return Buffer.concat(parts);
}
/* Wrap stub data in response PDUs of at most `chunk` stub bytes each. */
function responsePdus(stub, chunk) {
    var out = [];
    for (var off = 0; off < stub.length; off += chunk) {
        var piece = stub.slice(off, off + chunk);
        var h = Buffer.alloc(24);
        h[0] = 5; h[2] = 2;                                   // response
        h[3] = (off === 0 ? 1 : 0) | (off + chunk >= stub.length ? 2 : 0);
        h[4] = 0x10;
        h.writeUInt16LE(24 + piece.length, 8);
        h.writeUInt32LE(2, 12);
        h.writeUInt32LE(stub.length, 16);
        out.push(Buffer.concat([h, piece]));
    }
    return out;
}
function bindAck() {
    var b = Buffer.alloc(16);
    b[0] = 5; b[2] = 12; b[3] = 3; b[4] = 0x10;
    b.writeUInt16LE(16, 8);
    return b;
}

var SHARES = [
    { name: 'Media',  type: 0,          remark: 'Movies and series' },
    { name: 'IPC$',   type: 0x80000003, remark: 'IPC Service' },
    { name: 'films',  type: 0,          remark: '' },
    { name: 'C$',     type: 0x80000000, remark: 'Default share' },
    { name: 'Printer', type: 1,         remark: null },
    { name: 'Backup', type: 0,          remark: null }
];

test('the NetrShareEnum request is opnum 15 on context 0, framed to its own length', function () {
    var pdu = svc.rpcShareEnumRequest('192.168.1.10');
    assert.strictEqual(pdu[0], 5);                        // rpc_vers
    assert.strictEqual(pdu[2], 0);                        // request
    assert.strictEqual(pdu[3], 3);                        // first + last fragment
    assert.strictEqual(pdu.readUInt16LE(8), pdu.length);  // frag_length
    assert.strictEqual(pdu.readUInt16LE(20), 0);          // p_cont_id
    assert.strictEqual(pdu.readUInt16LE(22), 15);         // opnum
    assert.strictEqual(pdu.readUInt32LE(16), pdu.length - 24);   // alloc_hint = stub size
    // ServerName carries the UNC host, NUL-terminated.
    var n = pdu.readUInt32LE(28 + 8);
    assert.strictEqual(pdu.slice(40, 40 + n * 2).toString('utf16le'), '\\\\192.168.1.10\0');
    assert.strictEqual((pdu.length - 24) % 4, 0);         // NDR keeps the stub 4-aligned
});

test('parseShareEnum reads every row, with and without a remark', function () {
    var rows = plain(svc.parseShareEnum(shareEnumStub(SHARES)));
    assert.deepStrictEqual(rows.map(function (r) { return [r.name, r.type >>> 0, r.remark]; }), [
        ['Media', 0, 'Movies and series'], ['IPC$', 0x80000003, 'IPC Service'], ['films', 0, ''],
        ['C$', 0x80000000, 'Default share'], ['Printer', 1, ''], ['Backup', 0, '']
    ]);
});

test('parseShareEnum returns nothing for an empty container', function () {
    assert.deepStrictEqual(plain(svc.parseShareEnum(Buffer.concat([u32(1), u32(1), u32(0x20000), u32(0), u32(0),
                                                                   u32(0), u32(0), u32(0), u32(0)]))), []);
});

test('rpcSplit keeps a PDU that has not fully arrived for the next read', function () {
    var pdus = responsePdus(shareEnumStub(SHARES), 64);
    var all = Buffer.concat(pdus);
    var sp = svc.rpcSplit(all.slice(0, pdus[0].length + 10));
    assert.strictEqual(sp.pdus.length, 1);
    assert.strictEqual(sp.rest.length, 10);
    assert.strictEqual(sp.last, false);
    assert.strictEqual(svc.rpcSplit(all).last, true);
});

/* A connection whose SMB layer is faked: the reply comes back split over
 * several fragments, the first through the IOCTL and the rest through READs,
 * the way a server with many shares answers. */
function fakeConnection(replyPdus) {
    var c = new svc.SmbConnection({ host: 'nas', share: 'IPC$' });
    var calls = [], queue = [];
    var fid = Buffer.alloc(16);
    c.open = function (p, isDir, cb, access) { calls.push(['open', p, access]); cb(null, { fileId: fid }); };
    c.close = function () { calls.push(['close']); };
    c.transceive = function (fileId, input, maxOut, cb) {
        calls.push(['ioctl', input[2]]);
        if (input[2] === 11) return cb(null, bindAck(), false);
        queue = replyPdus.slice(1);
        cb(null, replyPdus[0], false);
    };
    c.read = function (fileId, off, len, cb) { calls.push(['read']); cb(null, queue.shift() || Buffer.alloc(0)); };
    return { conn: c, calls: calls };
}

test('listShares binds, calls, reads the remaining fragments and keeps only disk shares', function (t, done) {
    var f = fakeConnection(responsePdus(shareEnumStub(SHARES), 40));
    f.conn.listShares(function (err, shares) {
        assert.ifError(err);
        assert.deepStrictEqual(plain(shares), [
            { name: 'Backup', remark: '' }, { name: 'films', remark: '' },
            { name: 'Media', remark: 'Movies and series' }
        ]);
        assert.deepStrictEqual(f.calls[0], ['open', 'srvsvc', 0x0012019F]);
        assert.ok(f.calls.filter(function (c) { return c[0] === 'read'; }).length > 1);
        assert.deepStrictEqual(f.calls[f.calls.length - 1], ['close']);
        done();
    });
});

test('listShares reports a reply cut short instead of hanging', function (t, done) {
    var pdus = responsePdus(shareEnumStub(SHARES), 40);
    var f = fakeConnection(pdus.slice(0, 2));             // last fragment never arrives
    f.conn.listShares(function (err) {
        assert.match(String(err && err.message), /cut short/);
        done();
    });
});

test('listShares passes a server-side WERROR through', function (t, done) {
    var stub = shareEnumStub([]);
    stub.writeUInt32LE(5, stub.length - 4);                // ERROR_ACCESS_DENIED
    var f = fakeConnection(responsePdus(stub, 4000));
    f.conn.listShares(function (err) {
        assert.match(String(err && err.message), /server error 0x5/);
        done();
    });
});
