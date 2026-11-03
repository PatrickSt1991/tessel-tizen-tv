/* Bundles tizen-app/service/*.js into one file: node scripts/bundle-service.js <out.js>
 *
 * Tizen 10 runs a web service in an embedded Node 20 (Electron, inside Chromium) instead of the
 * Node 4 of older sets, and services split over several files with require('./x.js') do not
 * come up there (TV-Store, Vetro), while TizenBrew's, one bundled file wrapped in a function,
 * does. So the .wgt carries the service the same way: every module wrapped in a function, the
 * relative requires resolved here, nothing declared at the top level, and only Node's built-in
 * modules left for the platform's require. ES5, so the bundle runs on Node 4.4.3 as well.
 */
'use strict';
var fs = require('fs'), path = require('path');

var DIR = path.join(__dirname, '..', 'tizen-app', 'service');
var ENTRY = fs.existsSync(path.join(DIR, 'index.js')) ? './index.js' : './service.js';
var REQ = /require\(['"](\.\/[A-Za-z0-9_.-]+(?:\.js)?)['"]\)/g;

var order = [], seen = {};
function resolveFile(id) {
    var rel = id;
    if (!path.extname(rel)) rel += '.js';
    return rel;
}

(function visit(id) {
    var normId = resolveFile(id);
    if (seen[normId]) return;
    seen[normId] = true;
    var filePath = path.join(DIR, normId);
    if (!fs.existsSync(filePath)) {
        throw new Error('Cannot find local module: ' + normId + ' at ' + filePath);
    }
    var src = fs.readFileSync(filePath, 'utf8'), m;
    REQ.lastIndex = 0;
    while ((m = REQ.exec(src)) !== null) visit(m[1]);
    order.push({ id: normId, src: src });
})(ENTRY);

var out = [];
out.push('/* Tessel service, bundled by scripts/bundle-service.js from tizen-app/service/. Do not edit. */');
out.push('(function (nodeRequire, hostModule) {');
out.push('\'use strict\';');
out.push('var defs = {}, cache = {};');
out.push('function load(id) {');
out.push('    var key = id;');
out.push('    if (typeof key === \'string\' && key.slice(0, 2) === \'./\' && key.slice(-3) !== \'.js\') key += \'.js\';');
out.push('    if (cache[key]) return cache[key].exports;');
out.push('    if (!defs[key]) return nodeRequire(id);');
out.push('    var m = cache[key] = { exports: {} };');
out.push('    defs[key].call(m.exports, m, m.exports, load);');
out.push('    return m.exports;');
out.push('}');
order.forEach(function (f) {
    out.push('defs[' + JSON.stringify(f.id) + '] = function (module, exports, require) {');
    out.push(f.src);
    out.push('};');
});
out.push('var api = load(' + JSON.stringify(resolveFile(ENTRY)) + ');');
// The platform calls the lifecycle hooks on the service file's own exports, when it has them.
out.push('if (hostModule && hostModule.exports) for (var k in api) hostModule.exports[k] = api[k];');
out.push('})(typeof require === \'function\' ? require : null, typeof module === \'object\' ? module : null);');

var target = process.argv[2];
if (!target) { console.error('usage: node scripts/bundle-service.js <out.js>'); process.exit(2); }
var targetDir = path.dirname(target);
if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
fs.writeFileSync(target, out.join('\n') + '\n');
console.log('bundled ' + order.map(function (f) { return f.id; }).join(', ') + ' -> ' + target);

