'use strict';
// Setup-page strings, looked up by key — the same scheme as the TV app's
// tizen-app/js/i18n.js.  i18n/en.json is the English source every translation works
// from; each translation is i18n/<locale>.json and carries only what has been
// translated, so a key it lacks falls back to English.
//
// Markup uses data-i18n (text), data-i18n-placeholder and data-i18n-fmt: a
// sentence with elements inside keeps its children marked data-slot="0", "1" …
// and puts them where the translation has {0}, {1}.  Everything is set as
// text, never as HTML.

const I18n = (() => {
  // Same list as the TV app, so a language offered there is offered here.
  const LANGUAGES = [
    ['en', 'English'], ['af-ZA', 'Afrikaans'], ['ar-SA', 'العربية'], ['ca-ES', 'Català'],
    ['cs-CZ', 'Čeština'], ['da-DK', 'Dansk'], ['de-DE', 'Deutsch'], ['el-GR', 'Ελληνικά'],
    ['es-ES', 'Español'], ['fi-FI', 'Suomi'], ['fr-FR', 'Français'], ['he-IL', 'עברית'],
    ['hu-HU', 'Magyar'], ['it-IT', 'Italiano'], ['ja-JP', '日本語'], ['ko-KR', '한국어'],
    ['nl-NL', 'Nederlands'], ['no-NO', 'Norsk'], ['pl-PL', 'Polski'], ['pt-BR', 'Português (Brasil)'],
    ['pt-PT', 'Português (Portugal)'], ['ro-RO', 'Română'], ['ru-RU', 'Русский'], ['sr-SP', 'Српски'],
    ['sv-SE', 'Svenska'], ['tr-TR', 'Türkçe'], ['uk-UA', 'Українська'], ['vi-VN', 'Tiếng Việt'],
    ['zh-CN', '简体中文'], ['zh-TW', '繁體中文'],
  ];
  const STORE_KEY = 'tessel_setup_lang';

  let english = {};
  let strings = {};
  let current = 'en';

  async function readJson(path) {
    try {
      const r = await fetch(path);
      return r.ok ? await r.json() : {};
    } catch (e) { return {}; }
  }

  // nl, nl-NL, nl_BE → nl-NL: the exact locale first, then the first one for
  // the same language.  Unknown → English.
  function match(code) {
    const c = String(code || '').replace('_', '-').toLowerCase();
    if (!c) return 'en';
    let lang = c.split('-')[0];
    const exact = LANGUAGES.find(([k]) => k.toLowerCase() === c);
    if (exact) return exact[0];
    if (lang === 'nb' || lang === 'nn') lang = 'no';
    const same = LANGUAGES.find(([k]) => k.toLowerCase().split('-')[0] === lang);
    return same ? same[0] : 'en';
  }

  function t(key, ...args) {
    const s = key in strings ? strings[key] : key in english ? english[key] : key;
    return String(s).replace(/\{(\d+)\}/g, (m, n) => (args[n] === undefined ? m : String(args[n])));
  }

  function fillTemplate(el) {
    const slots = {};
    el.querySelectorAll('[data-slot]').forEach((k) => { slots[k.dataset.slot] = k; });
    const parts = t(el.dataset.i18nFmt).split(/\{(\d+)\}/);
    el.replaceChildren();
    parts.forEach((p, i) => {
      if (i % 2 === 0) { if (p) el.append(p); }
      else if (slots[p]) el.append(slots[p]);
    });
  }

  function apply(root = document) {
    root.querySelectorAll('[data-i18n-fmt]').forEach(fillTemplate);
    root.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n); });
    root.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
      el.placeholder = t(el.dataset.i18nPlaceholder);
    });
    document.title = t('page.title');
  }

  function chosen() {
    let saved = '';
    try { saved = localStorage.getItem(STORE_KEY) || ''; } catch (e) {}
    return match(saved || (navigator.languages && navigator.languages[0]) || navigator.language);
  }

  async function load(code) {
    english = await readJson('i18n/en.json');
    strings = code === 'en' ? english : await readJson('i18n/' + code + '.json');
    current = code;
    document.documentElement.lang = code;
    document.documentElement.dir = /^(ar|he)/.test(code) ? 'rtl' : 'ltr';
  }

  // Fill the language menu and switch on change.  The page's own values
  // (status pills, messages) are painted from t() by app.js, so a switch
  // reloads rather than trying to repaint every one of them.
  function wireMenu(select) {
    if (!select) return;
    LANGUAGES.forEach(([code, name]) => select.add(new Option(name, code, false, code === current)));
    select.onchange = () => {
      try { localStorage.setItem(STORE_KEY, select.value); } catch (e) {}
      location.reload();
    };
  }

  async function init(select) {
    await load(chosen());
    apply();
    wireMenu(select);
  }

  return { t, apply, init, match, current: () => current };
})();
