'use strict';
// Setup-page logic. Plain fetch + DOM — no build step, served from the binary.

const $ = (id) => document.getElementById(id);
let anon = false;
let localRelay = false;
let adopt = true;
// The shares on this box: the first one has id "", added ones a short random
// id. `editing` is the one the form shows; "new" is a share not saved yet.
let shares = [];
let editing = '';

// Every /api endpoint except /api/hello and /api/status needs the pairing
// token. This page is served by the same box, so it just reads the token off
// /api/status like a TV would; see the note on guard() in server.go for what
// that check is and isn't worth.
let token = '';
let lastAdoptLeft = 0;   // so the switch can repaint the window line without a fetch
const api = (path) => path + (token ? (path.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(token) : '');

// Human labels for the read-only playback pills.  The formats are product
// names, the same in every language.
const SURROUND_LABEL = {
  off:  () => I18n.t('pb.surroundOff'),
  eac3: () => 'Dolby Digital Plus 5.1',
  ac3:  () => 'Dolby Digital 5.1',
};

function setMsg(text, kind) {
  const m = $('msg');
  m.textContent = text || '';
  m.className = 'msg' + (kind ? ' ' + kind : '');
}

function paintAnon() {
  $('anon').classList.toggle('on', anon);
  $('creds').style.opacity = anon ? .4 : 1;
}

function paintLocalRelay() {
  $('localrelay').classList.toggle('on', localRelay);
}

function paintAdopt() {
  $('adopt').classList.toggle('on', adopt);
}

// The share password is only on offer inside the window; say plainly whether a
// TV pairing right now would get it.
function paintAdoptWindow(secondsLeft) {
  const el = $('adopt-state');
  if (!adopt)          { el.textContent = I18n.t('adopt.off'); return; }
  if (secondsLeft <= 0) { el.textContent = I18n.t('adopt.closed'); return; }
  const mins = Math.ceil(secondsLeft / 60);
  el.textContent = mins === 1 ? I18n.t('adopt.openOne') : I18n.t('adopt.openMany', mins);
}

async function allowAdopt() {
  const r = await fetch(api('/api/allow-adopt'), { method: 'POST' });
  if (!r.ok) { setMsg(I18n.t('adopt.reopenFailed'), 'err'); return; }
  const j = await r.json();
  paintAdoptWindow(j.seconds || 0);
  setMsg(I18n.t('adopt.reopened'), 'ok');
}

// Format a UTC ISO timestamp as "just now / N min ago / today at HH:MM /
// YYYY-MM-DD HH:MM" depending on how recent it is.  Keeps the "last paired"
// line readable without bringing in a date library.
function formatAgo(iso) {
  if (!iso) return '';
  const t = new Date(iso);
  if (isNaN(t)) return '';
  const sec = Math.floor((Date.now() - t.getTime()) / 1000);
  if (sec < 60)             return I18n.t('ago.now');
  if (sec < 60 * 60)        return I18n.t('ago.minutes', Math.floor(sec / 60));
  // Today: same Y/M/D as now → show HH:MM
  const now = new Date();
  const sameDay =
    t.getFullYear() === now.getFullYear() &&
    t.getMonth()    === now.getMonth() &&
    t.getDate()     === now.getDate();
  const hhmm = String(t.getHours()).padStart(2,'0') + ':' + String(t.getMinutes()).padStart(2,'0');
  if (sameDay) return I18n.t('ago.today', hhmm);
  return t.toISOString().slice(0,10) + ' ' + hhmm;
}

async function loadStatus() {
  try {
    const s = await (await fetch('/api/status')).json();
    token = s.token || '';
    $('st-enc').textContent = s.encoder || '—';
    $('st-hw').textContent = s.hwaccel === 'none' ? I18n.t('status.software') : (s.hwaccel || '—');
    $('st-share').textContent = !s.configured ? I18n.t('status.notConfigured')
      : (s.shares && s.shares.length ? s.shares.join(', ') : s.share);
    $('pb-surround').textContent = (SURROUND_LABEL[s.surround] || SURROUND_LABEL.off)();
    $('pb-relay').textContent = I18n.t(s.localRelay ? 'pb.accepted' : 'pb.notAccepted');
    lastAdoptLeft = s.adoptLeft || 0;
    paintAdoptWindow(lastAdoptLeft);
    $('st-url').textContent = s.serverURL || '—';
    // The address to type on the TV when the LAN scan can't reach this box.
    $('pair-addr').textContent = s.serverURL ? s.serverURL.replace(/^https?:\/\//, '') : I18n.t('pair.thisAddress');
    $('hdot').style.background = s.configured ? 'var(--ok)' : 'var(--mut)';
    if (s.configured && s.serverURL && s.token) {
      $('testcard').style.display = '';
      $('testlink').textContent = s.serverURL + '/play?path=/Movies/YourFile.mkv&token=' + s.token;
    }
    // "Last paired" indicator — survives server restarts so the user doesn't
    // think they have to re-pair after every binary upgrade.
    const lp = s.lastPair;
    const lpEl = $('lastpair');
    if (lp && lp.code && lp.at) {
      lpEl.textContent = I18n.t('pair.last', lp.code, formatAgo(lp.at));
      lpEl.style.display = '';
    } else {
      lpEl.style.display = 'none';
    }
  } catch (e) { /* server starting */ }
}

async function pair() {
  const code = $('code').value.trim();
  if (!code) { $('pairmsg').textContent = I18n.t('pair.needCode'); $('pairmsg').className = 'msg err'; return; }
  $('pairmsg').textContent = I18n.t('pair.pairing'); $('pairmsg').className = 'msg';
  const res = await (await fetch(api('/api/pair'), {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  })).json();
  if (res.ok) {
    $('pairmsg').textContent = I18n.t('pair.sent', res.url);
    $('pairmsg').className = 'msg ok';
    // Pick up the freshly-saved lastPair without waiting for the 5 s poll.
    loadStatus();
  } else {
    $('pairmsg').textContent = I18n.t('pair.failed', res.error || I18n.t('common.unknown'));
    $('pairmsg').className = 'msg err';
  }
}

function shareLabel(s) { return s.host + '/' + s.share; }

// Fill the share picker and show `want` in the form (or the first share when
// `want` has gone, e.g. after removing it).
function paintShares(want) {
  const pick = $('share-pick');
  pick.innerHTML = '';
  const add = (value, text) => {
    const o = document.createElement('option');
    o.value = value; o.textContent = text;
    pick.appendChild(o);
  };
  shares.forEach((s) => add(s.id || '', shareLabel(s)));
  // With nothing saved yet the form simply is the first share.
  add(shares.length ? 'new' : '', I18n.t(shares.length ? 'smb.addShare' : 'smb.newShare'));
  editing = [...pick.options].some((o) => o.value === want) ? want : pick.options[0].value;
  pick.value = editing;
  fillForm(shares.find((s) => (s.id || '') === editing && editing !== 'new') || {});
  $('remove-share').style.display = shares.some((s) => (s.id || '') === editing) ? '' : 'none';
}

function fillForm(smb) {
  $('host').value = smb.host || '';
  $('port').value = smb.port || 445;
  $('share').value = smb.share || '';
  $('user').value = smb.user || '';
  $('domain').value = smb.domain || '';
  $('pass').value = '';
  anon = !!smb.anonymous;
  paintAnon();
}

async function loadConfig(want) {
  const c = await (await fetch(api('/api/config'))).json();
  const first = c.smb || c.SMB || {};
  shares = [first, ...(c.extra_smb || [])].filter((s) => s.host && s.share);
  paintShares(want === undefined ? editing : want);
  localRelay = !!c.local_relay;
  paintLocalRelay();
  adopt = c.share_credentials !== false;
  paintAdopt();
}

// Status carries the token, so it has to land before anything else is fetched.
async function boot() {
  await I18n.init($('lang'));
  await loadStatus();
  await loadConfig();
  setInterval(loadStatus, 5000);
}

function readForm() {
  return {
    id: editing,
    host: $('host').value.trim(),
    port: parseInt($('port').value, 10) || 445,
    share: $('share').value.trim(),
    user: $('user').value.trim(),
    pass: $('pass').value,        // blank = keep stored
    domain: $('domain').value.trim(),
    anonymous: anon,
    share_credentials: adopt,
  };
}

async function postConfig(body) {
  return fetch(api('/api/config'), {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// Resolves true once the share is saved, so Test and Browse can go on to use it.
async function save() {
  const r = await postConfig(readForm());
  if (!r.ok) {
    setMsg(r.status === 409 ? I18n.t('smb.duplicate') : I18n.t('common.saveFailed'), 'err');
    return false;
  }
  const j = await r.json();
  setMsg(I18n.t('common.saved'), 'ok');
  await loadConfig(j.id || '');
  loadStatus();
  return true;
}

async function removeShare() {
  const s = shares.find((x) => (x.id || '') === editing);
  if (!s || !confirm(I18n.t('smb.removeConfirm', shareLabel(s)))) return;
  const r = await postConfig({ remove_share: editing });
  if (!r.ok) { setMsg(I18n.t('common.saveFailed'), 'err'); return; }
  setMsg(I18n.t('smb.removed', shareLabel(s)), 'ok');
  $('list').innerHTML = '';
  await loadConfig('');
  loadStatus();
}

// Posts only the relay permission — the server applies just the keys it's sent,
// so this can't disturb the share settings sitting in the form above.
async function savePlayback() {
  const m = $('pbmsg');
  const r = await postConfig({ local_relay: localRelay });
  if (r.ok) {
    m.textContent = I18n.t(localRelay ? 'pb.relaySaved' : 'pb.relayRevoked');
    m.className = 'msg ok';
    loadStatus();
  } else {
    m.textContent = I18n.t('common.saveFailed');
    m.className = 'msg err';
  }
}

async function test() {
  setMsg(I18n.t('smb.testing'));
  if (!await save()) return;
  const res = await (await fetch(api('/api/test?id=' + encodeURIComponent(editing)), { method: 'POST' })).json();
  if (res.ok) setMsg(I18n.t('smb.connected'), 'ok');
  else setMsg(I18n.t('smb.connectFailed', res.error || I18n.t('common.unknown')), 'err');
}

// Ask the server in the form which shares it offers and list them to pick
// from — with the form's settings, so it works before anything is saved.
async function findShares() {
  const f = readForm();
  if (!f.host) { setMsg(I18n.t('smb.hostFirst'), 'err'); return; }
  setMsg(I18n.t('smb.findingShares'));
  const ul = $('list');
  ul.innerHTML = '';
  const res = await (await fetch(api('/api/shares'), {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(f),
  })).json();
  if (!res.ok) { setMsg(I18n.t('smb.sharesFailed', res.error || I18n.t('common.unknown')), 'err'); return; }
  const shares = res.shares || [];
  if (!shares.length) { setMsg(I18n.t('smb.noShares'), 'err'); return; }
  setMsg(I18n.t('smb.pickShare'), 'ok');
  shares.forEach((name) => {
    const li = document.createElement('li');
    li.style.cursor = 'pointer'; li.style.padding = '4px 0';
    li.textContent = '📂 ' + name;
    li.onclick = () => { $('share').value = name; ul.innerHTML = ''; setMsg(''); };
    ul.appendChild(li);
  });
}

async function browse(path) {
  setMsg(path ? I18n.t('smb.loadingPath', path) : I18n.t('smb.loadingRoot'));
  const res = await (await fetch(api('/api/browse?id=' + encodeURIComponent(editing) +
    '&path=' + encodeURIComponent(path || '')))).json();
  const ul = $('list');
  ul.innerHTML = '';
  if (!res.ok) { setMsg(I18n.t('smb.browseFailed', res.error || I18n.t('common.unknown')), 'err'); return; }
  setMsg('');
  if (path) {
    const up = document.createElement('li');
    up.textContent = '↩ ..';
    up.style.cursor = 'pointer'; up.style.padding = '4px 0';
    up.onclick = () => browse(path.split('/').slice(0, -1).join('/'));
    ul.appendChild(up);
  }
  (res.entries || []).forEach((e) => {
    const li = document.createElement('li');
    li.style.padding = '4px 0';
    li.textContent = (e.isDir ? '📁 ' : '🎬 ') + e.name;
    if (e.isDir) {
      li.style.cursor = 'pointer';
      li.onclick = () => browse((path ? path + '/' : '') + e.name);
    } else {
      li.style.color = 'var(--mut)';
    }
    ul.appendChild(li);
  });
}

$('anon').onclick = () => { anon = !anon; paintAnon(); };
$('localrelay').onclick = () => { localRelay = !localRelay; paintLocalRelay(); };
$('adopt').onclick = () => { adopt = !adopt; paintAdopt(); paintAdoptWindow(lastAdoptLeft); };
$('allow-adopt').onclick = allowAdopt;
$('save-playback').onclick = savePlayback;
$('save').onclick = save;
$('test').onclick = test;
$('find-shares').onclick = findShares;
$('browse').onclick = async () => { if (await save()) browse(''); };
$('share-pick').onchange = () => { $('list').innerHTML = ''; setMsg(''); paintShares($('share-pick').value); };
$('remove-share').onclick = removeShare;
$('pair').onclick = pair;

boot();
