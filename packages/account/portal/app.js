// Phoenix console — vanilla SPA, no build step, no framework.
//
// Hash routes: #/, #/loop, #/settings, #/profile, #/robot, #/gallery,
// #/messaging, #/people, #/system, plus #/add (QR pairing) and #/admin.
//
// Every call below goes to the same-origin REST face the portal has always
// used, authenticated by the phx_session cookie. The request shapes are
// unchanged; this file owns presentation only.

import { qrSvg } from '/qr.js';
import { createLocationPicker } from '/map.js';
import { initBrand, initTheme } from '/brand.js';

/* ==========================================================================
   Elements
   ========================================================================== */

const app = document.getElementById('app');
const shell = document.getElementById('shell');
const authRoot = document.getElementById('auth-root');
const scrim = document.getElementById('scrim');
const pageTitle = document.getElementById('page-title');

/* ==========================================================================
   API
   ========================================================================== */

const api = async (method, path, body) => {
  try {
    const res = await fetch(path, {
      method,
      headers: body ? { 'content-type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data };
  } catch (error) {
    // A dead service should say so, not fail silently into an empty page.
    return { ok: false, status: 0, data: { error: 'Cannot reach the server.' } };
  }
};

/* ==========================================================================
   DOM builder
   ========================================================================== */

const BOOL_ATTRS = ['checked', 'selected', 'disabled', 'required', 'open'];

const h = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'on') for (const [ev, fn] of Object.entries(v)) el.addEventListener(ev, fn);
    else if (k === 'hidden') el.hidden = v;
    else if (BOOL_ATTRS.includes(k)) { if (v) el.setAttribute(k, ''); }
    else el.setAttribute(k, v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(typeof kid === 'string' || typeof kid === 'number' ? String(kid) : kid);
  }
  return el;
};

/** Inline icon from the shared 24x24 line set. */
const ICONS = {
  home: 'M3.5 10.5 12 3.5l8.5 7M5.5 9.5V20h13V9.5',
  users: 'M16 20v-1.5a3.5 3.5 0 0 0-3.5-3.5h-5A3.5 3.5 0 0 0 4 18.5V20M10 11.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7ZM20 20v-1.5a3.5 3.5 0 0 0-2.6-3.4M15.4 4.6a3.5 3.5 0 0 1 0 6.8',
  sliders: 'M4 7h10M18 7h2M4 17h4M12 17h8M4 12h2M10 12h10M16 5v4M10 15v4M8 10v4',
  robot: 'M8 4h8a4 4 0 0 1 4 4v8a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4V8a4 4 0 0 1 4-4ZM9.5 10.5h.01M14.5 10.5h.01M9 15h6',
  image: 'M4 5.5h16v13H4zM4 15l4.5-4.5 4 4 3-3L20 16M15.5 9.5h.01',
  message: 'M20 11.5a7.6 7.6 0 0 1-8.2 7.6 8.2 8.2 0 0 1-3.4-.8L4 19.5l1.4-4a7.6 7.6 0 0 1-1-3.9 7.6 7.6 0 0 1 8.2-7.6A7.6 7.6 0 0 1 20 11.5Z',
  user: 'M19 20v-1.5a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4V20M12 11a3.75 3.75 0 1 0 0-7.5 3.75 3.75 0 0 0 0 7.5Z',
  server: 'M7 5h10a2 2 0 0 1 2 2v2a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2ZM7 13h10a2 2 0 0 1 2 2v2a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-2a2 2 0 0 1 2-2ZM8.5 8h.01M8.5 16h.01',
  arrow: 'M5 12h13m0 0-5-5m5 5-5 5',
  back: 'M19 12H6m0 0 5-5m-5 5 5 5',
  plus: 'M12 5v14M5 12h14',
  alert: 'M12 9v4.5m0 3.5v.01M10.3 3.9 2.6 17.2a2 2 0 0 0 1.7 3h15.4a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z',
  check: 'm5 12.5 4.5 4.5L19 7.5',
  inbox: 'M4 13h4l1.5 3h5l1.5-3h4M4 13l2.5-8h11L20 13v6a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-6Z',
  link: 'M9.5 14.5 14.5 9.5M10.5 6.5 12 5a4.2 4.2 0 0 1 6 6l-1.5 1.5M13.5 17.5 12 19a4.2 4.2 0 0 1-6-6l1.5-1.5',
  clock: 'M12 7v5l3 2m6-2a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z',
  bell: 'M18 9a6 6 0 1 0-12 0c0 5-2 6.5-2 6.5h16S18 14 18 9ZM10.3 19a2 2 0 0 0 3.4 0',
  download: 'M12 4v10m0 0 4-4m-4 4-4-4M4 18h16',
};

const icon = (name, size = 16, className) => {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('fill', 'none');
  svg.setAttribute('aria-hidden', 'true');
  if (className) svg.setAttribute('class', className);
  const p = document.createElementNS(ns, 'path');
  p.setAttribute('d', ICONS[name] || ICONS.server);
  p.setAttribute('stroke', 'currentColor');
  p.setAttribute('stroke-width', '1.6');
  p.setAttribute('stroke-linecap', 'round');
  p.setAttribute('stroke-linejoin', 'round');
  svg.append(p);
  return svg;
};

/* ==========================================================================
   Formatting
   ========================================================================== */

const fmtDate = (v) => (v ? new Date(Number(v) || v).toLocaleString(undefined, {
  dateStyle: 'medium', timeStyle: 'short',
}) : '—');
const fmtDay = (v) => (v ? new Date(Number(v) || v).toLocaleDateString(undefined, { dateStyle: 'medium' }) : '—');
const fmtBool = (v) => (v ? 'yes' : 'no');

/** Sentence-case a key like `googleWork` or `top_stories`. */
const prettyLabel = (key) => String(key)
  .replace(/[_-]+/g, ' ')
  .replace(/([a-z\d])([A-Z])/g, '$1 $2')
  .replace(/^./, (c) => c.toUpperCase());

const initials = (account) => {
  const source = `${account?.firstName || ''} ${account?.lastName || ''}`.trim() || account?.email || '?';
  return source.split(/[\s@._-]+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
};

/* ==========================================================================
   UI primitives
   ========================================================================== */

const show = (node) => {
  app.replaceChildren(node);
  app.scrollIntoView({ block: 'start', behavior: 'instant' });
};

const page = (title, description, ...kids) => {
  pageTitle.textContent = title;
  document.title = `${title} — Phoenix`;
  return h('div', {},
    h('div', { class: 'page-head' },
      h('h2', { text: title }),
      description ? h('p', { text: description }) : null),
    ...kids);
};

const card = (heading, opts = {}, ...kids) => {
  const head = heading
    ? h('div', { class: 'card-head' },
      h('h3', { text: heading }),
      opts.sub ? h('span', { class: 'sub', text: opts.sub }) : null,
      opts.actions ? h('span', { class: 'spacer' }) : null,
      ...(opts.actions || []))
    : null;
  return h('section', { class: 'card' }, head,
    opts.bare ? kids : h('div', { class: 'card-body' }, ...kids));
};

const row = (left, right) => h('div', { class: 'kv' },
  h('span', { class: 'k' }, left),
  h('span', { class: 'v' }, right));

const field = (label, control, hint) => h('label', { class: 'field' },
  h('span', { class: 'field-label' }, label),
  control,
  hint ? h('span', { class: 'field-hint' }, hint) : null);

const empty = (title = 'Nothing here yet', body = '', iconName = 'inbox') => h('div', { class: 'empty' },
  h('div', { class: 'ic' }, icon(iconName, 20)),
  h('h4', { text: title }),
  body ? h('p', { text: body }) : null);

/** An explicit, visible failure. Nothing in this console fakes a success. */
const errorBox = (message, detail) => h('div', { class: 'notice notice-error' },
  icon('alert', 16),
  h('div', {},
    h('div', { text: message }),
    detail ? h('div', { class: 'field-hint', style: 'margin-top:.3rem', text: detail }) : null));

const loading = (rows = 4) => h('div', { class: 'loading-rows' },
  ...Array.from({ length: rows }, () => h('div', { class: 'skeleton' })));

const toggle = (name, checked, label, hint) => {
  const input = h('input', { type: 'checkbox', name, checked: !!checked });
  const el = h('label', { class: 'switch' },
    input,
    h('span', { class: 'track' }),
    h('span', { class: 'switch-text' },
      h('span', {}, label),
      hint ? h('span', { class: 'switch-hint' }, hint) : null));
  // Dim the rest of the group while the setting is off, so the page shows what
  // is actually in effect.
  const sync = () => {
    const group = el.closest('fieldset');
    if (group) group.classList.toggle('group-off', !input.checked);
  };
  input.addEventListener('change', sync);
  queueMicrotask(sync);
  return el;
};

const chip = (name, checked, label) => h('label', { class: 'chip' },
  h('input', { type: 'checkbox', name, checked: !!checked }),
  h('span', { class: 'chip-mark' }),
  h('span', {}, label));

let notifyTimer = null;
function notify(msg, kind = 'ok') {
  document.getElementById('toast')?.remove();
  const el = h('div', { id: 'toast', class: `toast ${kind}`, role: 'status', 'aria-live': 'polite' }, msg);
  document.body.append(el);
  clearTimeout(notifyTimer);
  notifyTimer = setTimeout(() => el.remove(), 3400);
}

const debounce = (fn, ms) => {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
};

/**
 * Promise-based confirmation, replacing window.confirm. Destructive actions in
 * this console delete other people's photographs and remove people from a
 * household, so they deserve a dialog that names what is about to happen.
 */
function confirmDialog({ title, body, confirmLabel = 'Confirm', danger = true }) {
  return new Promise((resolve) => {
    const dialog = h('dialog', { class: 'modal' },
      h('h3', { text: title }),
      body ? h('p', { text: body }) : null,
      h('div', { class: 'row row-end', style: 'margin-top:1.25rem' },
        h('button', { class: 'btn', type: 'button', on: { click: () => close(false) } }, 'Cancel'),
        h('button', {
          class: `btn ${danger ? 'btn-danger' : 'btn-primary'}`,
          type: 'button',
          on: { click: () => close(true) },
        }, confirmLabel)));

    const close = (value) => {
      dialog.close();
      dialog.remove();
      resolve(value);
    };
    dialog.addEventListener('cancel', (e) => { e.preventDefault(); close(false); });
    document.body.append(dialog);
    dialog.showModal();
    dialog.querySelector('.btn-danger, .btn-primary')?.focus();
  });
}

/* ==========================================================================
   Session state
   ========================================================================== */

let me = null;

async function refreshMe() {
  const r = await api('GET', '/api/me');
  me = r.ok ? r.data.account : null;
  paintAccount();
  return me;
}

function paintAccount() {
  shell.hidden = !me;
  authRoot.hidden = !!me;
  if (!me) return;
  document.getElementById('avatar').textContent = initials(me);
  document.getElementById('who-name').textContent =
    [me.firstName, me.lastName].filter(Boolean).join(' ') || me.email;
  document.getElementById('who-email').textContent = me.email || '';
}

/** The first loop, which for essentially every household is the only one. */
async function firstLoop() {
  const r = await api('GET', '/api/loop');
  return r.ok && Array.isArray(r.data.loops) && r.data.loops.length ? r.data.loops[0] : null;
}

/* ==========================================================================
   Overview
   ========================================================================== */

async function renderHome() {
  const container = page('Overview', 'Your household at a glance.', loading(3));
  show(container);

  const [loops, robots] = await Promise.all([
    api('GET', '/api/loop'),
    api('GET', '/api/robots'),
  ]);

  const greeting = me?.firstName ? `Welcome back, ${me.firstName}.` : 'Welcome back.';
  const body = page('Overview', greeting);

  // `GET /api/loop` answers { loops: [...] }, not a bare array.
  const loopList = loops.ok && Array.isArray(loops.data.loops) ? loops.data.loops : [];
  const robotList = robots.ok && Array.isArray(robots.data) ? robots.data : [];
  // Each loop also carries a member record for the robot itself; it is not a
  // person and must not be counted as one.
  const peopleOf = (l) => (l.members || []).filter((m) => !(m.accountId && m.accountId === l.robot));
  const members = loopList.reduce((n, l) => n + peopleOf(l).length, 0);
  const unlinked = loopList.reduce((n, l) => n + peopleOf(l).filter((m) => !m.account).length, 0);

  body.append(h('div', { class: 'stat-grid' },
    h('article', { class: 'stat' },
      h('div', { class: 'label' }, icon('users', 14), 'Members'),
      h('div', { class: 'value', text: String(members) }),
      h('div', { class: 'note', text: `across ${loopList.length} household${loopList.length === 1 ? '' : 's'}` })),
    h('article', { class: 'stat' },
      h('div', { class: 'label' }, icon('robot', 14), 'Robots'),
      h('div', { class: 'value', text: String(robotList.length) }),
      h('div', { class: 'note', text: robotList.length ? 'paired to this server' : 'none paired yet' })),
    h('article', { class: 'stat' },
      h('div', { class: 'label' }, icon('link', 14), 'Unlinked'),
      h('div', { class: 'value', text: String(unlinked) }),
      h('div', { class: 'note', text: unlinked ? 'members with no account' : 'every member is linked' }))));

  // The single most common cause of "I had trouble fetching your personal
  // settings" is a member with no account link, so say so here rather than
  // making someone find it.
  if (unlinked > 0) {
    body.append(h('div', { class: 'notice notice-warn', style: 'margin-top:1rem' },
      icon('alert', 16),
      h('div', {},
        h('div', {}, `${unlinked} member${unlinked === 1 ? ' has' : 's have'} no account linked.`),
        h('div', { class: 'field-hint', style: 'margin-top:.3rem' },
          'The robot cannot load a personal report for them until it is. '),
        h('a', { class: 'link', href: '#/loop', style: 'display:inline-block;margin-top:.5rem' },
          'Link them now'))));
  }

  body.append(h('h3', { style: 'margin:2rem 0 .9rem;font-size:var(--t-base)' }, 'Jump to'));
  const quick = (href, label, iconName, note) => h('a', { class: 'quick', href },
    h('span', { class: 'ic' }, icon(iconName, 16)),
    h('span', {}, h('div', { text: label }),
      note ? h('div', { class: 'field-hint', text: note }) : null),
    icon('arrow', 15, 'arrow'));
  body.append(h('div', { class: 'quick-grid' },
    quick('#/loop', 'Household', 'users', 'Members and account links'),
    quick('#/settings', 'Personal report', 'sliders', 'Weather, news, commute'),
    quick('#/robot', 'Robots', 'robot', 'Pairing and status'),
    quick('#/gallery', 'Gallery', 'image', 'What the robot captured')));

  if (!loops.ok) body.append(h('div', { style: 'margin-top:1.5rem' }, errorBox('Could not load your household.', loops.data.error)));
  if (!robots.ok) body.append(h('div', { style: 'margin-top:1rem' }, errorBox('Could not load robots.', robots.data.error)));

  if (loopList.length) {
    const loopCard = card('Your household', {});
    for (const l of loopList) {
      const n = peopleOf(l).length;
      loopCard.querySelector('.card-body').append(row(
        l.name, `${n} member${n === 1 ? '' : 's'} · ${l.robotFriendlyId || 'no robot'}`));
    }
    body.append(h('div', { style: 'margin-top:1.5rem' }, loopCard));
  }
  if (robotList.length) {
    const robotCard = card('Robots', {});
    for (const rb of robotList) {
      robotCard.querySelector('.card-body').append(row(rb.friendlyId, rb.loopName || '—'));
    }
    body.append(robotCard);
  }

  setBadge('badge-members', members);
  setBadge('badge-robots', robotList.length);
  show(body);
}

function setBadge(id, count) {
  const el = document.getElementById(id);
  if (!el) return;
  el.hidden = !count;
  el.textContent = String(count);
}

/* ==========================================================================
   Household (loop and members)
   ========================================================================== */

async function renderLoop() {
  show(page('Household', 'Members, their account links, and the household itself.', loading(5)));

  const r = await api('GET', '/api/loop');
  const container = page('Household', 'Members, their account links, and the household itself.');

  if (!r.ok) { container.append(errorBox('Could not load your household.', r.data.error)); return show(container); }
  const loops = Array.isArray(r.data.loops) ? r.data.loops : [];
  const active = loops[0] || null;
  if (!active) {
    container.append(empty('No household yet', 'A household is created when your first robot is paired.', 'users'));
    return show(container);
  }

  const isOwner = active.owner === me?.id;

  /* -- the household record ------------------------------------------- */

  const renameForm = h('form', { class: 'row', on: { submit: renameLoop } },
    h('input', { name: 'name', value: active.name, required: true, 'aria-label': 'Household name', style: 'flex:1;min-width:12rem' }),
    h('button', { type: 'submit', class: 'btn' }, 'Rename'));

  const loopCard = card(active.name, {
    sub: active.isSuspended ? null : 'Active',
    actions: [h('button', {
      class: 'btn btn-sm btn-danger',
      type: 'button',
      on: { click: suspendLoop },
    }, active.isSuspended ? 'Un-suspend' : 'Suspend')],
  },
    active.isSuspended
      ? h('div', { class: 'notice notice-warn' }, icon('alert', 16),
        h('div', {}, 'This household is suspended. Member edits are blocked while it is.'))
      : null,
    row('Household ID', h('code', { text: active.id })),
    row('Owner', isOwner ? h('span', {}, 'You ', h('span', { class: 'pill pill-accent' }, 'owner')) : active.owner),
    row('Robot', active.robotFriendlyId || 'none paired'),
    row('Status', active.isSuspended
      ? h('span', { class: 'pill pill-error' }, 'Suspended')
      : h('span', { class: 'pill pill-ok' }, h('span', { class: 'dot' }), 'Active')),
    renameForm);
  container.append(loopCard);

  /* -- account linking ------------------------------------------------- */

  const state = { picker: null, editId: null };

  const searchInput = h('input', {
    type: 'search',
    name: 'email',
    placeholder: 'Search accounts by email…',
    'aria-label': 'Search accounts by email',
    on: { input: debounce(searchAccounts, 250) },
  });
  const resultsBox = h('div', { class: 'link-results' });

  const people = active.members.filter((m) => !(m.accountId && m.accountId === active.robot));
  const unlinkedCount = people.filter((m) => !m.account).length;
  setBadge('badge-members', people.length);

  const membersCard = card('Members', {
    sub: `${people.length} ${people.length === 1 ? 'person' : 'people'}`
      + `${unlinkedCount ? ` · ${unlinkedCount} unlinked` : ''}`,
  },
    h('p', { class: 'field-hint' },
      'Linking a member to an account is what lets the robot fetch that person’s own '
      + 'weather, news and commute. Pick an account here, then press Link on the member.'),
    h('div', { class: 'link-picker' }, searchInput, resultsBox),
    h('div', { class: 'member-list' }));
  container.append(membersCard);

  const listEl = membersCard.querySelector('.member-list');

  function memberBlock(m) {
    const linked = m.account;
    // The loop carries a member record for the robot itself, whose "account" is
    // the robot's own id with no email. Rendering it as a nameless person with
    // a null address is just wrong, so it gets its own presentation and none of
    // the person-only actions.
    const isRobot = !!m.accountId && m.accountId === active.robot;
    const name = isRobot
      ? (active.robotFriendlyId || 'Robot')
      : ([m.memberProperties?.firstName, m.memberProperties?.lastName].filter(Boolean).join(' ')
        || (linked && [linked.firstName, linked.lastName].filter(Boolean).join(' '))
        || '(no name)');

    if (isRobot) {
      return h('div', { class: 'member-block is-robot', 'data-member': m.id },
        h('div', { class: 'member-name' },
          icon('robot', 15),
          name,
          h('span', { class: 'pill pill-accent' }, 'robot')),
        row('Joined', fmtDay(m.created)),
        h('p', { class: 'field-hint' },
          'This is the robot’s own place in the household, not a person. '
          + 'It is managed from the Robots page.'));
    }

    const accountLabel = linked
      ? (linked.email || linked.id || 'linked')
        + (linked.isActive === false ? ' (inactive)' : '')
      : (m.accountId || 'none');

    const children = [];

    if (state.editId === m.id) {
      const form = h('form', {
        class: 'edit-member',
        on: {
          submit: async (e) => {
            e.preventDefault();
            const fd = Object.fromEntries(new FormData(form));
            const payload = {
              loopId: active.id,
              id: m.id,
              nickname: fd.nickname || null,
              phoneticName: fd.phoneticName || null,
            };
            const a = await api('POST', '/api/loop/members/nickname', payload);
            const b = await api('POST', '/api/loop/members/phonetic', payload);
            if (a.ok && b.ok) { notify('Saved'); state.editId = null; await renderLoop(); }
            else notify(a.data.error || b.data.error || 'Could not save', 'error');
          },
        },
      },
        field('Nickname', h('input', { name: 'nickname', value: m.nickname || '' }),
          'What the robot calls them.'),
        field('Phonetic name', h('input', { name: 'phoneticName', value: m.phoneticName || '' }),
          'Spell it how it sounds, if the robot says it wrong.'),
        h('div', { class: 'row' },
          h('button', { type: 'submit', class: 'btn btn-primary btn-sm' }, 'Save'),
          h('button', {
            type: 'button', class: 'btn btn-sm',
            on: { click: () => { state.editId = null; paintMembers(); } },
          }, 'Cancel')));
      children.push(form);
    }

    const enrolChip = (kind, label) => h('label', { class: 'chip' },
      h('input', {
        type: 'checkbox',
        checked: !!m.enrolled?.[kind],
        on: {
          change: async (e) => {
            const res = await api('POST', '/api/loop/members/enrollment', {
              loopId: active.id, id: m.id, [kind]: e.target.checked,
            });
            if (res.ok) { notify('Enrolment saved'); await renderLoop(); }
            else { e.target.checked = !e.target.checked; notify(res.data.error || 'Could not save', 'error'); }
          },
        },
      }),
      h('span', { class: 'chip-mark' }), h('span', {}, label));

    const actions = [
      h('button', {
        class: 'link', type: 'button',
        on: { click: () => toggleLink(m) },
      }, linked ? 'Unlink' : 'Link account'),
      h('button', {
        class: 'link', type: 'button',
        on: { click: () => { state.editId = state.editId === m.id ? null : m.id; paintMembers(); } },
      }, 'Edit'),
    ];
    if (isOwner) {
      actions.push(h('button', {
        class: 'link danger', type: 'button',
        on: { click: () => removeMember(m, name) },
      }, 'Remove'));
    }

    children.push(
      h('div', { class: 'member-name' }, name,
        h('span', { class: `status status-${m.status || 'invited'}`, text: m.status || 'invited' })),
      row('Account', accountLabel),
      row('Enrolled', `face ${fmtBool(m.enrolled?.face)} · voice ${fmtBool(m.enrolled?.voice)}`),
      linked
        ? null
        : h('div', { class: 'member-unlinked-note' }, icon('alert', 13),
          h('span', {}, 'No account linked — the robot cannot load their personal report.')),
      h('div', { class: 'enroll' }, enrolChip('face', 'Face'), enrolChip('voice', 'Voice')),
      h('div', { class: 'member-actions' }, ...actions));

    return h('div', {
      class: `member-block${linked ? '' : ' unlinked'}`,
      'data-member': m.id,
    }, ...children);
  }

  function paintMembers() {
    // Members needing a link come first: they are the actionable ones, and on a
    // twelve-person household they were otherwise scattered down the page. The
    // robot's own record sorts last — it is never something to act on here.
    const rank = (m) => (m.accountId && m.accountId === active.robot ? 2 : (m.account ? 1 : 0));
    const ordered = [...active.members].sort((a, b) => rank(a) - rank(b));
    listEl.replaceChildren(ordered.length
      ? h('div', { class: 'member-grid' }, ...ordered.map(memberBlock))
      : empty('No members yet', 'Invite someone below.', 'users'));
  }
  paintMembers();

  /* -- invite ---------------------------------------------------------- */

  container.append(card('Invite a member', {},
    h('form', {
      class: 'invite-form',
      on: {
        submit: async (e) => {
          e.preventDefault();
          const fd = Object.fromEntries(new FormData(e.target));
          const payload = { loopId: active.id };
          for (const k of ['email', 'firstName', 'lastName']) if (fd[k]) payload[k] = fd[k];
          const res = await api('POST', '/api/loop/invite', payload);
          if (res.ok) { notify('Invitation sent'); await renderLoop(); }
          else notify(res.data.error || 'Could not invite', 'error');
        },
      },
    },
      field('Email', h('input', { name: 'email', type: 'email', placeholder: 'them@example.com' })),
      field('First name', h('input', { name: 'firstName' })),
      field('Last name', h('input', { name: 'lastName' })),
      h('button', { type: 'submit', class: 'btn btn-primary' }, 'Send invitation'))));

  show(container);

  /* -- actions --------------------------------------------------------- */

  async function toggleLink(m) {
    if (m.account) {
      const res = await api('POST', '/api/loop/members/unlink', { loopId: active.id, id: m.id });
      if (res.ok) { notify('Unlinked'); await renderLoop(); }
      else notify(res.data.error || 'Could not unlink', 'error');
      return;
    }
    if (!state.picker) { notify('Search for an account above and pick one first.', 'error'); return; }
    const res = await api('POST', '/api/loop/members/link', {
      loopId: active.id, id: m.id, accountId: state.picker.id,
    });
    if (res.ok) { notify(`Linked to ${state.picker.email}`); await renderLoop(); }
    else notify(res.data.error || 'Could not link', 'error');
  }

  async function removeMember(m, name) {
    const yes = await confirmDialog({
      title: `Remove ${name}?`,
      body: 'They will be removed from the household. The robot will stop recognising them as a member.',
      confirmLabel: 'Remove',
    });
    if (!yes) return;
    const res = await api('POST', '/api/loop/members/remove', { loopId: active.id, id: m.id });
    if (res.ok) { notify('Member removed'); await renderLoop(); }
    else notify(res.data.error || 'Could not remove', 'error');
  }

  async function renameLoop(e) {
    e.preventDefault();
    const name = new FormData(e.target).get('name');
    const res = await api('PUT', '/api/loop', { loopId: active.id, name });
    if (res.ok) { notify('Renamed'); await renderLoop(); }
    else notify(res.data.error || 'Could not rename', 'error');
  }

  async function suspendLoop() {
    if (!active.isSuspended) {
      const yes = await confirmDialog({
        title: 'Suspend this household?',
        body: 'Member edits are blocked while a household is suspended. You can un-suspend it again at any time.',
        confirmLabel: 'Suspend',
      });
      if (!yes) return;
    }
    const endpoint = active.isSuspended ? 'unsuspend' : 'suspend';
    const res = await api('POST', `/api/loop/${endpoint}`, { loopId: active.id });
    if (res.ok) { notify(active.isSuspended ? 'Un-suspended' : 'Suspended'); await renderLoop(); }
    else notify(res.data.error || 'Could not change status', 'error');
  }

  async function searchAccounts(ev) {
    const term = ev.target.value.trim();
    if (!term) { resultsBox.replaceChildren(); return; }
    const res = await api('GET', `/api/accounts/search?email=${encodeURIComponent(term)}`);
    if (!res.ok) { resultsBox.replaceChildren(); return; }
    const accounts = res.data.accounts || [];
    if (!accounts.length) {
      resultsBox.replaceChildren(h('p', { class: 'map-result-empty' }, 'No matching account.'));
      return;
    }
    resultsBox.replaceChildren(...accounts.slice(0, 8).map((a) => h('button', {
      type: 'button',
      class: 'account-opt',
      on: {
        click: () => {
          state.picker = a;
          searchInput.value = a.email;
          resultsBox.replaceChildren(h('p', { class: 'map-result-empty' },
            `Selected ${a.email} — now press Link on a member.`));
        },
      },
    }, `${a.email}${a.firstName ? ` (${a.firstName})` : ''}`)));
  }
}

/* ==========================================================================
   Personal report settings
   ========================================================================== */

async function renderSettings() {
  show(page('Personal report', 'What the robot includes when you ask for your report.', loading(6)));

  const r = await api('GET', '/api/settings');
  const container = page('Personal report', 'What the robot includes when you ask for your report.');
  if (!r.ok) { container.append(errorBox('Could not load your settings.', r.data.error)); return show(container); }
  const s = r.data.settings;

  const form = h('form', { class: 'settings-form' });

  const weather = h('fieldset', {},
    h('legend', {}, 'Weather'),
    toggle('weather', s.weather.active, 'Include weather', 'The robot opens the report with today’s forecast.'),
    field('Units', h('select', { name: 'units' },
      h('option', { value: 'f', selected: !s.weather.celsius }, 'Fahrenheit'),
      h('option', { value: 'c', selected: s.weather.celsius }, 'Celsius'))));

  const news = h('fieldset', {},
    h('legend', {}, 'News'),
    toggle('news', s.news.active, 'Read the news', 'Pick the categories the robot should cover.'),
    h('div', { class: 'chips' },
      Object.entries(s.news.categories).map(([cat, on]) => chip(`news_${cat}`, on, prettyLabel(cat)))));

  // Commute used to be four bare coordinate fields. Nobody knows their own
  // latitude, so the setting was effectively unusable; the picker submits the
  // same values and lets you point at a map instead.
  const picker = createLocationPicker({
    places: [
      { key: 'home', label: 'Home', point: s.commute.home || {} },
      { key: 'work', label: 'Work', point: s.commute.work || {} },
    ],
  });

  const pad = (n) => String(n).padStart(2, '0');
  const depHour = s.commute.time?.hour ?? 9;
  const depMin = s.commute.time?.min ?? 0;

  const commute = h('fieldset', {},
    h('legend', {}, 'Commute'),
    toggle('commute', s.commute.active, 'Give commute directions', 'How long it takes to get from home to work.'),
    h('div', { class: 'grid2' },
      field('Travel mode', h('select', { name: 'mode' },
        [['driving', 'Driving'], ['walking', 'Walking'], ['bicycling', 'Cycling'], ['transit', 'Public transit']]
          .map(([value, label]) => h('option', { value, selected: s.commute.mode === value }, label)))),
      field('Usual departure time',
        h('input', { type: 'time', name: 'departure', value: `${pad(depHour)}:${pad(depMin)}` }))),
    h('div', { class: 'notice' }, icon('clock', 15),
      h('div', {},
        'The robot shows the traffic and departure displays only when you ask within two hours '
        + 'before this time. Ask earlier and it just says how long the trip takes right now.')),
    picker.element);

  const calendar = h('fieldset', {},
    h('legend', {}, 'Calendar'),
    toggle('calendar', s.calendar.active, 'Read your calendar', 'Which calendars the robot may look at.'),
    h('div', { class: 'chips' },
      [['googlePersonal', 'Google personal'], ['googleWork', 'Google work'],
        ['outlookPersonal', 'Outlook personal'], ['outlookWork', 'Outlook work']]
        .map(([key, label]) => chip(`cal_${key}`, s.calendar[key], label))));

  const saveBtn = h('button', { type: 'submit', class: 'btn btn-primary' }, 'Save changes');
  form.append(weather, news, commute, calendar,
    h('div', { class: 'save-bar' },
      h('p', {}, 'Changes apply the next time you ask for your report.'),
      saveBtn));

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    saveBtn.disabled = true;
    const fd = Object.fromEntries(new FormData(form));
    const newsCats = {};
    for (const k of Object.keys(s.news.categories)) newsCats[k] = !!fd[`news_${k}`];
    const cal = {};
    for (const k of ['googlePersonal', 'googleWork', 'outlookPersonal', 'outlookWork']) cal[k] = !!fd[`cal_${k}`];
    const payload = {
      weather: { active: !!fd.weather, celsius: fd.units === 'c' },
      news: { active: !!fd.news, categories: newsCats },
      commute: {
        active: !!fd.commute,
        mode: fd.mode,
        ...picker.value(),
        // <input type=time> gives "HH:MM"; the wire format is {hour, min}.
        ...(typeof fd.departure === 'string' && /^\d{1,2}:\d{2}$/.test(fd.departure)
          ? { time: { hour: Number(fd.departure.split(':')[0]), min: Number(fd.departure.split(':')[1]) } }
          : {}),
      },
      calendar: { active: !!fd.calendar, ...cal },
    };
    const res = await api('PUT', '/api/settings', payload);
    saveBtn.disabled = false;
    notify(res.ok ? 'Settings saved' : (res.data.error || 'Could not save'), res.ok ? 'ok' : 'error');
  });

  container.append(form);
  show(container);
}

/* ==========================================================================
   Account
   ========================================================================== */

async function renderProfile() {
  show(page('Account', 'Your profile, password and email address.', loading(5)));

  const meRes = await api('GET', '/api/me');
  const container = page('Account', 'Your profile, password and email address.');
  if (!meRes.ok) { container.append(errorBox('Not signed in.')); return show(container); }
  const a = meRes.data.account;

  const profileForm = h('form', {}, );
  profileForm.append(
    h('div', { class: 'grid2' },
      field('First name', h('input', { name: 'firstName', value: a.firstName || '', autocomplete: 'given-name' })),
      field('Last name', h('input', { name: 'lastName', value: a.lastName || '', autocomplete: 'family-name' }))),
    h('div', { class: 'grid2' },
      field('Birthday', h('input', {
        type: 'date', name: 'birthdayDate',
        value: a.birthday ? new Date(Number(a.birthday)).toISOString().slice(0, 10) : '',
      })),
      field('Gender', h('select', { name: 'gender' },
        ['', 'male', 'female', 'other', 'they'].map((g) =>
          h('option', { value: g, selected: a.gender === g }, g ? prettyLabel(g) : '(not set)'))))),
    field('Phone number', h('input', { name: 'phoneNumber', type: 'tel', value: a.phoneNumber || '', autocomplete: 'tel' })),
    toggle('messagingAllowed', a.messagingAllowed ?? true, 'Allow messaging',
      'Let other people in the household send you messages through the robot.'),
    h('div', { class: 'row', style: 'margin-top:1.25rem' },
      h('button', { type: 'submit', class: 'btn btn-primary' }, 'Save changes')));

  profileForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(profileForm));
    const res = await api('PUT', '/api/me', {
      firstName: fd.firstName || undefined,
      lastName: fd.lastName || undefined,
      gender: fd.gender || undefined,
      // The control is a date picker; the API still stores epoch milliseconds.
      birthday: fd.birthdayDate ? Date.parse(`${fd.birthdayDate}T00:00:00Z`) : null,
      phoneNumber: fd.phoneNumber || null,
      messagingAllowed: !!fd.messagingAllowed,
    });
    if (res.ok) { notify('Profile saved'); await refreshMe(); await renderProfile(); }
    else notify(res.data.error || 'Could not save', 'error');
  });

  container.append(card('Profile', { sub: `Signed in as ${a.email}` }, profileForm));

  const pwForm = h('form', {},
    field('Current password', h('input', { name: 'currentPassword', type: 'password', required: true, autocomplete: 'current-password' })),
    field('New password', h('input', { name: 'newPassword', type: 'password', minlength: 8, required: true, autocomplete: 'new-password' }),
      'At least 8 characters.'),
    h('div', { class: 'row', style: 'margin-top:1.25rem' },
      h('button', { type: 'submit', class: 'btn btn-primary' }, 'Change password')));
  pwForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const res = await api('POST', '/api/me/password', Object.fromEntries(new FormData(pwForm)));
    notify(res.ok ? 'Password changed' : (res.data.error || 'Could not change password'), res.ok ? 'ok' : 'error');
    if (res.ok) pwForm.reset();
  });
  container.append(card('Change password', {}, pwForm));

  const mailForm = h('form', {},
    field('Current password', h('input', { name: 'currentPassword', type: 'password', required: true, autocomplete: 'current-password' })),
    field('New email address', h('input', { name: 'email', type: 'email', required: true })),
    h('div', { class: 'row', style: 'margin-top:1.25rem' },
      h('button', { type: 'submit', class: 'btn btn-primary' }, 'Change email')));
  mailForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const res = await api('POST', '/api/me/email', Object.fromEntries(new FormData(mailForm)));
    notify(res.ok ? 'Email changed' : (res.data.error || 'Could not change email'), res.ok ? 'ok' : 'error');
    if (res.ok) { await refreshMe(); await renderProfile(); }
  });
  container.append(card('Change email address', {}, mailForm));

  show(container);
}

/* ==========================================================================
   Robots
   ========================================================================== */

async function renderRobot() {
  show(page('Robots', 'The robots paired with this server.', loading(3)));

  const robots = await api('GET', '/api/robots');
  const container = page('Robots', 'The robots paired with this server.');
  container.querySelector('.page-head').append(h('div', { class: 'row' },
    h('a', { class: 'btn btn-primary', href: '#/add' }, icon('plus', 15), 'Add a robot')));

  if (!robots.ok) { container.append(errorBox('Could not load robots.', robots.data.error)); return show(container); }
  const list = Array.isArray(robots.data) ? robots.data : [];
  setBadge('badge-robots', list.length);

  if (!list.length) {
    container.append(empty('No robots paired yet',
      'Pair one by showing it a setup code from the Add a robot screen.', 'robot'));
    return show(container);
  }

  for (const robot of list) {
    const detail = h('div', {});
    const c = card(robot.friendlyId, {
      sub: robot.loopName || '—',
      actions: [h('button', {
        class: 'btn btn-sm', type: 'button',
        on: { click: (e) => loadDetail(e.currentTarget, robot, detail) },
      }, 'Details')],
    },
      row('Household', robot.loopName || '—'),
      row('Created', fmtDate(robot.created)),
      row('Last seen', fmtDate(robot.lastSeen)),
      detail);
    container.append(c);
  }
  show(container);

  async function loadDetail(button, robot, host) {
    button.disabled = true;
    host.replaceChildren(loading(2));
    const r = await api('GET', `/api/robot?loopId=${encodeURIComponent(robot.loopId || '')}`);
    button.disabled = false;
    if (!r.ok) { host.replaceChildren(errorBox('Could not load robot detail.', r.data.error)); return; }
    const d = r.data;
    host.replaceChildren(
      row('Household', d.loop ? `${d.loop.name} (${d.loop.id})` : '—'),
      row('Status', d.loop?.isSuspended
        ? h('span', { class: 'pill pill-error' }, 'Suspended')
        : h('span', { class: 'pill pill-ok' }, h('span', { class: 'dot' }), 'Active')),
      row('Robot account', d.robot ? d.robot.id : '—'),
      d.diagnostics
        ? errorBox('The Classic entrypoint reported a problem.', JSON.stringify(d.diagnostics))
        : null,
      d.getRobot ? h('pre', { class: 'json', text: JSON.stringify(d.getRobot, null, 2) }) : null);
  }
}

/* ==========================================================================
   Add a robot — QR pairing (carried over verbatim in behaviour)
   ========================================================================== */

let pollTimer = null;
function stopPoll() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }

async function renderAdd() {
  const container = page('Set up a robot', 'Show the code to the robot and it will join your network.');
  container.querySelector('.page-head').prepend(
    h('a', { class: 'link', href: '#/robot', style: 'display:inline-flex;align-items:center;gap:.35rem;margin-bottom:.75rem' },
      icon('back', 14), 'Back to robots'));

  const errorLine = h('p', { class: 'error', hidden: true });
  const form = h('form', {},
    field('Home Wi-Fi name (SSID)', h('input', { name: 'ssid', required: true, autocomplete: 'off' })),
    field('Wi-Fi password', h('input', { name: 'password', type: 'password', autocomplete: 'off' })),
    h('details', { class: 'map-manual' },
      h('summary', {}, 'Advanced: static IP'),
      h('div', { class: 'map-manual-grid' },
        field('IP', h('input', { name: 'ip' })),
        field('Netmask', h('input', { name: 'netmask' })),
        field('Gateway', h('input', { name: 'gateway' })),
        field('DNS 1', h('input', { name: 'dns1' })),
        field('DNS 2', h('input', { name: 'dns2' })))),
    errorLine,
    h('div', { class: 'row', style: 'margin-top:1.25rem' },
      h('button', { type: 'submit', class: 'btn btn-primary' }, 'Show setup code')));

  const formCard = card('Network details', {}, form);
  container.append(formCard);
  show(container);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(form));
    const staticConfig = (fd.ip || fd.netmask || fd.gateway)
      ? { ip: fd.ip, netmask: fd.netmask, gateway: fd.gateway, dns1: fd.dns1, dns2: fd.dns2 }
      : null;
    const r = await api('POST', '/api/robots/setup', {
      ssid: fd.ssid, password: fd.password, static: staticConfig,
    });
    if (!r.ok) {
      errorLine.hidden = false;
      errorLine.textContent = r.data.error || 'Could not create a setup code.';
      return;
    }
    formCard.hidden = true;

    const codes = r.data.qr.codes;
    let frame = 0;
    const holder = h('div', { class: 'qr-codes', on: { click: () => { frame = (frame + 1) % codes.length; paint(); } } });
    const status = h('p', { class: 'field-hint', style: 'text-align:center' },
      h('span', { class: 'spinner', style: 'display:inline-block;vertical-align:-3px;margin-right:.5rem' }),
      'Waiting for the robot to scan…');

    const paint = () => holder.replaceChildren(...[0, 1].map((i) =>
      h('div', {}, qrSvg(codes[(frame + i) % codes.length], 5))));
    paint();

    container.append(card('Setup code', { sub: `${codes.length} frames` },
      h('p', { class: 'instruct' }, 'Open the robot’s setup screen and hold this up to its eye.'),
      holder,
      h('p', { class: 'field-hint', style: 'text-align:center' }, 'Tap the codes to advance the frames.'),
      status));

    stopPoll();
    pollTimer = setInterval(async () => {
      const res = await api('GET', `/api/robots/setup/status?token=${encodeURIComponent(r.data.token)}`);
      if (res.ok && res.data.complete) {
        stopPoll();
        status.replaceChildren(icon('check', 15), ' The robot is set up. Returning to your robots…');
        status.style.color = 'var(--ok)';
        setTimeout(() => { location.hash = '#/robot'; }, 1600);
      }
    }, 2000);
  });
}

/* ==========================================================================
   Gallery
   ========================================================================== */

async function renderGallery() {
  show(page('Gallery', 'Photographs and media the robot captured.', loading(3)));

  const loop = await firstLoop();
  const container = page('Gallery', 'Photographs and media the robot captured.');
  if (!loop) { container.append(empty('No household', 'Pair a robot first.', 'image')); return show(container); }

  const r = await api('GET', `/api/media?loopId=${encodeURIComponent(loop.id)}`);
  if (!r.ok) { container.append(errorBox('Could not load the gallery.', r.data.error)); return show(container); }

  const items = (r.data.media || []).filter((m) => !m.isDeleted && m.url);
  if (!items.length) {
    container.append(empty('Nothing captured yet', 'Photographs the robot takes will appear here.', 'image'));
    return show(container);
  }

  const selected = new Set();
  const deleteBtn = h('button', {
    class: 'btn btn-danger btn-sm', type: 'button', disabled: true,
    on: { click: removeSelected },
  }, 'Delete selected');

  const imageUrl = (m) => {
    const path = (m.path || '').split('/').pop();
    if (!/^[A-Za-z0-9_-]+$/.test(path)) return '';
    return `/api/media/blob/${path}`;
  };

  const syncDelete = () => {
    deleteBtn.disabled = selected.size === 0;
    deleteBtn.textContent = selected.size ? `Delete ${selected.size} selected` : 'Delete selected';
  };

  const grid = h('div', { class: 'media-grid' }, ...items.map((m) => h('div', {
    class: 'media-tile', 'data-path': m.path,
  },
    h('img', { src: imageUrl(m), loading: 'lazy', alt: `${m.type} captured ${fmtDate(m.created)}`, on: { click: () => openMedia(m) } }),
    h('label', { class: 'chip' },
      h('input', {
        type: 'checkbox',
        'aria-label': 'Select this item',
        on: {
          change: (e) => {
            if (e.target.checked) selected.add(m.path); else selected.delete(m.path);
            syncDelete();
          },
        },
      }),
      h('span', { class: 'chip-mark' }), h('span', {}, 'Select')),
    h('div', { class: 'media-caption' }, `${m.type} · ${fmtDay(m.created)}`))));

  container.append(card(`${items.length} item${items.length === 1 ? '' : 's'}`, {
    sub: loop.name, actions: [deleteBtn], bare: true,
  }, h('div', { class: 'card-body' }, grid)));
  show(container);

  function openMedia(m) {
    const overlay = h('div', {
      class: 'overlay',
      on: { click: (e) => { if (e.target === overlay || e.target.tagName !== 'IMG') overlay.remove(); } },
    },
      h('img', { src: imageUrl(m), class: 'overlay-img', alt: '' }),
      h('p', {}, `${m.type} · ${m.path} · ${fmtDate(m.created)}`));
    const onKey = (e) => { if (e.key === 'Escape') { overlay.remove(); removeEventListener('keydown', onKey); } };
    addEventListener('keydown', onKey);
    document.body.append(overlay);
  }

  async function removeSelected() {
    if (!selected.size) return;
    const yes = await confirmDialog({
      title: `Delete ${selected.size} item${selected.size === 1 ? '' : 's'}?`,
      body: 'This cannot be undone, and nobody else has a copy.',
      confirmLabel: 'Delete',
    });
    if (!yes) return;
    const res = await api('POST', '/api/media/remove', { loopId: loop.id, paths: [...selected] });
    notify(res.ok ? 'Deleted' : (res.data.error || 'Could not delete'), res.ok ? 'ok' : 'error');
    if (res.ok) await renderGallery();
  }
}

/* ==========================================================================
   Messages
   ========================================================================== */

async function renderMessaging() {
  show(page('Messages', 'Household messages, push registrations and the notification socket.', loading(4)));

  const loop = await firstLoop();
  const container = page('Messages', 'Household messages, push registrations and the notification socket.');

  /* -- Jot ------------------------------------------------------------- */
  if (loop) {
    const r = await api('GET', `/api/jot?loopId=${encodeURIComponent(loop.id)}`);
    const list = h('div', { class: 'jot-list' });
    if (r.ok) {
      const msgs = r.data.messages || [];
      list.replaceChildren(...msgs.slice().reverse().map((m) => h('div', { class: 'jot-msg' },
        h('div', { class: 'jot-meta' },
          `${fmtDate(m.created)} · ${m.sender || '—'}${m.isEncrypted ? ' · encrypted' : ''}`),
        h('div', { text: m.content || '(media)' }))));
      if (!msgs.length) list.replaceChildren(empty('No messages yet', 'Send one below.', 'message'));
    } else {
      list.replaceChildren(errorBox('Could not load messages.', r.data.error));
    }

    const compose = h('form', { class: 'compose' },
      h('input', { name: 'content', placeholder: 'Message your household…', required: true, 'aria-label': 'Message' }),
      h('button', { type: 'submit', class: 'btn btn-primary' }, 'Send'));
    compose.addEventListener('submit', async (e) => {
      e.preventDefault();
      const content = new FormData(compose).get('content');
      const res = await api('POST', '/api/jot/message', { loopId: loop.id, content });
      notify(res.ok ? 'Sent' : (res.data.error || 'Could not send'), res.ok ? 'ok' : 'error');
      if (res.ok) await renderMessaging();
    });

    container.append(card('Household messages', { sub: loop.name }, list, compose));
  } else {
    container.append(card('Household messages', {}, empty('No household', 'Pair a robot first.', 'message')));
  }

  /* -- Push ------------------------------------------------------------ */
  const pushCard = card('Push registrations', { sub: 'Devices registered for notifications' }, loading(2));
  container.append(pushCard);

  /* -- Notification socket --------------------------------------------- */
  const notifCard = card('Notification socket', {}, loading(1));
  container.append(notifCard);

  show(container);

  const [pushRes, notifRes] = await Promise.all([
    api('GET', '/api/push'),
    api('GET', '/api/notifications'),
  ]);

  const pushBody = pushCard.querySelector('.card-body');
  if (pushRes.ok) {
    const devices = pushRes.data.devices || [];
    pushBody.replaceChildren(devices.length
      ? h('div', {}, ...devices.map((d) => h('div', { class: 'kv' },
        h('span', { class: 'k' }, d.name),
        h('span', { class: 'v' },
          h('code', { text: `${d.type} · ${d.pushToken}` }),
          h('button', {
            class: 'link danger', type: 'button',
            on: {
              click: async () => {
                const yes = await confirmDialog({
                  title: `Remove ${d.name}?`,
                  body: 'That device will stop receiving notifications.',
                  confirmLabel: 'Remove',
                });
                if (!yes) return;
                const res = await api('POST', '/api/push/remove', { name: d.name });
                notify(res.ok ? 'Device removed' : (res.data.error || 'Could not remove'), res.ok ? 'ok' : 'error');
                if (res.ok) await renderMessaging();
              },
            },
          }, 'Remove')))))
      : empty('No devices registered', 'Devices appear here once they register for push.', 'bell'));
  } else {
    pushBody.replaceChildren(errorBox('Could not load push devices.', pushRes.data.error));
  }

  const notifBody = notifCard.querySelector('.card-body');
  if (notifRes.ok) {
    const connected = notifRes.data.status && notifRes.data.status.connected;
    notifBody.replaceChildren(
      row('Connected', connected
        ? h('span', { class: 'pill pill-ok' }, h('span', { class: 'dot dot-live' }), 'Yes')
        : h('span', { class: 'pill pill-warn' }, 'No')),
      h('p', { class: 'field-hint' },
        'Delivery over the socket is robot-side; this reports the status the service knows about.'));
  } else {
    notifBody.replaceChildren(errorBox('Could not load notification status.', notifRes.data.error));
  }
}

/* ==========================================================================
   People — person catalogue (read-only)
   ========================================================================== */

async function renderPeople() {
  show(page('People', 'The person catalogue, as the robot sees it.', loading(4)));

  const loop = await firstLoop();
  const container = page('People', 'The person catalogue, as the robot sees it.');
  if (!loop) { container.append(empty('No household', 'Pair a robot first.', 'users')); return show(container); }

  container.append(h('div', { class: 'notice' }, icon('alert', 15),
    h('div', {}, 'This surface is read-only. Answering the robot’s questions is a phone-side flow; '
      + 'nothing here is stubbed — these are the real values it holds.')));

  const r = await api('GET', `/api/people?loopId=${encodeURIComponent(loop.id)}`);
  if (!r.ok) { container.append(errorBox('Could not load the person catalogue.', r.data.error)); return show(container); }
  const d = r.data;

  if (d.diagnostics) {
    container.append(errorBox('Some sources could not be reached.',
      d.diagnostics.map((x) => x.message || x.code).join(' · ')));
  }

  const answers = Array.isArray(d.answers) ? d.answers : [];
  container.append(card('Answers', { sub: `${answers.length} recorded` },
    answers.length
      ? h('div', {}, ...answers.slice(0, 60).map((a) =>
        row(prettyLabel(a.key || a.id || 'answer'), String(a.value ?? a.answer ?? '—'))))
      : empty('No answers yet', 'These accumulate as the robot asks its questions.', 'message')));

  const propRows = (label, obj) => {
    const entries = Object.entries(obj || {});
    return card(label, { sub: `${entries.length} propert${entries.length === 1 ? 'y' : 'ies'}` },
      entries.length
        ? h('div', {}, ...entries.map(([k, v]) =>
          row(prettyLabel(k), typeof v === 'object' ? JSON.stringify(v) : String(v))))
        : empty('Nothing set', '', 'inbox'));
  };
  container.append(propRows('Account properties', d.accountProperties));
  container.append(propRows('Household properties', d.loopProperties));

  const holidays = Array.isArray(d.holidays) ? d.holidays : [];
  container.append(card('Birthdays and holidays', { sub: `${holidays.length}` },
    holidays.length
      ? h('div', {}, ...holidays.map((x) => row(x.name || x.type || 'entry', x.date ? fmtDay(x.date) : '—')))
      : empty('None recorded', '', 'clock')));

  const voice = Array.isArray(d.voiceTraining) ? d.voiceTraining : [];
  container.append(card('Voice enrolment', { sub: `${voice.length} record${voice.length === 1 ? '' : 's'}` },
    d.enrolment
      ? row('Robot enrolled', d.enrolment.robot
        ? h('span', { class: 'pill pill-ok' }, 'Yes')
        : h('span', { class: 'pill pill-warn' }, 'No'))
      : null,
    voice.length
      ? h('div', {}, ...voice.map((v) => row(v.accountId || v.key || 'record', v.created ? fmtDate(v.created) : '—')))
      : empty('No voice training records', '', 'message')));

  show(container);
}

/* ==========================================================================
   System
   ========================================================================== */

async function renderSystem() {
  show(page('System', 'Updates, OAuth clients and IFTTT.', loading(4)));

  const [upd, oauth, ifttt] = await Promise.all([
    api('GET', '/api/update/status'),
    api('GET', '/api/oauthclients'),
    api('GET', '/api/ifttt'),
  ]);

  const container = page('System', 'Updates, OAuth clients and IFTTT.');

  const updates = upd.ok ? (upd.data.updates || []) : [];
  container.append(card('Software updates (OTA)', {
    sub: upd.ok ? `${updates.length} catalog entr${updates.length === 1 ? 'y' : 'ies'}` : null,
  },
    upd.ok
      ? (updates.length
        ? h('div', {}, ...updates.slice(0, 20).map((u) =>
          row(u.subsystem || '?', `${u.fromVersion || '?'} → ${u.toVersion || '?'}`)))
        : empty('No updates offered', 'The catalog is reachable but empty.', 'download'))
      : errorBox('Could not reach the update catalog.', upd.data.error),
    h('p', { class: 'field-hint' },
      'This shows the catalog a robot would be offered. Updates are not pushed from here.')));

  container.append(card('OAuth clients', {}, oauth.ok
    ? ((oauth.data.clients || []).length
      ? h('div', {}, ...oauth.data.clients.map((c) => row(c.name || c.clientId, c.id)))
      : empty('No registered clients', '', 'link'))
    : errorBox('Could not load OAuth clients.', oauth.data.error)));

  const iftttCard = card('IFTTT', {});
  const iftttBody = iftttCard.querySelector('.card-body');
  if (ifttt.ok) {
    const id = ifttt.data.identity;
    iftttBody.append(row('Identity', id && id.id ? String(id.id) : '—'));
    for (const t of (ifttt.data.applets || [])) iftttBody.append(row('Trigger', t.text || t.id));
    if (ifttt.data.diagnostics) {
      iftttBody.append(h('div', { class: 'notice notice-warn' }, icon('alert', 15),
        h('div', { text: ifttt.data.diagnostics.message })));
    }
  } else {
    iftttBody.append(errorBox('Could not load IFTTT.', ifttt.data.error));
  }
  container.append(iftttCard);

  show(container);
}

/* ==========================================================================
   Admin
   ========================================================================== */

async function renderAdmin() {
  const container = page('Admin', 'Server-wide robot administration.');
  show(container);

  // There is no password to enter here. Administrator access is a property of the
  // signed-in account and the server re-checks it on every admin route, so this
  // screen only decides what to show. A signed-out visitor never reaches this
  // function — the router sends them to the sign-in screen.
  const access = await api('GET', '/api/admin/me');

  if (access.status === 403) {
    container.append(card('Not an administrator', { sub: me ? (me.email || '') : '' },
      h('p', {}, 'This account is not an administrator, so the server-wide admin surface is not available to it.'),
      errorBox('An existing administrator grants access with scripts/portal-grant-admin.mjs.', access.data.error)));
    return;
  }
  if (!access.ok) {
    container.append(card('Admin surface unavailable', {},
      errorBox('Could not check administrator access.', access.data.error)));
    return;
  }

  await loadPanel();

  async function loadPanel() {
    const robots = await api('GET', '/api/admin/robots');
    const list = robots.ok && Array.isArray(robots.data) ? robots.data : [];
    container.append(card('All adopted robots', { sub: `${list.length}` },
      robots.ok
        ? (list.length
          ? h('div', {}, ...list.map((rb) => row(rb.friendlyId,
            `${rb.loopName || '—'} · ${rb.ownerEmail || '—'} · ${rb.accessKeyId}`)))
          : empty('No robots adopted', '', 'robot'))
        : errorBox('Could not list robots.', robots.data.error)));

    const result = h('pre', { class: 'json', hidden: true });
    const adoptForm = h('form', {},
      h('div', { class: 'grid2' },
        field('Robot name', h('input', { name: 'friendlyId', placeholder: 'castle-cylinder-fig-quilt', required: true })),
        field('Owner email', h('input', { name: 'ownerEmail', type: 'email', placeholder: 'optional' }))),
      h('div', { class: 'row', style: 'margin-top:1.25rem' },
        h('button', { type: 'submit', class: 'btn btn-primary' }, 'Adopt')),
      result);
    adoptForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = Object.fromEntries(new FormData(adoptForm));
      const res = await api('POST', '/api/admin/adopt', {
        friendlyId: fd.friendlyId, ownerEmail: fd.ownerEmail || undefined,
      });
      result.hidden = false;
      if (!res.ok) { result.textContent = `Error: ${res.data.error}`; return; }
      result.textContent = [
        '# Write this to /var/jibo/credentials.json on the robot:',
        JSON.stringify(res.data.credentialsJson, null, 2),
        '', '# Then point the robot at this server:',
        ...(res.data.instructions || []),
      ].join('\n');
      notify('Robot adopted');
    });
    container.append(card('Manually adopt a robot', {}, adoptForm));
  }
}

/* ==========================================================================
   Auth screen
   ========================================================================== */

function renderAuth() {
  shell.hidden = true;
  authRoot.hidden = false;
  document.title = 'Sign in — Phoenix';

  const frag = document.getElementById('tpl-auth').content.cloneNode(true);
  authRoot.replaceChildren(frag);
  initBrand(authRoot);

  const segment = authRoot.querySelector('#auth-segment');
  const form = authRoot.querySelector('#auth-form');
  const submit = authRoot.querySelector('#auth-submit');
  const err = authRoot.querySelector('#auth-error');
  const title = authRoot.querySelector('#auth-title');
  const sub = authRoot.querySelector('#auth-sub');
  const signupOnly = authRoot.querySelector('.signup-only');
  const password = form.querySelector('[name="password"]');

  let mode = 'login';
  const COPY = {
    login: { title: 'Welcome back', sub: 'Use the same account you sign into the robot app with.', cta: 'Sign in' },
    signup: { title: 'Create an account', sub: 'This account lives on this server only.', cta: 'Create account' },
  };

  for (const tab of segment.querySelectorAll('.tab')) {
    tab.addEventListener('click', () => {
      mode = tab.dataset.tab;
      segment.dataset.active = mode;
      for (const t of segment.querySelectorAll('.tab')) {
        const on = t.dataset.tab === mode;
        t.classList.toggle('active', on);
        t.setAttribute('aria-selected', String(on));
      }
      if (signupOnly) signupOnly.hidden = mode !== 'signup';
      title.textContent = COPY[mode].title;
      sub.textContent = COPY[mode].sub;
      submit.textContent = COPY[mode].cta;
      password.setAttribute('autocomplete', mode === 'signup' ? 'new-password' : 'current-password');
      err.hidden = true;
    });
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!form.reportValidity()) return;
    submit.disabled = true;
    submit.textContent = mode === 'signup' ? 'Creating…' : 'Signing in…';
    const fd = Object.fromEntries(new FormData(form));
    const res = await api('POST', mode === 'signup' ? '/api/signup' : '/api/login', fd);
    submit.disabled = false;
    submit.textContent = COPY[mode].cta;
    if (!res.ok) {
      err.hidden = false;
      err.textContent = res.data.error || 'That did not work. Check your details and try again.';
      return;
    }
    await refreshMe();
    if (!location.hash || location.hash === '#/') location.hash = '#/';
    route();
  });
}

/* ==========================================================================
   Shell chrome
   ========================================================================== */

function initChrome() {
  const menuBtn = document.getElementById('menu-btn');
  const closeNav = () => {
    document.body.classList.remove('nav-open');
    menuBtn?.setAttribute('aria-expanded', 'false');
    scrim.hidden = true;
  };
  menuBtn?.addEventListener('click', () => {
    const open = document.body.classList.toggle('nav-open');
    menuBtn.setAttribute('aria-expanded', String(open));
    scrim.hidden = !open;
  });
  scrim.addEventListener('click', closeNav);
  document.getElementById('nav')?.addEventListener('click', (e) => {
    if (e.target.closest('a')) closeNav();
  });

  // Account menu.
  const chipBtn = document.getElementById('account-chip');
  const menu = document.getElementById('account-menu');
  chipBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    const open = menu.hidden;
    menu.hidden = !open;
    chipBtn.setAttribute('aria-expanded', String(open));
  });
  document.addEventListener('click', (e) => {
    if (menu && !menu.hidden && !menu.contains(e.target)) {
      menu.hidden = true;
      chipBtn?.setAttribute('aria-expanded', 'false');
    }
  });
  addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (menu) menu.hidden = true;
    closeNav();
  });

  document.getElementById('logout')?.addEventListener('click', async () => {
    await api('POST', '/api/logout');
    me = null;
    location.hash = '#/';
    route();
  });
}

function paintNav(hash) {
  for (const a of document.querySelectorAll('#nav .nav-item')) {
    a.classList.toggle('active', a.dataset.route === hash);
  }
}

/* ==========================================================================
   Router
   ========================================================================== */

const ROUTES = {
  '#/': renderHome,
  '#/loop': renderLoop,
  '#/settings': renderSettings,
  '#/profile': renderProfile,
  '#/robot': renderRobot,
  '#/gallery': renderGallery,
  '#/messaging': renderMessaging,
  '#/people': renderPeople,
  '#/system': renderSystem,
  '#/add': renderAdd,
};

async function route() {
  stopPoll();
  // `/admin` is served by the same shell; treat the path as the route so the
  // bare URL works rather than silently landing on the overview.
  const hash = (location.pathname === '/admin' && !location.hash) ? '#/admin' : (location.hash || '#/');

  await refreshMe();

  if (hash === '#/admin') {
    // Administrator access follows the signed-in account, so there is nothing to
    // unlock here: a signed-out visitor gets the sign-in screen instead, and a
    // signed-in non-admin is told so rather than being asked for a password.
    if (!me) return renderAuth();
    shell.hidden = false;
    authRoot.hidden = true;
    paintNav('');
    return renderAdmin();
  }

  if (!me) return renderAuth();

  paintNav(ROUTES[hash] ? hash : '#/');
  const render = ROUTES[hash] || renderHome;
  try {
    await render();
  } catch (error) {
    show(page('Something went wrong', '',
      errorBox('This page failed to render.', String(error?.message || error))));
  }
}

addEventListener('hashchange', route);

initChrome();
initTheme();
initBrand(document).finally(route);
