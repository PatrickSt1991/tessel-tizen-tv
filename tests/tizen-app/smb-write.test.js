'use strict';

var assert = require('assert');
var test   = require('node:test');
var fs     = require('fs');
var vm     = require('vm');
var path   = require('path');

var SRC = fs.readFileSync(path.join(__dirname, '../../tizen-app/service/service.js'), 'utf8');

/* Same loader as smb-shares.test.js: servers that never bind. */
function loadService() {
    var fakeHttp = { createServer: function () { return { listen: function () {} }; } };
    var sandbox = {
        module: { exports: {} }, Buffer: Buffer, console: console,
        setTimeout: setTimeout, clearTimeout: clearTimeout,
        process: { on: function () {} },
        require: function (name) { return name === 'http' ? fakeHttp : require(name); }
    };
    vm.runInNewContext(SRC + '\nmodule.exports = { SmbConnection: SmbConnection, SMB2: SMB2 };', sandbox);
    return sandbox.module.exports;
}
var svc = loadService();

/* A connection whose _send is a fake server: records every request, answers
 * CREATE with a file id and the size `sizes` names for that open, WRITE
 * with the count asked (or `take` of it), CLOSE with nothing. */
function fakeConn(opts) {
    opts = opts || {};
    var c = new svc.SmbConnection({ host: 'nas', share: 'Media' });
    c.maxWrite = opts.maxWrite || 65536;
    c.sent = [];
    var opens = 0;
    c._send = function (cmd, body, charge, cb) {
        c.sent.push({ cmd: cmd, body: body, charge: charge });
        if (cmd === svc.SMB2.CREATE) {
            if (opts.openFails) return cb(0xC0000022, null, null);   // ACCESS_DENIED
            var resp = Buffer.alloc(88);
            var size = (opts.sizes || [0, 0])[opens++] || 0;
            resp.writeUInt32LE(size, 48);
            Buffer.from('0123456789abcdef').copy(resp, 64);
            return cb(0, Buffer.alloc(64), resp);
        }
        if (cmd === svc.SMB2.WRITE) {
            if (opts.writeFails) return cb(0xC000007F, null, null);   // DISK_FULL
            var r = Buffer.alloc(17);
            var len = body.readUInt32LE(4);
            r.writeUInt32LE(opts.take ? Math.min(opts.take, len) : len, 4);
            return cb(0, Buffer.alloc(64), r);
        }
        if (cmd === svc.SMB2.CLOSE) return cb(0, Buffer.alloc(64), Buffer.alloc(60));
        cb(0xC0000002, null, null);
    };
    return c;
}
function writes(c) { return c.sent.filter(function (s) { return s.cmd === svc.SMB2.WRITE; }); }

test('a WRITE carries the data after a 48-byte fixed part, at the offset asked, with the right credit charge', function (t, done) {
    var c = fakeConn();
    var data = Buffer.alloc(70000, 0xAB);
    c.write(Buffer.from('0123456789abcdef'), 4096, data, function (err, count) {
        assert.ifError(err);
        assert.strictEqual(count, 70000);
        var w = writes(c)[0];
        assert.strictEqual(w.charge, 2);
        assert.strictEqual(w.body.readUInt16LE(0), 49);          // StructureSize
        assert.strictEqual(w.body.readUInt16LE(2), 112);         // DataOffset from the header start
        assert.strictEqual(w.body.readUInt32LE(4), 70000);       // Length
        assert.strictEqual(w.body.readUInt32LE(8), 4096);        // Offset (low)
        assert.strictEqual(w.body.slice(16, 32).toString(), '0123456789abcdef');
        assert.strictEqual(w.body.length, 48 + 70000);
        assert.strictEqual(w.body[48], 0xAB);
        done();
    });
});

test('putFile creates or overwrites, writes in pieces the server allows, closes, and reports the size on the share', function (t, done) {
    var c = fakeConn({ maxWrite: 1000, sizes: [0, 2500] });
    c.putFile('/tessel-backup.json', Buffer.alloc(2500, 0x20), function (err, size) {
        assert.ifError(err);
        assert.strictEqual(size, 2500);
        var create = c.sent[0];
        assert.strictEqual(create.cmd, svc.SMB2.CREATE);
        assert.strictEqual(create.body.readUInt32LE(24), 0x00100183);   // DesiredAccess includes WRITE_DATA
        assert.strictEqual(create.body.readUInt32LE(36), 5);            // FILE_OVERWRITE_IF
        var w = writes(c);
        assert.deepStrictEqual(w.map(function (x) { return x.body.readUInt32LE(4); }), [1000, 1000, 500]);
        assert.deepStrictEqual(w.map(function (x) { return x.body.readUInt32LE(8); }), [0, 1000, 2000]);
        var cmds = c.sent.map(function (s) { return s.cmd; });
        // open, 3 writes, close, open again (read-only, to look it up), close.
        assert.deepStrictEqual(cmds, [5, 9, 9, 9, 6, 5, 6]);
        assert.strictEqual(c.sent[5].body.readUInt32LE(36), 1);         // FILE_OPEN for the look-up
        done();
    });
});

test('a short write carries on from where the server stopped', function (t, done) {
    var c = fakeConn({ take: 300, sizes: [0, 700] });
    c.putFile('/x.txt', Buffer.alloc(700, 1), function (err, size) {
        assert.ifError(err);
        assert.strictEqual(size, 700);
        assert.deepStrictEqual(writes(c).map(function (x) { return x.body.readUInt32LE(8); }), [0, 300, 600]);
        done();
    });
});

test('a share that refuses the file, or a write that fails, is an error with the NT status named, and the handle is closed', function (t, done) {
    fakeConn({ openFails: true }).putFile('/x', Buffer.alloc(1), function (err) {
        assert.ok(/open "\/x"/.test(err.message), err.message);
        var c = fakeConn({ writeFails: true });
        c.putFile('/x', Buffer.alloc(1), function (e2) {
            assert.ok(/^write: /.test(e2.message), e2.message);
            assert.strictEqual(c.sent[c.sent.length - 1].cmd, svc.SMB2.CLOSE);
            done();
        });
    });
});
