// Phoenix portal — vanilla SPA. Hash routes: #/, #/loop, #/settings, #/profile, #/robot,
// #/gallery, #/messaging, #/system (+ #/add for QR pairing, #/admin). Talks to the same-origin
// REST face (session cookie) that the original portal used. QR rendered by the vendored qr.js.

import { qrSvg } from '/qr.js';
import { createLocationPicker } from '/map.js';

const app = document.getElementById('app');
const sidebar = document.getElementById('sidebar');
const whoBox = document.getElementById('who-box');
const who = document.getElementById('who');

const api = async (method, path, body) => {
  const res = await fetch(path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
};

// -- tiny element builder -----------------------------------------------------
const h = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k === 'on') for (const [ev, fn] of Object.entries(v)) el.addEventListener(ev, fn);
    else if (typeof v === 'boolean' && ['checked', 'selected', 'disabled', 'required'].includes(k)) {
      if (v) el.setAttribute(k, ''); else el.removeAttribute(k);
    }
    else if (k === 'hidden') el.hidden = v;
    else if (k.startsWith('data-')) el.setAttribute(k, v);
    else el.setAttribute(k, v);
  }
  for (const kid of kids.flat()) {
    if (kid == null) continue;
    el.appendChild(typeof kid === 'string' ? document.createTextNode(kid) : kid);
  }
  return el;
};
const text = (s) => document.createTextNode(s == null ? '' : String(s));

const show = (frag) => { app.replaceChildren(frag); };
const empty = () => h('p', { class: 'muted' }, 'Nothing here yet.');

const fmtDate = (v) => (v ? new Date(v).toLocaleString() : '—');
const fmtBool = (v) => (v ? 'yes' : 'no');
const row = (left, right) => h('div', { class: 'kv' }, h('span', { class: 'k' }, left), h('span', { class: 'v' }, right));
const panel = (...kids) => h('section', { class: 'card' }, h('h2', { class: 'sr-only' }, ''), ...kids);
const errP = (msg) => h('p', { class: 'error' }, msg);

// -- controls -----------------------------------------------------------------
// A bare <input type=checkbox> is unreadable at a glance and unpleasant to hit on
// a phone, and these are settings a household toggles, not a form they fill in.
// Both helpers keep the same `name` and checked semantics, so FormData still
// reads them exactly as before — only the presentation changes.

/** A labelled toggle. `hint` explains the setting under its name. */
const toggle = (name, checked, label, hint) => {
  const input = h('input', { type: 'checkbox', name, checked: !!checked });
  const el = h('label', { class: 'switch' },
    input,
    h('span', { class: 'track' }),
    h('span', { class: 'switch-text' },
      h('span', {}, label),
      hint ? h('span', { class: 'switch-hint' }, hint) : null));
  // Grey the rest of the group out while the setting is off, so the page shows
  // what is actually in effect instead of a wall of equally-live controls.
  const sync = () => {
    const group = el.closest('fieldset');
    if (group) group.classList.toggle('group-off', !input.checked);
  };
  input.addEventListener('change', sync);
  queueMicrotask(sync);
  return el;
};

/** A pill for multi-select lists (news categories, calendars, media selection). */
const chip = (name, checked, label) => h(
  'label', { class: 'chip' },
  h('input', { type: 'checkbox', name, checked: !!checked }),
  h('span', { class: 'chip-mark' }),
  h('span', {}, label),
);

/** Sentence-case a source key like `googleWork` or `top_stories`. */
const prettyLabel = (key) => String(key)
  .replace(/[_-]+/g, ' ')
  .replace(/([a-z\d])([A-Z])/g, '$1 $2')
  .replace(/^./, (c) => c.toUpperCase());

let me = null;

async function refreshMe() {
  const r = await api('GET', '/api/me');
  me = r.ok ? r.data.account : null;
  sidebar.hidden = !me;
  whoBox.hidden = !me;
  if (me) who.textContent = me.firstName || me.email;
}

function requireLogin() {
  if (!me) { location.hash = '#/'; route(); return false; }
  return true;
}

function topBar() {
  return h('div', { class: 'section-head' },
    h('p', { class: 'muted' }, 'Choose an area on the left.'));
}

// ============================================================================
// Members / loop surface
// ============================================================================

function memberRow(member, loop, opts = {}) {
  const isOwner = loop.owner === (me && me.id);
  const linked = member.account;
  const nameParts = [member.memberProperties?.firstName, member.memberProperties?.lastName]
    .filter(Boolean).join(' ') || (linked && [linked.firstName, linked.lastName].filter(Boolean).join(' ')) || '(no name)';
  const statusBadge = h('span', { class: `status status-${member.status || 'invited'}` }, member.status || 'invited');

  const linkedNote = linked
    ? h('span', { class: 'muted' }, `\u2192 ${linked.email}${linked.isActive ? '' : ' (inactive)'}`)
    // Say what the consequence is, not just the state: an unlinked member is why
    // the report skill answers "I had trouble fetching your personal settings".
    : h('span', { class: 'member-unlinked-note' }, 'No account linked \u2014 Jibo cannot load their personal report');

  const actions = [];
  if (opts.onLink) {
    actions.push(h('button', { class: 'link', on: { click: opts.onLink } }, linked ? 'Unlink' : 'Link account'));
  }
  if (opts.onEdit) {
    actions.push(h('button', { class: 'link', on: { click: opts.onEdit } }, 'Edit'));
  }
  if (isOwner && opts.onRemove) {
    actions.push(h('button', { class: 'link danger', on: { click: opts.onRemove } }, 'Remove'));
  }

  const bus = h('div', { class: 'member' },
    h('div', { class: 'member-name' }, nameParts, ' ', statusBadge),
    h('div', { class: 'kv' },
      h('span', { class: 'k' }, 'Account'),
      h('span', { class: 'v' }, linked ? `${linked.email} (${member.accountId})` : (member.accountId || 'none'))),
    h('div', { class: 'kv' },
      h('span', { class: 'k' }, 'Enrolled'),
      h('span', { class: 'v' }, `face ${fmtBool(member.enrolled?.face)} · voice ${fmtBool(member.enrolled?.voice)}`)),
    linkedNote,
    h('div', { class: 'member-actions' }, ...actions));

  return bus;
}

function enrollmentControl(member, loop, onChange) {
  const on = (field) => async (e) => {
    const r = await api('POST', '/api/loop/members/enrollment', {
      loopId: loop.id, id: member.id, [field]: e.target.checked,
    });
    if (r.ok) { notify('Enrollment saved'); if (onChange) onChange(); }
    else notify(r.data.error || 'failed', 'error');
  };
  const enrolChip = (kind, label) => h('label', { class: 'chip' },
    h('input', { type: 'checkbox', checked: !!member.enrolled?.[kind], on: { change: on(kind) } }),
    h('span', { class: 'chip-mark' }), h('span', {}, label));
  return h('div', { class: 'enroll' }, enrolChip('face', 'Face'), enrolChip('voice', 'Voice'));
}

async function renderLoop() {
  if (!requireLogin()) return;
  const container = h('div', {}, h('h2', {}, 'Loop & members'), topBar(), h('p', { class: 'muted' }, 'Loading…'));
  show(container);

  const r = await api('GET', '/api/loop');
  container.replaceChildren(h('h2', {}, 'Loop & people'), topBar());
  if (!r.ok) { container.appendChild(errP(r.data.error || 'Could not load loop')); return; }
  const loops = r.data.loops || [];

  // loop selector (usually exactly one)
  const active = loops.length ? loops[0] : null;
  if (loops.length > 1) {
    const sel = h('select', { on: { change: (e) => pickLoop(e.target.value) } });
    loops.forEach((l) => sel.appendChild(h('option', { value: l.id }, l.name)));
    container.appendChild(h('label', { class: 'sub' }, 'Loop', sel));
  }
  if (!active) { container.appendChild(empty()); return; }

  // loop record card
  const loopCard = h('section', { class: 'card' },
    h('h3', {}, active.name),
    row('Loop ID', active.id),
    row('Owner', active.owner),
    row('Robot', active.robotFriendlyId || 'none'),
    row('Status', active.isSuspended ? h('span', { class: 'warn' }, 'Suspended') : 'Active'),
    h('form', { class: 'row', on: { submit: renameLoop } },
      h('input', { name: 'name', value: active.name, required: true }),
      h('button', { type: 'submit', class: 'primary' }, 'Rename')));

  const suspendBtn = h('button', { class: 'link danger', on: { click: suspendLoop } },
    active.isSuspended ? 'Un-suspend loop' : 'Suspend loop');
  loopCard.appendChild(h('div', { class: 'row' }, suspendBtn));

  // invite form
  const inviteForm = h('form', { class: 'invite-form', on: { submit: inviteMember } },
    h('label', { class: 'sub' }, 'Email', h('input', { name: 'email', type: 'email' })),
    h('label', { class: 'sub' }, 'First name', h('input', { name: 'firstName' })),
    h('label', { class: 'sub' }, 'Last name', h('input', { name: 'lastName' })),
    h('button', { type: 'submit', class: 'primary' }, 'Invite member'));

  const linkPicker = h('div', { class: 'link-picker' },
    h('input', { name: 'email', placeholder: 'search accounts by email…', on: { input: debounce(searchAccounts, 250) } }),
    h('div', { class: 'link-results' }));

  const membersCard = h('section', { class: 'card' },
    h('h3', {}, `Members (${active.members.length})`),
    h('p', { class: 'muted' }, 'Link each member to their account — that is what lets Jibo fetch their personal report.'),
    h('div', { class: 'member-link-tool' }, linkPicker),
    h('div', { class: 'member-list' }),
    h('h3', {}, 'Invite a member'),
    inviteForm);

  loopCard.appendChild(active.isSuspended ? h('p', { class: 'warn' }, 'This loop is suspended — member edits are blocked.') : h('div', {}));
  container.appendChild(loopCard);
  container.appendChild(membersCard);

  const listEl = membersCard.querySelector('.member-list');
  const state = { picker: null, editId: null };

  function buildMemberBlock(m) {
    const children = [memberRow(m, active, {
      onEdit: () => { state.editId = state.editId === m.id ? null : m.id; renderMemberList(); },
      onRemove: () => removeMember(m),
      onLink: () => toggleLink(m),
    }), enrollmentControl(m, active, () => reloadLoop())];
    if (state.editId === m.id) {
      const form = h('form', { class: 'edit-member', on: { submit: async (e) => {
        e.preventDefault();
        const fd = Object.fromEntries(new FormData(form));
        const payload = { loopId: active.id, id: m.id, nickname: fd.nickname || null, phoneticName: fd.phoneticName || null };
        const r = await api('POST', '/api/loop/members/nickname', payload);
        const rp = await api('POST', '/api/loop/members/phonetic', payload);
        if (r.ok && rp.ok) { notify('Saved'); state.editId = null; await reloadLoop(); }
        else notify(r.data.error || rp.data.error || 'failed', 'error');
      } } },
        h('label', { class: 'sub' }, 'Nickname', h('input', { name: 'nickname', value: m.nickname || '' })),
        h('label', { class: 'sub' }, 'Phonetic name', h('input', { name: 'phoneticName', value: m.phoneticName || '' })),
        h('button', { type: 'submit', class: 'primary' }, 'Save'),
        h('button', { type: 'button', class: 'link', on: { click: () => { state.editId = null; renderMemberList(); } } }, 'Close'));
      children.unshift(form);
    }
    return h('div', { class: `member-block${m.account ? '' : ' unlinked'}`, 'data-member': m.id }, ...children);
  }

  function renderMemberList() {
    // Members needing an account link come first: they are the actionable ones,
    // and on a 12-person household they were otherwise scattered down the page.
    const ordered = [...active.members].sort((a, b) => Number(!!a.account) - Number(!!b.account));
    const grid = h('div', { class: 'member-grid' }, ...ordered.map(buildMemberBlock));
    listEl.replaceChildren(grid);
  }
  renderMemberList();

  async function toggleLink(m) {
    if (m.account) {
      const r = await api('POST', '/api/loop/members/unlink', { loopId: active.id, id: m.id });
      if (r.ok) { notify('Unlinked'); await reloadLoop(); } else notify(r.data.error || 'failed', 'error');
      return;
    }
    if (!state.picker) { notify('Pick an account first (search above).', 'error'); return; }
    const r = await api('POST', '/api/loop/members/link', { loopId: active.id, id: m.id, accountId: state.picker.id });
    if (r.ok) { notify(`Linked to ${state.picker.email}`); await reloadLoop(); }
    else notify(r.data.error || 'failed', 'error');
  }

  async function removeMember(m) {
    if (!confirm(`Remove ${m.memberProperties?.firstName || m.id} from the loop?`)) return;
    const r = await api('POST', '/api/loop/members/remove', { loopId: active.id, id: m.id });
    if (r.ok) { notify('Removed'); await reloadLoop(); } else notify(r.data.error || 'failed', 'error');
  }

  async function renameLoop(e) {
    e.preventDefault();
    const name = new FormData(e.target).get('name');
    const r = await api('PUT', '/api/loop', { loopId: active.id, name });
    if (r.ok) { notify('Renamed'); await reloadLoop(); } else notify(r.data.error || 'failed', 'error');
  }

  async function suspendLoop() {
    const endpoint = active.isSuspended ? 'unsuspend' : 'suspend';
    const r = await api('POST', `/api/loop/${endpoint}`, { loopId: active.id });
    if (r.ok) { notify(active.isSuspended ? 'Un-suspended' : 'Suspended'); await reloadLoop(); }
    else notify(r.data.error || 'failed', 'error');
  }

  async function inviteMember(e) {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(e.target));
    const payload = { loopId: active.id };
    for (const k of ['email', 'firstName', 'lastName']) if (fd[k]) payload[k] = fd[k];
    const r = await api('POST', '/api/loop/invite', payload);
    if (r.ok) { notify('Invitation sent'); await reloadLoop(); }
    else notify(r.data.error || 'failed', 'error');
  }

  async function searchAccounts(ev) {
    const term = ev.target.value.trim();
    const res = await api('GET', `/api/accounts/search?email=${encodeURIComponent(term)}`);
    const box = membersCard.querySelector('.link-results');
    if (!box) return;
    if (!res.ok) { box.replaceChildren(); return; }
    box.replaceChildren(...res.data.accounts.slice(0, 8).map((a) =>
      h('button', { type: 'button', class: 'link account-opt', on: { click: () => {
        state.picker = a;
        ev.target.value = `${a.email}`;
        box.replaceChildren(h('span', { class: 'muted' }, `→ will link to ${a.email}`));
      } } }, `${a.email}${a.firstName ? ' (' + a.firstName + ')' : ''}`)));
  }

  async function reloadLoop() { await renderLoop(); }

  async function pickLoop() {
    await renderLoop();
  }
}

let notifyTimer = null;
function notify(msg, kind = 'ok') {
  let el = document.getElementById('toast');
  if (!el) { el = document.createElement('div'); el.id = 'toast'; document.body.appendChild(el); }
  el.textContent = msg;
  el.className = `toast ${kind}`;
  clearTimeout(notifyTimer);
  notifyTimer = setTimeout(() => { el.remove(); }, 3000);
}

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

// ============================================================================
// Settings (personal report)
// ============================================================================

async function renderSettings() {
  if (!requireLogin()) return;
  const container = h('div', {}, h('h2', {}, 'Personal report'), topBar(), h('p', { class: 'muted' }, 'Loading…'));
  show(container);
  const r = await api('GET', '/api/settings');
  container.replaceChildren(h('h2', {}, 'Personal report'));
  if (!r.ok) { container.appendChild(errP(r.data.error || 'Could not load settings')); return; }
  const s = r.data.settings;

  const form = h('form', { class: 'settings-form', on: { submit: save } });

  const weather = h('fieldset', {},
    h('legend', {}, 'Weather'),
    toggle('weather', s.weather.active, 'Include weather', 'Jibo opens the report with today\u2019s forecast.'),
    h('label', { class: 'sub' }, h('span', { class: 'field-label' }, 'Units'),
      h('select', { name: 'units' },
        h('option', { value: 'f', selected: !s.weather.celsius }, 'Fahrenheit'),
        h('option', { value: 'c', selected: s.weather.celsius }, 'Celsius'))));

  const news = h('fieldset', {},
    h('legend', {}, 'News'),
    toggle('news', s.news.active, 'Read the news', 'Pick the categories Jibo should cover.'),
    h('div', { class: 'chips' },
      Object.entries(s.news.categories).map(([cat, on]) => chip(`news_${cat}`, on, prettyLabel(cat)))));

  // Commute used to be four bare number fields — home lat, home lng, work lat,
  // work lng. Nobody knows their coordinates, so the setting was effectively
  // unusable. The picker keeps the same submitted values and lets you point at a
  // map instead; the manual fields are still there, folded away, for when the
  // tiles cannot be reached.
  const picker = createLocationPicker({
    places: [
      { key: 'home', label: 'Home', point: s.commute.home || {} },
      { key: 'work', label: 'Work', point: s.commute.work || {} },
    ],
  });

  const commute = h('fieldset', {},
    h('legend', {}, 'Commute'),
    toggle('commute', s.commute.active, 'Give commute directions', 'How long it takes to get from home to work.'),
    h('label', { class: 'sub' }, h('span', { class: 'field-label' }, 'Travel mode'),
      h('select', { name: 'mode' },
        [['driving', 'Driving'], ['walking', 'Walking'], ['bicycling', 'Cycling'], ['transit', 'Public transit']]
          .map(([value, label]) => h('option', { value, selected: s.commute.mode === value }, label)))),
    picker.element);

  const calendar = h('fieldset', {},
    h('legend', {}, 'Calendar'),
    toggle('calendar', s.calendar.active, 'Read your calendar', 'Which calendars Jibo may look at.'),
    h('div', { class: 'chips' },
      [['googlePersonal', 'Google personal'], ['googleWork', 'Google work'],
       ['outlookPersonal', 'Outlook personal'], ['outlookWork', 'Outlook work']]
        .map(([key, label]) => chip(`cal_${key}`, s.calendar[key], label))));

  form.append(weather, news, commute, calendar,
    h('div', { class: 'row' },
      h('p', { class: 'muted' }, 'What Jibo includes when you ask for your personal report.'),
      h('button', { type: 'submit', class: 'primary' }, 'Save changes')));

  container.appendChild(form);

  async function save(e) {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(form));
    const newsCats = {};
    for (const k of Object.keys(s.news.categories)) newsCats[k] = !!fd[`news_${k}`];
    const calendar = {};
    for (const k of ['googlePersonal', 'googleWork', 'outlookPersonal', 'outlookWork']) calendar[k] = !!fd[`cal_${k}`];
    const body = {
      weather: { active: !!fd.weather, celsius: fd.units === 'c' },
      news: { active: !!fd.news, categories: newsCats },
      commute: { active: !!fd.commute, mode: fd.mode, ...picker.value() },
      calendar: { active: !!fd.calendar, ...calendar },
    };
    const r = await api('PUT', '/api/settings', body);
    notify(r.ok ? 'Saved.' : (r.data.error || 'Save failed'), r.ok ? 'ok' : 'error');
  }
}

// ============================================================================
// Profile
// ============================================================================

async function renderProfile() {
  if (!requireLogin()) return;
  const container = h('div', {}, h('h2', {}, 'Account'), topBar(), h('p', { class: 'muted' }, 'Loading…'));
  show(container);

  const meRes = await api('GET', '/api/me');
  container.replaceChildren(h('h2', {}, 'Account'));
  if (!meRes.ok) { container.appendChild(errP('not logged in')); return; }
  const a = meRes.data.account;

  const card = h('section', { class: 'card' }, h('h3', {}, 'Profile'));
  const form = h('form', { on: { submit: saveProfile } },
    h('label', { class: 'sub' }, 'First name', h('input', { name: 'firstName', value: a.firstName || '' })),
    h('label', { class: 'sub' }, 'Last name', h('input', { name: 'lastName', value: a.lastName || '' })),
    h('label', { class: 'sub' }, h('span', { class: 'field-label' }, 'Birthday'),
      h('input', { type: 'date', name: 'birthdayDate',
        value: a.birthday ? new Date(Number(a.birthday)).toISOString().slice(0, 10) : '' })),
    h('label', { class: 'sub' }, 'Gender', h('select', { name: 'gender' },
      ['', 'male', 'female', 'other', 'they'].map((g) => h('option', { value: g, selected: a.gender === g }, g || '(none)')))),
    h('label', { class: 'sub' }, 'Phone number', h('input', { name: 'phoneNumber', value: a.phoneNumber || '' })),
    toggle('messagingAllowed', a.messagingAllowed ?? true, 'Allow messaging', 'Let other people in the loop send you messages through Jibo.'),
    h('button', { type: 'submit', class: 'primary' }, 'Save changes'),
    h('p', { class: 'muted' }, `Signed in as ${a.email}`));
  card.appendChild(form);
  container.appendChild(card);

  const pw = h('section', { class: 'card' }, h('h3', {}, 'Change password'));
  const pwForm = h('form', { on: { submit: changePassword } },
    h('label', { class: 'sub' }, 'Current password', h('input', { name: 'currentPassword', type: 'password', required: true })),
    h('label', { class: 'sub' }, 'New password', h('input', { name: 'newPassword', type: 'password', minlength: 8, required: true })),
    h('button', { type: 'submit', class: 'primary' }, 'Change password'));
  pw.appendChild(pwForm);
  container.appendChild(pw);

  const mail = h('section', { class: 'card' }, h('h3', {}, 'Change email address'));
  const mailForm = h('form', { on: { submit: changeEmail } },
    h('label', { class: 'sub' }, 'Current password', h('input', { name: 'currentPassword', type: 'password', required: true })),
    h('label', { class: 'sub' }, 'New email', h('input', { name: 'email', type: 'email', required: true })),
    h('button', { type: 'submit', class: 'primary' }, 'Change email'));
  mail.appendChild(mailForm);
  container.appendChild(mail);

  async function saveProfile(e) {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(form));
    const body = {
      firstName: fd.firstName || undefined,
      lastName: fd.lastName || undefined,
      gender: fd.gender || undefined,
      // The field is a date picker now; the API still stores epoch ms.
      birthday: fd.birthdayDate ? Date.parse(`${fd.birthdayDate}T00:00:00Z`) : null,
      phoneNumber: fd.phoneNumber || null,
      messagingAllowed: !!fd.messagingAllowed,
    };
    const r = await api('PUT', '/api/me', body);
    if (r.ok) { notify('Saved'); await refreshMe(); await renderProfile(); }
    else notify(r.data.error || 'failed', 'error');
  }
  async function changePassword(e) {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(pwForm));
    const r = await api('POST', '/api/me/password', fd);
    notify(r.ok ? 'Password changed' : (r.data.error || 'failed'), r.ok ? 'ok' : 'error');
    pwForm.reset();
  }
  async function changeEmail(e) {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(mailForm));
    const r = await api('POST', '/api/me/email', fd);
    notify(r.ok ? 'Email changed' : (r.data.error || 'failed'), r.ok ? 'ok' : 'error');
    if (r.ok) { await refreshMe(); await renderProfile(); }
  }
}

// ============================================================================
// Robot
// ============================================================================

async function renderRobot() {
  if (!requireLogin()) return;
  const container = h('div', {}, h('h2', {}, 'Robot'), topBar(), h('p', { class: 'muted' }, 'Loading…'));
  show(container);

  const robots = await api('GET', '/api/robots');
  container.replaceChildren(h('h2', {}, 'Robot'));
  if (!robots.ok) { container.appendChild(errP(robots.data.error || 'could not load')); return; }

  const addBtn = h('button', { class: 'primary', on: { click: () => { location.hash = '#/add'; } } }, '+ Add a robot');
  container.appendChild(h('div', { class: 'row' }, addBtn));

  for (const robot of robots.data) {
    const card = h('section', { class: 'card card-click', on: { click: () => showRobotDetail(robot) } },
      h('h3', {}, robot.friendlyId),
      row('Loop', robot.loopName || '—'),
      row('Created', fmtDate(robot.created)),
      row('Last seen', fmtDate(robot.lastSeen)));
    container.appendChild(card);
  }
  if (!robots.data.length) container.appendChild(empty());

  async function showRobotDetail(robot) {
    const leaf = h('div', {}, h('p', { class: 'muted' }, 'Loading robot detail…'));
    container.appendChild(leaf);
    const r = await api('GET', `/api/robot?loopId=${encodeURIComponent(robot.loopId || '')}`);
    if (!r.ok) { leaf.replaceWith(errP(r.data.error || 'could not load robot')); return; }
    const d = r.data;
    leaf.replaceWith(h('section', { class: 'card' },
      h('h3', {}, d.robot?.friendlyId || robot.friendlyId),
      row('Loop', d.loop ? `${d.loop.name} (${d.loop.id})` : '—'),
      row('Status', d.loop?.isSuspended ? h('span', { class: 'warn' }, 'Suspended') : 'Active'),
      row('Robot account', d.robot ? d.robot.id : '—'),
      d.diagnostics ? row('Classic diagnostics', h('span', { class: 'warn' }, JSON.stringify(d.diagnostics))) : null,
      d.getRobot ? h('pre', { class: 'json' }, JSON.stringify(d.getRobot, null, 2)) : null));
  }
}

// ============================================================================
// Gallery / Media
// ============================================================================

async function renderGallery() {
  if (!requireLogin()) return;
  const container = h('div', {}, h('h2', {}, 'Gallery'), topBar(), h('p', { class: 'muted' }, 'Loading…'));
  show(container);
  const loop = await firstLoop();
  if (!loop) { container.append(h('p', { class: 'muted' }, 'No loop.')); return; }
  const r = await api('GET', `/api/media?loopId=${encodeURIComponent(loop.id)}`);
  container.replaceChildren(h('h2', {}, `Gallery — ${loop.name}`));
  if (!r.ok) { container.appendChild(errP(r.data.error || 'could not load media')); return; }

  const items = (r.data.media || []).filter((m) => !m.isDeleted && m.url);
  if (!items.length) { container.appendChild(empty()); return; }
  const grid = h('div', { class: 'media-grid' });
  const selected = new Set();
  items.forEach((m) => {
    const tile = h('div', { class: 'media-tile', 'data-path': m.path },
      h('img', { src: imageUrl(m), loading: 'lazy', on: { click: () => openMedia(m) } }),
      h('div', { class: 'media-caption' }, `${m.type} · ${fmtDate(m.created)}`),
      h('label', { class: 'chip' }, h('input', { type: 'checkbox', on: { change: (e) => {
        if (e.target.checked) selected.add(m.path); else selected.delete(m.path);
      } } }), h('span', { class: 'chip-mark' }), h('span', {}, 'Select')));
    grid.appendChild(tile);
  });
  container.appendChild(grid);
  const delBtn = h('button', { class: 'link danger', on: { click: removeSelected } }, 'Delete selected');
  container.appendChild(delBtn);

  function imageUrl(m) {
    const path = (m.path || '').split('/').pop();
    if (!/^[A-Za-z0-9_-]+$/.test(path)) return '';
    return `/api/media/blob/${path}`;
  }

  function openMedia(m) {
    const overlay = h('div', { class: 'overlay', on: { click: (e) => { if (e.target === overlay) overlay.remove(); } } },
      h('img', { src: imageUrl(m), class: 'overlay-img' }),
      h('p', { class: 'muted' }, `${m.type} · path ${m.path} · ${fmtDate(m.created)}`));
    document.body.appendChild(overlay);
  }

  async function removeSelected() {
    if (!selected.size) return;
    if (!confirm(`Delete ${selected.size} item(s)?`)) return;
    const r = await api('POST', '/api/media/remove', { loopId: loop.id, paths: [...selected] });
    notify(r.ok ? 'Deleted' : (r.data.error || 'failed'), r.ok ? 'ok' : 'error');
    if (r.ok) await renderGallery();
  }
}

// ============================================================================
// Messaging
// ============================================================================

async function renderMessaging() {
  if (!requireLogin()) return;
  const container = h('div', {}, h('h2', {}, 'Messages & notifications'), topBar(), h('p', { class: 'muted' }, 'Loading…'));
  show(container);
  const loop = await firstLoop();

  // Jot
  const jot = h('section', { class: 'card' }, h('h3', {}, 'Loop messages (Jot)'));
  container.appendChild(jot);
  if (loop) {
    const r = await api('GET', `/api/jot?loopId=${encodeURIComponent(loop.id)}`);
    const list = h('div', { class: 'jot-list' });
    jot.appendChild(list);
    if (r.ok) {
      const msgs = r.data.messages || [];
      list.replaceChildren(...msgs.slice().reverse().map((m) =>
        h('div', { class: 'jot-msg' },
          h('div', { class: 'jot-meta' }, `${fmtDate(m.created)} · ${m.sender || '—'}${m.isEncrypted ? ' · encrypted' : ''}`),
          h('div', {}, m.content || '(media)'))));
      if (!msgs.length) list.appendChild(empty());
    } else {
      list.appendChild(errP(r.data.error || 'could not load messages'));
    }
    const form = h('form', { class: 'row', on: { submit: async (e) => {
      e.preventDefault();
      const content = new FormData(form).get('content');
      const res = await api('POST', '/api/jot/message', { loopId: loop.id, content });
      notify(res.ok ? 'Sent' : (res.data.error || 'failed'), res.ok ? 'ok' : 'error');
      if (res.ok) await renderMessaging();
    } } },
      h('input', { name: 'content', placeholder: 'Message your Jibo loop…', required: true }),
      h('button', { type: 'submit', class: 'primary' }, 'Send'));
    jot.appendChild(form);
  }

  // Push registrations
  const push = h('section', { class: 'card' }, h('h3', {}, 'Push registrations'));
  container.appendChild(push);
  const pushRes = await api('GET', '/api/push');
  if (pushRes.ok) {
    const devices = pushRes.data.devices || [];
    push.appendChild(h('div', { class: 'kv' }, h('span', { class: 'k' }, 'Devices'), h('span', { class: 'v' }, String(devices.length))));
    devices.forEach((d) => {
      push.appendChild(h('div', { class: 'kv' },
        h('span', { class: 'k' }, d.name),
        h('span', { class: 'v' }, `${d.type} · ${d.pushToken}`,
          h('button', { class: 'link danger', on: { click: () => removePush(d) } }, 'remove'))));
    });
  } else {
    push.appendChild(errP(pushRes.data.error || 'could not load push devices'));
  }
  async function removePush(d) {
    const r = await api('POST', '/api/push/remove', { name: d.name });
    notify(r.ok ? 'Device removed' : (r.data.error || 'failed'), r.ok ? 'ok' : 'error');
    if (r.ok) await renderMessaging();
  }

  // Notifications
  const notif = h('section', { class: 'card' }, h('h3', {}, 'Notification socket'));
  container.appendChild(notif);
  const n = await api('GET', '/api/notifications');
  if (n.ok) {
    notif.appendChild(row('Connected', n.data.status && n.data.status.connected ? 'yes' : 'no'));
  } else {
    notif.appendChild(errP(n.data.error || 'could not load notification status'));
  }
}

// ============================================================================
// System (OTA / IFTTT / OAuth)
// ============================================================================

async function renderSystem() {
  if (!requireLogin()) return;
  const container = h('div', {}, h('h2', {}, 'System'), topBar(), h('p', { class: 'muted' }, 'Loading…'));
  show(container);

  const [upd, oauth, ifttt] = await Promise.all([
    api('GET', '/api/update/status'),
    api('GET', '/api/oauthclients'),
    api('GET', '/api/ifttt'),
  ]);
  container.replaceChildren(h('h2', {}, 'System'));

  const update = h('section', { class: 'card' }, h('h3', {}, 'Software updates (OTA)'));
  if (upd.ok) {
    const items = upd.data.updates || [];
    update.appendChild(row('Catalog entries', String(items.length)));
    items.slice(0, 20).forEach((u) => update.appendChild(row(u.subsystem || '?', `${u.fromVersion || '?'} → ${u.toVersion || '?'}`)));
  } else {
    update.appendChild(errP(upd.data.error || 'classic unreachable'));
  }
  container.appendChild(update);

  const oauthCard = h('section', { class: 'card' }, h('h3', {}, 'OAuth clients'));
  if (oauth.ok) {
    (oauth.data.clients || []).forEach((c) => oauthCard.appendChild(row(c.name || c.clientId, c.id)));
  } else {
    oauthCard.appendChild(errP(oauth.data.error || 'could not load'));
  }
  container.appendChild(oauthCard);

  const iftttCard = h('section', { class: 'card' }, h('h3', {}, 'IFTTT'));
  if (ifttt.ok) {
    const id = ifttt.data.identity;
    iftttCard.appendChild(row('Identity', id && id.id ? String(id.id) : '—'));
    (ifttt.data.applets || []).forEach((t) => iftttCard.appendChild(row('Trigger', t.text || t.id)));
    if (ifttt.data.diagnostics) iftttCard.appendChild(row('Note', ifttt.data.diagnostics.message));
  } else {
    iftttCard.appendChild(errP(ifttt.data.error || 'could not load'));
  }
  container.appendChild(iftttCard);
}

// ============================================================================
// Home dashboard
// ============================================================================

async function renderHome() {
  if (!requireLogin()) return;
  const container = h('div', {}, h('h2', {}, 'Overview'), topBar(), h('p', { class: 'muted' }, 'Loading…'));
  show(container);

  const [loops, robots, meRes] = await Promise.all([
    api('GET', '/api/loop'),
    api('GET', '/api/robots'),
    api('GET', '/api/me'),
  ]);
  container.replaceChildren(h('h2', {}, `Hi ${meRes.ok && meRes.data.account.firstName ? meRes.data.account.firstName : ''}`.trim()));

  const short = h('section', { class: 'card' }, h('h3', {}, 'Quick links'));
  short.appendChild(h('div', { class: 'row' },
    h('a', { href: '#/loop' }, 'Manage loop members'),
    h('a', { href: '#/settings' }, 'Personal report'),
    h('a', { href: '#/gallery' }, 'Gallery')));
  container.appendChild(short);

  if (loops.ok) {
    const loopCard = h('section', { class: 'card' }, h('h3', {}, 'Your loop'));
    for (const l of loops.data) {
      loopCard.appendChild(row(l.name, `${l.members.length} members · ${l.robotFriendlyId || 'no robot'}`));
    }
    container.appendChild(loopCard);
  }
  if (robots.ok) {
    const robotCard = h('section', { class: 'card' }, h('h3', {}, 'Robots'));
    for (const rb of robots.data) robotCard.appendChild(row(rb.friendlyId, rb.loopName || '—'));
    container.appendChild(robotCard);
  }
}

// ============================================================================
// Add robot (QR pair) — carried over from the original portal
// ============================================================================

let pollTimer = null;
async function renderAdd() {
  if (!requireLogin()) return;
  const container = h('div', {},
    h('button', { class: 'link', on: { click: () => { stopPoll(); location.hash = '#/robot'; } } }, '← Back'),
    h('h2', {}, 'Set up a new robot'));
  show(container);

  const form = h('form', { class: 'card', on: { submit: doSetup } },
    h('label', { class: 'sub' }, 'Home WiFi name (SSID)', h('input', { name: 'ssid', required: true })),
    h('label', { class: 'sub' }, 'WiFi password', h('input', { name: 'password', type: 'password' })),
    h('details', {},
      h('summary', {}, 'Advanced: static IP'),
      h('div', { class: 'grid2' },
        h('label', { class: 'sub' }, 'IP', h('input', { name: 'ip' })),
        h('label', { class: 'sub' }, 'Netmask', h('input', { name: 'netmask' })),
        h('label', { class: 'sub' }, 'Gateway', h('input', { name: 'gateway' })),
        h('label', { class: 'sub' }, 'DNS 1', h('input', { name: 'dns1' })),
        h('label', { class: 'sub' }, 'DNS 2', h('input', { name: 'dns2' })))),
    h('p', { class: 'error', id: 'wifi-error', hidden: true }),
    h('button', { type: 'submit', class: 'primary' }, 'Show setup code'));

  container.appendChild(form);

  async function doSetup(e) {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(form));
    const staticConfig = (fd.ip || fd.netmask || fd.gateway) ? { ip: fd.ip, netmask: fd.netmask, gateway: fd.gateway, dns1: fd.dns1, dns2: fd.dns2 } : null;
    const r = await api('POST', '/api/robots/setup', { ssid: fd.ssid, password: fd.password, static: staticConfig });
    if (!r.ok) { const el = form.querySelector('#wifi-error'); el.hidden = false; el.textContent = r.data.error || 'failed'; return; }
    form.hidden = true;
    const stage = h('div', { class: 'card' },
      h('p', { class: 'instruct' }, 'Open Jibo\u2019s setup screen and hold this up to his eye.'),
      h('div', { class: 'qr-codes', on: { click: cycleFrames } }),
      h('p', { class: 'muted', id: 'qr-status' }, 'Waiting for Jibo to scan…'));
    container.appendChild(stage);

    const codes = r.data.qr.codes;
    let frame = 0;
    const renderFrame = () => {
      const holder = stage.querySelector('.qr-codes');
      holder.replaceChildren(...[0, 1].map((i) => {
        const idx = (frame + i) % codes.length;
        const div = h('div', {}, qrSvg(codes[idx], 5));
        return div;
      }));
    };
    function cycleFrames() { frame = (frame + 1) % codes.length; renderFrame(); }
    renderFrame();
    startPoll(r.data.token, stage.querySelector('#qr-status'));
  }

  function startPoll(token, statusEl) {
    stopPoll();
    pollTimer = setInterval(async () => {
      const r = await api('GET', `/api/robots/setup/status?token=${encodeURIComponent(token)}`);
      if (r.ok && r.data.complete) {
        stopPoll();
        statusEl.textContent = '✅ Jibo is set up! Returning to your robots…';
        statusEl.style.color = 'var(--ok)';
        setTimeout(() => { location.hash = '#/robot'; route(); }, 1500);
      }
    }, 2000);
  }
}
function stopPoll() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }

// ============================================================================
// Admin
// ============================================================================

async function renderAdmin() {
  const container = h('div', {}, h('h2', {}, 'Admin'));
  show(container);
  const meRes = await api('GET', '/api/admin/me');
  const login = h('form', { class: 'card narrow', on: { submit: doLogin } },
    h('label', { class: 'sub' }, 'Admin password', h('input', { name: 'password', type: 'password', required: true })),
    h('button', { type: 'submit', class: 'primary' }, 'Unlock'));
  container.appendChild(login);

  async function doLogin(e) {
    e.preventDefault();
    const r = await api('POST', '/api/admin/login', Object.fromEntries(new FormData(login)));
    if (!r.ok) { notify(r.data.error || 'wrong password', 'error'); return; }
    await loadPanel();
  }

  async function loadPanel() {
    login.remove();
    const robots = await api('GET', '/api/admin/robots');
    const section = h('section', { class: 'card' }, h('h3', {}, 'All adopted robots'));
    if (robots.ok) {
      robots.data.forEach((rb) => section.appendChild(row(rb.friendlyId, `${rb.loopName || '—'} · ${rb.ownerEmail || '—'} · ${rb.accessKeyId}`)));
    }
    container.appendChild(section);

    const adopt = h('section', { class: 'card' }, h('h3', {}, 'Manually adopt a robot'));
    const form = h('form', { class: 'row', on: { submit: doAdopt } },
      h('input', { name: 'friendlyId', placeholder: 'robot name, e.g. castle-cylinder-fig-quilt', required: true }),
      h('input', { name: 'ownerEmail', type: 'email', placeholder: 'owner email (optional)' }),
      h('button', { type: 'submit', class: 'primary' }, 'Adopt'),
      h('pre', { class: 'json', name: 'result', hidden: true }));
    adopt.appendChild(form);
    container.appendChild(adopt);

    async function doAdopt(e) {
      e.preventDefault();
      const fd = Object.fromEntries(new FormData(form));
      const r = await api('POST', '/api/admin/adopt', { friendlyId: fd.friendlyId, ownerEmail: fd.ownerEmail || undefined });
      const pre = form.elements.result;
      pre.hidden = false;
      if (!r.ok) { pre.textContent = `Error: ${r.data.error}`; return; }
      pre.textContent = [
        '# Write this to /var/jibo/credentials.json on the robot:',
        JSON.stringify(r.data.credentialsJson, null, 2),
        '', '# Then point the robot at this server:',
        ...(r.data.instructions || []),
      ].join('\n');
      await loadPanel();
    }
  }
}

// ============================================================================
// auth + router
// ============================================================================

function renderAuth() {
  const frag = document.getElementById('tpl-auth').content.cloneNode(true);
  show(frag);
  const form = document.getElementById('auth-form');
  const submit = document.getElementById('auth-submit');
  const err = document.getElementById('auth-error');
  const signupOnly = app.querySelector('.signup-only');
  let mode = 'login';
  app.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => {
    mode = t.dataset.tab;
    app.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x.dataset.tab === mode));
    if (signupOnly) signupOnly.hidden = mode !== 'signup';
    submit.textContent = mode === 'signup' ? 'Sign up' : 'Log in';
    err.hidden = true;
  }));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(form));
    const r = await api('POST', mode === 'signup' ? '/api/signup' : '/api/login', fd);
    if (!r.ok) { err.hidden = false; err.textContent = r.data.error || 'failed'; return; }
    await refreshMe();
    location.hash = '#/';
    route();
  });
}

async function firstLoop() {
  const r = await api('GET', '/api/loop');
  return r.ok && r.data.loops && r.data.loops.length ? r.data.loops[0] : null;
}

const RENDER = {
  '/': renderHome,
  '#/': renderHome,
  '#/loop': renderLoop,
  '#/settings': renderSettings,
  '#/profile': renderProfile,
  '#/robot': renderRobot,
  '#/gallery': renderGallery,
  '#/messaging': renderMessaging,
  '#/system': renderSystem,
  '#/add': renderAdd,
};

async function route() {
  const hash = location.hash || '#/';
  if (hash === '#/admin') return renderAdmin();
  const fn = RENDER[hash] || renderHome;
  await refreshMe();
  if (!me && hash !== '#/admin') return renderAuth();
  return fn();
}

document.getElementById('logout').addEventListener('click', async () => {
  await api('POST', '/api/logout');
  me = null;
  location.hash = '#/';
  route();
});

window.addEventListener('hashchange', () => { stopPoll(); route(); });
route();