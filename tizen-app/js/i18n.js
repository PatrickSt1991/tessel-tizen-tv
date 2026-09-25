/* i18n.js — every user-facing string, looked up by key.
 *
 * The English text lives in i18n/en.json, the source file Crowdin translates
 * from; each translation is i18n/<locale>.json (nl-NL.json, pt-BR.json …),
 * named by full locale so pt-BR/pt-PT and zh-CN/zh-TW can't collide.  A
 * language file only carries what has been translated: a key it lacks falls
 * back to English, and a key English lacks shows as the key itself, so a
 * missing string is visible rather than blank.
 *
 * Both files are read synchronously while this script loads.  They sit inside
 * the .wgt, so that is a local read, and it means every script after this one
 * can call I18n.t() at load time — the option lists built at the top of
 * server.js, for instance.
 *
 * Markup uses attributes instead: data-i18n (text), data-i18n-placeholder,
 * data-i18n-title, data-i18n-alt and data-i18n-aria-label, filled in by apply().  A sentence
 * with elements inside it uses data-i18n-fmt: its children marked
 * data-slot="0", "1" … are kept and put where the translation has {0}, {1},
 * so each language can order the sentence its own way.  Everything is set
 * as text, never as HTML, so a translation can't inject markup.
 *
 * ES5 + XHR on purpose — safest on the Tizen 5.0 WebView.
 */
var I18n = (function () {
    'use strict';

    var DIR = 'i18n/';

    /* Every language the app offers, by the locale code its file is named
     * after, with the name as its speakers write it.  A language listed here
     * without a file yet simply shows English. */
    var LANGUAGES = [
        { code: 'en',    name: 'English' },
        { code: 'af-ZA', name: 'Afrikaans' },
        { code: 'ar-SA', name: 'العربية' },
        { code: 'ca-ES', name: 'Català' },
        { code: 'cs-CZ', name: 'Čeština' },
        { code: 'da-DK', name: 'Dansk' },
        { code: 'de-DE', name: 'Deutsch' },
        { code: 'el-GR', name: 'Ελληνικά' },
        { code: 'es-ES', name: 'Español' },
        { code: 'fi-FI', name: 'Suomi' },
        { code: 'fr-FR', name: 'Français' },
        { code: 'he-IL', name: 'עברית' },
        { code: 'hu-HU', name: 'Magyar' },
        { code: 'it-IT', name: 'Italiano' },
        { code: 'ja-JP', name: '日本語' },
        { code: 'ko-KR', name: '한국어' },
        { code: 'nl-NL', name: 'Nederlands' },
        { code: 'no-NO', name: 'Norsk' },
        { code: 'pl-PL', name: 'Polski' },
        { code: 'pt-BR', name: 'Português (Brasil)' },
        { code: 'pt-PT', name: 'Português (Portugal)' },
        { code: 'ro-RO', name: 'Română' },
        { code: 'ru-RU', name: 'Русский' },
        { code: 'sr-SP', name: 'Српски' },
        { code: 'sv-SE', name: 'Svenska' },
        { code: 'tr-TR', name: 'Türkçe' },
        { code: 'uk-UA', name: 'Українська' },
        { code: 'vi-VN', name: 'Tiếng Việt' },
        { code: 'zh-CN', name: '简体中文' },
        { code: 'zh-TW', name: '繁體中文' }
    ];

    var TV_LOCALE_KEY = 'vlctv_tv_locale_v1';   // last language tizen.systeminfo reported

    var english = {};
    var strings = {};
    var current = 'en';

    function readJson(path) {
        try {
            var x = new XMLHttpRequest();
            x.open('GET', path, false);
            x.send();
            // A packaged file reports status 0, a served one 200.
            if (x.status !== 0 && x.status !== 200) return {};
            var j = JSON.parse(x.responseText || '{}');
            return (j && typeof j === 'object') ? j : {};
        } catch (e) { return {}; }
    }

    /* Map whatever the TV or the setting says (nl, nl-NL, nl_NL, NL-nl) onto
     * a code from LANGUAGES: the exact locale first, then the first one for
     * the same language.  Unknown → English. */
    function match(code) {
        var c = String(code || '').replace('_', '-').toLowerCase();
        if (!c) return 'en';
        var lang = c.split('-')[0];
        var i;
        for (i = 0; i < LANGUAGES.length; i++)
            if (LANGUAGES[i].code.toLowerCase() === c) return LANGUAGES[i].code;
        // Norwegian arrives as nb/nn from most systems.
        if (lang === 'nb' || lang === 'nn') lang = 'no';
        for (i = 0; i < LANGUAGES.length; i++)
            if (LANGUAGES[i].code.toLowerCase().split('-')[0] === lang) return LANGUAGES[i].code;
        return 'en';
    }

    function explicitSetting() {
        return (typeof Settings !== 'undefined') ? Settings.get('uiLanguage') : '';
    }

    /* '' in the setting means "follow the TV".  What the TV reports through
     * tizen.systeminfo is remembered from the previous start (it only answers
     * asynchronously); before that, the WebView's navigator.language. */
    function chosen() {
        var s = explicitSetting();
        if (s) return match(s);
        var tv = '';
        try { tv = localStorage.getItem(TV_LOCALE_KEY) || ''; } catch (e) {}
        return match(tv || ((typeof navigator !== 'undefined') && (navigator.language || navigator.userLanguage)));
    }

    /* Ask the TV for its menu language.  If it differs from what this start
     * picked, remember it and reload once so the whole UI follows. */
    function followTvLocale() {
        if (explicitSetting()) return;
        if (typeof tizen === 'undefined' || !tizen.systeminfo) return;
        try {
            tizen.systeminfo.getPropertyValue('LOCALE', function (l) {
                var code = match(l && l.language);
                var stored = '';
                try { stored = localStorage.getItem(TV_LOCALE_KEY) || ''; } catch (e) {}
                if (l && l.language && l.language !== stored) {
                    try { localStorage.setItem(TV_LOCALE_KEY, l.language); } catch (e) {}
                    if (code !== current && typeof location !== 'undefined' && location.reload) location.reload();
                }
            }, function () {});
        } catch (e) {}
    }

    function load(code) {
        english = readJson(DIR + 'en.json');
        current = code;
        strings = code === 'en' ? english : readJson(DIR + code + '.json');
        if (typeof document !== 'undefined' && document.documentElement) {
            document.documentElement.lang = code;
            document.documentElement.dir = /^(ar|he)/.test(code) ? 'rtl' : 'ltr';
        }
    }

    /* t('smb.saved') / t('player.resumedFrom', '12:34'): {0}, {1} … are
     * replaced by the extra arguments, in order. */
    function t(key) {
        var s = Object.prototype.hasOwnProperty.call(strings, key) ? strings[key]
              : Object.prototype.hasOwnProperty.call(english, key) ? english[key]
              : key;
        if (arguments.length > 1) {
            var args = arguments;
            s = String(s).replace(/\{(\d+)\}/g, function (m, n) {
                var v = args[+n + 1];
                return v === undefined ? m : String(v);
            });
        }
        return s;
    }

    var ATTRS = [
        ['data-i18n-placeholder', 'placeholder'],
        ['data-i18n-title', 'title'],
        ['data-i18n-alt', 'alt'],
        ['data-i18n-aria-label', 'aria-label']
    ];

    /* "Or go to {0} and enter code {1}." with the slot elements put back in. */
    function fillTemplate(el) {
        var slots = {};
        var kids = el.querySelectorAll('[data-slot]');
        for (var k = 0; k < kids.length; k++) slots[kids[k].getAttribute('data-slot')] = kids[k];
        var parts = String(t(el.getAttribute('data-i18n-fmt'))).split(/\{(\d+)\}/);
        while (el.firstChild) el.removeChild(el.firstChild);
        for (var p = 0; p < parts.length; p++) {
            if (p % 2 === 0) { if (parts[p]) el.appendChild(document.createTextNode(parts[p])); }
            else if (slots[parts[p]]) el.appendChild(slots[parts[p]]);
        }
    }

    /* Fill in every data-i18n* attribute under root (default: the page). */
    function apply(root) {
        root = root || document;
        var fmts = root.querySelectorAll('[data-i18n-fmt]');
        for (var f = 0; f < fmts.length; f++) fillTemplate(fmts[f]);
        var els = root.querySelectorAll('[data-i18n]');
        for (var i = 0; i < els.length; i++) els[i].textContent = t(els[i].getAttribute('data-i18n'));
        for (var a = 0; a < ATTRS.length; a++) {
            var withAttr = root.querySelectorAll('[' + ATTRS[a][0] + ']');
            for (var j = 0; j < withAttr.length; j++)
                withAttr[j].setAttribute(ATTRS[a][1], t(withAttr[j].getAttribute(ATTRS[a][0])));
        }
    }

    /* Switching language rebuilds every string the scripts already put on
     * screen, so the simplest correct thing is a reload. */
    function setLanguage(code) {
        if (typeof Settings !== 'undefined') Settings.set('uiLanguage', code ? match(code) : '');
        if (typeof location !== 'undefined' && location.reload) location.reload();
    }

    function languageName(code) {
        for (var i = 0; i < LANGUAGES.length; i++) if (LANGUAGES[i].code === code) return LANGUAGES[i].name;
        return code;
    }

    load(chosen());
    followTvLocale();
    // This script sits at the end of <body>, so the markup is already there:
    // translate it now, before the scripts after this one start painting values.
    if (typeof document !== 'undefined' && document.querySelectorAll) apply(document);

    return {
        t: t,
        apply: apply,
        current: function () { return current; },
        languages: function () { return LANGUAGES.slice(); },
        languageName: languageName,
        setLanguage: setLanguage,
        match: match,
        // For the Node tests: swap in string tables without a WebView.
        _setTables: function (en, tr, code) { english = en || {}; strings = tr || english; current = code || 'en'; }
    };
})();

// Ignored by the Tizen/browser build; lets Node tests drive the module.
if (typeof module !== 'undefined' && module.exports) module.exports = I18n;
