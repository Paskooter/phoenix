// Phoenix console — vanilla SPA, no build step, no framework.
//
// Hash routes: #/, #/loop, #/settings, #/profile, #/robot, #/gallery,
// #/inbox, #/system, plus #/add (connection choice), #/add/new
// (QR pairing), #/claim (existing-robot migration) and #/admin.
//
// Every call below goes to the same-origin REST face the portal has always
// used, authenticated by the phx_session cookie. The request shapes are
// unchanged; this file owns presentation only.

import { qrSvg } from '/qr.js';
import { createLocationPicker } from '/map.js';
import { initBrand, initTheme } from '/brand.js';
import {
  browserPushState,
  disableBrowserPush,
  enableBrowserPush,
  promptInstall,
  registerPortalServiceWorker,
  syncBrowserPush,
} from '/pwa.js';

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
  copy: 'M9 9h10v12H9zM5 15V3h10v2',
  share: 'M16 5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5ZM6 14.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5ZM16 24a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5ZM8.2 10.8l5.6-3.2M8.2 13.2l5.6 3.2',
  eye: 'M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Zm9.5 2.6a2.6 2.6 0 1 0 0-5.2 2.6 2.6 0 0 0 0 5.2Z',
  refresh: 'M20 12a8 8 0 1 1-2.6-5.9M20 4v4h-4',
  lock: 'M7 10.5V8a5 5 0 0 1 10 0v2.5M5.5 10.5h13a1 1 0 0 1 1 1V20a1 1 0 0 1-1 1h-13a1 1 0 0 1-1-1v-8.5a1 1 0 0 1 1-1Z',
  chip: 'M8.5 4h7a4.5 4.5 0 0 1 4.5 4.5v7a4.5 4.5 0 0 1-4.5 4.5h-7A4.5 4.5 0 0 1 4 15.5v-7A4.5 4.5 0 0 1 8.5 4ZM9.5 9.5h5v5h-5zM12 4V1.5m0 21V20M4 12H1.5m21 0H20',
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

const fmtDate = (v, fallback = '—') => {
  if (v === null || v === undefined || v === '') return fallback;
  const date = new Date(Number(v) || v);
  return Number.isNaN(date.getTime()) ? fallback : date.toLocaleString(undefined, {
    dateStyle: 'medium', timeStyle: 'short',
  });
};
const fmtDay = (v) => (v ? new Date(Number(v) || v).toLocaleDateString(undefined, { dateStyle: 'medium' }) : '—');
const fmtBool = (v) => (v ? 'yes' : 'no');

// Some old Robot_20160225 records serialize unset optional fields as the
// literal string "null". It is not useful data, and showing five copies of it
// under Connection makes the detail card look broken.
const meaningfulText = (value) => {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text && !/^(?:null|undefined|none|n\/?a)$/i.test(text) ? text : null;
};

const robotLastSeen = (value) => fmtDate(value, 'Not yet observed');

const connectionStatus = (connection) => {
  if (connection?.connected === true) {
    return h('span', { class: 'pill pill-ok' }, h('span', { class: 'dot dot-live' }), 'Connected');
  }
  if (connection?.connected === false) return h('span', { class: 'pill pill-warn' }, 'Not connected');
  return h('span', { class: 'pill pill-warn' }, 'Status unavailable');
};

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

const chip = (name, checked, label, value) => h('label', { class: 'chip' },
  h('input', { type: 'checkbox', name, checked: !!checked, value }),
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
  if (me) {
    void registerPortalServiceWorker();
    void syncBrowserPush(api, me.id);
  }
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

  // The Administration section only appears for an account that has the flag.
  // This is presentation, not protection: every /api/admin route re-checks it
  // server-side, so revealing the link to a hand-edited client grants nothing.
  const adminNav = document.getElementById('nav-admin');
  if (adminNav) adminNav.hidden = !me.isAdmin;
}

// Loop-scoped surfaces must never silently pick an arbitrary loop.
// Remember the user's explicit choice locally, then fall back safely if that
// loop is no longer visible (for example after an invitation is removed).
const ACTIVE_LOOP_STORAGE_KEY = 'phoenix.activeLoopId';
let activeLoopId = (() => {
  try { return localStorage.getItem(ACTIVE_LOOP_STORAGE_KEY) || ''; } catch { return ''; }
})();

function rememberActiveLoop(id) {
  activeLoopId = String(id || '');
  try {
    if (activeLoopId) localStorage.setItem(ACTIVE_LOOP_STORAGE_KEY, activeLoopId);
    else localStorage.removeItem(ACTIVE_LOOP_STORAGE_KEY);
  } catch {
    // Browsing with storage disabled is still supported for this session.
  }
}

async function householdContext() {
  const r = await api('GET', '/api/loop');
  const loops = r.ok && Array.isArray(r.data.loops) ? r.data.loops : [];
  const active = loops.find((loop) => String(loop.id) === activeLoopId) || loops[0] || null;
  if (active && String(active.id) !== activeLoopId) rememberActiveLoop(active.id);
  if (!active && activeLoopId) rememberActiveLoop('');
  return { ok: r.ok, error: r.data?.error, loops, active };
}

function householdSwitcher(context) {
  if (!context.active || context.loops.length < 2) return null;
  const select = h('select', {
    'aria-label': 'Active loop',
    on: {
      change: (event) => {
        rememberActiveLoop(event.target.value);
        route();
      },
    },
  }, ...context.loops.map((loop) => {
    const membership = (loop.members || []).find((member) => String(member.accountId) === String(me?.id));
    const invited = membership && String(membership.status || '').toLowerCase() === 'invited';
    return h('option', { value: loop.id }, `${loop.name || 'Unnamed loop'}${invited ? ' (invitation)' : ''}`);
  }));
  select.value = String(context.active.id);
  return h('div', { class: 'household-switcher' },
    h('span', { class: 'field-label' }, 'Viewing loop'),
    select);
}

/* ==========================================================================
   Overview
   ========================================================================== */

async function renderHome() {
  const container = page('Overview', 'Your loops at a glance.', loading(3));
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
  const membershipState = (loop) => (loop.members || []).find((member) => String(member.accountId) === String(me?.id))?.status;
  const usableLoops = loopList.filter((loop) => loop.canManage === true
    || String(membershipState(loop) || '').toLowerCase() === 'accepted');
  const pendingInvitations = loopList.filter((loop) => loop.canManage !== true
    && String(membershipState(loop) || '').toLowerCase() === 'invited');
  // Each loop also carries a member record for the robot itself; it is not a
  // person and must not be counted as one.
  const peopleOf = (l) => (l.members || []).filter((m) => !(m.accountId && m.accountId === l.robot));
  const members = usableLoops.reduce((n, l) => n + peopleOf(l).length, 0);
  const unlinked = usableLoops.reduce((n, l) => n + peopleOf(l).filter((m) => !m.account).length, 0);

  body.append(h('div', { class: 'stat-grid' },
    h('article', { class: 'stat' },
      h('div', { class: 'label' }, icon('users', 14), 'Members'),
      h('div', { class: 'value', text: String(members) }),
      h('div', { class: 'note', text: `across ${usableLoops.length} loop${usableLoops.length === 1 ? '' : 's'}` })),
    h('article', { class: 'stat' },
      h('div', { class: 'label' }, icon('robot', 14), 'Robots'),
      h('div', { class: 'value', text: String(robotList.length) }),
      h('div', { class: 'note', text: robotList.length ? 'paired to this server' : 'none paired yet' })),
    h('article', { class: 'stat' },
      h('div', { class: 'label' }, icon('link', 14), 'Unlinked'),
      h('div', { class: 'value', text: String(unlinked) }),
      h('div', { class: 'note', text: unlinked ? 'members with no account' : 'every member is linked' }))));

  if (pendingInvitations.length) {
    body.append(h('div', { class: 'notice notice-warn', style: 'margin-top:1rem' }, icon('users', 16),
      h('div', {}, `${pendingInvitations.length} loop invitation${pendingInvitations.length === 1 ? '' : 's'} waiting. `,
        h('a', { class: 'link', href: '#/loop' }, 'Review invitations'))));
  }

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
    quick('#/loop', 'Loops', 'users', 'Members and account links'),
    quick('#/settings', 'Personal report', 'sliders', 'Weather, news, commute'),
    quick('#/robot', 'Robots', 'robot', 'Pairing and status'),
    quick('#/gallery', 'Gallery', 'image', 'What the robot captured')));

  if (!loops.ok) body.append(h('div', { style: 'margin-top:1.5rem' }, errorBox('Could not load your loops.', loops.data.error)));
  if (!robots.ok) body.append(h('div', { style: 'margin-top:1rem' }, errorBox('Could not load robots.', robots.data.error)));

  if (usableLoops.length) {
    const loopCard = card('Your loops', {});
    for (const l of usableLoops) {
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
   Loops and members
   ========================================================================== */

async function renderLoop() {
  show(page('Loops', 'Members, account links, and the selected loop.', loading(5)));

  const context = await householdContext();
  const container = page('Loops', 'Members, account links, and the selected loop.');

  if (!context.ok) { container.append(errorBox('Could not load your loops.', context.error)); return show(container); }
  const active = context.active;
  if (!active) {
    container.append(empty('No loops yet', 'A loop is created when your first robot is paired.', 'users'));
    return show(container);
  }

  const switcher = householdSwitcher(context);
  if (switcher) container.append(switcher);

  // Capability is decided by the server with the loop projection. Keep the
  // UI aligned with that authorization decision instead of deriving it from a
  // record identifier returned for display/association purposes.
  const isOwner = active.canManage === true;
  const myMembership = (active.members || []).find((member) => String(member.accountId) === String(me?.id));
  const isInvited = !isOwner && String(myMembership?.status || '').toLowerCase() === 'invited';
  const personName = (member, fallback = 'A loop member') => member?.nickname
    || [member?.memberProperties?.firstName, member?.memberProperties?.lastName].filter(Boolean).join(' ')
    || [member?.account?.firstName, member?.account?.lastName].filter(Boolean).join(' ')
    || fallback;

  // Source parity: a pending invitation is not a usable household. The
  // original app takes the member to an explicit accept/decline screen rather
  // than exposing owner-only controls that would fail with 403.
  if (isInvited) {
    const owner = (active.members || []).find((member) => String(member.accountId) === String(active.owner));
    const accepted = (active.members || []).filter((member) => member.accountId
      && String(member.accountId) !== String(active.robot)
      && String(member.status || '').toLowerCase() === 'accepted');
    const accept = h('button', { type: 'button', class: 'btn btn-primary' }, 'Accept invitation');
    const decline = h('button', { type: 'button', class: 'btn btn-quiet' }, 'Decline');
    accept.addEventListener('click', async () => {
      accept.disabled = true;
      const res = await api('POST', '/api/loop/accept', { loopId: active.id });
      if (res.ok) { notify('You joined this loop.'); await renderLoop(); }
      else { accept.disabled = false; notify(res.data.error || 'Could not accept invitation', 'error'); }
    });
    decline.addEventListener('click', async () => {
      const yes = await confirmDialog({
        title: `Decline ${active.name}?`,
        body: 'You will no longer see this loop. The owner can send another invitation later.',
        confirmLabel: 'Decline invitation',
      });
      if (!yes) return;
      decline.disabled = true;
      const res = await api('POST', '/api/loop/decline', { loopId: active.id });
      if (!res.ok) { decline.disabled = false; notify(res.data.error || 'Could not decline invitation', 'error'); return; }
      rememberActiveLoop('');
      location.hash = '#/';
    });
    container.append(card('Loop invitation', { sub: active.name },
      h('p', {}, 'You have been invited to join this loop. Accept to see its Jibo, gallery, and inbox.'),
      row('Invited by', personName(owner, 'The loop owner')),
      accepted.length ? row('Current members', accepted.map((member) => personName(member)).join(', ')) : null,
      h('div', { class: 'row', style: 'margin-top:1rem' }, accept, decline)));
    show(container);
    return;
  }

  /* -- the loop record ------------------------------------------------ */

  const renameForm = isOwner ? h('form', { class: 'row', on: { submit: renameLoop } },
    h('input', { name: 'name', value: active.name, required: true, 'aria-label': 'Loop name', style: 'flex:1;min-width:12rem' }),
    h('button', { type: 'submit', class: 'btn' }, 'Rename')) : null;
  const owner = (active.members || []).find((member) => String(member.accountId) === String(active.owner));

  const loopCard = card(active.name, {
    sub: active.isSuspended ? null : 'Active',
    actions: isOwner ? [h('button', {
      class: 'btn btn-sm btn-danger',
      type: 'button',
      on: { click: suspendLoop },
    }, active.isSuspended ? 'Un-suspend' : 'Suspend')] : [],
  },
    active.isSuspended
      ? h('div', { class: 'notice notice-warn' }, icon('alert', 16),
        h('div', {}, 'This loop is suspended. Member edits are blocked while it is.'))
      : null,
    row('Loop ID', h('code', { text: active.id })),
    row('Owner', isOwner
      ? h('span', {}, 'You ', h('span', { class: 'pill pill-accent' }, 'owner'))
      : personName(owner, 'Loop owner')),
    row('Robot', active.robotFriendlyId || 'none paired'),
    row('Status', active.isSuspended
      ? h('span', { class: 'pill pill-error' }, 'Suspended')
      : h('span', { class: 'pill pill-ok' }, h('span', { class: 'dot' }), 'Active')),
    !isOwner ? h('p', { class: 'field-hint' }, 'You are a member of this loop. Its owner manages members and settings.') : null,
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
    h('p', { class: 'field-hint' }, isOwner
      ? 'Linking a member to an account is what lets the robot fetch that person’s own '
        + 'weather, news and commute. Pick an account here, then press Link on the member.'
      : 'The loop owner manages member accounts and recognition settings.'),
    isOwner ? h('div', { class: 'link-picker' }, searchInput, resultsBox) : null,
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
          'This is the robot’s own place in the loop, not a person. '
          + 'It is managed from the Robots page.'));
    }

    const accountLabel = isOwner && linked
      ? (linked.email || linked.id || 'linked')
        + (linked.isActive === false ? ' (inactive)' : '')
      : (linked ? 'Linked account' : 'Not linked');

    const children = [];

    if (isOwner && state.editId === m.id) {
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

    const actions = [];
    if (isOwner) {
      actions.push(h('button', {
        class: 'link', type: 'button',
        on: { click: () => toggleLink(m) },
      }, linked ? 'Unlink' : 'Link account'));
      actions.push(h('button', {
        class: 'link', type: 'button',
        on: { click: () => { state.editId = state.editId === m.id ? null : m.id; paintMembers(); } },
      }, 'Edit'));
      actions.push(h('button', {
        class: 'link danger', type: 'button',
        on: { click: () => removeMember(m, name) },
      }, 'Remove'));
    } else if (String(m.accountId) === String(me?.id)) {
      actions.push(h('button', {
        class: 'link danger', type: 'button',
        on: { click: () => leaveLoop(m) },
      }, 'Leave loop'));
    }

    children.push(
      h('div', { class: 'member-name' }, name,
        h('span', { class: `status status-${m.status || 'invited'}`, text: m.status || 'invited' })),
      row('Account', accountLabel),
      row('Recognition record', `Face: ${m.enrolled?.face ? 'recorded' : 'not recorded'} · Voice: ${m.enrolled?.voice ? 'recorded' : 'not recorded'}`),
      isOwner && !linked ? h('div', { class: 'member-unlinked-note' }, icon('alert', 13),
        h('span', {}, 'No account linked — the robot cannot load their personal report.')) : null,
      isOwner ? h('p', { class: 'field-hint' },
        'Face and voice recognition are trained on Jibo. This console cannot start, complete, or mark a training session.') : null,
      actions.length ? h('div', { class: 'member-actions' }, ...actions) : null);

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

  if (isOwner) container.append(card('Invite a member', {},
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
      body: 'They will be removed from the loop. The robot will stop recognising them as a member.',
      confirmLabel: 'Remove',
    });
    if (!yes) return;
    const res = await api('POST', '/api/loop/members/remove', { loopId: active.id, id: m.id });
    if (res.ok) { notify('Member removed'); await renderLoop(); }
    else notify(res.data.error || 'Could not remove', 'error');
  }

  async function leaveLoop(m) {
    const yes = await confirmDialog({
      title: `Leave ${active.name}?`,
      body: 'You will lose access to this loop’s Jibo, gallery, and inbox. The owner can invite you again later.',
      confirmLabel: 'Leave loop',
    });
    if (!yes) return;
    const res = await api('POST', '/api/loop/members/remove', { loopId: active.id, id: m.id });
    if (!res.ok) { notify(res.data.error || 'Could not leave loop', 'error'); return; }
    rememberActiveLoop('');
    location.hash = '#/';
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
        title: 'Suspend this loop?',
        body: 'Member edits are blocked while a loop is suspended. You can un-suspend it again at any time.',
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

function browserTimeZone(candidate) {
  const value = typeof candidate === 'string' && candidate.trim() ? candidate.trim() : '';
  try {
    const zone = value || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    new Intl.DateTimeFormat(undefined, { timeZone: zone }).format();
    return zone;
  } catch {
    return 'UTC';
  }
}

function calendarDateKey(timestamp, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', numberingSystem: 'latn',
  }).formatToParts(new Date(timestamp));
  const values = Object.fromEntries(parts.filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function calendarMonthLabel(cursor, timeZone) {
  // Format midday on the selected civil month, not UTC midnight: western timezones
  // would otherwise display the previous month for a cursor at the first UTC instant.
  const sample = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth(), 15, 12));
  return new Intl.DateTimeFormat(undefined, { timeZone, month: 'long', year: 'numeric' }).format(sample);
}

function calendarCursorForToday(timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', numberingSystem: 'latn',
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
  return new Date(Date.UTC(Number(values.year), Number(values.month) - 1, 1));
}

function calendarMonthWindow(cursor) {
  const year = cursor.getUTCFullYear();
  const month = cursor.getUTCMonth();
  const firstDay = new Date(Date.UTC(year, month, 1)).getUTCDay();
  const gridStart = Date.UTC(year, month, 1 - firstDay);
  const gridEnd = gridStart + 42 * 86400000;
  return {
    start: new Date(gridStart - 2 * 86400000).toISOString(),
    end: new Date(gridEnd + 2 * 86400000).toISOString(),
  };
}

function maskedCalendarUrl(value) {
  try {
    const url = new URL(value);
    // Subscription paths often contain an opaque provider token. They are
    // useful to distinguish two calendars, but never useful at full length in
    // a compact account row (and an unbroken path must not set the page width).
    const path = url.pathname.length > 56
      ? `${url.pathname.slice(0, 38)}…${url.pathname.slice(-14)}`
      : url.pathname;
    const label = `${url.protocol}//${url.host}${path}${url.search ? ' · query hidden' : ''}`;
    return label.length > 96 ? `${label.slice(0, 78)}…${label.slice(-16)}` : label;
  } catch {
    return 'Saved calendar link';
  }
}

function calendarStatus(subscription) {
  const status = subscription.verification?.status || 'unknown';
  return {
    label: status === 'ok' ? 'Verified' : status === 'invalid' ? 'Needs attention' : 'Not checked',
    className: status === 'ok' ? 'status-ok' : status === 'invalid' ? 'status-error' : 'status-unknown',
  };
}

function createCalendarManager({ subscriptions: initialSubscriptions, timeZone: initialTimeZone }) {
  let subscriptions = Array.isArray(initialSubscriptions) ? initialSubscriptions : [];
  let timeZone = browserTimeZone(initialTimeZone);
  let cursor = calendarCursorForToday(timeZone);
  let editingId = null;

  const root = h('div', { class: 'ical-manager' });
  const list = h('div', { class: 'ical-subscription-list' });
  const preview = h('div', { class: 'ical-preview' });
  const helper = h('p', { class: 'field-hint ical-manager-hint' },
    'Paste a read-only iCal subscription URL. Phoenix checks it now, keeps bad links editable, and caches the parsed events for the report.');
  const labelInput = h('input', { type: 'text', maxlength: 120, placeholder: 'e.g. Family', autocomplete: 'off' });
  const urlInput = h('input', { type: 'url', inputmode: 'url', placeholder: 'https://calendar.example.com/feed.ics', autocomplete: 'url' });
  const timeZoneInput = h('input', {
    type: 'text', name: 'calendarTimeZone', value: timeZone, placeholder: 'America/New_York',
    spellcheck: 'false', autocomplete: 'off',
  });
  const addButton = h('button', { type: 'button', class: 'btn btn-primary btn-sm' }, 'Save calendar link');
  const cancelButton = h('button', { type: 'button', class: 'btn btn-sm', hidden: true }, 'Cancel edit');
  const addStatus = h('p', { class: 'field-hint ical-add-status', role: 'status', 'aria-live': 'polite' });

  function renderSubscriptions() {
    if (!subscriptions.length) {
      list.replaceChildren(empty('No calendars linked', 'Add a read-only iCal URL above to see its events here.', 'calendar'));
      return;
    }
    list.replaceChildren(...subscriptions.map((subscription) => {
      const state = calendarStatus(subscription);
      const enabled = h('input', { type: 'checkbox', checked: subscription.enabled !== false, 'aria-label': `Use ${subscription.label}` });
      enabled.addEventListener('change', async () => {
        enabled.disabled = true;
        const result = await api('PUT', `/api/calendar/subscriptions/${encodeURIComponent(subscription.id)}`, { enabled: enabled.checked });
        if (!result.ok) enabled.checked = subscription.enabled !== false;
        else await reloadSubscriptions();
        enabled.disabled = false;
      });
      const verify = h('button', {
        type: 'button', class: 'btn btn-sm', on: { click: async () => {
          verify.disabled = true;
          const result = await api('POST', `/api/calendar/subscriptions/${encodeURIComponent(subscription.id)}/verify`);
          verify.disabled = false;
          if (result.ok) { notify(result.data.subscription.verification.status === 'ok' ? 'Calendar verified' : 'Calendar still needs attention', result.data.subscription.verification.status === 'ok' ? 'ok' : 'error'); await reloadSubscriptions(); }
          else notify(result.data.error || 'Could not verify calendar', 'error');
        } },
      }, 'Verify');
      const edit = h('button', {
        type: 'button', class: 'btn btn-sm', on: { click: () => {
          editingId = subscription.id;
          labelInput.value = subscription.label || '';
          urlInput.value = subscription.url || '';
          addButton.textContent = 'Update calendar link';
          cancelButton.hidden = false;
          urlInput.focus();
        } },
      }, 'Edit');
      const remove = h('button', {
        type: 'button', class: 'btn btn-sm btn-danger', on: { click: async () => {
          const yes = await confirmDialog({ title: 'Remove this calendar?', body: `Remove ${subscription.label} from the account?`, confirmLabel: 'Remove' });
          if (!yes) return;
          const result = await api('DELETE', `/api/calendar/subscriptions/${encodeURIComponent(subscription.id)}`);
          if (result.ok) { notify('Calendar removed'); await reloadSubscriptions(); }
          else notify(result.data.error || 'Could not remove calendar', 'error');
        } },
      }, 'Remove');
      const error = subscription.verification?.status === 'invalid'
        ? h('p', { class: 'ical-subscription-error', text: subscription.verification.lastError || 'The link could not be verified.' }) : null;
      return h('article', { class: 'ical-subscription' },
        h('div', { class: 'ical-subscription-main' },
          h('div', { class: 'ical-subscription-title' },
            h('span', { class: 'ical-enabled' }, enabled),
            h('strong', { text: subscription.label }),
            h('span', { class: `status-badge ${state.className}`, text: state.label })),
          h('div', { class: 'ical-subscription-url', text: maskedCalendarUrl(subscription.url) }),
          h('div', { class: 'ical-subscription-meta' },
            `${subscription.verification?.eventCount || 0} events`,
            subscription.verification?.lastChecked ? ` · checked ${fmtDate(subscription.verification.lastChecked)}` : ''),
          error),
        h('div', { class: 'ical-subscription-actions' }, verify, edit, remove));
    }));
  }

  function renderMonth(events) {
    const eventByDay = new Map();
    for (const event of events || []) {
      if (!event?.start?.timestamp) continue;
      const key = calendarDateKey(event.start.timestamp, timeZone);
      if (!eventByDay.has(key)) eventByDay.set(key, []);
      eventByDay.get(key).push(event);
    }
    const year = cursor.getUTCFullYear();
    const month = cursor.getUTCMonth();
    const firstDay = new Date(Date.UTC(year, month, 1)).getUTCDay();
    const today = calendarDateKey(Date.now(), timeZone);
    const cells = [];
    for (let index = 0; index < 42; index += 1) {
      const civil = new Date(Date.UTC(year, month, 1 + index - firstDay));
      const key = `${civil.getUTCFullYear()}-${String(civil.getUTCMonth() + 1).padStart(2, '0')}-${String(civil.getUTCDate()).padStart(2, '0')}`;
      const dayEvents = eventByDay.get(key) || [];
      cells.push(h('div', { class: `calendar-day${civil.getUTCMonth() === month ? '' : ' outside'}${key === today ? ' today' : ''}` },
        h('span', { class: 'calendar-day-number', text: civil.getUTCDate() }),
        h('div', { class: 'calendar-day-events' }, dayEvents.slice(0, 4).map((event) => h('div', {
          class: `calendar-event${event.fullDay ? ' all-day' : ''}`, title: event.summary || 'Calendar event',
        }, event.fullDay ? (event.summary || 'Untitled') : `${new Intl.DateTimeFormat(undefined, { timeZone, timeStyle: 'short' }).format(new Date(event.start.timestamp))} · ${event.summary || 'Untitled'}`))),
        dayEvents.length > 4 ? h('span', { class: 'calendar-more', text: `+${dayEvents.length - 4} more` }) : null));
    }
    const header = h('div', { class: 'ical-preview-head' },
      h('div', {}, h('h4', { text: calendarMonthLabel(cursor, timeZone) }), h('p', { text: `${events.length} event${events.length === 1 ? '' : 's'} · ${timeZone}` })),
      h('div', { class: 'ical-preview-nav' },
        h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Previous month', on: { click: () => { cursor = new Date(Date.UTC(year, month - 1, 1)); loadEvents(); } } }, icon('back', 16)),
        h('button', { type: 'button', class: 'btn btn-sm', on: { click: () => { cursor = calendarCursorForToday(timeZone); loadEvents(); } } }, 'Today'),
        h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Next month', on: { click: () => { cursor = new Date(Date.UTC(year, month + 1, 1)); loadEvents(); } } }, icon('arrow', 16))));
    const weekLabels = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((day) => h('span', { class: 'calendar-weekday', text: day }));
    preview.replaceChildren(header, h('div', { class: 'calendar-grid' }, ...weekLabels, ...cells));
  }

  async function loadEvents() {
    if (!subscriptions.length) {
      preview.replaceChildren(empty('Your calendar preview starts here', 'Verify a subscription to populate a live month view.', 'calendar'));
      return;
    }
    if (!subscriptions.some((subscription) => subscription.verification?.status === 'ok')) {
      preview.replaceChildren(errorBox('Calendar preview unavailable', 'At least one subscription must verify successfully before Phoenix can show events.'));
      return;
    }
    preview.replaceChildren(h('div', { class: 'ical-preview-loading' }, loading(7)));
    const window = calendarMonthWindow(cursor);
    const result = await api('GET', `/api/calendar/events?start=${encodeURIComponent(window.start)}&end=${encodeURIComponent(window.end)}`);
    if (!result.ok) {
      preview.replaceChildren(errorBox('Could not load the calendar preview.', result.data.error));
      return;
    }
    renderMonth(result.data.events || []);
  }

  async function reloadSubscriptions() {
    const result = await api('GET', '/api/calendar/subscriptions');
    if (!result.ok) {
      list.replaceChildren(errorBox('Could not load calendar subscriptions.', result.data.error));
      preview.replaceChildren(errorBox('Could not load the calendar preview.', result.data.error));
      return;
    }
    subscriptions = result.data.subscriptions || [];
    timeZone = browserTimeZone(result.data.timeZone || timeZone);
    timeZoneInput.value = timeZone;
    renderSubscriptions();
    await loadEvents();
  }

  addButton.addEventListener('click', async () => {
    const url = urlInput.value.trim();
    if (!url) { addStatus.textContent = 'Paste an iCal URL first.'; return; }
    addButton.disabled = true;
    cancelButton.disabled = true;
    addStatus.textContent = editingId ? 'Updating and verifying…' : 'Saving and verifying…';
    const path = editingId ? `/api/calendar/subscriptions/${encodeURIComponent(editingId)}` : '/api/calendar/subscriptions';
    const result = await api(editingId ? 'PUT' : 'POST', path, { label: labelInput.value.trim() || 'Calendar', url, enabled: true });
    addButton.disabled = false;
    cancelButton.disabled = false;
    if (!result.ok) {
      addStatus.textContent = result.data.error || 'Could not save this calendar.';
      return;
    }
    const status = result.data.subscription.verification.status;
    notify(status === 'ok' ? 'Calendar linked' : 'Calendar saved — needs attention', status === 'ok' ? 'ok' : 'error');
    editingId = null;
    labelInput.value = '';
    urlInput.value = '';
    addButton.textContent = 'Save calendar link';
    cancelButton.hidden = true;
    addStatus.textContent = status === 'ok' ? 'Verified and ready for the report.' : 'Saved safely. Fix the link or verify it again when ready.';
    await reloadSubscriptions();
  });
  cancelButton.addEventListener('click', () => {
    editingId = null;
    labelInput.value = '';
    urlInput.value = '';
    addButton.textContent = 'Save calendar link';
    cancelButton.hidden = true;
    addStatus.textContent = '';
  });
  timeZoneInput.addEventListener('change', () => {
    timeZone = browserTimeZone(timeZoneInput.value);
    timeZoneInput.value = timeZone;
    loadEvents();
  });

  root.append(
    helper,
    h('div', { class: 'ical-add-grid' },
      field('Calendar name', labelInput, 'A name only you will see in this account.'),
      field('iCal subscription URL', urlInput, 'http, https, and webcal links are supported.'),
      field('Display timezone', timeZoneInput, 'Events are laid out in this IANA timezone.')),
    h('div', { class: 'ical-add-actions' }, addButton, cancelButton, addStatus),
    list,
    preview);
  renderSubscriptions();
  loadEvents();
  return { element: root };
}

/* ==========================================================================
   Personal report settings
   ========================================================================== */

async function renderSettings() {
  show(page('Personal report', 'What the robot includes when you ask for your report.', loading(6)));

  const [r, calendarRes] = await Promise.all([
    api('GET', '/api/settings'),
    api('GET', '/api/calendar/subscriptions'),
  ]);
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

  const calendarManager = createCalendarManager({
    subscriptions: calendarRes.ok ? calendarRes.data.subscriptions : (s.calendar.icalSubscriptions || []),
    timeZone: calendarRes.ok ? calendarRes.data.timeZone : s.calendar.timeZone,
  });
  const calendar = h('fieldset', { class: 'calendar-fieldset' },
    h('legend', {}, 'Calendar'),
    toggle('calendar', s.calendar.active, 'Read your calendar', 'Use verified iCal subscriptions in the robot’s report.'),
    calendarManager.element);

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
      // The four legacy credential flags stay in storage for report compatibility,
      // but this editor no longer pretends that a checkbox links a provider.
      calendar: { active: !!fd.calendar, timeZone: fd.calendarTimeZone || undefined },
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
    toggle('messagingAllowed', a.messagingAllowed ?? true, 'Receive Jibo messages',
      'Let other people in your loops send you messages through the robot.'),
    field('Message alerts', h('select', { name: 'jotNotificationMode' },
      h('option', { value: 'tagged', selected: a.jotNotificationMode === 'tagged' }, 'Only when I am selected'),
      h('option', { value: 'always', selected: a.jotNotificationMode === 'always' }, 'For every loop message'),
      h('option', { value: 'none', selected: a.jotNotificationMode === 'none' }, 'Do not alert me')),
    'Controls visible browser alerts after you enable notifications on this device.'),
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
      jotNotificationMode: fd.jotNotificationMode,
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
    notify(res.ok ? 'Check the new email address to confirm the change.' : (res.data.error || 'Could not change email'), res.ok ? 'ok' : 'error');
    if (res.ok) mailForm.reset();
  });
  container.append(card('Change email address', {
    sub: 'Your address stays unchanged until you confirm the link sent to the new inbox.',
  }, mailForm));

  // The PWA remains optional: all console functionality still works in the
  // mobile browser. This card is the explicit, user-controlled place to
  // install it or grant notification permission.
  const pwaCard = card('Jibo app and notifications', {
    sub: 'Install the console, then choose whether this browser may alert you.',
  }, loading(3));
  container.append(pwaCard);

  show(container);

  const pwaBody = pwaCard.querySelector('.card-body');
  const state = await browserPushState(api);
  const capabilities = state.capabilities;
  const installDetail = capabilities.installed
    ? 'Installed on this device.'
    : capabilities.canPromptInstall
      ? 'Add the console to this device for a full-screen app experience.'
      : capabilities.ios
        ? 'In Safari, use Share → Add to Home Screen to install the Jibo app.'
        : 'Use your browser’s Install app option to add the console to this device.';
  const installButton = capabilities.canPromptInstall
    ? h('button', {
      type: 'button', class: 'btn btn-secondary',
      on: { click: async () => {
        const result = await promptInstall();
        notify(result.accepted ? 'The app is being installed.' : 'Install was not completed.', result.accepted ? 'ok' : 'error');
        await renderProfile();
      } },
    }, 'Install app')
    : null;
  const rows = [
    row('App', h('span', { class: capabilities.installed ? 'pill pill-ok' : 'pill' },
      capabilities.installed ? 'Installed' : 'Browser version')),
    h('p', { class: 'field-hint' }, installDetail),
    installButton,
  ];

  if (!capabilities.push) {
    rows.push(h('div', { class: 'notice notice-error' }, icon('alert', 16),
      h('div', {}, 'Browser notifications are unavailable here.',
        h('div', { class: 'field-hint', style: 'margin-top:.3rem' },
          capabilities.secure ? 'This browser does not provide the Web Push APIs.' : 'Open the console over HTTPS to use notifications.'))));
  } else if (!state.server.ok || !state.server.data.available) {
    rows.push(row('Notifications', h('span', { class: 'pill pill-warn' }, 'Not configured')),
      h('p', { class: 'field-hint' }, state.server.data?.reason || state.server.data?.error
        || 'This server has not enabled browser notifications yet.'));
  } else if (state.permission === 'denied') {
    rows.push(row('Notifications', h('span', { class: 'pill pill-warn' }, 'Blocked')),
      h('p', { class: 'field-hint' }, 'Allow notifications for this site in your browser settings, then return here.'));
  } else if (state.subscription) {
    const actions = h('div', { class: 'row', style: 'margin-top:.9rem;gap:.65rem;flex-wrap:wrap' },
      h('button', { type: 'button', class: 'btn btn-secondary', on: { click: async () => {
        const result = await api('POST', '/api/web-push/test');
        notify(result.ok ? 'Test notification requested.' : (result.data.error || 'Could not send a test notification.'), result.ok ? 'ok' : 'error');
      } } }, 'Send test'),
      h('button', { type: 'button', class: 'btn btn-danger', on: { click: async () => {
        try {
          await disableBrowserPush(api);
          notify('Notifications disabled on this browser.');
          await renderProfile();
        } catch (error) { notify(error.message || 'Could not disable notifications.', 'error'); }
      } } }, 'Disable here'));
    rows.push(row('Notifications', h('span', { class: 'pill pill-ok' }, h('span', { class: 'dot dot-live' }), 'Enabled on this browser')),
      h('p', { class: 'field-hint' }, 'New loop messages can alert this device. Notification previews never include message text.'), actions);
  } else {
    rows.push(row('Notifications', h('span', { class: 'pill pill-warn' }, 'Off')),
      h('p', { class: 'field-hint' }, capabilities.ios && !capabilities.installed
        ? 'Install the app from Safari’s Share menu first, then enable notifications here.'
        : 'Enable only if this is a device you trust.'),
      h('button', { type: 'button', class: 'btn btn-primary', disabled: capabilities.ios && !capabilities.installed,
        on: { click: async () => {
          try {
            await enableBrowserPush(api);
            notify('Notifications enabled on this browser.');
            await renderProfile();
          } catch (error) { notify(error.message || 'Could not enable notifications.', 'error'); }
        } },
      }, 'Enable notifications'));
  }
  pwaBody.replaceChildren(...rows.filter(Boolean));
}

/* ==========================================================================
   Robots
   ========================================================================== */

async function renderRobot() {
  show(page('Robots', 'Your Jibos and their current connection status.', loading(3)));

  const robots = await api('GET', '/api/robots');
  const container = page('Robots', 'Connection status is checked when this page opens.');
  container.querySelector('.page-head').append(h('div', { class: 'row' },
    h('button', { class: 'btn btn-quiet', type: 'button', on: { click: renderRobot } }, icon('refresh', 15), 'Refresh status'),
    h('a', { class: 'btn btn-primary', href: '#/add' }, icon('plus', 15), 'Add a Jibo')));

  if (!robots.ok) { container.append(errorBox('Could not load robots.', robots.data.error)); return show(container); }
  const list = Array.isArray(robots.data) ? robots.data : [];
  setBadge('badge-robots', list.length);

  if (!list.length) {
    container.append(card('Add your first Jibo', {},
      h('p', { class: 'instruct' }, 'Start with the state your Jibo is in today.'),
      h('p', { class: 'field-hint' }, 'First check whether Jibo has been pointed at this server. A robot on its setup screen may still be trying to reach the old cloud.'),
      h('div', { class: 'row', style: 'margin-top:1.25rem' },
        h('a', { class: 'btn btn-primary', href: '#/add' }, icon('plus', 15), 'Add a Jibo'))));
    return show(container);
  }

  for (const robot of list) {
    const detail = h('div', {});
    const c = card(robot.friendlyId, {
      sub: meaningfulText(robot.loopName) || 'No loop name',
      actions: [h('button', {
        class: 'btn btn-sm', type: 'button',
        on: { click: (e) => loadDetail(e.currentTarget, robot, detail) },
      }, 'View details')],
    },
      row('Loop', meaningfulText(robot.loopName) || '—'),
      row('Access', robot.canManage ? 'Owner' : 'Shared with you'),
      row('Connection', connectionStatus(robot.connection)),
      row('Created', fmtDate(robot.created)),
      row('Last seen', robotLastSeen(robot.lastSeen)),
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
    const payload = d.getRobot?.payload && typeof d.getRobot.payload === 'object' && !Array.isArray(d.getRobot.payload)
      ? d.getRobot.payload : {};
    const remoteEnabled = typeof payload.remoteEnabled === 'boolean' ? payload.remoteEnabled : null;
    const ssid = meaningfulText(payload.SSID);
    const location = [payload.city, payload.state, payload.country].map(meaningfulText).filter(Boolean).join(', ');
    const timezone = meaningfulText(payload.timezone);
    const platform = meaningfulText(payload.platform);
    const serialNumber = meaningfulText(payload.serialNumber);
    host.replaceChildren(
      row('Loop', meaningfulText(d.loop?.name) || '—'),
      row('Status', d.loop?.isSuspended
        ? h('span', { class: 'pill pill-error' }, 'Suspended')
        : h('span', { class: 'pill pill-ok' }, h('span', { class: 'dot' }), 'Active')),
      row('Connection', connectionStatus(d.connection)),
      row('Last seen', robotLastSeen(d.robot?.lastSeen)),
      ssid ? row('Wi-Fi network', ssid) : null,
      location ? row('Location', location) : null,
      timezone ? row('Timezone', timezone) : null,
      platform ? row('Platform', platform) : null,
      serialNumber ? row('Serial number', serialNumber) : null,
      remoteEnabled === null ? null : row('Remote access', remoteEnabled ? 'Enabled' : 'Disabled'),
      d.diagnostics
        ? h('div', { class: 'notice notice-warn' }, icon('alert', 16),
          h('div', {}, 'Additional robot status is unavailable right now. Basic loop information is still shown.'))
        : null);
  }
}

/* ==========================================================================
   Claim an already-paired robot
   ========================================================================== */

async function renderClaim() {
  const container = page('Migrate an existing Jibo',
    'Move a Jibo that was set up before to jibo.io and link it to this account.');
  container.querySelector('.page-head').prepend(
    h('a', { class: 'link', href: '#/add', style: 'display:inline-flex;align-items:center;gap:.35rem;margin-bottom:.75rem' },
      icon('back', 14), 'Choose a different path'));

  const result = h('div', { hidden: true });
  const request = h('button', { type: 'button', class: 'btn btn-primary' },
    icon('link', 15), 'Create migration command');
  request.addEventListener('click', async () => {
    request.disabled = true;
    const res = await api('POST', '/api/robots/claim-code', {});
    request.disabled = false;
    result.hidden = false;
    if (!res.ok) {
      result.replaceChildren(errorBox('Could not create a migration command.', res.data?.error));
      return;
    }
    const publicJiboIo = /(^|\.)jibo\.io$/i.test(location.hostname);
    const host = res.data.repointHost || '<server-ip>';
    const adoptionUrl = `${location.origin}${res.data.adoptionPath || '/api/adopt-robot'}`;
    // jibo.io uses the public-DNS/Let's Encrypt repointer, so a customer does
    // not need a copy of the server CA. Other deployments retain the generic
    // private-CA command and receive their configured public IP explicitly.
    const scriptUrl = 'https://jibo.io/robot-ota-repoint.sh';
    const command = publicJiboIo
      ? [
        `curl --fail --remote-name ${scriptUrl}`,
        `bash ./robot-ota-repoint.sh --robot root@<robot-ip> --claim-code ${res.data.code} --yes`,
      ].join(' && ')
      : [
        'scripts/parity-robot/repoint-robot.sh',
        '--robot root@<robot-ip>',
        `--phoenix ${host}`,
        `--claim-code ${res.data.code}`,
        `--adoption-url ${adoptionUrl}`,
        '--yes',
      ].join(' ');
    const expiry = fmtDate(res.data.expires);
    result.replaceChildren(
      h('div', { class: 'notice notice-warn' },
        h('strong', {}, 'One use only.'), ' This private command expires ', expiry,
        '. Do not share it; it links whichever robot proves possession to your account.'),
      h('p', { class: 'instruct' },
        'Run this on the computer that can SSH as root to your Jibo. Replace only ',
        h('code', {}, '<robot-ip>'), '. The command reads the existing robot credentials over SSH; do not copy those credentials into this site.'),
      publicJiboIo ? h('p', { class: 'field-hint' },
        'The command downloads the public script first. You can ',
        h('a', { href: scriptUrl, download: 'robot-ota-repoint.sh' }, 'download and inspect it'),
        ' before running this single command.') : null,
      h('div', { class: 'restart-cmd' },
        h('span', { class: 'prompt' }, '$'), h('code', { text: command }), copyButton(() => command)),
      !publicJiboIo && !res.data.repointHost ? h('p', { class: 'field-hint' },
        'This server has not published its robot-repoint IP, so replace ', h('code', {}, '<server-ip>'),
        ' with the public IP the robot should reach.') : null,
      h('p', { class: 'field-hint' },
        'It keeps the robot’s existing credentials, does not import the former cloud account or its people, and links the robot to this account.'),
      h('ol', { class: 'field-hint' },
        h('li', {}, 'Run the command and wait for it to report that the robot was claimed.'),
        h('li', {}, 'Keep Jibo powered and online while its regular updater checks the jibo.io catalog.'),
        h('li', {}, 'Return to ', h('a', { href: '#/robot' }, 'Robots'), ' and refresh its status.')));
  });

  container.append(
    card('Before you start', {},
      h('p', { class: 'instruct' }, 'Choose this only for a Jibo that was set up before and still has its robot credentials.'),
      h('p', { class: 'field-hint' }, 'This computer needs owner-authorized root SSH access to the robot. Confirm ',
        h('code', {}, 'ssh root@<robot-ip> true'), ' works without asking for a password.'),
      h('p', { class: 'field-hint' }, 'If Jibo is on its setup screen, its old credentials cannot be claimed. Use ',
        h('a', { href: '#/add' }, 'the setup-screen path'), ' instead.')),
    card('Get your migration command', {},
      h('p', { class: 'instruct' }, 'Create the short-lived account-linking command only when you are ready to run it.'),
      h('div', { class: 'row', style: 'margin-top:1.25rem' }, request),
      result));
  show(container);
}

/* ==========================================================================
   Connect a robot — first establish cloud target, then setup state
   ========================================================================== */

let pollTimer = null;
function stopPoll() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }

function renderAdd() {
  const container = page('Add a Jibo', 'Two quick questions will take you to the right setup path.');
  const cloudName = /(^|\.)jibo\.io$/i.test(location.hostname) ? 'jibo.io' : 'this Phoenix server';
  container.querySelector('.page-head').prepend(
    h('a', { class: 'link', href: '#/robot', style: 'display:inline-flex;align-items:center;gap:.35rem;margin-bottom:.75rem' },
      icon('back', 14), 'Back to robots'));
  const next = h('div', {});
  const chooseTarget = (alreadyPointed) => {
    next.replaceChildren(card('2. What is Jibo showing now?', {},
      h('p', { class: 'field-hint' }, alreadyPointed
        ? 'Since it already reaches this server, choose its current setup state.'
        : 'We will repoint it first. Choose its current setup state so the helper uses the correct credential path.'),
      h('div', { class: 'row', style: 'margin-top:1.25rem' },
        h('a', { class: 'btn btn-primary', href: alreadyPointed ? '#/add/new' : '#/add/repoint-oobe' },
          icon('plus', 15), 'Setup screen / no credentials'),
        h('a', { class: 'btn', href: '#/claim' }, icon('link', 15), 'Already set up / has credentials')),
      h('p', { class: 'field-hint' }, 'The setup-screen path uses QR pairing. The already-set-up path uses the robot’s existing credentials and a one-time account claim.'),
      h('button', { type: 'button', class: 'btn btn-quiet', on: { click: () => { next.replaceChildren(); } } },
        'Change my answer')));
  };
  container.append(card(`1. Has this Jibo already been pointed at ${cloudName}?`, {},
    h('p', { class: 'instruct' }, 'A factory-reset Jibo may show a setup screen while still pointing at the original, offline cloud.'),
    h('div', { class: 'row', style: 'margin-top:1.25rem' },
      h('button', { type: 'button', class: 'btn btn-primary', on: { click: () => chooseTarget(true) } }, 'Yes'),
      h('button', { type: 'button', class: 'btn', on: { click: () => chooseTarget(false) } }, 'No'),
      h('button', { type: 'button', class: 'btn', on: { click: () => chooseTarget(false) } }, 'I’m not sure')),
    h('p', { class: 'field-hint' }, '“No” and “I’m not sure” use the same safe repoint check. You will need owner-authorized root SSH access.')),
  next,
  h('p', { class: 'field-hint' }, 'Need more context? Read the ', h('a', { href: '/guide' }, 'public guide'), '.'));
  show(container);
}

function renderAddRepointOobe() {
  const container = page('Repoint a Jibo on its setup screen',
    'Point an unprovisioned Jibo at jibo.io, then complete normal QR setup.');
  container.querySelector('.page-head').prepend(
    h('a', { class: 'link', href: '#/add', style: 'display:inline-flex;align-items:center;gap:.35rem;margin-bottom:.75rem' },
      icon('back', 14), 'Choose a different path'));
  if (!/(^|\.)jibo\.io$/i.test(location.hostname)) {
    container.append(card('This helper is for jibo.io', {},
      h('p', { class: 'instruct' }, 'This one-command repoint targets jibo.io and its public certificate. For another Phoenix server, use that server’s own deployment instructions before QR setup.')));
    return show(container);
  }
  const scriptUrl = 'https://jibo.io/robot-ota-repoint.sh';
  const dryRun = `curl --fail --remote-name ${scriptUrl} && bash ./robot-ota-repoint.sh --robot root@<robot-ip> --oobe --dry-run`;
  const apply = 'bash ./robot-ota-repoint.sh --robot root@<robot-ip> --oobe --yes';
  container.append(
    card('Before you start', {},
      h('p', { class: 'instruct' }, 'Jibo must have no active robot credentials and be reachable by root SSH. It may currently be in a developer mode used to get SSH; the helper sets its next boot to OOBE.'),
      h('p', { class: 'field-hint' }, 'From the computer where you will run the command, make sure ',
        h('code', {}, 'ssh root@<robot-ip> true'), ' succeeds without a password prompt. The helper does not install SSH access or reset the robot.'),
      h('p', { class: 'field-hint' }, 'If Jibo is already on the setup screen but has not been repointed, do this before generating a QR code. Do not reboot between obtaining SSH access and repointing if reboot would close SSH.')),
    card('1. Review the repoint plan', {},
      h('p', { class: 'instruct' }, 'Download the public helper and run its read-only plan first. You can ',
        h('a', { href: scriptUrl, download: 'robot-ota-repoint.sh' }, 'inspect the script'), ' before running it.'),
      h('div', { class: 'restart-cmd' }, h('span', { class: 'prompt' }, '$'), h('code', { text: dryRun }), copyButton(() => dryRun))),
    card('2. Point Jibo at jibo.io', {},
      h('p', { class: 'instruct' }, 'Run this only when the plan names your Jibo. It prepares OOBE for the next boot, does not adopt old credentials, and makes no account record. It can be rerun if the first attempt is interrupted.'),
      h('div', { class: 'restart-cmd' }, h('span', { class: 'prompt' }, '$'), h('code', { text: apply }), copyButton(() => apply))),
    card('3. Finish normal setup', {},
      h('p', { class: 'instruct' }, 'After the helper confirms OOBE mode and no credentials, reboot Jibo and return to its setup screen. Create a QR code in this account and let Jibo scan it. That step creates and links its new robot account.'),
      h('p', { class: 'field-hint' }, 'Use the QR path, not a migration claim code. If Jibo already knows your Wi-Fi, it may skip the Wi-Fi portion of setup; that does not change the account-pairing step.'),
      h('a', { class: 'btn btn-primary', href: '#/add/new' }, icon('plus', 15), 'Continue to QR setup')));
  show(container);
}

/* ==========================================================================
   Add a new/factory-reset robot — QR pairing
   ========================================================================== */

async function renderAddNew() {
  const container = page('Set up a robot', 'Show the code to the robot and it will join your network.');
  container.querySelector('.page-head').prepend(
    h('a', { class: 'link', href: '#/add', style: 'display:inline-flex;align-items:center;gap:.35rem;margin-bottom:.75rem' },
      icon('back', 14), 'Choose a different path'));

  container.append(h('div', { class: 'notice notice-warn' }, icon('alert', 16),
    h('div', {}, 'This works only after Jibo has been pointed at this server. If it is still trying to reach the original cloud, ',
      h('a', { href: '#/add/repoint-oobe' }, 'repoint it first'), '.')));
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
      // qrSvg() returns SVG *markup*. It must go in as markup: a plain string
      // child is appended as a text node, which is why the setup code used to
      // render as a wall of literal <svg> source instead of a scannable code.
      h('div', { html: qrSvg(codes[(frame + i) % codes.length], 5) })));
    paint();

    const qrCard = card('Setup code', { sub: `${codes.length} frames · valid for 15 minutes` },
      h('p', { class: 'instruct' }, 'Open the robot’s setup screen and hold this up to its eye.'),
      holder,
      h('p', { class: 'field-hint', style: 'text-align:center' }, 'Tap the codes to advance the frames.'),
      status);
    container.append(qrCard);

    stopPoll();
    pollTimer = setInterval(async () => {
      const res = await api('GET', `/api/robots/setup/status?token=${encodeURIComponent(r.data.token)}`);
      if (res.ok && res.data.expired) {
        stopPoll();
        status.replaceChildren('This setup code has expired. Make a new one and scan it again.');
        status.style.color = 'var(--warn)';
        const again = h('button', { type: 'button', class: 'btn btn-primary', on: { click: () => {
          qrCard.remove();
          formCard.hidden = false;
          form.requestSubmit();
        } } }, 'Make a new code');
        qrCard.append(h('div', { class: 'row', style: 'justify-content:center;margin-top:1rem' }, again));
      } else if (res.ok && res.data.complete) {
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
  show(page('Gallery', 'Photographs and media captured across your loops.', loading(3)));

  const context = await householdContext();
  const container = page('Gallery', 'Photographs and media captured across your loops.');
  if (!context.ok) { container.append(errorBox('Could not load your loops.', context.error)); return show(container); }
  // The native Jibo gallery was a single, date-sorted timeline spanning every
  // accepted loop. Do the same here: a person with two Jibos should never have
  // to guess which household contains a photo.
  const visibleLoops = context.loops.filter((candidate) => candidate.canManage === true
    || (candidate.members || []).some((member) => String(member.accountId) === String(me?.id)
      && String(member.status || '').toLowerCase() === 'accepted'));
  if (!visibleLoops.length) {
    container.append(empty('No loop', 'Accept a loop invitation or pair a robot first.', 'image'));
    return show(container);
  }

  const responses = await Promise.all(visibleLoops.map(async (loop) => ({
    loop,
    result: await api('GET', `/api/media?loopId=${encodeURIComponent(loop.id)}`),
  })));
  const failures = responses.filter(({ result }) => !result.ok);
  // Media.List expands each parent once more for every thumbnail, with the
  // expanded thumbnail carrying `reference: <parent path>`. A gallery tile
  // represents the parent capture; use its ordinary thumbnail as the preview
  // when available, and retain the parent image for the full-size viewer.
  const items = responses.flatMap(({ loop, result }) => (result.ok ? (result.data.media || []) : [])
    .filter((m) => !m.isDeleted && m.url && !m.reference)
    .map((m) => {
      const thumbs = Array.isArray(m.thumbs) ? m.thumbs.filter((thumb) => thumb && thumb.url && thumb.path) : [];
      const preview = thumbs.find((thumb) => thumb.type === 'thumb') || thumbs[0] || m;
      return {
        ...m, loopId: loop.id, loopName: loop.name, previewPath: preview.path,
        // Media.Remove is owner-only in the original service. A shared-loop
        // gallery stays readable, but must not offer a delete control that
        // cannot possibly alter the capture.
        canDelete: loop.canManage === true,
      };
    }))
    .sort((a, b) => Number(b.created || 0) - Number(a.created || 0));
  if (failures.length) {
    container.append(h('div', { class: 'notice notice-warn' }, icon('alert', 16),
      h('div', {}, `Could not load media from ${failures.length} loop${failures.length === 1 ? '' : 's'}. The rest of your gallery is still shown.`)));
  }
  if (!items.length) {
    container.append(failures.length === responses.length
      ? errorBox('Could not load the gallery.', failures[0]?.result.data.error)
      : empty('Nothing captured yet', 'Photographs the robot takes will appear here.', 'image'));
    return show(container);
  }

  const selected = new Map();
  const deleteBtn = h('button', {
    class: 'btn btn-danger btn-sm', type: 'button', disabled: true,
    on: { click: removeSelected },
  }, 'Delete selected');

  const imageUrl = (value) => {
    const path = typeof value === 'string' ? value : (value?.path || '').split('/').pop();
    if (!/^[A-Za-z0-9_-]+$/.test(path)) return '';
    return `/api/media/blob/${path}`;
  };

  const syncDelete = () => {
    deleteBtn.disabled = selected.size === 0;
    deleteBtn.textContent = selected.size ? `Delete ${selected.size} selected` : 'Delete selected';
  };

  const grid = h('div', { class: 'media-grid' }, ...items.map((m) => h('div', {
    class: 'media-tile', 'data-path': m.path, 'data-loop': m.loopId,
  },
    h('img', { src: imageUrl(m.previewPath), loading: 'lazy', alt: `${m.type} captured ${fmtDate(m.created)}`, on: { click: () => openMedia(m) } }),
    m.canDelete ? h('label', { class: 'chip' },
      h('input', {
        type: 'checkbox',
        'aria-label': 'Select this item',
        on: {
          change: (e) => {
            const key = `${m.loopId}:${m.path}`;
            if (e.target.checked) selected.set(key, m); else selected.delete(key);
            syncDelete();
          },
        },
      }),
      h('span', { class: 'chip-mark' }), h('span', {}, 'Select')) : null,
    h('div', { class: 'media-caption' }, `${m.loopName || 'Loop'} · ${m.type} · ${fmtDay(m.created)}`))));

  container.append(card(`${items.length} item${items.length === 1 ? '' : 's'}`, {
    sub: `${visibleLoops.length} ${visibleLoops.length === 1 ? 'loop' : 'loops'}`,
    actions: items.some((item) => item.canDelete) ? [deleteBtn] : [], bare: true,
  }, h('div', { class: 'card-body' }, grid)));
  show(container);

  function openMedia(m) {
    const share = typeof navigator.share === 'function'
      ? h('button', {
        type: 'button', class: 'btn btn-sm',
        on: {
          click: async (event) => {
            event.stopPropagation();
            try {
              const response = await fetch(imageUrl(m));
              if (!response.ok) throw new Error('The image is no longer available');
              const blob = await response.blob();
              const extension = m.type === 'recording' || m.type === 'audio' ? 'mp4' : 'jpg';
              const file = new File([blob], `jibo-${m.path}.${extension}`, {
                type: blob.type || (extension === 'mp4' ? 'video/mp4' : 'image/jpeg'),
              });
              const data = { title: 'Jibo capture', text: `${m.loopName || 'Jibo'} capture` };
              if (!navigator.canShare || navigator.canShare({ files: [file] })) data.files = [file];
              await navigator.share(data);
            } catch (error) {
              // Dismissing the native share sheet is not an error worth showing.
              if (error?.name !== 'AbortError') notify(error?.message || 'Could not share this capture.', 'error');
            }
          },
        },
      }, icon('share', 14), 'Share') : null;
    const overlay = h('div', {
      class: 'overlay',
      on: { click: (e) => { if (e.target === overlay || e.target.tagName !== 'IMG') overlay.remove(); } },
    },
      h('img', { src: imageUrl(m), class: 'overlay-img', alt: '' }),
      h('p', {}, `${m.loopName || 'Loop'} · ${m.type} · ${fmtDate(m.created)}`),
      share);
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
    const pathsByLoop = new Map();
    for (const item of selected.values()) {
      const paths = pathsByLoop.get(item.loopId) || [];
      paths.push(item.path);
      pathsByLoop.set(item.loopId, paths);
    }
    const results = await Promise.all([...pathsByLoop.entries()].map(([loopId, paths]) =>
      api('POST', '/api/media/remove', { loopId, paths })));
    const failed = results.find((result) => !result.ok);
    notify(failed ? (failed.data.error || 'Could not delete every selected item') : 'Deleted', failed ? 'error' : 'ok');
    if (!failed) await renderGallery();
  }
}

/* ==========================================================================
   Jibo inbox
   ========================================================================== */

function inboxPeople(loop) {
  const people = new Map();
  for (const member of loop.members || []) {
    if (String(member.status || '').toLowerCase() !== 'accepted'
      || !member.accountId || String(member.accountId) === String(loop.robot)) continue;
    const account = member.account || {};
    const label = String(member.accountId) === String(me?.id)
      ? 'You'
      : member.nickname
        || [account.firstName, account.lastName].filter(Boolean).join(' ')
        || [member.memberProperties?.firstName, member.memberProperties?.lastName].filter(Boolean).join(' ')
        || 'A loop member';
    people.set(String(member.accountId), { id: String(member.accountId), label });
  }
  if (loop.owner && String(loop.owner) !== String(loop.robot) && !people.has(String(loop.owner))) {
    people.set(String(loop.owner), {
      id: String(loop.owner),
      label: String(loop.owner) === String(me?.id) ? 'You' : 'Loop owner',
    });
  }
  return [...people.values()];
}

function inboxPersonLabel(loop, accountId) {
  if (String(accountId) === String(loop.robot)) return loop.robotFriendlyId || 'Jibo';
  return inboxPeople(loop).find((person) => person.id === String(accountId))?.label || 'A loop member';
}

function inboxMessageContent(message) {
  if (message.isEncrypted) return 'This protected message can only be opened by a device with this loop key.';
  if (typeof message.content === 'string' && message.content) return message.content;
  if (Array.isArray(message.parts) && message.parts.length) return 'This message includes an attachment.';
  return 'This message has no text.';
}

async function renderInbox() {
  show(page('Jibo inbox', 'Messages saved in the selected loop.', loading(3)));

  const context = await householdContext();
  const loop = context.active;
  const container = page('Jibo inbox', 'Messages saved in the selected loop.');
  if (!context.ok) container.append(errorBox('Could not load your loops.', context.error));
  else {
    const switcher = householdSwitcher(context);
    if (switcher) container.append(switcher);
  }

  if (loop) {
    const r = await api('GET', `/api/jot?loopId=${encodeURIComponent(loop.id)}`);
    const list = h('div', { class: 'jot-list' });
    if (r.ok) {
      const msgs = r.data.messages || [];
      list.replaceChildren(...msgs.slice().reverse().map((message) => {
        const tags = [...new Set((message.tags || []).map(String))];
        const intendedFor = tags.length
          ? `For: ${tags.map((tag) => inboxPersonLabel(loop, tag)).join(', ')}`
          : 'For the loop';
        return h('article', { class: 'jot-msg' },
          h('div', { class: 'jot-meta' },
            h('span', { class: 'jot-sender', text: inboxPersonLabel(loop, message.sender) }),
            h('span', { text: fmtDate(message.created) })),
          h('div', { class: 'jot-recipient', text: intendedFor }),
          h('div', { class: 'jot-content', text: inboxMessageContent(message) }));
      }));
      if (!msgs.length) list.replaceChildren(empty('No Jibo messages yet', 'Messages you send here stay with this loop.', 'message'));
    } else {
      list.replaceChildren(errorBox('Could not load the Jibo inbox.', r.data.error));
    }

    const people = inboxPeople(loop);
    const recipients = people.length ? h('fieldset', { class: 'jot-recipient-picker' },
      h('legend', { text: 'Who is this for?' }),
      h('p', { class: 'field-hint', text: 'Optional. Everyone in the loop can view its message history; selecting people sends them an alert when notifications are enabled.' }),
      h('div', { class: 'chips' }, ...people.map((person) => chip('tags', false, person.label, person.id)))) : null;

    const compose = h('form', { class: 'jot-compose' },
      field('Message', h('textarea', {
        name: 'content', rows: 3, placeholder: 'Write a short message…', required: true, 'aria-label': 'Message',
      }), 'Text messages are available here today. Attachments, scheduled delivery, and delivery status are not yet available in the console.'),
      recipients,
      h('div', { class: 'compose' },
        h('span', { class: 'field-hint', text: `Saved to ${loop.name || 'this loop'}.` }),
        h('button', { type: 'submit', class: 'btn btn-primary' }, 'Send message')));
    compose.addEventListener('submit', async (e) => {
      e.preventDefault();
      const data = new FormData(compose);
      const content = data.get('content');
      const tags = data.getAll('tags');
      const res = await api('POST', '/api/jot/message', { loopId: loop.id, content, tags });
      notify(res.ok ? 'Message sent' : (res.data.error || 'Could not send message'), res.ok ? 'ok' : 'error');
      if (res.ok) await renderInbox();
    });

    container.append(card('Jibo messages', { sub: loop.name }, list));
    container.append(card('Send a Jibo message', {}, compose));
  } else {
    container.append(card('Jibo messages', {}, empty('No loop', 'Pair a robot first.', 'message')));
  }
  show(container);
}

/* ==========================================================================
   System
   ========================================================================== */

async function renderSystem() {
  show(page('System', 'Software updates and connected services.', loading(4)));

  const [upd, ifttt] = await Promise.all([
    api('GET', '/api/update/status'),
    api('GET', '/api/ifttt'),
  ]);

  const container = page('System', 'Software updates and connected services.');

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

  const iftttCard = card('IFTTT', {});
  const iftttBody = iftttCard.querySelector('.card-body');
  if (ifttt.ok) {
    const id = ifttt.data.identity;
    iftttBody.append(row('Identity', id && id.id ? String(id.id) : 'Not connected'));
    for (const t of (ifttt.data.applets || [])) iftttBody.append(row('Trigger', t.text || t.id));
    iftttBody.append(h('p', { class: 'field-hint' },
      'IFTTT establishes and manages its own connection. This page reports the identity and triggers it has made available to Jibo.'));
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
   Administration
   ==========================================================================
   Four surfaces under #/admin: the server's own status, the configuration
   editor, adopted robots, and who else is an administrator.

   Administrator access is a property of the signed-in account and the server
   re-checks it on every /api/admin/* route, so nothing here grants anything —
   it only decides what to draw. A hand-edited client gets 403s.
   ========================================================================== */

const ADMIN_TABS = [
  { hash: '#/admin', label: 'Status', icon: 'server' },
  { hash: '#/admin/config', label: 'Configuration', icon: 'sliders' },
  { hash: '#/admin/voice-turns', label: 'Voice turns', icon: 'clock' },
  { hash: '#/admin/logs', label: 'Logs', icon: 'message' },
  { hash: '#/admin/robots', label: 'Robots', icon: 'robot' },
  { hash: '#/admin/admins', label: 'Administrators', icon: 'users' },
];

/** The admin page frame: heading, sub-navigation, and a body to fill. */
function adminPage(active, title, description) {
  const container = page(title, description);
  const nav = h('nav', { class: 'subnav', 'aria-label': 'Administration' },
    ...ADMIN_TABS.map((tab) => h('a', {
      href: tab.hash,
      class: tab.hash === active ? 'active' : '',
      'aria-current': tab.hash === active ? 'page' : null,
    }, icon(tab.icon, 15), tab.label)));
  container.querySelector('.page-head').after(nav);
  return container;
}

/**
 * Confirm the session really is an administrator before drawing anything.
 * Returns false when it has already rendered the refusal.
 */
async function adminGate(container) {
  const access = await api('GET', '/api/admin/me');
  if (access.ok) return true;

  if (access.status === 403) {
    container.append(card('Not an administrator', { sub: me ? (me.email || '') : '' },
      h('p', { class: 'field-hint' },
        'This account is not an administrator, so the server-wide admin surface is not available '
        + 'to it. An existing administrator can grant access from the Administrators tab, or from '
        + 'the command line:'),
      h('div', { class: 'restart-cmd' },
        h('span', { class: 'prompt' }, '$'),
        h('code', { text: 'node scripts/portal-grant-admin.mjs --email ' + (me?.email || 'you@example.com') }),
        copyButton(() => 'node scripts/portal-grant-admin.mjs --email ' + (me?.email || 'you@example.com')))));
  } else {
    container.append(errorBox('Could not check administrator access.', access.data.error));
  }
  show(container);
  return false;
}

/** A small copy-to-clipboard button; `get` supplies the text at click time. */
function copyButton(get) {
  const button = h('button', {
    class: 'btn btn-sm', type: 'button', 'aria-label': 'Copy',
    on: {
      click: async (e) => {
        const target = e.currentTarget;
        try {
          await navigator.clipboard.writeText(get());
          target.replaceChildren(icon('check', 14), 'Copied');
          setTimeout(() => target.replaceChildren(icon('copy', 14), 'Copy'), 1600);
        } catch {
          notify('Could not reach the clipboard — select the text and copy it.', 'error');
        }
      },
    },
  }, icon('copy', 14), 'Copy');
  return button;
}

/* -- Status ---------------------------------------------------------------- */

async function renderAdminStatus() {
  const container = adminPage('#/admin', 'Administration', 'What this server is doing right now.');
  show(container);
  if (!(await adminGate(container))) return;

  container.append(loading(4));
  const res = await api('GET', '/api/admin/status');
  container.querySelector('.loading-rows')?.remove();

  if (!res.ok) { container.append(errorBox('Could not read server status.', res.data.error)); return; }
  const d = res.data;

  const hours = Math.floor(d.runtime.uptimeSeconds / 3600);
  const mins = Math.floor((d.runtime.uptimeSeconds % 3600) / 60);
  const uptime = hours ? `${hours}h ${mins}m` : `${mins}m`;

  container.append(h('div', { class: 'stat-grid' },
    h('article', { class: 'stat' },
      h('div', { class: 'label' }, icon('clock', 14), 'Uptime'),
      h('div', { class: 'value', text: uptime }),
      h('div', { class: 'note', text: `since ${fmtDate(d.runtime.startedAt)}` })),
    h('article', { class: 'stat' },
      h('div', { class: 'label' }, icon('users', 14), 'Accounts'),
      h('div', { class: 'value', text: String(d.store.accounts) }),
      h('div', { class: 'note', text: `${d.store.loops ?? 0} loop${d.store.loops === 1 ? '' : 's'}` })),
    h('article', { class: 'stat' },
      h('div', { class: 'label' }, icon('robot', 14), 'Robots'),
      h('div', { class: 'value', text: String(d.store.robots ?? 0) }),
      h('div', { class: 'note', text: 'adopted on this server' })),
    h('article', { class: 'stat' },
      h('div', { class: 'label' }, icon('chip', 14), 'Memory'),
      h('div', { class: 'value', text: `${d.runtime.memoryMb} MB` }),
      h('div', { class: 'note', text: `Node ${d.runtime.node}` }))));

  container.append(card('This process', {},
    row('Node', d.runtime.node),
    row('Platform', d.runtime.platform),
    row('Process ID', String(d.runtime.pid)),
    row('Working directory', h('code', { text: d.runtime.cwd })),
    row('Configuration file', d.config.envFileExists
      ? h('span', {}, h('code', { text: d.config.envFile }),
        h('span', { class: 'pill' }, `${d.config.envFileKeys} set`))
      : h('span', { class: 'pill pill-warn' }, `none at ${d.config.envFile}`)),
    row('Branding override', d.config.brandingFile
      ? h('code', { text: d.config.brandingFile })
      : h('span', { class: 'muted' }, 'none — using the shipped defaults'))));

  // Peers: a real probe, not a reading of the configuration.
  const peerCard = card('Peer services', {
    sub: d.peers.length ? `${d.peers.filter((p) => p.reachable).length} of ${d.peers.length} reachable` : null,
  });
  const peerBody = peerCard.querySelector('.card-body');
  if (!d.peers.length) {
    peerBody.replaceChildren(empty('No peers configured',
      'Service addresses are set with the NET_ settings on the Configuration tab. Without them this '
      + 'service runs alone.', 'link'));
  } else {
    peerBody.replaceChildren(...d.peers.map((p) => h('div', { class: 'peer' },
      h('span', { class: 'who', text: p.label }),
      h('span', { class: 'target', text: p.target }),
      p.reachable
        ? h('span', { class: 'pill pill-ok' }, h('span', { class: 'dot' }), `${p.status} · ${p.ms} ms`)
        : h('span', { class: 'pill pill-error' }, p.error || 'unreachable'))));
    peerBody.append(h('p', { class: 'field-hint', style: 'margin-top:.75rem' },
      'Each of these was requested just now. A service that is configured but unreachable is shown '
      + 'unreachable — nothing here is inferred from the configuration alone.'));
  }
  container.append(peerCard);
}

/* -- Configuration --------------------------------------------------------- */

/** Commands for restarting a set of services, in each of the ways this stack runs. */
function restartInstructions(serviceIds, services) {
  const compose = serviceIds.map((id) => services[id]?.compose).filter(Boolean);
  return [
    {
      how: 'Docker Compose',
      cmd: `docker compose restart ${compose.join(' ')}`,
    },
    {
      how: 'systemd user units',
      cmd: 'systemctl --user restart phoenix-robot@<instance>',
    },
    {
      how: 'Run directly',
      cmd: serviceIds.map((id) => `node ${services[id]?.script || ''}`).filter(Boolean).join('\n'),
    },
  ];
}

async function renderAdminConfig() {
  const container = adminPage('#/admin/config', 'Configuration',
    'Every setting this stack reads from its environment.');
  show(container);
  if (!(await adminGate(container))) return;

  container.append(loading(6));
  const res = await api('GET', '/api/admin/config');
  container.querySelector('.loading-rows')?.remove();
  if (!res.ok) { container.append(errorBox('Could not load the configuration.', res.data.error)); return; }

  const { groups, settings, services, envFile } = res.data;

  // Pending edits, keyed by setting. A row is dirty while its value differs
  // from what the server reported.
  const edits = new Map();
  const rows = new Map();

  container.append(h('div', { class: 'notice' }, icon('alert', 15),
    h('div', {},
      h('div', {}, 'Changes are written to ', h('code', { text: envFile.path }), '.'),
      h('div', { class: 'field-hint', style: 'margin-top:.3rem' },
        'Services read these values when they start, so a change takes effect after you restart the '
        + 'services each setting names. Nothing here is applied to a running process.'))));

  /* toolbar ------------------------------------------------------------- */
  const search = h('input', {
    type: 'search', class: 'search', placeholder: `Search ${settings.length} settings…`,
    'aria-label': 'Search settings',
  });
  const onlyModified = h('label', { class: 'chip' },
    h('input', { type: 'checkbox' }), h('span', { class: 'chip-mark' }), h('span', {}, 'Modified'));
  const onlySet = h('label', { class: 'chip' },
    h('input', { type: 'checkbox' }), h('span', { class: 'chip-mark' }), h('span', {}, 'Set'));

  container.append(h('div', { class: 'cfg-toolbar' }, search, onlySet, onlyModified));

  /* layout -------------------------------------------------------------- */
  const index = h('nav', { class: 'cfg-index', 'aria-label': 'Setting groups' });
  const list = h('div', {});
  container.append(h('div', { class: 'cfg-layout' }, index, list));

  const byGroup = new Map(groups.map((g) => [g.id, []]));
  for (const s of settings) byGroup.get(s.group)?.push(s);

  for (const group of groups) {
    const items = byGroup.get(group.id) || [];
    if (!items.length) continue;
    index.append(h('a', { href: `#cfg-${group.id}`, 'data-group': group.id },
      h('span', { text: group.label }), h('span', { class: 'n', text: String(items.length) })));

    const section = h('section', { class: 'cfg-group', id: `cfg-${group.id}`, 'data-group': group.id },
      h('header', {}, h('h3', { text: group.label }), h('p', { text: group.blurb })),
      h('div', { class: 'cfg-list' }, ...items.map(settingRow)));
    list.append(section);
  }

  const noMatches = h('p', { class: 'cfg-empty', hidden: true }, 'No setting matches that search.');
  list.append(noMatches);

  /* save bar ------------------------------------------------------------ */
  const summary = h('p', {}, 'No changes yet.');
  const saveBtn = h('button', { class: 'btn btn-primary', type: 'button', disabled: true }, 'Save changes');
  const discardBtn = h('button', { class: 'btn', type: 'button', hidden: true }, 'Discard');
  // Hidden until there is something to save. A permanent bar reading "no
  // changes yet" is a quarter of a phone screen spent saying nothing.
  const saveBar = h('div', { class: 'save-bar', hidden: true }, summary, discardBtn, saveBtn);
  container.append(saveBar);

  saveBtn.addEventListener('click', save);
  discardBtn.addEventListener('click', () => {
    for (const key of [...edits.keys()]) revert(key);
  });

  /* ---------------------------------------------------------------- rows */

  function settingRow(spec) {
    const badges = h('span', { class: 'cfg-badges' });
    if (spec.source === 'environment') badges.append(h('span', { class: 'pill pill-warn' }, 'environment'));
    else if (spec.source === 'file') badges.append(h('span', { class: 'pill pill-accent' }, 'configured'));
    else badges.append(h('span', { class: 'pill' }, 'default'));
    if (spec.danger) badges.append(h('span', { class: 'pill pill-error' }, icon('alert', 11), 'sensitive'));

    const control = h('div', { class: 'cfg-control' });
    let input;

    if (spec.type === 'bool') {
      input = h('select', {},
        h('option', { value: '' }, spec.default === null ? 'Not set' : `Not set (${spec.default})`),
        h('option', { value: 'true' }, 'true'),
        h('option', { value: 'false' }, 'false'));
      input.value = spec.value || '';
    } else if (spec.type === 'enum') {
      input = h('select', {}, ...(spec.options || []).map((o) =>
        h('option', { value: o.value }, o.label)));
      input.value = spec.value || '';
    } else {
      input = h('input', {
        type: spec.type === 'number' ? 'number' : 'text',
        value: spec.value || '',
        placeholder: spec.placeholder || (spec.default != null ? `default: ${spec.default}` : 'not set'),
        autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false',
      });
      if (spec.type === 'secret') {
        input.setAttribute('data-secret', '');
        input.setAttribute('type', 'text');
      }
      if (spec.min != null) input.setAttribute('min', spec.min);
      if (spec.max != null) input.setAttribute('max', spec.max);
    }

    if (spec.locked) input.disabled = true;
    input.addEventListener('input', () => onEdit(spec, input));
    input.addEventListener('change', () => onEdit(spec, input));
    control.append(input);

    // Secrets: reveal what is actually set, and offer a strong replacement.
    if (spec.type === 'secret' && !spec.locked) {
      if (spec.hasValue) {
        control.append(h('button', {
          class: 'btn btn-sm', type: 'button',
          on: {
            // currentTarget is null once the event has finished dispatching,
            // so the button is captured before the request is awaited.
            click: async (e) => {
              const button = e.currentTarget;
              button.disabled = true;
              const res2 = await api('POST', '/api/admin/config/reveal', { key: spec.key });
              button.disabled = false;
              if (!res2.ok) { notify(res2.data.error || 'Could not reveal', 'error'); return; }
              input.value = res2.data.value;
              button.remove();
              onEdit(spec, input);
            },
          },
        }, icon('eye', 14), 'Reveal'));
      }
      control.append(h('button', {
        class: 'btn btn-sm', type: 'button',
        on: {
          click: async () => {
            const res2 = await api('POST', '/api/admin/config/generate', {});
            if (!res2.ok) { notify(res2.data.error || 'Could not generate', 'error'); return; }
            input.value = res2.data.value;
            onEdit(spec, input);
          },
        },
      }, icon('refresh', 14), 'Generate'));
    }

    const revertLink = h('button', {
      class: 'link revert', type: 'button', hidden: true,
      on: { click: () => revert(spec.key) },
    }, 'Revert');

    const foot = h('div', { class: 'cfg-foot' },
      spec.services?.length
        ? h('span', { class: 'restart' }, icon('refresh', 12),
          `Needs restart: ${spec.services.map((s) => services[s]?.label || s).join(', ')}`)
        : null,
      spec.default != null ? h('span', {}, `Default: ${spec.default}`) : h('span', {}, 'No default'),
      revertLink);

    const item = h('div', {
      class: `cfg-item${spec.locked ? ' locked' : ''}`,
      'data-key': spec.key,
      'data-search': `${spec.key} ${spec.label} ${spec.help}`.toLowerCase(),
    },
      h('div', { class: 'cfg-head' },
        h('span', { class: 'name', text: spec.label }),
        h('span', { class: 'cfg-key', text: spec.key }),
        badges),
      h('p', { class: 'cfg-help', text: spec.help }),
      control,
      spec.locked
        ? h('div', { class: 'cfg-locked-note' }, icon('lock', 13),
          h('span', {}, 'Set in the process environment, which always overrides the configuration '
            + 'file. Editing it here would have no effect, so it is read-only. Change it where the '
            + 'service is launched.'))
        : null,
      // An environment variable shadowing a different configured value is
      // exactly the situation that wastes an afternoon. Say it out loud.
      (!spec.locked && spec.fileValue != null && spec.fileValue !== spec.value)
        ? h('div', { class: 'cfg-locked-note' }, icon('alert', 13),
          h('span', {}, `The file says "${spec.fileValue}" but the running process has `
            + `"${spec.value || 'nothing'}". Restart to pick the file value up.`))
        : null,
      foot);

    rows.set(spec.key, { item, input, spec, revertLink });
    return item;
  }

  function onEdit(spec, input) {
    const next = String(input.value ?? '');
    const original = spec.value === '••••••••' ? null : (spec.value || '');
    // A masked secret has no comparable original, so any typing counts.
    const dirty = original === null ? next !== '' && next !== '••••••••' : next !== original;

    if (dirty) edits.set(spec.key, next);
    else edits.delete(spec.key);

    const row = rows.get(spec.key);
    row.item.classList.toggle('dirty', dirty);
    row.revertLink.hidden = !dirty;
    paintSaveBar();
  }

  function revert(key) {
    const row = rows.get(key);
    if (!row) return;
    row.input.value = row.spec.value === '••••••••' ? '' : (row.spec.value || '');
    edits.delete(key);
    row.item.classList.remove('dirty');
    row.revertLink.hidden = true;
    paintSaveBar();
  }

  function paintSaveBar() {
    const n = edits.size;
    saveBtn.disabled = n === 0;
    discardBtn.hidden = n === 0;
    saveBar.hidden = n === 0;
    if (!n) return;

    const affected = new Set();
    for (const key of edits.keys()) {
      for (const s of rows.get(key)?.spec.services || []) affected.add(services[s]?.label || s);
    }
    summary.replaceChildren(
      h('strong', { text: `${n} change${n === 1 ? '' : 's'}` }),
      ` — will need a restart of ${[...affected].join(', ')}.`);
  }

  async function save() {
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving…';
    const changes = Object.fromEntries(edits);
    const result = await api('PUT', '/api/admin/config', { changes });
    saveBtn.textContent = 'Save changes';

    if (!result.ok) {
      const errors = result.data.errors || {};
      for (const [key, message] of Object.entries(errors)) {
        const row = rows.get(key);
        if (!row) continue;
        row.input.setAttribute('aria-invalid', 'true');
        row.item.querySelector('.cfg-help').after(h('p', { class: 'error', 'data-field-error': '' }, message));
      }
      notify(result.data.error || 'Could not save', 'error');
      saveBtn.disabled = false;
      return;
    }

    notify(`Saved ${result.data.applied.length + result.data.cleared.length} setting(s)`);
    showRestartPanel(result.data);
    await renderAdminConfig();
  }

  function showRestartPanel(data) {
    const ids = data.restartRequired || [];
    if (!ids.length) return;
    const dialog = h('dialog', { class: 'modal', style: 'width:min(560px,calc(100vw - 2rem))' },
      h('h3', {}, 'Saved — now restart to apply'),
      h('p', {}, `Written to ${data.path}. These services read the settings you changed and are `
        + 'still running with the old values:'),
      h('div', { class: 'row', style: 'margin:.85rem 0' },
        ...ids.map((id) => h('span', { class: 'pill pill-accent' }, services[id]?.label || id))),
      h('p', { class: 'field-hint' },
        'Restart them the way this stack is run here — these are the usual three:'),
      h('div', { class: 'restart-panel', style: 'margin-top:.75rem' },
        ...restartInstructions(ids, services).map((r) => h('div', {},
          h('div', { class: 'restart-how', text: r.how }),
          h('div', { class: 'restart-cmd' },
            h('span', { class: 'prompt' }, '$'),
            h('code', { text: r.cmd }),
            copyButton(() => r.cmd))))),
      data.backup
        ? h('p', { class: 'field-hint', style: 'margin-top:1rem' },
          `The previous file was copied to ${data.backup}.`)
        : null,
      h('div', { class: 'row row-end', style: 'margin-top:1.25rem' },
        h('button', {
          class: 'btn btn-primary', type: 'button',
          on: { click: () => { dialog.close(); dialog.remove(); } },
        }, 'Done')));
    document.body.append(dialog);
    dialog.showModal();
  }

  /* ------------------------------------------------------------- filters */

  const applyFilter = () => {
    const term = search.value.trim().toLowerCase();
    const wantModified = onlyModified.querySelector('input').checked;
    const wantSet = onlySet.querySelector('input').checked;
    let shown = 0;

    for (const [key, { item, spec }] of rows) {
      const matches = !term || item.dataset.search.includes(term);
      const modifiedOk = !wantModified || edits.has(key);
      const setOk = !wantSet || spec.hasValue;
      const visible = matches && modifiedOk && setOk;
      item.hidden = !visible;
      if (visible) shown += 1;
    }
    // Hide a group heading whose settings are all filtered out.
    for (const section of list.querySelectorAll('.cfg-group')) {
      section.hidden = ![...section.querySelectorAll('.cfg-item')].some((i) => !i.hidden);
    }
    noMatches.hidden = shown > 0;
  };

  search.addEventListener('input', debounce(applyFilter, 120));
  onlyModified.querySelector('input').addEventListener('change', applyFilter);
  onlySet.querySelector('input').addEventListener('change', applyFilter);

  // Highlight the group currently on screen in the index.
  if ('IntersectionObserver' in window) {
    const io = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const id = entry.target.dataset.group;
        for (const a of index.querySelectorAll('a')) a.classList.toggle('current', a.dataset.group === id);
      }
    }, { rootMargin: '-20% 0px -70% 0px' });
    for (const section of list.querySelectorAll('.cfg-group')) io.observe(section);
  }
}

/* -- Robots ---------------------------------------------------------------- */

async function renderAdminRobots() {
  const container = adminPage('#/admin/robots', 'Robots',
    'Every robot adopted on this server, across all loops.');
  show(container);
  if (!(await adminGate(container))) return;

  container.append(loading(3));
  const robots = await api('GET', '/api/admin/robots');
  container.querySelector('.loading-rows')?.remove();

  const list = robots.ok && Array.isArray(robots.data) ? robots.data : [];
  const robotCard = card('Adopted robots', { sub: `${list.length}` });
  const body = robotCard.querySelector('.card-body');
  if (!robots.ok) body.replaceChildren(errorBox('Could not list robots.', robots.data.error));
  else if (!list.length) {
    body.replaceChildren(empty('No robots adopted',
      'Adopt one below, or pair a new robot from the Robots page.', 'robot'));
  } else {
    body.replaceChildren(...list.map((rb) => h('div', { class: 'member-block' },
      h('div', { class: 'member-name' }, icon('robot', 15), rb.friendlyId),
      row('Loop', rb.loopName || '—'),
      row('Owner', rb.ownerEmail || '—'),
      row('Access key', h('code', { text: rb.accessKeyId })),
      row('Last seen', fmtDate(rb.lastSeen)))));
    body.classList.add('member-grid');
  }
  container.append(robotCard);

  const result = h('pre', { class: 'json', hidden: true });
  const adoptForm = h('form', {},
    h('p', { class: 'field-hint' },
      'For a robot that completed setup against the original cloud years ago. This mints fresh '
      + 'credentials and a loop, and shows you exactly what to write to the robot.'),
    h('div', { class: 'grid2' },
      field('Robot name', h('input', {
        name: 'friendlyId', placeholder: 'castle-cylinder-fig-quilt', required: true,
        autocapitalize: 'off', spellcheck: 'false',
      }), 'The four-word name the robot reports.'),
      field('Owner email', h('input', { name: 'ownerEmail', type: 'email', placeholder: 'optional' }),
        'An existing account. Leave blank to use the synthetic adopted owner.')),
    h('label', { class: 'check-row' },
      h('input', { name: 'transferExisting', type: 'checkbox' }),
      h('span', {}, 'Transfer a robot already owned by another Phoenix account (administrator-confirmed).')),
    h('div', { class: 'row', style: 'margin-top:1.25rem' },
      h('button', { type: 'submit', class: 'btn btn-primary' }, 'Adopt robot')),
    result);

  adoptForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(adoptForm));
    const res = await api('POST', '/api/admin/adopt', {
      friendlyId: fd.friendlyId, ownerEmail: fd.ownerEmail || undefined,
      transferExisting: fd.transferExisting === 'on',
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

/* -- Administrators -------------------------------------------------------- */

async function renderAdminAdmins() {
  const container = adminPage('#/admin/admins', 'Administrators',
    'Who can reach this surface. Access is a flag on the account, checked on every request.');
  show(container);
  if (!(await adminGate(container))) return;

  container.append(loading(3));
  const res = await api('GET', '/api/admin/admins');
  container.querySelector('.loading-rows')?.remove();
  if (!res.ok) { container.append(errorBox('Could not list accounts.', res.data.error)); return; }

  const { accounts, adminCount } = res.data;

  if (adminCount === 1) {
    container.append(h('div', { class: 'notice notice-warn' }, icon('alert', 15),
      h('div', {},
        h('div', {}, 'This instance has one administrator.'),
        h('div', { class: 'field-hint', style: 'margin-top:.3rem' },
          'If that account is lost, admin access is recovered only from the command line with '
          + 'scripts/portal-grant-admin.mjs. Granting a second administrator avoids that.'))));
  }

  const listCard = card('Accounts', { sub: `${adminCount} of ${accounts.length} are administrators` });
  const body = listCard.querySelector('.card-body');

  body.replaceChildren(...accounts.map((a) => {
    const isSelf = me && a.id === me.id;
    const name = [a.firstName, a.lastName].filter(Boolean).join(' ');
    return h('div', { class: `member-block${a.isAdmin ? '' : ' '}`.trim() },
      h('div', { class: 'member-name' },
        h('span', { class: 'avatar', style: 'width:24px;height:24px;font-size:10px' },
          (name || a.email || '?').slice(0, 2).toUpperCase()),
        name || a.email || a.id,
        a.isAdmin ? h('span', { class: 'pill pill-accent' }, 'administrator') : null,
        isSelf ? h('span', { class: 'pill' }, 'you') : null),
      row('Email', a.email || '—'),
      row('Active', a.isActive ? 'yes' : 'no'),
      h('div', { class: 'member-actions' },
        h('button', {
          class: a.isAdmin ? 'link danger' : 'link', type: 'button',
          on: { click: () => setAdmin(a, !a.isAdmin) },
        }, a.isAdmin ? 'Revoke admin' : 'Make administrator')));
  }));
  body.classList.add('member-grid');
  container.append(listCard);

  container.append(card('From the command line', {},
    h('p', { class: 'field-hint' },
      'The same flag, for when nobody can sign in to this page:'),
    ...[
      'node scripts/portal-grant-admin.mjs --list',
      'node scripts/portal-grant-admin.mjs --email you@example.com',
      'node scripts/portal-grant-admin.mjs --email you@example.com --revoke',
    ].map((cmd) => h('div', { class: 'restart-cmd' },
      h('span', { class: 'prompt' }, '$'), h('code', { text: cmd }), copyButton(() => cmd)))));

  async function setAdmin(account, grant) {
    const label = account.email || account.id;
    const yes = await confirmDialog({
      title: grant ? `Make ${label} an administrator?` : `Revoke ${label}'s access?`,
      body: grant
        ? 'They will be able to read and change every setting on this server, adopt robots, and grant '
          + 'administrator access to others.'
        : 'They will lose access to the admin surface immediately — the flag is checked on every '
          + 'request, so there is no session to wait out.',
      confirmLabel: grant ? 'Make administrator' : 'Revoke',
      danger: !grant,
    });
    if (!yes) return;
    const out = await api('POST', '/api/admin/admins', { email: account.email, grant });
    if (!out.ok) { notify(out.data.error || 'Could not change access', 'error'); return; }
    notify(grant ? 'Administrator access granted' : 'Administrator access revoked');
    await renderAdminAdmins();
  }
}

/* ==========================================================================
   Auth screen
   ========================================================================== */

let authNotice = '';
let pendingActivationEmail = '';
let publicMailAction = null;

function clearPublicMailUrl() {
  // Keep a user-selected hash route, but remove the bearer code from history
  // and from anything they might copy from the address bar.
  history.replaceState(null, '', `/${location.hash || ''}`);
}

async function consumePublicMailAction() {
  const params = new URLSearchParams(location.search);
  const code = params.get('code') || '';
  if (location.pathname === '/activate') {
    clearPublicMailUrl();
    if (!code) { authNotice = 'This confirmation link is incomplete.'; return; }
    const res = await api('POST', '/api/signup/verify', { code });
    authNotice = res.ok
      ? 'Your email is confirmed. You can sign in now.'
      : (res.data.error || 'This confirmation link is invalid or has expired.');
    return;
  }
  if (location.pathname === '/confirmemailreset') {
    clearPublicMailUrl();
    if (!code) { authNotice = 'This email-change link is incomplete.'; return; }
    const res = await api('POST', '/api/me/email/confirm', { code });
    authNotice = res.ok
      ? 'Your email address has been changed. Please sign in again.'
      : (res.data.error || 'This email-change link is invalid or has expired.');
    return;
  }
  if (location.pathname === '/reset') {
    clearPublicMailUrl();
    if (!code) { authNotice = 'This password-reset link is incomplete.'; return; }
    publicMailAction = { type: 'reset', code };
  }
}

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
  const email = form.querySelector('[name="email"]');
  const password = form.querySelector('[name="password"]');
  const emailField = email.closest('.field');
  const passwordField = password.closest('.field');
  const forgot = authRoot.querySelector('#auth-forgot');
  const resend = authRoot.querySelector('#auth-resend');

  let mode = publicMailAction?.type === 'reset' ? 'reset' : 'login';
  const COPY = {
    login: { title: 'Welcome back', sub: 'Use the same account you sign into the robot app with.', cta: 'Sign in' },
    signup: { title: 'Create an account', sub: 'We will send a confirmation link before the account can sign in.', cta: 'Create account' },
    recovery: { title: 'Reset your password', sub: 'Enter your email and we will send a reset link if an account exists.', cta: 'Send reset link' },
    reset: { title: 'Choose a new password', sub: 'Use at least 8 characters with an uppercase letter, lowercase letter, and number.', cta: 'Set new password' },
  };

  const setMessage = (message, isError = false) => {
    err.hidden = !message;
    err.textContent = message || '';
    err.classList.toggle('error', isError);
  };

  const setMode = (next) => {
    mode = next;
    segment.hidden = next === 'recovery' || next === 'reset';
    segment.dataset.active = next === 'signup' ? 'signup' : 'login';
    for (const t of segment.querySelectorAll('.tab')) {
      const on = t.dataset.tab === next;
      t.classList.toggle('active', on);
      t.setAttribute('aria-selected', String(on));
    }
    if (signupOnly) signupOnly.hidden = next !== 'signup';
    emailField.hidden = next === 'reset';
    passwordField.hidden = next === 'recovery';
    email.required = next !== 'reset';
    password.required = next !== 'recovery';
    forgot.hidden = next !== 'login';
    resend.hidden = !(pendingActivationEmail && (next === 'login' || next === 'signup'));
    title.textContent = COPY[next].title;
    sub.textContent = COPY[next].sub;
    submit.textContent = COPY[next].cta;
    password.setAttribute('autocomplete', next === 'signup' || next === 'reset' ? 'new-password' : 'current-password');
    setMessage(authNotice, false);
  };

  for (const tab of segment.querySelectorAll('.tab')) {
    tab.addEventListener('click', () => { authNotice = ''; setMode(tab.dataset.tab); });
  }
  forgot.addEventListener('click', () => { authNotice = ''; setMode('recovery'); });
  resend.addEventListener('click', async () => {
    resend.disabled = true;
    const res = await api('POST', '/api/signup/resend', { email: pendingActivationEmail });
    resend.disabled = false;
    setMessage(res.ok ? 'If that address has a pending account, a new confirmation link was sent.'
      : (res.data.error || 'Could not resend the confirmation email.'), !res.ok);
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!form.reportValidity()) return;
    submit.disabled = true;
    submit.textContent = mode === 'signup' ? 'Creating…'
      : (mode === 'recovery' ? 'Sending…' : (mode === 'reset' ? 'Updating…' : 'Signing in…'));
    const fd = Object.fromEntries(new FormData(form));
    const endpoint = mode === 'signup' ? '/api/signup'
      : (mode === 'recovery' ? '/api/password/reset/request'
        : (mode === 'reset' ? '/api/password/reset/confirm' : '/api/login'));
    const payload = mode === 'reset' ? { code: publicMailAction?.code, password: fd.password } : fd;
    const res = await api('POST', endpoint, payload);
    submit.disabled = false;
    submit.textContent = COPY[mode].cta;
    if (!res.ok) {
      setMessage(res.data.error || 'That did not work. Check your details and try again.', true);
      return;
    }
    if (mode === 'signup' && res.data.verificationRequired) {
      pendingActivationEmail = fd.email;
      authNotice = 'Check your inbox and follow the confirmation link before signing in.';
      setMode('login');
      return;
    }
    if (mode === 'recovery') {
      authNotice = 'If that address has an account, a password-reset link was sent.';
      setMode('login');
      return;
    }
    if (mode === 'reset') {
      publicMailAction = null;
      authNotice = 'Your password has been updated. You can sign in now.';
      setMode('login');
      return;
    }
    await refreshMe();
    if (!location.hash || location.hash === '#/') location.hash = '#/';
    route();
  });

  setMode(mode);
}

/* ==========================================================================
   Shell chrome
   ========================================================================== */

function initChrome() {
  const menuBtn = document.getElementById('menu-btn');
  const mobileMenuBtn = document.getElementById('mobile-menu-btn');
  const menuControls = [menuBtn, mobileMenuBtn].filter(Boolean);
  const setNavOpen = (open) => {
    document.body.classList.toggle('nav-open', open);
    for (const control of menuControls) control.setAttribute('aria-expanded', String(open));
    scrim.hidden = !open;
  };
  const closeNav = () => {
    setNavOpen(false);
  };
  for (const control of menuControls) {
    control.addEventListener('click', () => setNavOpen(!document.body.classList.contains('nav-open')));
  }
  scrim.addEventListener('click', closeNav);
  document.getElementById('nav')?.addEventListener('click', (e) => {
    if (e.target.closest('a')) closeNav();
  });
  document.querySelector('.sidebar-brand')?.addEventListener('click', closeNav);

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
    // A sign-out is a reasonable expectation of privacy on a shared device.
    // Remove the browser's subscription before invalidating the session.
    try { await disableBrowserPush(api); } catch { /* no subscription or offline */ }
    await api('POST', '/api/logout');
    me = null;
    location.hash = '#/';
    route();
  });
}

function paintNav(hash) {
  for (const a of document.querySelectorAll('#nav .nav-item')) {
    const route = a.dataset.route;
    // Every #/admin/* sub-route keeps the one Administration item highlighted;
    // the sub-navigation inside the page says which of them you are on.
    const active = route === hash
      || (route === '#/admin' && hash.startsWith('#/admin'));
    a.classList.toggle('active', active);
    if (active) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
  let primaryActive = false;
  for (const a of document.querySelectorAll('#mobile-tabbar [data-route]')) {
    const active = a.dataset.route === hash;
    a.classList.toggle('active', active);
    if (active) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
    primaryActive ||= active;
  }
  document.getElementById('mobile-menu-btn')?.classList.toggle('active', !primaryActive);
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
  '#/claim': renderClaim,
  '#/gallery': renderGallery,
  '#/inbox': renderInbox,
  '#/system': renderSystem,
  '#/add': renderAdd,
  '#/add/repoint-oobe': renderAddRepointOobe,
  '#/add/new': renderAddNew,
};

/* -- Voice-turn latency ---------------------------------------------------- */

const fmtMs = (value) => Number.isFinite(value) ? `${Math.round(value).toLocaleString()} ms` : '—';

// Stage keys are an allowlisted part of the telemetry schema.  Keep the UI's
// labels friendly without ever reflecting an arbitrary value into the panel.
const VOICE_STAGE_LABELS = Object.freeze({
  context_wait: 'Context available',
  asr: 'Speech recognition',
  nlu: 'Language parsing',
  route: 'Intent routing',
  skill: 'Skill response',
  skill_redirect: 'Redirected skill',
  history_launch: 'Launch history (background)',
  history_speech: 'Speech history (background)',
  response_ready: 'Final response ready',
  http_request: 'Service request',
});

function voiceStageLabel(stage) {
  return VOICE_STAGE_LABELS[stage] || 'Recorded stage';
}

function voiceStageTone(stage) {
  if (stage === 'asr') return 'voice-tone-asr';
  if (stage === 'nlu' || stage === 'context_wait') return 'voice-tone-language';
  if (stage === 'skill' || stage === 'skill_redirect') return 'voice-tone-skill';
  if (stage === 'response_ready' || stage === 'route') return 'voice-tone-response';
  return 'voice-tone-background';
}

const VOICE_BACKGROUND_STAGES = new Set(['history_launch', 'history_speech', 'http_request']);
const numericTime = (value) => Number.isFinite(value) && value >= 0 ? value : null;

function temporalStage(stage, turnStartedAt, tapeEndsAt) {
  const startedAt = numericTime(stage.startedAt);
  const endedAt = numericTime(stage.endedAt);
  if (startedAt === null || endedAt === null || endedAt < startedAt) return null;
  // A bad or late foreign timestamp must not overflow the visual tape. The
  // original numbers remain server-side timing-only data; the UI just bounds
  // its rendering to this turn's safely calculated time window.
  const start = Math.max(turnStartedAt, Math.min(startedAt, tapeEndsAt));
  const end = Math.max(start, Math.min(endedAt, tapeEndsAt));
  return { ...stage, start, end, durationMs: Math.max(0, end - start) };
}

function temporalLanes(stages) {
  const lanes = [];
  for (const stage of stages) {
    // Keep non-overlapping stages together so the normal request path reads as
    // one continuous tape. A new lane is allocated only for a real overlap.
    const lane = lanes.find((candidate) => candidate.end <= stage.start);
    if (lane) {
      lane.stages.push(stage);
      lane.end = stage.end;
    } else lanes.push({ end: stage.end, stages: [stage] });
  }
  return lanes.map((lane) => lane.stages);
}

function tapeSegment(stage, turnStartedAt, scale) {
  const offset = stage.start - turnStartedAt;
  const width = stage.durationMs;
  const leftPct = Math.min(100, (offset / scale) * 100);
  // Zero-length phases have a visible marker; their exact duration is still
  // stated in text and the browser tooltip.
  const widthPct = width ? Math.max(.75, Math.min(100 - leftPct, (width / scale) * 100)) : .75;
  const label = voiceStageLabel(stage.stage);
  const bounds = `+${fmtMs(offset)} to +${fmtMs(offset + width)}`;
  const description = `${label}: ${bounds}, ${fmtMs(width)} elapsed duration, ${stage.outcome}.`;
  return h('span', {
    class: `voice-waterfall-span ${voiceStageTone(stage.stage)}`,
    style: `--stage-left: ${leftPct.toFixed(2)}%; --stage-width: ${widthPct.toFixed(2)}%`,
    tabindex: '0', title: description, 'aria-label': description,
  }, h('span', { text: label }));
}

function tapeDetails(stages, turnStartedAt) {
  return h('ul', { class: 'voice-tape-details', role: 'list' }, ...stages.map((stage) => {
    const offset = stage.start - turnStartedAt;
    const bounds = `+${fmtMs(offset)} → +${fmtMs(offset + stage.durationMs)}`;
    return h('li', { class: voiceStageTone(stage.stage), role: 'listitem' },
      h('span', { class: 'voice-tape-swatch', 'aria-hidden': 'true' }),
      h('strong', { text: voiceStageLabel(stage.stage) }),
      h('span', { text: `${bounds} · ${fmtMs(stage.durationMs)}` }),
      h('span', { class: 'pill', text: stage.outcome }));
  }));
}

function tapeLanes(lanes, turnStartedAt, scale, completionOffset, label) {
  return h('div', { class: 'voice-tape-lanes' }, ...lanes.map((lane, index) =>
    h('div', { class: `voice-tape-lane ${lanes.length > 1 ? 'voice-tape-lane-overlap' : 'voice-tape-lane-single'}` },
      lanes.length > 1 && h('span', { class: 'voice-tape-lane-label', text: `${label} ${index + 1}` }),
      h('div', { class: 'voice-waterfall-track', 'aria-label': `${label}${lanes.length > 1 ? ` ${index + 1}` : ''}` },
        h('span', { class: 'voice-completion-line', style: `--completion-pct: ${completionOffset.toFixed(2)}%`, 'aria-hidden': 'true' }),
        ...lane.map((stage) => tapeSegment(stage, turnStartedAt, scale))))));
}

function asrTimingList(asr) {
  return h('dl', { class: 'voice-asr-timings' },
    h('div', {}, h('dt', { text: 'Audio received' }), h('dd', { text: fmtMs(asr.audioMs) })),
    h('div', {}, h('dt', { text: 'Silence endpoint' }), h('dd', { text: fmtMs(asr.silenceWaitMs) })),
    h('div', {}, h('dt', { text: 'Recognition' }), h('dd', { text: fmtMs(asr.recognizeMs) })));
}

/** A purpose-built telemetry view; it never reads or renders raw log lines. */
async function renderAdminVoiceTurns() {
  const container = adminPage('#/admin/voice-turns', 'Voice turns',
    'Recent gateway latency, without speech or identity data.');
  show(container);
  if (!(await adminGate(container))) return;

  const state = { range: '3600000', turnId: '', outcome: '', stage: '', loading: false, expanded: new Set() };
  const body = h('div', { class: 'voice-turn-results' }, loading(5));
  const status = h('span', { class: 'note', text: 'Loading recent turns…' });
  const idInput = h('input', {
    type: 'search', class: 'voice-turn-id', placeholder: 'Exact turn ID (UUID)',
    'aria-label': 'Find an exact voice turn ID',
  });
  const rangeSelect = h('select', { 'aria-label': 'Time range' },
    ...[['900000', 'Last 15 minutes'], ['3600000', 'Last hour'], ['21600000', 'Last 6 hours'], ['0', 'Retained turns']]
      .map(([value, label]) => h('option', { value, selected: value === state.range }, label)));
  const outcomeSelect = h('select', { 'aria-label': 'Filter by outcome' }, h('option', { value: '' }, 'All outcomes'));
  const stageSelect = h('select', { 'aria-label': 'Filter by stage' }, h('option', { value: '' }, 'All stages'));
  const refresh = h('button', { class: 'btn btn-quiet', type: 'button' }, icon('refresh', 14), 'Refresh');

  const toolbar = h('div', { class: 'voice-turn-toolbar' },
    h('label', { class: 'log-control' }, 'Time', rangeSelect),
    h('label', { class: 'log-control voice-turn-search' }, 'Turn ID', idInput),
    h('label', { class: 'log-control' }, 'Outcome', outcomeSelect),
    h('label', { class: 'log-control' }, 'Stage', stageSelect),
    h('span', { class: 'spacer' }), refresh, status);
  container.append(toolbar, body);
  container.append(h('p', { class: 'note voice-turn-note' },
    'Shows only the gateway process’s bounded timing projection. It contains no transcript, audio, '
      + 'robot/account identity, credentials, or raw log lines.'));

  function options(select, values, selected, allLabel) {
    const current = select.value || selected || '';
    select.replaceChildren(h('option', { value: '' }, allLabel),
      ...values.map((value) => h('option', { value, selected: value === current }, value)));
  }

  function draw(turns) {
    // The DOM is intentionally rebuilt from the bounded server projection on
    // every poll.  Capture native <details> state first so inspecting a turn
    // is not interrupted by the five-second refresh.
    for (const opened of body.querySelectorAll('details.voice-turn[open][data-turn-id]')) {
      state.expanded.add(opened.dataset.turnId);
    }
    // Do not retain IDs which are outside the current bounded/filter result;
    // this keeps a long-lived admin tab from accumulating stale UI state.
    const visibleTurnIds = new Set(turns.map((turn) => turn.turnId));
    for (const turnId of state.expanded) {
      if (!visibleTurnIds.has(turnId)) state.expanded.delete(turnId);
    }
    if (!turns.length) {
      body.replaceChildren(empty('No voice turns match', 'Try a wider time range or clear a filter.', 'clock'));
      return;
    }
    const list = h('div', { class: 'voice-turn-list', role: 'list' });
    list.append(h('div', { class: 'voice-turn-head', role: 'row' },
      h('span', {}, 'Time'), h('span', {}, 'Turn'), h('span', {}, 'Total'), h('span', {}, 'Outcome')));
    for (const turn of turns) {
      const stages = turn.stages || [];
      const turnStartedAt = numericTime(turn.startedAt);
      const responseReady = stages.find((stage) => stage.stage === 'response_ready');
      const completionAt = numericTime(turn.completedAt)
        ?? numericTime(responseReady?.endedAt)
        ?? (turnStartedAt === null ? null : turnStartedAt + (Number(turn.totalMs) || 0));
      const knownEnds = stages.map((stage) => numericTime(stage.endedAt)).filter((value) => value !== null);
      const tapeEndsAt = turnStartedAt === null ? null : Math.max(turnStartedAt, completionAt || turnStartedAt, ...knownEnds);
      const scale = tapeEndsAt === null ? null : Math.max(1, tapeEndsAt - turnStartedAt);
      const completionOffset = scale === null || completionAt === null
        ? 100 : Math.min(100, Math.max(0, ((completionAt - turnStartedAt) / scale) * 100));
      const temporalStages = scale === null ? [] : stages
        .filter((stage) => stage.stage !== 'response_ready')
        .map((stage) => temporalStage(stage, turnStartedAt, tapeEndsAt))
        .filter(Boolean)
        .sort((a, b) => a.start - b.start || a.end - b.end);
      const mainStages = temporalStages.filter((stage) => !VOICE_BACKGROUND_STAGES.has(stage.stage));
      const backgroundStages = temporalStages.filter((stage) => VOICE_BACKGROUND_STAGES.has(stage.stage));
      const mainLanes = temporalLanes(mainStages);
      const backgroundLanes = temporalLanes(backgroundStages);
      const unavailableStages = stages.filter((stage) => stage.stage !== 'response_ready').length - temporalStages.length;
      const scaleId = `voice-waterfall-scale-${turn.turnId}`;
      const detail = h('details', {
        class: 'voice-turn', 'data-turn-id': turn.turnId, open: state.expanded.has(turn.turnId),
        on: { toggle: () => {
          if (detail.open) state.expanded.add(turn.turnId);
          else state.expanded.delete(turn.turnId);
        } },
      });
      const timeline = h('div', { class: 'voice-turn-timeline' },
        h('div', { class: 'voice-timeline-heading' },
          h('div', {}, h('strong', { text: 'Turn timing waterfall' }),
            h('p', { id: scaleId, class: 'field-hint', text: scale === null
              ? 'This older retained turn does not include temporal stage bounds.'
              : `The main path is one elapsed-time tape from turn start to ${fmtMs(scale)}. Extra lanes appear only for real overlap; background work is grouped separately.` })),
          h('div', { class: 'voice-timeline-axis', 'aria-hidden': 'true' },
            h('span', { text: 'Turn start · 0 ms' }), h('span', { text: scale === null ? 'Timing unavailable' : `End · ${fmtMs(scale)}` })) ),
        scale !== null && h('div', { class: 'voice-waterfall', 'aria-describedby': scaleId },
          h('div', { class: 'voice-waterfall-section' },
            h('div', { class: 'voice-waterfall-section-title', text: 'Main response path' }),
            mainStages.length
              ? [
                tapeLanes(mainLanes, turnStartedAt, scale, completionOffset, 'Overlap lane'),
                tapeDetails(mainStages, turnStartedAt),
              ]
              : h('p', { class: 'field-hint', text: 'No positioned main-path stages were recorded.' })),
          backgroundStages.length && h('div', { class: 'voice-waterfall-section voice-waterfall-background' },
            h('div', { class: 'voice-waterfall-section-title', text: 'Background / overlapping work' }),
            h('p', { class: 'field-hint', text: 'These spans may continue after the final response is ready.' }),
            tapeLanes(backgroundLanes, turnStartedAt, scale, completionOffset, 'Background lane'),
            tapeDetails(backgroundStages, turnStartedAt)),
          h('div', { class: 'voice-completion-note' },
            h('span', { class: 'voice-completion-dot', 'aria-hidden': 'true' }),
            h('strong', { text: `Final response ready · +${fmtMs(Math.max(0, (completionAt || turnStartedAt) - turnStartedAt))}` }),
            h('span', { text: 'Completion milestone; it is not a duration bar.' })),
          unavailableStages > 0 && h('p', { class: 'field-hint', text: `${unavailableStages} older stage timing record${unavailableStages === 1 ? '' : 's'} cannot be positioned on this tape.` })),
        h('div', { class: 'voice-timeline-legend', 'aria-label': 'Timeline colour legend' },
          h('span', { text: 'Colour key:' }),
          h('span', { class: 'voice-legend voice-tone-asr', text: 'Speech' }),
          h('span', { class: 'voice-legend voice-tone-language', text: 'Language / context' }),
          h('span', { class: 'voice-legend voice-tone-skill', text: 'Skill' }),
          h('span', { class: 'voice-legend voice-tone-response', text: 'Response' }),
          h('span', { class: 'voice-legend voice-tone-background', text: 'Background' })));
      if (turn.asr) {
        timeline.append(h('div', { class: 'voice-asr' },
          h('div', { class: 'voice-asr-heading' }, h('strong', { text: 'ASR phase breakdown' }),
            h('span', { class: 'field-hint', text: 'Provider-reported elapsed components, not separate timestamped spans.' })),
          asrTimingList(turn.asr)));
      }
      else timeline.append(h('p', { class: 'field-hint', text: 'No server-side ASR breakdown for this turn.' }));
      detail.append(h('summary', { class: 'voice-turn-row' },
        h('span', { text: fmtDate(turn.startedAt) }),
        h('code', { text: turn.turnId }),
        h('strong', { text: fmtMs(turn.totalMs) }),
        h('span', { class: 'pill', text: turn.outcome || 'in progress' })), timeline);
      list.append(detail);
    }
    body.replaceChildren(list);
  }

  async function load({ initial = false } = {}) {
    if (state.loading) return;
    state.loading = true;
    refresh.disabled = true;
    if (initial) body.replaceChildren(loading(5));
    const query = new URLSearchParams({ limit: '50' });
    if (state.range !== '0') query.set('from', String(Date.now() - Number(state.range)));
    if (state.turnId) query.set('turnId', state.turnId);
    if (state.outcome) query.set('outcome', state.outcome);
    if (state.stage) query.set('stage', state.stage);
    const res = await api('GET', `/api/admin/voice-turns?${query.toString()}`);
    state.loading = false;
    refresh.disabled = false;
    if (!res.ok) {
      status.textContent = 'Unavailable';
      body.replaceChildren(errorBox('Could not load voice-turn telemetry.', res.data.error || 'Try refresh.'));
      return;
    }
    options(outcomeSelect, res.data.outcomes || [], state.outcome, 'All outcomes');
    options(stageSelect, res.data.stages || [], state.stage, 'All stages');
    draw(res.data.turns || []);
    status.textContent = `${(res.data.turns || []).length} shown · ${res.data.retained} retained`;
  }

  const apply = () => {
    state.range = rangeSelect.value;
    state.turnId = idInput.value.trim();
    state.outcome = outcomeSelect.value;
    state.stage = stageSelect.value;
    load({ initial: true });
  };
  rangeSelect.addEventListener('change', apply);
  outcomeSelect.addEventListener('change', apply);
  stageSelect.addEventListener('change', apply);
  idInput.addEventListener('input', debounce(apply, 300));
  refresh.addEventListener('click', () => load());

  await load({ initial: true });
  stopPoll();
  pollTimer = setInterval(() => load(), 5000);
}

/**
 * The server's own log lines, live.
 *
 * This polls with a cursor instead of holding a stream open. The shared service
 * boundary serialises a route's return value and ends the response, so a
 * server-sent-event endpoint would mean changing that boundary for one screen;
 * a one-second cursor poll is a few hundred bytes and reads as live.
 *
 * What it can show is bounded by the deployment: in the colocated stack every
 * service shares one process, so this is a whole-server view, while under docker
 * compose each container has its own process and only the account service's
 * lines appear here.
 *
 * The level selector filters what was recorded. It cannot reveal lines the
 * service suppressed at its own LOG_LEVEL — run the service at debug to see
 * debug lines.
 */
async function renderAdminLogs() {
  const container = adminPage('#/admin/logs', 'Logs', 'What this server is doing, as it happens.');
  show(container);
  if (!(await adminGate(container))) return;

  const state = { cursor: 0, level: '', ns: '', paused: false, shown: 0, dropped: 0 };

  const list = h('div', { class: 'log-list', role: 'log', 'aria-live': 'polite' });
  const status = h('span', { class: 'note', text: 'connecting…' });

  const levelSelect = h('select', { class: 'log-level' },
    ...[['', 'All levels'], ['error', 'Error and above'], ['warn', 'Warn and above'],
      ['info', 'Info and above'], ['debug', 'Debug and above']]
      .map(([value, label]) => h('option', { value, selected: value === state.level }, label)));

  const nsInput = h('input', {
    type: 'search', class: 'log-ns', placeholder: 'namespace, e.g. gateway',
    'aria-label': 'Filter by namespace prefix',
  });

  function appendLine(line) {
    const time = new Date(line.t);
    const stamp = Number.isNaN(time.getTime()) ? '' : time.toLocaleTimeString();
    const extras = Object.entries(line)
      .filter(([k]) => !['t', 'level', 'ns', 'msg', 'seq'].includes(k))
      .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`)
      .join(' ');
    const el = h('div', { class: `log-line log-${line.level}` },
      h('span', { class: 'log-time', text: stamp }),
      h('span', { class: `log-badge log-badge-${line.level}`, text: line.level }),
      h('span', { class: 'log-ns-name', text: line.ns || '' }),
      h('span', { class: 'log-msg', text: line.msg }),
      extras ? h('span', { class: 'log-extras', text: extras }) : null);
    list.append(el);
    state.shown += 1;
  }

  // Newest at the bottom, like a terminal. Only auto-scroll if the reader is
  // already at the bottom, so scrolling back to read something is not yanked
  // away by the next line.
  function atBottom() {
    return list.scrollHeight - list.scrollTop - list.clientHeight < 40;
  }

  function trim() {
    // Keep the DOM bounded no matter how long the tab is left open.
    while (list.childElementCount > 500) list.firstElementChild.remove();
  }

  async function tick() {
    if (state.paused) return;
    const q = new URLSearchParams({ since: String(state.cursor), limit: '200' });
    if (state.level) q.set('level', state.level);
    if (state.ns) q.set('ns', state.ns);
    const res = await api('GET', `/api/admin/logs?${q.toString()}`);
    if (!res.ok) {
      status.textContent = res.data?.error || 'could not read the log';
      return;
    }
    const stick = atBottom();
    state.cursor = res.data.cursor;
    const events = res.data.events || [];
    for (const line of events) appendLine(line);
    if (events.length) trim();
    const noun = state.shown === 1 ? 'line' : 'lines';
    status.textContent = state.paused
      ? `paused — ${state.shown} ${noun}`
      : `${state.shown} ${noun} · ${res.data.buffered} buffered in this process`
        + (res.data.dropped > state.dropped ? ` · ${res.data.dropped - state.dropped} dropped since last poll` : '');
    state.dropped = res.data.dropped;
    if (events.length && stick) list.scrollTop = list.scrollHeight;
  }

  // A filter change re-reads from the start of the buffer, because the filter
  // changes which lines exist as far as this view is concerned.
  function applyFilter() {
    state.level = levelSelect.value;
    state.ns = nsInput.value.trim();
    state.cursor = 0;
    state.shown = 0;
    list.replaceChildren();
    tick();
  }

  levelSelect.addEventListener('change', applyFilter);
  let nsTimer = null;
  nsInput.addEventListener('input', () => {
    clearTimeout(nsTimer);
    nsTimer = setTimeout(applyFilter, 300);
  });

  const pause = h('button', { class: 'btn btn-quiet', type: 'button', text: 'Pause' });
  pause.addEventListener('click', () => {
    state.paused = !state.paused;
    pause.textContent = state.paused ? 'Resume' : 'Pause';
    if (!state.paused) tick();
  });

  const clear = h('button', { class: 'btn btn-quiet', type: 'button', text: 'Clear' });
  clear.addEventListener('click', () => { list.replaceChildren(); state.shown = 0; });

  const toolbar = h('div', { class: 'log-toolbar' },
    h('label', { class: 'log-control' }, 'Level', levelSelect),
    h('label', { class: 'log-control' }, 'Namespace', nsInput),
    h('div', { class: 'log-actions' }, pause, clear, status));

  const wrap = h('div', { class: 'log-panel' }, toolbar, list);
  container.append(wrap);

  await tick();
  stopPoll();
  pollTimer = setInterval(tick, 1000);

  container.querySelector('.notice-info')?.remove();
  container.append(h('p', { class: 'note' },
    'Only lines this process logged appear here. The level selector filters what '
    + 'was recorded — it cannot reveal lines the service suppressed, so run it at '
    + 'LOG_LEVEL=debug to see debug output.'));
}

/**
 * The admin area. Kept out of ROUTES because reaching it does not require the
 * signed-in-and-nav-highlighted treatment the household surfaces get: the
 * server decides who may see it, and it has its own sub-navigation.
 */
const ADMIN_ROUTES = {
  '#/admin': renderAdminStatus,
  '#/admin/config': renderAdminConfig,
  '#/admin/voice-turns': renderAdminVoiceTurns,
  '#/admin/logs': renderAdminLogs,
  '#/admin/robots': renderAdminRobots,
  '#/admin/admins': renderAdminAdmins,
};

async function route() {
  stopPoll();
  await consumePublicMailAction();
  // `/admin` is served by the same shell; treat the path as the route so the
  // bare URL works rather than silently landing on the overview.
  const requestedHash = (location.pathname === '/admin' && !location.hash) ? '#/admin' : (location.hash || '#/');
  // Preserve bookmarks for the former People and technical Messages pages.
  // Both now have a single, user-facing destination.
  const legacyRoute = { '#/people': '#/loop', '#/messaging': '#/inbox' }[requestedHash];
  const hash = legacyRoute || requestedHash;
  if (legacyRoute) history.replaceState(null, '', legacyRoute);

  await refreshMe();

  if (ADMIN_ROUTES[hash]) {
    // Administrator access follows the signed-in account, so there is nothing to
    // unlock here: a signed-out visitor gets the sign-in screen instead, and a
    // signed-in non-admin is told so rather than being asked for a password.
    if (!me) return renderAuth();
    shell.hidden = false;
    authRoot.hidden = true;
    paintNav(hash);
    try {
      await ADMIN_ROUTES[hash]();
    } catch (error) {
      show(page('Something went wrong', '',
        errorBox('This page failed to render.', String(error?.message || error))));
    }
    return undefined;
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

addEventListener('hashchange', () => {
  // A tab change in an installed app should start at the top of the next
  // destination, rather than preserve a deep scroll position from the last.
  scrollTo({ top: 0, left: 0, behavior: 'auto' });
  route();
});

initChrome();
initTheme();
initBrand(document).finally(route);
