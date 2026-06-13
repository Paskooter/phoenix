// Phoenix portal — vanilla SPA. Hash routes: #/ (auth or dashboard), #/add, #/admin.
// Talks to the same-origin REST face (session cookie). QR rendered by the vendored qr.js.

import { qrSvg } from '/qr.js';

const app = document.getElementById('app');
const nav = document.getElementById('nav');
const who = document.getElementById('who');
const api = async (method, path, body) => {
  const res = await fetch(path, {
    method, headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
};
const tpl = (id) => document.getElementById(id).content.cloneNode(true);
const show = (frag) => { app.replaceChildren(frag); };

let me = null;

async function refreshMe() {
  const r = await api('GET', '/api/me');
  me = r.ok ? r.data.account : null;
  nav.hidden = !me;
  if (me) who.textContent = me.firstName || me.email;
}

document.getElementById('logout').addEventListener('click', async () => {
  await api('POST', '/api/logout');
  me = null; location.hash = '#/'; route();
});

// -- auth ---------------------------------------------------------------------

function renderAuth() {
  show(tpl('tpl-auth')); // insert first, then bind against the live DOM
  let mode = 'login';
  const form = document.getElementById('auth-form');
  const submit = document.getElementById('auth-submit');
  const err = document.getElementById('auth-error');
  const signupOnly = app.querySelector('.signup-only');

  app.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => {
    mode = t.dataset.tab;
    app.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x.dataset.tab === mode));
    signupOnly.hidden = mode !== 'signup';
    submit.textContent = mode === 'signup' ? 'Sign up' : 'Log in';
    err.hidden = true;
  }));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(form));
    const r = await api('POST', mode === 'signup' ? '/api/signup' : '/api/login', fd);
    if (!r.ok) { err.hidden = false; err.textContent = r.data.error || 'failed'; return; }
    await refreshMe(); location.hash = '#/'; route();
  });
}

// -- dashboard ----------------------------------------------------------------

async function renderDashboard() {
  show(tpl('tpl-dashboard'));
  document.getElementById('add-robot').addEventListener('click', () => { location.hash = '#/add'; });
  document.getElementById('go-settings').addEventListener('click', () => { location.hash = '#/settings'; });
  const r = await api('GET', '/api/robots');
  const list = document.getElementById('robot-list');
  const empty = app.querySelector('.empty');
  if (!r.ok) { empty.hidden = false; empty.textContent = 'Could not load robots.'; return; }
  if (!r.data.length) { empty.hidden = false; return; }
  for (const robot of r.data) {
    const li = document.createElement('li');
    li.innerHTML = `<span class="dot"></span><span class="name"></span><span class="muted loop"></span>`;
    li.querySelector('.name').textContent = robot.friendlyId;
    li.querySelector('.loop').textContent = robot.loopName || '';
    list.appendChild(li);
  }
}

// -- add robot ----------------------------------------------------------------

let pollTimer = null;
function renderAdd() {
  show(tpl('tpl-add'));
  document.getElementById('add-back').addEventListener('click', () => { stopPoll(); location.hash = '#/'; });
  const form = document.getElementById('wifi-form');
  const err = document.getElementById('wifi-error');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(form));
    const staticConfig = (fd.ip || fd.netmask || fd.gateway) ? { ip: fd.ip, netmask: fd.netmask, gateway: fd.gateway, dns1: fd.dns1, dns2: fd.dns2 } : null;
    const r = await api('POST', '/api/robots/setup', { ssid: fd.ssid, password: fd.password, static: staticConfig });
    if (!r.ok) { err.hidden = false; err.textContent = r.data.error || 'failed'; return; }
    renderQr(r.data);
  });
}

function renderQr({ token, qr }) {
  document.getElementById('wifi-form').hidden = true;
  const stage = document.getElementById('qr-stage');
  stage.hidden = false;
  const codes = document.getElementById('qr-codes');
  codes.innerHTML = qr.codes.map((c) => qrSvg(c, 6)).join('');
  const status = document.getElementById('qr-status');
  startPoll(token, status);
}

function startPoll(token, statusEl) {
  stopPoll();
  pollTimer = setInterval(async () => {
    const r = await api('GET', `/api/robots/setup/status?token=${encodeURIComponent(token)}`);
    if (r.ok && r.data.complete) {
      stopPoll();
      statusEl.textContent = '✅ Jibo is set up! Returning to your robots…';
      statusEl.style.color = 'var(--ok)';
      setTimeout(() => { location.hash = '#/'; route(); }, 1500);
    }
  }, 2000);
}
function stopPoll() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }

// -- personal report settings -------------------------------------------------

async function renderSettings() {
  show(tpl('tpl-settings'));
  document.getElementById('settings-back').addEventListener('click', () => { location.hash = '#/'; });
  const form = document.getElementById('settings-form');
  const status = document.getElementById('settings-status');
  const el = (n) => form.elements[n];

  const r = await api('GET', '/api/settings');
  if (!r.ok) { status.hidden = false; status.textContent = 'Could not load settings.'; return; }
  const s = r.data.settings;
  el('weather').checked = s.weather.active;
  el('units').value = s.weather.celsius ? 'c' : 'f';
  el('news').checked = s.news.active;
  el('calendar').checked = s.calendar.active;
  el('commute').checked = s.commute.active;
  el('home_lat').value = s.commute.home.lat ?? '';
  el('home_lng').value = s.commute.home.lng ?? '';
  el('work_lat').value = s.commute.work.lat ?? '';
  el('work_lng').value = s.commute.work.lng ?? '';
  el('mode').value = s.commute.mode || 'driving';

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const num = (n) => (el(n).value === '' ? null : Number(el(n).value));
    const body = {
      weather: { active: el('weather').checked, celsius: el('units').value === 'c' },
      news: { active: el('news').checked },
      calendar: { active: el('calendar').checked },
      commute: {
        active: el('commute').checked,
        home: { lat: num('home_lat'), lng: num('home_lng') },
        work: { lat: num('work_lat'), lng: num('work_lng') },
        mode: el('mode').value,
      },
    };
    const put = await api('PUT', '/api/settings', body);
    status.hidden = false;
    status.textContent = put.ok ? '✅ Saved.' : (put.data.error || 'Save failed');
    status.style.color = put.ok ? 'var(--ok)' : 'var(--error)';
  });
}

// -- admin --------------------------------------------------------------------

async function renderAdmin() {
  show(tpl('tpl-admin'));
  const loginForm = document.getElementById('admin-login');
  const panel = document.getElementById('admin-panel');
  const err = document.getElementById('admin-error');

  const enter = async () => {
    const rows = document.getElementById('admin-rows');
    const r = await api('GET', '/api/admin/robots');
    if (!r.ok) return false;
    loginForm.hidden = true; panel.hidden = false;
    rows.replaceChildren(...r.data.map((rb) => {
      const tr = document.createElement('tr');
      const cells = [rb.friendlyId, rb.ownerEmail || '—', rb.loopName || '—', rb.accessKeyId, rb.lastSeen ? new Date(rb.lastSeen).toLocaleString() : 'never'];
      cells.forEach((c) => { const td = document.createElement('td'); td.textContent = c; tr.appendChild(td); });
      return tr;
    }));
    return true;
  };

  if (!(await enter())) {
    loginForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const r = await api('POST', '/api/admin/login', Object.fromEntries(new FormData(loginForm)));
      if (!r.ok) { err.hidden = false; err.textContent = r.data.error || 'wrong password'; return; }
      await enter();
    });
  }

  document.getElementById('adopt-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(e.target));
    const r = await api('POST', '/api/admin/adopt', { friendlyId: fd.friendlyId, ownerEmail: fd.ownerEmail || undefined });
    const out = document.getElementById('adopt-result');
    out.hidden = false;
    if (!r.ok) { out.textContent = `Error: ${r.data.error}`; return; }
    out.textContent = [
      '# Write this to /var/jibo/credentials.json on the robot:',
      JSON.stringify(r.data.credentialsJson, null, 2),
      '', '# Then point the robot at this server:',
      ...r.data.instructions,
    ].join('\n');
    await enter();
  });
}

// -- router -------------------------------------------------------------------

async function route() {
  const hash = location.hash || '#/';
  if (hash.startsWith('#/admin')) return renderAdmin();
  await refreshMe();
  if (!me) return renderAuth();
  if (hash.startsWith('#/add')) return renderAdd();
  if (hash.startsWith('#/settings')) return renderSettings();
  return renderDashboard();
}

window.addEventListener('hashchange', () => { stopPoll(); route(); });
route();
