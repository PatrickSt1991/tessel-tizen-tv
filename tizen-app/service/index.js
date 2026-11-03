/* Entry point for Tizen 10 background service (madebypatk.smbproxy).
 * In development / source tree, service.js holds the implementation so existing
 * unit tests that inspect service.js via fs.readFileSync continue to pass.
 * scripts/bundle-service.js inlines this and all dependencies into a single
 * service/index.js inside dist/tessel.wgt.
 */
'use strict';
module.exports = require('./service.js');

