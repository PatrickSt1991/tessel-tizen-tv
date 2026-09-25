/* The real I18n module with the English table loaded, for sandboxes that run
 * app code calling I18n.t().  Node has no XHR, so the table is handed over
 * directly instead of being read the way the TV reads it. */
var I18n = require('../../../tizen-app/js/i18n.js');
var en = require('../../../tizen-app/i18n/en.json');
I18n._setTables(en, en, 'en');
module.exports = I18n;
