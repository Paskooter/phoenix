// Phoenix console — vanilla SPA, no build step, no framework.
//
// Hash routes: #/, #/loop, #/settings, #/profile, #/robot, #/tips, #/gallery,
// #/inbox, #/system, plus #/robot/<loopId>[/<section>] (one robot's
// settings), #/add (connection choice), #/add/new (QR pairing), #/claim
// (existing-robot migration) and #/admin.
//
// Every call below goes to the same-origin REST face the portal has always
// used, authenticated by the phx_session cookie. The request shapes are
// unchanged apart from the console's verified-mailbox invitation claim route.

import { qrSvg } from '/qr.js';
import { createLocationPicker } from '/map.js';
import { getBrandSync, initBrand, initTheme, pick } from '/brand.js';
import { createLoopKeyClient } from '/loop-keys.js';
import { createEmailVerificationUi } from '/email-verification.js';
import {
  browserPushState,
  disableBrowserPush,
  dropBrowserPush,
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

const apiRaw = async (method, path, body) => {
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

// Every page renders asynchronously. Without a guard, a slow response for a
// page the user has already left lands afterwards and replaces the page they
// navigated to (or restarts its poll). Each navigation bumps this counter; a
// response that arrives after one is never delivered, so the stale render
// simply stops where it was.
let navSeq = 0;
const api = async (method, path, body) => {
  const seq = navSeq;
  const result = await apiRaw(method, path, body);
  return seq === navSeq ? result : new Promise(() => {});
};
const loopKeys = createLoopKeyClient({ api: apiRaw });
const keyRevocationChannel = typeof BroadcastChannel === 'function' ? new BroadcastChannel('phoenix-private-access') : null;
if (keyRevocationChannel) keyRevocationChannel.onmessage = async ({ data }) => {
  if (!data || data.accountId !== me?.id) return;
  if (data.type === 'logout') {
    clearPrivateView(); await loopKeys.forgetAll(); await loopKeys.setAccount(null); me = null; void route();
  } else if (data.type === 'forget' && typeof data.loopId === 'string') {
    await loopKeys.forget(data.loopId);
  }
};
const privateViewCleanup = new Set();
function clearPrivateView() {
  for (const cleanup of privateViewCleanup) cleanup();
  privateViewCleanup.clear();
}

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
    else if (k === 'on') {
      for (const [ev, fn] of Object.entries(v)) el.addEventListener(ev, ev === 'submit' ? guardSubmit(fn) : fn);
    }
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

/**
 * Wrap an async submit handler so a form cannot be submitted again while its
 * request is in flight. A double-click used to send a message, an invitation or
 * a password change twice. Submit buttons are disabled for the duration.
 */
function guardSubmit(handler) {
  return async function guardedSubmit(event) {
    event.preventDefault();
    const form = event.currentTarget;
    if (form.dataset.busy) return;
    form.dataset.busy = '1';
    form.setAttribute('aria-busy', 'true');
    const buttons = [...form.querySelectorAll('button[type="submit"]')].filter((b) => !b.disabled);
    for (const button of buttons) button.disabled = true;
    try {
      await handler.call(this, event);
    } finally {
      delete form.dataset.busy;
      form.removeAttribute('aria-busy');
      for (const button of buttons) button.disabled = false;
    }
  };
}

const onSubmit = (form, handler) => form.addEventListener('submit', guardSubmit(handler));

/** Inline icon from the shared 24x24 line set. */
const ICONS = {
  home: 'M3.5 10.5 12 3.5l8.5 7M5.5 9.5V20h13V9.5',
  users: 'M16 20v-1.5a3.5 3.5 0 0 0-3.5-3.5h-5A3.5 3.5 0 0 0 4 18.5V20M10 11.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7ZM20 20v-1.5a3.5 3.5 0 0 0-2.6-3.4M15.4 4.6a3.5 3.5 0 0 1 0 6.8',
  sliders: 'M4 7h10M18 7h2M4 17h4M12 17h8M4 12h2M10 12h10M16 5v4M10 15v4M8 10v4',
  search: 'M10.5 17.5a7 7 0 1 0 0-14 7 7 0 0 0 0 14ZM20 20l-4.6-4.6',
  robot: 'M8 4h8a4 4 0 0 1 4 4v8a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4V8a4 4 0 0 1 4-4ZM9.5 10.5h.01M14.5 10.5h.01M9 15h6',
  sparkles: 'm12 2 1.8 5.2L19 9l-5.2 1.8L12 16l-1.8-5.2L5 9l5.2-1.8L12 2ZM19 17l.7 1.3L21 19l-1.3.7L19 21l-.7-1.3L17 19l1.3-.7L19 17ZM4 16l.6 1.4L6 18l-1.4.6L4 20l-.6-1.4L2 18l1.4-.6L4 16Z',
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
  calendar: 'M7 3.5v3M17 3.5v3M4.5 9.5h15M6 5h12a1.5 1.5 0 0 1 1.5 1.5v12A1.5 1.5 0 0 1 18 20H6a1.5 1.5 0 0 1-1.5-1.5v-12A1.5 1.5 0 0 1 6 5Z',
  chevron: 'm6 9 6 6 6-6',
  pin: 'M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11Zm0-8.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z',
  wifi: 'M2.5 9a14 14 0 0 1 19 0M5.5 12.5a9.5 9.5 0 0 1 13 0M8.6 15.9a5 5 0 0 1 6.8 0M12 19.5h.01',
  trash: 'M4.5 7h15M9.5 7V4.5h5V7M6.5 7l.8 12a1.5 1.5 0 0 0 1.5 1.4h6.4a1.5 1.5 0 0 0 1.5-1.4l.8-12M10 11v5.5M14 11v5.5',
  chip: 'M8.5 4h7a4.5 4.5 0 0 1 4.5 4.5v7a4.5 4.5 0 0 1-4.5 4.5h-7A4.5 4.5 0 0 1 4 15.5v-7A4.5 4.5 0 0 1 8.5 4ZM9.5 9.5h5v5h-5zM12 4V1.5m0 21V20M4 12H1.5m21 0H20',
  face: 'M12 20.5a8.5 8.5 0 1 0 0-17 8.5 8.5 0 0 0 0 17ZM9 10v.5M15 10v.5M8.8 14.2a4.3 4.3 0 0 0 6.4 0',
  mic: 'M12 14.5a3 3 0 0 0 3-3v-5a3 3 0 0 0-6 0v5a3 3 0 0 0 3 3ZM6 11.5a6 6 0 0 0 12 0M12 17.5V20.5',
  mail: 'M4.5 5.5h15a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1h-15a1 1 0 0 1-1-1v-11a1 1 0 0 1 1-1ZM4 6.5l8 6 8-6',
  userPlus: 'M14.5 20v-1.5A3.5 3.5 0 0 0 11 15H6a3.5 3.5 0 0 0-3.5 3.5V20M8.5 11.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7ZM18.5 8v6M15.5 11h6',
  sun: 'M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM12 2.5v2M12 19.5v2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M2.5 12h2M19.5 12h2M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4',
  news: 'M5.5 4.5h10a1 1 0 0 1 1 1V18a2 2 0 0 0 2 2h-12a2 2 0 0 1-2-2V5.5a1 1 0 0 1 1-1ZM16.5 9h2a1 1 0 0 1 1 1v8a2 2 0 0 1-2 2M8 8.5h5M8 12h5M8 15.5h3',
  smartHome: 'M3.5 10.5 12 3.5l8.5 7M5.5 9.5V20h13V9.5M12 17.2h.01M10.3 15.5a2.4 2.4 0 0 1 3.4 0M8.75 13.95a4.6 4.6 0 0 1 6.5 0',
  external: 'M7 17 17 7M7 7h10v10',
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
/** `YYYY-MM-DD` for a date input, or '' for a missing or unparseable value. */
const isoDay = (v) => {
  const date = new Date(Number(v));
  return v !== null && v !== undefined && v !== '' && !Number.isNaN(date.getTime()) ? date.toISOString().slice(0, 10) : '';
};

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

const safePhotoPath = (url) => {
  const key = typeof url === 'string' ? url.split('/').pop() : '';
  return /^[A-Za-z0-9_-]+$/.test(key) ? `/member-photos/${key}` : null;
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
let badgesPainted = false;
const emailVerificationUi = createEmailVerificationUi({
  api: apiRaw, h, icon, notify, getAccount: () => me,
  refreshAccount: async () => { await refreshMe(); if (location.hash === '#/profile') await renderProfile(); },
});

/** Fill the sidebar counts once per session, whichever page was opened first. */
async function paintBadges() {
  const [loops, robots] = await Promise.all([apiRaw('GET', '/api/loop'), apiRaw('GET', '/api/robots')]);
  if (robots.ok && Array.isArray(robots.data)) setBadge('badge-robots', robots.data.length);
  if (loops.ok && Array.isArray(loops.data.loops)) setBadge('badge-members', loopPeopleTotal(loops.data.loops));
}

async function refreshMe() {
  const r = await api('GET', '/api/me');
  me = r.ok ? r.data.account : null;
  await loopKeys.setAccount(me?.id || null);
  paintAccount();
  if (me && !badgesPainted) {
    badgesPainted = true;
    void paintBadges();
  }
  if (me) {
    void registerPortalServiceWorker();
    void syncBrowserPush(apiRaw, me.id);
  }
  return me;
}

function paintAccount() {
  shell.hidden = !me;
  authRoot.hidden = !!me;
  emailVerificationUi.paintBanner(document.getElementById('email-verification-banner'), me);
  if (!me) return;
  const avatar = document.getElementById('avatar');
  avatar.textContent = initials(me);
  const photo = safePhotoPath(me.photoUrl);
  avatar.style.backgroundImage = photo ? `url("${photo}")` : '';
  avatar.classList.toggle('has-photo', !!photo);
  document.getElementById('who-name').textContent =
    [me.firstName, me.lastName].filter(Boolean).join(' ') || me.email;
  document.getElementById('who-email').textContent = me.email || '';
  const emailStatus = document.getElementById('who-email-status');
  emailStatus.textContent = me.emailVerified ? 'Email verified' : 'Email not verified';
  emailStatus.className = me.emailVerified ? 'email-status is-verified' : 'email-status is-unverified';

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

const membershipState = (loop) => String((loop.members || [])
  .find((member) => String(member.accountId) === String(me?.id))?.status || '').toLowerCase();

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

// Things to say to Jibo, shared by the Overview and Get to know Jibo.
const SAY_PHRASES = [
  'What time is it?',
  'What’s the weather?',
  'What’s my personal report?',
  'Tell me the news.',
  'Take a picture.',
  'Who was Ada Lovelace?',
];

function greetingFor(date = new Date()) {
  const hour = date.getHours();
  if (hour >= 5 && hour < 12) return 'Good morning';
  if (hour >= 12 && hour < 17) return 'Good afternoon';
  return 'Good evening';
}

/** "just now", "5 minutes ago", "yesterday", or a date. */
function fmtSince(value) {
  const time = Number(value);
  if (!Number.isFinite(time) || time <= 0) return '';
  const minutes = Math.floor((Date.now() - time) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  return fmtAgo(time);
}

/** A clock time from the report's {hour, min}, in the viewer's own format. */
function fmtClock({ hour, min } = {}) {
  if (!Number.isInteger(Number(hour))) return '';
  const date = new Date(2000, 0, 1, Number(hour), Number(min) || 0);
  return date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

/** One line per part of the personal report: what Jibo will include, in words. */
function reportSummary(s) {
  const COMMUTE = { driving: 'Driving', walking: 'Walking', bicycling: 'Cycling', transit: 'Public transit' };
  const topics = Object.entries(s.news?.categories || {}).filter(([, on]) => on)
    .map(([name]) => name[0].toUpperCase() + name.slice(1));
  const commuteReady = s.commute?.home?.lat != null && s.commute?.work?.lat != null;
  const calendars = (s.calendar?.icalSubscriptions || []).filter((item) => item.enabled).length
    + ['googlePersonal', 'googleWork', 'outlookPersonal', 'outlookWork'].filter((key) => s.calendar?.[key]).length;
  const list = (items) => (items.length > 2 ? `${items.slice(0, 2).join(', ')} and ${items.length - 2} more` : items.join(' and '));
  return [
    { icon: 'sun', label: 'Weather', on: !!s.weather?.active,
      value: s.weather?.active ? `On, in ${s.weather.celsius ? '°C' : '°F'}` : 'Off' },
    { icon: 'news', label: 'News', on: !!s.news?.active && topics.length > 0,
      value: !s.news?.active ? 'Off' : (topics.length ? list(topics) : 'No topics picked') },
    { icon: 'pin', label: 'Commute', on: !!s.commute?.active && commuteReady,
      value: !s.commute?.active ? 'Off' : (commuteReady
        ? [COMMUTE[s.commute.mode] || 'Driving', fmtClock(s.commute.time) && `at ${fmtClock(s.commute.time)}`].filter(Boolean).join(' ')
        : 'Home and work not set') },
    { icon: 'calendar', label: 'Calendar', on: !!s.calendar?.active && calendars > 0,
      value: !s.calendar?.active ? 'Off' : (calendars ? `${calendars} calendar${calendars === 1 ? '' : 's'}` : 'No calendar linked') },
  ];
}

async function renderHome() {
  show(page('Overview', '', loading(4)));

  const [loops, robots, settings] = await Promise.all([
    api('GET', '/api/loop'),
    api('GET', '/api/robots'),
    api('GET', '/api/settings'),
  ]);

  const body = page('Overview', 'Here’s how things look across your Jibos.');
  const firstName = meaningfulText(me?.firstName);
  body.querySelector('.page-head h2').textContent = `${greetingFor()}${firstName ? `, ${firstName}` : ''}`;
  const subtitle = body.querySelector('.page-head p');

  // `GET /api/loop` answers { loops: [...] }, not a bare array.
  const loopList = loops.ok && Array.isArray(loops.data.loops) ? loops.data.loops : [];
  const robotList = robots.ok && Array.isArray(robots.data) ? robots.data : [];
  const usableLoops = loopList.filter((loop) => loop.canManage === true || membershipState(loop) === 'accepted');
  const invitations = loopList.filter((loop) => loop.canManage !== true && membershipState(loop) === 'invited');
  setBadge('badge-members', loopPeopleTotal(loopList));
  setBadge('badge-robots', robotList.length);

  // The one sentence that matters most at a glance: is Jibo there?
  const known = robotList.filter((robot) => typeof robot.connection?.connected === 'boolean');
  const connected = known.filter((robot) => robot.connection.connected).length;
  if (!robotList.length && !loopList.length) subtitle.textContent = 'Let’s get your Jibo online.';
  else if (known.length && known.length === robotList.length) {
    subtitle.textContent = robotList.length === 1
      ? (connected ? `${robotName(robotList[0])} is connected right now.` : `${robotName(robotList[0])} isn’t connected right now.`)
      : (connected ? `${connected} of your ${robotList.length} Jibos ${connected === 1 ? 'is' : 'are'} connected right now.`
        : 'None of your Jibos are connected right now.');
  }

  const openLoop = (loopId) => { rememberActiveLoop(loopId); location.hash = '#/loop'; };
  const sectionHead = (title, link) => h('div', { class: 'ov-head' },
    h('h3', { text: title }),
    link ? h('a', { class: 'ov-link', href: link.href }, link.label, icon('arrow', 13)) : null);

  /* -- invitations ------------------------------------------------------- */

  if (invitations.length) {
    body.append(h('section', { class: 'card ov-invites' },
      ...invitations.map((loop) => {
        const people = loopPeople(loop);
        const owner = people.find((person) => person.isOwner);
        const joined = people.filter((person) => !person.invited).length;
        const view = h('button', { type: 'button', class: 'btn btn-sm btn-primary', on: { click: () => openLoop(loop.id) } },
          'View invitation');
        return h('div', { class: 'ov-invite' },
          robotAvatar(loop.avatarColor, 'md'),
          h('div', { class: 'ov-invite-text' },
            h('b', {}, `${owner?.name || 'Someone'} invited you to ${loop.name || 'their loop'}`),
            h('span', {}, `${joined} ${joined === 1 ? 'person is' : 'people are'} in it. Join to see this Jibo’s gallery and inbox.`)),
          view);
      })));
  }

  if (!loops.ok) body.append(errorBox('Could not load your loops.', loops.data.error));
  if (!robots.ok) body.append(errorBox('Could not load your robots.', robots.data.error));

  /* -- a brand-new account --------------------------------------------------- */

  const main = h('div', { class: 'ov-main' });
  const aside = h('div', { class: 'ov-aside' });

  if (robots.ok && loops.ok && !robotList.length && !usableLoops.length) {
    const onJiboIo = /(^|\.)jibo\.io$/i.test(location.hostname);
    main.append(h('section', { class: 'card ov-welcome' },
      h('div', { class: 'ov-welcome-head' },
        robotAvatar('blue', 'lg'),
        h('div', {},
          h('h3', {}, 'Bring your Jibo online'),
          h('p', {}, 'Three steps, and he takes it from there.'))),
      h('ol', { class: 'steps' },
        h('li', {}, h('strong', {}, 'Open him up to SSH. '),
          'The free ', h('a', { class: 'link', href: 'https://github.com/Paskooter/Jibo-DFU-Mod-Toolkit', target: '_blank', rel: 'noopener' }, 'DFU toolkit'),
          ' puts Jibo in int-developer mode and onto your Wi-Fi.'),
        h('li', {}, h('strong', {}, 'Add him here. '), 'Add a Jibo gives you one command to run on a computer on the same network.'),
        h('li', {}, h('strong', {}, 'That’s it. '), 'Jibo updates himself, restarts, and joins your loop.')),
      h('div', { class: 'row' },
        h('a', { class: 'btn btn-primary', href: '#/add' }, icon('plus', 15), 'Add a Jibo'),
        onJiboIo ? h('a', { class: 'btn btn-quiet', href: '/guide' }, 'Read the setup guide') : null)));
  }

  /* -- your Jibos ------------------------------------------------------------- */

  if (robotList.length) {
    const tile = (robot) => h('a', {
      class: 'jibo-tile',
      href: robot.canManage ? `#/robot/${encodeURIComponent(robot.loopId)}` : '#/robot',
      title: robot.friendlyId,
    },
    robotAvatar(robot.avatarColor, 'md'),
    h('span', { class: 'jibo-tile-text' },
      h('b', { text: robotName(robot) }),
      h('span', { text: robot.canManage ? 'Yours' : 'Shared with you' })),
    h('span', { class: 'jibo-tile-foot' },
      connectionStatus(robot.connection),
      h('span', { class: 'jibo-tile-facts', text: robot.lastSeen ? `Seen ${fmtSince(robot.lastSeen)}` : 'Not seen yet' })));
    main.append(h('section', { class: 'ov-section' },
      sectionHead(robotList.length === 1 ? 'Your Jibo' : 'Your Jibos', { href: '#/robot', label: 'Robots' }),
      h('div', { class: 'jibo-grid' },
        ...robotList.map(tile),
        h('a', { class: 'jibo-tile jibo-tile-add', href: '#/add' },
          h('span', { class: 'jibo-add-ic' }, icon('plus', 18)),
          h('span', { class: 'jibo-tile-text' }, h('b', {}, 'Add a Jibo'), h('span', {}, 'Bring another robot online'))))));
  }

  /* -- loops ------------------------------------------------------------------- */

  if (usableLoops.length) {
    main.append(h('section', { class: 'ov-section' },
      sectionHead(usableLoops.length === 1 ? 'Your loop' : 'Your loops', { href: '#/loop', label: 'Loops' }),
      h('div', { class: 'loop-list' }, ...usableLoops.map((loop) => {
        const people = loopPeople(loop);
        const joined = people.filter((person) => !person.invited);
        const invited = people.length - joined.length;
        const owner = people.find((person) => person.isOwner);
        const facts = [`${joined.length} ${joined.length === 1 ? 'person' : 'people'}`];
        if (invited) facts.push(`${invited} invited`);
        facts.push(loop.canManage ? 'You own it' : `Owned by ${owner?.name || 'someone else'}`);
        const shown = joined.slice(0, 5);
        return h('button', { type: 'button', class: 'loop-row', on: { click: () => openLoop(loop.id) } },
          h('span', { class: 'avatar-stack', 'aria-hidden': 'true' },
            ...shown.map((person) => personAvatar(person.name, {
              key: person.id, size: 'sm', photo: person.isMe ? safePhotoPath(me?.photoUrl) : null,
            })),
            joined.length > shown.length ? h('span', { class: 'person-avatar person-avatar-sm avatar-more' }, `+${joined.length - shown.length}`) : null),
          h('span', { class: 'loop-row-text' },
            h('b', { text: loop.name || 'Unnamed loop' }),
            h('span', { text: facts.join(' · ') })),
          icon('chevron', 16, 'loop-row-caret'));
      }))));
  }

  // Photographs arrive after the rest of the page: they are the slowest thing
  // to fetch, and the page is useful without them.
  const photos = h('section', { class: 'ov-section', hidden: true });
  main.append(photos);

  /* -- your personal report ------------------------------------------------ */

  const report = h('section', { class: 'card ov-report' },
    h('div', { class: 'card-head' }, h('h3', {}, 'Your personal report'),
      h('span', { class: 'spacer' }), h('a', { class: 'btn btn-sm', href: '#/settings' }, 'Edit')));
  if (settings.ok && settings.data.settings) {
    const rows = reportSummary(settings.data.settings);
    report.append(h('div', { class: 'card-body' },
      h('ul', { class: 'report-rows' }, ...rows.map((item) => h('li', { class: item.on ? 'is-on' : '' },
        h('span', { class: 'report-ic' }, icon(item.icon, 15)),
        h('span', { class: 'report-label', text: item.label }),
        h('span', { class: 'report-value', text: item.value })))),
      h('p', { class: 'field-hint' }, 'Ask “Hey Jibo, what’s my personal report?”',
        settings.data.settings.offerProactively ? ' He also offers it when he recognizes you.' : '')));
  } else {
    report.append(h('div', { class: 'card-body' }, errorBox('Could not load your personal report settings.', settings.data?.error)));
  }
  aside.append(report);

  /* -- things to try ------------------------------------------------------------ */

  const day = Math.floor(Date.now() / 86400000);
  const phrases = [0, 1, 2].map((i) => SAY_PHRASES[(day + i) % SAY_PHRASES.length]);
  aside.append(h('section', { class: 'card say-card ov-say' },
    h('div', { class: 'card-body' },
      h('h3', {}, 'Say “Hey Jibo”, then ask'),
      h('ul', { class: 'say-list' }, ...phrases.map((phrase) => h('li', {}, phrase))),
      h('a', { class: 'ov-link', href: '#/tips' }, 'More things to try', icon('arrow', 13)))));

  body.append(h('div', { class: 'ov-grid' }, main, aside));
  show(body);

  if (usableLoops.length) loadRecentPhotos(usableLoops, photos, sectionHead);
}

/** Up to six of the newest photographs across the given loops, into `slot`. */
async function loadRecentPhotos(loops, slot, sectionHead) {
  const responses = await Promise.all(loops.map((loop) => api('GET', `/api/media?loopId=${encodeURIComponent(loop.id)}`)));
  const items = responses.flatMap((result) => (result.ok ? (result.data.media || []) : []))
    .filter((m) => !m.isDeleted && m.url && !m.reference && m.type !== 'video')
    .map((m) => {
      const thumbs = Array.isArray(m.thumbs) ? m.thumbs.filter((thumb) => thumb && thumb.url && thumb.path) : [];
      const preview = thumbs.find((thumb) => thumb.type === 'thumb') || thumbs[0] || m;
      const key = String(preview.path || '').split('/').pop();
      return /^[A-Za-z0-9_-]+$/.test(key) ? { ...preview, path: key,
        loopId: m.loopId, created: Number(m.created || 0) } : null;
    })
    .filter(Boolean)
    .sort((a, b) => b.created - a.created)
    .slice(0, 6);
  if (!items.length || !slot.isConnected) return;
  slot.replaceChildren(
    sectionHead('Recent photos', { href: '#/gallery', label: 'Gallery' }),
    h('div', { class: 'photo-strip' }, ...items.map((item) => h('a', { class: 'photo-tile', href: '#/gallery' },
      secureCapturePreview(item, { alt: `Photo taken ${fmtDate(item.created)}` })))));
  slot.hidden = false;
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

/* -- people -------------------------------------------------------------- */

// Initials on a color chosen from the person's name, so a household looks the
// same on every visit. Only the signed-in account's own photo is shown: the
// photo route serves each account its own picture and nobody else's.
const PERSON_TONES = 8;
function personTone(key) {
  let hash = 0;
  for (const ch of String(key || '')) hash = (hash * 31 + ch.codePointAt(0)) >>> 0;
  return hash % PERSON_TONES;
}
function initialsOf(name) {
  const words = String(name || '').replace(/[“”"]/g, '').trim().split(/[\s@._-]+/).filter(Boolean);
  return (words.slice(0, 2).map((word) => [...word][0]).join('') || '?').toUpperCase();
}
function personAvatar(name, { key = name, photo = null, size = 'md' } = {}) {
  const el = h('span', { class: `person-avatar person-avatar-${size} tone-${personTone(key)}`, 'aria-hidden': 'true' },
    initialsOf(name));
  if (photo) {
    el.style.backgroundImage = `url("${photo}")`;
    el.classList.add('has-photo');
  }
  return el;
}

/** "today", "3 days ago", or a date, for when something happened. */
function fmtAgo(value) {
  const time = Number(value);
  if (!Number.isFinite(time) || time <= 0) return '';
  const days = Math.floor((Date.now() - time) / 86400000);
  if (days < 1) return 'today';
  if (days < 2) return 'yesterday';
  if (days < 14) return `${days} days ago`;
  return `on ${fmtDay(time)}`;
}

/** The people of a loop, in the order a household reads them. */
function loopPeople(loop) {
  const same = (a, b) => a != null && b != null && String(a) === String(b);
  const fullName = (first, last) => [first, last].filter(Boolean).join(' ');
  return (loop.members || [])
    .filter((m) => !(m.accountId && same(m.accountId, loop.robot)))
    .map((m) => {
      const props = m.memberProperties || {};
      const email = m.account?.email || props.email || null;
      const name = fullName(props.firstName, props.lastName)
        || fullName(m.account?.firstName, m.account?.lastName)
        || m.nickname
        || (email ? email.split('@')[0] : '')
        || 'Unnamed person';
      return {
        m,
        id: m.id,
        name,
        firstName: props.firstName || m.account?.firstName || name.split(' ')[0],
        email,
        nickname: meaningfulText(m.nickname),
        phonetic: meaningfulText(m.phoneticName),
        isOwner: same(m.accountId, loop.owner),
        isMe: same(m.accountId, me?.id),
        invited: String(m.status || '').toLowerCase() === 'invited',
        hasAccount: !!m.account,
        inactive: m.account?.isActive === false,
        face: !!m.enrolled?.face,
        voice: !!m.enrolled?.voice,
        created: m.created,
      };
    })
    .sort((a, b) => (Number(b.isOwner) - Number(a.isOwner)) || (Number(b.isMe) - Number(a.isMe))
      || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
}

/** People across every loop the account can use, for the sidebar count. */
function loopPeopleTotal(loops) {
  return (loops || [])
    .filter((loop) => loop.canManage === true || (loop.members || []).some((member) =>
      String(member.accountId) === String(me?.id) && String(member.status || '').toLowerCase() === 'accepted'))
    .reduce((n, loop) => n + (loop.members || []).filter((m) => !(m.accountId && m.accountId === loop.robot)).length, 0);
}

/** What Jibo knows about someone: two small marks, spelled out for screen readers. */
function recognitionMarks(person) {
  const mark = (known, iconName, label) => h('span', {
    class: `recog-mark ${known ? 'is-known' : ''}`,
    title: known ? `Jibo knows ${person.firstName}’s ${label.toLowerCase()}` : `Jibo hasn’t learned ${person.firstName}’s ${label.toLowerCase()} yet`,
    'aria-label': `${label}: ${known ? 'known' : 'not learned yet'}`,
  }, icon(iconName, 13), h('span', { class: 'recog-label' }, label));
  return h('span', { class: 'recog' }, mark(person.face, 'face', 'Face'), mark(person.voice, 'mic', 'Voice'));
}

/* -- the page -------------------------------------------------------------- */

// What stays put when the page redraws itself after a change: the open
// person, the add form, and the scroll position. A fresh visit starts clean.
let loopUi = { open: null, add: false, addMode: 'email', setting: null };

async function renderLoop({ keep = false } = {}) {
  if (!keep) loopUi = { open: null, add: false, addMode: 'email', setting: null };
  const scrollBack = keep ? scrollY : null;
  const title = 'Loops';
  const description = 'The people around each Jibo, and what he knows about them.';
  if (!keep) show(page(title, description, loading(5)));

  if (pendingInvitation) {
    if (pendingInvitation.email && pendingInvitation.email.toLowerCase() !== me.email?.toLowerCase()) {
      show(page('Your invitation', '', card('Sign in with the invited email', {},
        h('p', {}, `This invitation was sent to ${pendingInvitation.email}. You are signed in as ${me.email}.`),
        h('button', { type: 'button', class: 'btn btn-primary', on: { click: () => document.getElementById('logout').click() } },
          'Switch account'))));
      return;
    }
    const claimed = await api('POST', '/api/loop/invitations/claim', {});
    if (!claimed.ok) {
      show(page('Your invitation', '', errorBox('Could not load your invitation.', claimed.data.error)));
      return;
    }
  }

  const context = await householdContext();
  const container = page(title, description);
  const finish = () => {
    show(container);
    if (scrollBack !== null) scrollTo({ top: scrollBack, left: 0, behavior: 'instant' });
    const track = container.querySelector('.loop-tabs');
    const current = track?.querySelector('[aria-current]');
    if (current && track.scrollWidth > track.clientWidth) {
      const offset = current.getBoundingClientRect().left - track.getBoundingClientRect().left;
      track.scrollLeft += offset - (track.clientWidth - current.offsetWidth) / 2;
    }
  };

  if (!context.ok) { container.append(errorBox('Could not load your loops.', context.error)); return finish(); }
  if (pendingInvitation) {
    const target = pendingInvitation.loopId
      ? context.loops.find((loop) => String(loop.id) === pendingInvitation.loopId)
      : context.loops.find((loop) => membershipState(loop) === 'invited');
    if (target) {
      rememberActiveLoop(target.id);
      context.active = target;
      if (membershipState(target) !== 'invited') clearPendingInvitation();
    } else {
      container.append(card('Invitation unavailable', {},
        h('p', {}, me.emailVerified
          ? 'This invitation may have been cancelled or the loop may be suspended. Ask the loop owner to send another invitation.'
          : 'Verify your email address before this invitation can be linked to your account.'),
        !me.emailVerified ? h('a', { class: 'btn btn-primary', href: '#/profile' }, 'Verify your email') : null,
        h('button', { type: 'button', class: 'btn', on: { click: () => { clearPendingInvitation(); renderLoop(); } } }, 'Back to your loops')));
      return finish();
    }
  }
  setBadge('badge-members', loopPeopleTotal(context.loops));
  const active = context.active;
  if (!active) {
    container.append(card('', {},
      empty('No loops yet', 'A loop is the household around one Jibo. It starts when you pair your first robot.', 'users'),
      h('div', { class: 'row', style: 'justify-content:center;margin-top:0' },
        h('a', { class: 'btn btn-primary', href: '#/add' }, icon('plus', 15), 'Add a Jibo'))));
    return finish();
  }

  const tabs = loopTabs(context);
  if (tabs) container.append(tabs);

  const isOwner = active.canManage === true;
  const people = loopPeople(active);
  const mine = people.find((person) => person.isMe);
  const owner = people.find((person) => person.isOwner);
  const refresh = () => renderLoop({ keep: true });
  const color = robotColorOf(active.avatarColor);

  // A pending invitation is not a usable household yet: the original app took
  // an invited member to an explicit accept/decline screen rather than showing
  // controls that would fail with 403.
  if (!isOwner && mine?.invited) {
    container.append(invitationCard(active, people, owner, color));
    return finish();
  }

  container.append(loopHero(active, people, { isOwner, owner, color }));
  if (active.isSuspended) {
    container.append(h('div', { class: 'notice notice-warn' }, icon('alert', 16),
      h('div', {}, isOwner
        ? 'This loop is suspended. Nobody can join it, and nobody in it can be changed, until you resume it.'
        : 'This loop is suspended by its owner. Nobody can join it or be changed until it is resumed.'),
      isOwner ? h('button', { type: 'button', class: 'btn btn-sm', style: 'margin-inline-start:auto', on: { click: () => setSuspended(false) } }, 'Resume') : null));
  }

  /* -- people ----------------------------------------------------------- */

  const joined = people.filter((person) => !person.invited);
  const invited = people.filter((person) => person.invited).sort((a, b) => Number(b.created || 0) - Number(a.created || 0));
  const counts = [`${joined.length} ${joined.length === 1 ? 'person' : 'people'}`];
  if (invited.length) counts.push(`${invited.length} invited`);

  const list = h('div', { class: 'people-list' });
  // replaceChildren() would render a null as the text "null".
  const paintPeople = () => list.replaceChildren(...[
    ...joined.map(personRow),
    invited.length ? h('div', { class: 'people-group' }, 'Invited') : null,
    ...invited.map(personRow),
  ].filter(Boolean));
  paintPeople();
  const peopleCard = card('People', { sub: counts.join(' · ') },
    list,
    joined.length ? h('p', { class: 'people-note' },
      'Jibo learns faces and voices on the robot itself. The green marks show what he already knows.') : null);
  peopleCard.querySelector('.card-body').classList.add('people-body');
  container.append(peopleCard);

  /* -- add someone ------------------------------------------------------ */

  let addCard = null;
  if (isOwner && !active.isSuspended) {
    addCard = h('section', { class: 'card add-person', id: 'add-person' });
    paintAdd();
    container.append(addCard);
  }

  /* -- loop settings ------------------------------------------------------ */

  const settingsHost = h('div', { class: 'loop-settings' });
  const paintSettings = () => settingsHost.replaceChildren(isOwner ? ownerSettings() : memberSettings());
  paintSettings();
  container.append(settingsHost);

  finish();

  /* -- rows ---------------------------------------------------------------- */

  function personRow(person) {
    const chips = [
      person.isMe ? h('span', { class: 'pill pill-accent' }, 'You') : null,
      person.isOwner ? h('span', { class: 'pill' }, 'Owner') : null,
      person.inactive ? h('span', { class: 'pill pill-error' }, 'Account disabled') : null,
    ].filter(Boolean);

    const details = [];
    if (person.nickname) details.push(`Jibo calls ${person.isMe ? 'you' : 'them'} “${person.nickname}”`);
    if (person.invited) {
      details.push(`Invited ${fmtAgo(person.created)}`.trim());
      if (isOwner && person.email) details.push(person.email);
    } else if (isOwner) {
      details.push(person.hasAccount ? (person.email || 'Has an account') : 'No account');
    } else if (!person.hasAccount) {
      details.push('No account');
    }

    const canManage = isOwner && !active.isSuspended;
    const panelId = `person-panel-${person.id}`;
    const open = canManage && loopUi.open === person.id;
    const toggle = canManage ? h('button', {
      type: 'button',
      class: `btn btn-sm person-manage-btn${open ? ' is-open' : ''}`,
      'aria-expanded': String(open),
      'aria-controls': panelId,
      'aria-label': `${open ? 'Close' : 'Manage'} ${person.name}`,
      on: { click: () => { loopUi.open = open ? null : person.id; paintPeople(); } },
    }, h('span', { class: 'person-manage-label' }, open ? 'Done' : 'Manage'), icon('chevron', 14, 'person-manage-caret')) : null;

    return h('div', { class: `person${open ? ' is-open' : ''}`, 'data-member': person.id },
      h('div', { class: 'person-row' },
        personAvatar(person.name, { key: person.id, photo: person.isMe ? safePhotoPath(me?.photoUrl) : null }),
        h('div', { class: 'person-main' },
          h('div', { class: 'person-name' }, h('span', { class: 'person-name-text', text: person.name }), ...chips),
          details.length ? h('div', { class: 'person-sub', text: details.join(' · ') }) : null),
        person.invited ? h('span') : recognitionMarks(person),
        toggle || h('span')),
      open ? managePanel(person, panelId) : null);
  }

  function managePanel(person, panelId) {
    const sections = [];

    // What Jibo calls them.
    const nameForm = h('form', { class: 'person-form' },
      field('Nickname', h('input', { name: 'nickname', value: person.nickname || '', placeholder: person.firstName, autocomplete: 'off' }),
        'Leave empty to use their first name.'),
      field('Pronunciation', h('input', { name: 'phoneticName', value: person.phonetic || '', placeholder: 'e.g. Nah-nah', autocomplete: 'off' }),
        'Spell it the way it sounds, if Jibo says it wrong.'),
      h('div', { class: 'person-form-actions' }, h('button', { type: 'submit', class: 'btn btn-sm btn-primary' }, 'Save')));
    nameForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      const fd = new FormData(nameForm);
      const nickname = String(fd.get('nickname') || '').trim() || null;
      const phoneticName = String(fd.get('phoneticName') || '').trim() || null;
      const calls = [];
      if (nickname !== person.nickname) calls.push(api('POST', '/api/loop/members/nickname', { loopId: active.id, id: person.id, nickname }));
      if (phoneticName !== person.phonetic) calls.push(api('POST', '/api/loop/members/phonetic', { loopId: active.id, id: person.id, phoneticName }));
      if (!calls.length) { notify('Nothing to save'); return; }
      const results = await Promise.all(calls);
      const failed = results.find((result) => !result.ok);
      if (failed) { notify(failed.data.error || 'Could not save', 'error'); return; }
      notify('Saved');
      refresh();
    });
    sections.push(h('div', { class: 'person-section' },
      h('h4', { class: 'setting-group-title' }, person.isMe ? 'What Jibo calls you' : 'What Jibo calls them'), nameForm));

    // Their account or invitation.
    if (person.invited) {
      const resend = h('button', { type: 'button', class: 'btn btn-sm' }, icon('mail', 14), 'Resend invitation');
      resend.addEventListener('click', async () => {
        resend.disabled = true;
        const res = await api('POST', '/api/loop/invite', {
          loopId: active.id,
          email: person.email,
          firstName: person.m.memberProperties?.firstName || undefined,
          lastName: person.m.memberProperties?.lastName || undefined,
        });
        resend.disabled = false;
        if (res.ok) { notify(`Invitation sent again to ${person.email}`); refresh(); }
        else notify(res.data.error || 'Could not resend the invitation', 'error');
      });
      sections.push(h('div', { class: 'person-section' },
        h('h4', { class: 'setting-group-title' }, 'Invitation'),
        h('p', { class: 'person-section-text' }, person.email
          ? `Sent to ${person.email} ${fmtAgo(person.created)}. They join by accepting it after signing in.`
          : `Sent ${fmtAgo(person.created)}.`),
        person.email ? h('div', { class: 'row' }, resend) : null));
    } else if (!person.isOwner) {
      sections.push(h('div', { class: 'person-section' },
        h('h4', { class: 'setting-group-title' }, 'Account'),
        ...(person.hasAccount ? linkedAccountSection(person) : accountLinker(person))));
    }

    if (!person.isOwner) {
      const remove = h('button', { type: 'button', class: 'btn btn-sm btn-quiet btn-danger-quiet' },
        icon('trash', 14), person.invited ? 'Cancel invitation' : `Remove ${person.firstName}`);
      remove.addEventListener('click', () => removePerson(person));
      sections.push(h('div', { class: 'person-panel-foot' }, remove));
    } else {
      sections.push(h('p', { class: 'person-panel-foot field-hint' },
        person.isMe ? 'You own this loop. To hand it to someone else, use Transfer ownership below.' : 'The owner of this loop.'));
    }
    return h('div', { class: 'person-panel', id: panelId }, ...sections);
  }

  function linkedAccountSection(person) {
    const unlink = h('button', { type: 'button', class: 'btn btn-sm' }, 'Unlink account');
    unlink.addEventListener('click', async () => {
      const yes = await confirmDialog({
        title: `Unlink ${person.firstName}’s account?`,
        body: `${person.name} stays in the loop, but Jibo will stop giving them their personal report until an account is linked again.`,
        confirmLabel: 'Unlink',
      });
      if (!yes) return;
      const res = await api('POST', '/api/loop/members/unlink', { loopId: active.id, id: person.id });
      if (res.ok) { notify('Account unlinked'); refresh(); }
      else notify(res.data.error || 'Could not unlink', 'error');
    });
    return [
      h('p', { class: 'person-section-text' },
        person.email ? h('span', {}, 'Linked to ', h('strong', { text: person.email }), '. ') : null,
        'Jibo uses this account for their personal report and messages.'),
      h('div', { class: 'row' }, unlink),
    ];
  }

  // Link an existing account to someone Jibo already knows, so he can give
  // them their own personal report. The server only finds accounts by their
  // exact address, or ones already in this owner's loops.
  function accountLinker(person) {
    const input = h('input', { type: 'email', name: 'email', placeholder: 'Their email address', 'aria-label': `Email address of ${person.name}’s account`, autocomplete: 'off', required: true });
    const results = h('div', { class: 'link-results', 'aria-live': 'polite' });
    const find = h('button', { type: 'submit', class: 'btn btn-sm' }, 'Find account');
    const form = h('form', { class: 'link-form' }, input, find);
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const term = input.value.trim();
      if (term.length < 3) { results.replaceChildren(h('p', { class: 'link-empty' }, 'Enter the address they sign in with.')); return; }
      find.disabled = true;
      const res = await api('GET', `/api/accounts/search?email=${encodeURIComponent(term)}`);
      find.disabled = false;
      if (!res.ok) { results.replaceChildren(h('p', { class: 'link-empty' }, res.data.error || 'Could not search accounts.')); return; }
      const accounts = res.data.accounts || [];
      if (!accounts.length) {
        results.replaceChildren(h('p', { class: 'link-empty' },
          'No account uses that address yet. Once they create one on this site, link it here.'));
        return;
      }
      results.replaceChildren(...accounts.slice(0, 6).map((account) => {
        const label = [account.firstName, account.lastName].filter(Boolean).join(' ') || account.email;
        const link = h('button', { type: 'button', class: 'btn btn-sm btn-primary' }, icon('link', 14), 'Link');
        link.addEventListener('click', async () => {
          link.disabled = true;
          const linked = await api('POST', '/api/loop/members/link', { loopId: active.id, id: person.id, accountId: account.id });
          if (linked.ok) { notify(`${person.firstName} is now linked to ${account.email}`); refresh(); }
          else { link.disabled = false; notify(linked.data.error || 'Could not link that account', 'error'); }
        });
        return h('div', { class: 'link-result' },
          personAvatar(label, { key: account.id, size: 'sm' }),
          h('div', { class: 'link-result-text' }, h('b', { text: label }), h('span', { text: account.email })),
          link);
      }));
    });
    return [
      h('p', { class: 'person-section-text' },
        'No account. Jibo still knows them, but can’t give them a personal report. If they have an account on this site, link it:'),
      form,
      results,
    ];
  }

  /* -- add someone ----------------------------------------------------------- */

  function openAdd(open) {
    loopUi.add = open;
    paintAdd();
    if (open) {
      addCard.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      addCard.querySelector('input[name=firstName]')?.focus({ preventScroll: true });
    }
  }

  function paintAdd() {
    if (!loopUi.add) {
      addCard.replaceChildren(h('button', { type: 'button', class: 'add-person-tile', on: { click: () => openAdd(true) } },
        h('span', { class: 'add-person-ic' }, icon('userPlus', 18)),
        h('span', { class: 'add-person-text' },
          h('b', {}, `Add someone to ${active.name}`),
          h('span', {}, 'Invite them by email, or add a child or anyone else who won’t sign in.'))));
      return;
    }
    const byEmail = loopUi.addMode === 'email';
    const choice = (value, iconName, label, hint) => h('label', { class: `choice${loopUi.addMode === value ? ' is-selected' : ''}` },
      h('input', { type: 'radio', name: 'mode', value, checked: loopUi.addMode === value,
        on: { change: () => { loopUi.addMode = value; keepDraft(); paintAdd(); } } }),
      h('span', { class: 'choice-ic' }, icon(iconName, 16)),
      h('span', { class: 'choice-text' }, h('b', {}, label), h('span', {}, hint)));
    const draft = loopUi.draft || {};
    const form = h('form', { class: 'add-person-form' },
      h('fieldset', { class: 'choices' },
        h('legend', { class: 'field-label' }, 'How should they join?'),
        h('div', { class: 'choice-grid' },
          choice('email', 'mail', 'Invite by email', 'They get an email and join with their own account, so Jibo can give them a personal report.'),
          choice('local', 'user', 'Add without an account', 'For children, or anyone who won’t sign in. Jibo can still learn their face and voice.'))),
      h('div', { class: 'add-person-fields' },
        field('First name', h('input', { name: 'firstName', required: true, autocomplete: 'off', value: draft.firstName || '' })),
        field('Last name', h('input', { name: 'lastName', autocomplete: 'off', value: draft.lastName || '' }), 'Optional'),
        byEmail ? field('Email', h('input', { name: 'email', type: 'email', required: true, autocomplete: 'off', placeholder: 'name@example.com', value: draft.email || '' })) : null),
      h('div', { class: 'row' },
        h('button', { type: 'submit', class: 'btn btn-primary' }, byEmail ? 'Send invitation' : 'Add to loop'),
        h('button', { type: 'button', class: 'btn btn-quiet', on: { click: () => { loopUi.draft = null; openAdd(false); } } }, 'Cancel')));
    function keepDraft() {
      const fd = new FormData(form);
      loopUi.draft = { firstName: fd.get('firstName') || '', lastName: fd.get('lastName') || '', email: fd.get('email') || draft.email || '' };
    }
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const fd = new FormData(form);
      const payload = { loopId: active.id, firstName: String(fd.get('firstName') || '').trim() };
      const lastName = String(fd.get('lastName') || '').trim();
      if (lastName) payload.lastName = lastName;
      if (byEmail) payload.email = String(fd.get('email') || '').trim();
      const button = form.querySelector('button[type=submit]');
      button.disabled = true;
      const res = await api('POST', '/api/loop/invite', payload);
      button.disabled = false;
      if (!res.ok) { notify(res.data.error || 'Could not add them', 'error'); return; }
      notify(byEmail ? `Invitation sent to ${payload.email}` : `${payload.firstName} is now in ${active.name}`);
      loopUi.add = false;
      loopUi.draft = null;
      refresh();
    });
    addCard.replaceChildren(
      h('div', { class: 'card-head' }, h('h3', {}, 'Add someone'), h('span', { class: 'sub', text: active.name })),
      h('div', { class: 'card-body' }, form));
  }

  /* -- settings -------------------------------------------------------------- */

  // One row of the settings card. With an editor, its button opens the editor
  // in place; without one, the button acts at once (after its own confirmation).
  function settingLine(key, { label, value = null, hint = null, action = null, onAction = null, editor = null, danger = false }) {
    const editing = loopUi.setting === key;
    let button = null;
    if (action) {
      button = h('button', {
        type: 'button',
        class: `btn btn-sm${danger && !editing ? ' btn-danger' : ''}`,
        'aria-expanded': editor ? String(editing) : undefined,
      }, editing ? 'Cancel' : action);
      button.addEventListener('click', () => {
        if (!editor) { onAction(); return; }
        loopUi.setting = editing ? null : key;
        paintSettings();
        if (!editing) settingsHost.querySelector('.setting-line-editor input, .setting-line-editor select')?.focus();
      });
    }
    return h('div', { class: `setting-line${editing ? ' is-editing' : ''}` },
      h('div', { class: 'setting-line-text' },
        h('span', { class: 'setting-line-label', text: label }),
        value ? h('span', { class: 'setting-line-value' }, value) : null,
        hint ? h('span', { class: 'setting-line-hint', text: hint }) : null),
      button,
      editing && editor ? h('div', {
        class: 'setting-line-editor',
        on: { keydown: (event) => { if (event.key === 'Escape') { loopUi.setting = null; paintSettings(); } } },
      }, editor()) : null);
  }

  function technicalDetails() {
    return h('details', { class: 'loop-tech' },
      h('summary', {}, icon('chevron', 14, 'loop-tech-caret'), 'Technical details'),
      h('div', { class: 'loop-tech-body' },
        row('Loop ID', h('span', { class: 'mono-copy' }, h('code', { text: active.id }), copyButton(() => active.id))),
        row('Jibo ID', active.robotFriendlyId ? h('code', { text: active.robotFriendlyId }) : 'No Jibo paired'),
        active.created ? row('Created', fmtDay(active.created)) : null));
  }

  function ownerSettings() {
    const candidates = people.filter((person) => !person.isMe && !person.invited && person.hasAccount && !person.inactive);
    const lines = [
      settingLine('name', {
        label: 'Name',
        value: h('span', { text: active.name }),
        hint: 'Also Jibo’s name in this console, for everyone in the loop.',
        action: 'Rename',
        editor: () => {
          const input = h('input', { name: 'name', value: active.name, required: true, maxlength: 80, 'aria-label': 'Loop name' });
          const form = h('form', { class: 'inline-edit' }, input, h('button', { type: 'submit', class: 'btn btn-sm btn-primary' }, 'Save'));
          form.addEventListener('submit', async (event) => {
            event.preventDefault();
            const name = input.value.trim();
            if (!name) return;
            if (name === active.name) { loopUi.setting = null; paintSettings(); return; }
            const res = await api('PUT', '/api/loop', { loopId: active.id, name });
            if (res.ok) { notify('Renamed'); loopUi.setting = null; refresh(); }
            else notify(res.data.error || 'Could not rename', 'error');
          });
          return form;
        },
      }),
      settingLine('owner', {
        label: 'Owner',
        value: h('span', {}, 'You'),
        hint: candidates.length
          ? 'Hand this loop, and control of its Jibo’s settings, to someone else in it. You stay a member.'
          : 'Only someone in this loop with their own account can become its owner.',
        action: candidates.length ? 'Transfer…' : null,
        editor: () => {
          const select = h('select', { name: 'to', 'aria-label': 'New owner' },
            ...candidates.map((person) => h('option', { value: person.m.accountId }, person.email ? `${person.name} (${person.email})` : person.name)));
          const form = h('form', { class: 'inline-edit' }, select, h('button', { type: 'submit', class: 'btn btn-sm btn-danger' }, 'Transfer ownership'));
          form.addEventListener('submit', async (event) => {
            event.preventDefault();
            const target = candidates.find((person) => String(person.m.accountId) === select.value);
            if (!target) return;
            const yes = await confirmDialog({
              title: `Make ${target.name} the owner?`,
              body: `${target.name} will manage ${active.name} and its Jibo’s settings. You stay in the loop as a member, and only the new owner can undo this.`,
              confirmLabel: 'Transfer ownership',
            });
            if (!yes) return;
            const res = await api('POST', '/api/loop/transfer', { loopId: active.id, toAccountId: target.m.accountId });
            if (res.ok) { notify(`${target.name} now owns ${active.name}`); loopUi.setting = null; refresh(); }
            else notify(res.data.error || 'Could not transfer ownership', 'error');
          });
          return form;
        },
      }),
      active.isSuspended
        ? settingLine('suspend', {
          label: 'Suspended',
          hint: 'Nobody can join this loop or be changed in it until you resume it.',
          action: 'Resume loop',
          onAction: () => setSuspended(false),
        })
        : settingLine('suspend', {
          label: 'Suspend loop',
          hint: 'Freezes the loop: nobody can join it or be changed until you resume it.',
          action: 'Suspend…',
          onAction: () => setSuspended(true),
          danger: true,
        }),
    ];
    return card('Loop settings', {}, h('div', { class: 'setting-lines' }, ...lines), technicalDetails());
  }

  function memberSettings() {
    const leave = mine ? settingLine('leave', {
      label: 'Leave this loop',
      hint: 'You’ll lose access to its Jibo’s gallery and inbox. The owner can invite you again.',
      action: 'Leave…',
      onAction: () => leaveLoop(),
      danger: true,
    }) : null;
    return card('About this loop', {},
      h('div', { class: 'setting-lines' },
        settingLine('owner', {
          label: 'Owner',
          value: owner ? h('span', { text: owner.name }) : h('span', {}, 'Unknown'),
          hint: 'The owner adds people and changes this loop’s settings.',
        }),
        leave),
      technicalDetails());
  }

  /* -- actions ---------------------------------------------------------------- */

  async function removePerson(person) {
    const yes = await confirmDialog(person.invited
      ? {
        title: `Cancel ${person.firstName}’s invitation?`,
        body: `The invitation${person.email ? ` sent to ${person.email}` : ''} will stop working. You can invite them again later.`,
        confirmLabel: 'Cancel invitation',
      }
      : {
        title: `Remove ${person.name}?`,
        body: `${person.name} will no longer be part of ${active.name}, and Jibo will stop treating them as one of the family.`,
        confirmLabel: 'Remove',
      });
    if (!yes) return;
    const res = await api('POST', '/api/loop/members/remove', { loopId: active.id, id: person.id });
    if (res.ok) { notify(person.invited ? 'Invitation cancelled' : `${person.name} was removed`); loopUi.open = null; refresh(); }
    else notify(res.data.error || 'Could not remove them', 'error');
  }

  async function leaveLoop() {
    const yes = await confirmDialog({
      title: `Leave ${active.name}?`,
      body: 'You will lose access to this loop’s Jibo, gallery and inbox. The owner can invite you again later.',
      confirmLabel: 'Leave loop',
    });
    if (!yes) return;
    const res = await api('POST', '/api/loop/members/remove', { loopId: active.id, id: mine.id });
    if (!res.ok) { notify(res.data.error || 'Could not leave the loop', 'error'); return; }
    rememberActiveLoop('');
    notify(`You left ${active.name}`);
    location.hash = '#/';
  }

  async function setSuspended(suspend) {
    if (suspend) {
      const yes = await confirmDialog({
        title: `Suspend ${active.name}?`,
        body: 'Nobody can join the loop, and nobody in it can be changed, until you resume it. Jibo keeps working for the people already in it.',
        confirmLabel: 'Suspend loop',
      });
      if (!yes) return;
    }
    const res = await api('POST', `/api/loop/${suspend ? 'suspend' : 'unsuspend'}`, { loopId: active.id });
    if (res.ok) { notify(suspend ? 'Loop suspended' : 'Loop resumed'); loopUi.open = null; refresh(); }
    else notify(res.data.error || 'Could not change the loop', 'error');
  }
}

/** Every loop the account can see, when there is more than one. */
function loopTabs(context) {
  if (context.loops.length < 2) return null;
  return h('nav', { class: 'subnav loop-tabs', 'aria-label': 'Your loops' },
    ...context.loops.map((loop) => {
      const membership = (loop.members || []).find((member) => String(member.accountId) === String(me?.id));
      const invitation = loop.canManage !== true && String(membership?.status || '').toLowerCase() === 'invited';
      const current = String(loop.id) === String(context.active.id);
      return h('button', {
        type: 'button',
        class: current ? 'active' : '',
        'aria-current': current ? 'page' : undefined,
        on: { click: () => { if (!current) { rememberActiveLoop(loop.id); route(); } } },
      }, robotAvatar(loop.avatarColor, 'xs'), h('span', { text: loop.name || 'Unnamed loop' }),
      invitation ? h('span', { class: 'pill pill-warn loop-tab-pill' }, 'Invited') : null);
    }));
}

/** The loop, told from the point of view of its Jibo. */
function loopHero(loop, people, { isOwner, owner, color }) {
  const joined = people.filter((person) => !person.invited).length;
  const facts = [
    `${joined} ${joined === 1 ? 'person' : 'people'}`,
    isOwner ? 'You own this loop' : `Owned by ${owner?.name || 'someone else'}`,
  ].join(' · ');
  return h('section', { class: `card loop-hero robot-color-${color}` },
    h('div', { class: 'loop-hero-main' },
      robotAvatar(color, 'lg'),
      h('div', { class: 'loop-hero-text' },
        h('h2', { text: loop.name || 'Unnamed loop' }),
        h('div', { class: 'loop-hero-meta' },
          loop.robotFriendlyId
            ? h('span', { class: 'robot-id loop-hero-id', text: loop.robotFriendlyId })
            : h('span', { class: 'loop-hero-id' }, 'No Jibo paired'),
          h('span', { class: 'loop-hero-facts', text: facts }),
          loop.isSuspended ? h('span', { class: 'pill pill-warn' }, 'Suspended') : null))),
    isOwner && loop.robot ? h('a', { class: 'btn btn-sm loop-hero-action', href: `#/robot/${encodeURIComponent(loop.id)}` },
      icon('sliders', 14), 'Jibo’s settings') : null);
}

/** An invitation waiting for this account's answer. */
function invitationCard(loop, people, owner, color) {
  const joined = people.filter((person) => !person.invited);
  const inviter = owner?.name || 'The loop owner';
  const accept = h('button', { type: 'button', class: 'btn btn-primary' }, icon('check', 15), 'Accept invitation');
  const decline = h('button', { type: 'button', class: 'btn btn-quiet' }, 'Decline');
  accept.addEventListener('click', async () => {
    accept.disabled = true;
    const res = await api('POST', '/api/loop/accept', { loopId: loop.id });
    if (res.ok) { clearPendingInvitation(); notify(`Welcome to ${loop.name}`); renderLoop(); }
    else { accept.disabled = false; notify(res.data.error || 'Could not accept the invitation', 'error'); }
  });
  decline.addEventListener('click', async () => {
    const yes = await confirmDialog({
      title: `Decline ${loop.name}?`,
      body: 'You will no longer see this loop. The owner can send another invitation later.',
      confirmLabel: 'Decline invitation',
    });
    if (!yes) return;
    decline.disabled = true;
    const res = await api('POST', '/api/loop/decline', { loopId: loop.id });
    if (!res.ok) { decline.disabled = false; notify(res.data.error || 'Could not decline the invitation', 'error'); return; }
    clearPendingInvitation();
    rememberActiveLoop('');
    location.hash = '#/';
  });
  const others = joined.filter((person) => !person.isOwner);
  const who = others.length
    ? `${inviter} and ${others.length} ${others.length === 1 ? 'other person are' : 'others are'} already in it.`
    : `${inviter} is in it so far.`;
  return h('section', { class: `card loop-invite robot-color-${color}` },
    robotAvatar(color, 'lg'),
    h('p', { class: 'loop-invite-eyebrow' }, 'Invitation'),
    h('h2', {}, `Join ${loop.name}?`),
    h('p', { class: 'loop-invite-text' },
      `${inviter} invited you to this Jibo’s loop. Join to see his gallery and inbox, and so Jibo can get to know you.`),
    joined.length ? h('div', { class: 'avatar-stack', 'aria-hidden': 'true' },
      ...joined.slice(0, 5).map((person) => personAvatar(person.name, { key: person.id, size: 'sm' }))) : null,
    h('p', { class: 'field-hint' }, who),
    h('div', { class: 'row loop-invite-actions' }, accept, decline));
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
  if (status === 'ok' && subscription.verification?.lastError) {
    return { label: 'Using saved events', className: 'status-unknown' };
  }
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
    'Paste a read-only iCal URL. Phoenix checks it now and refreshes it daily while enabled, even when this page is closed. Removing it stops the refresh.');
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
      const enabled = h('input', {
        type: 'checkbox', checked: subscription.enabled !== false,
        'aria-label': `Use and refresh ${subscription.label}`,
        title: 'Turn off to pause daily refresh and exclude this calendar from the report',
      });
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
          if (result.ok) {
            const verification = result.data.subscription.verification;
            notify(verification.lastError ? 'Refresh failed; saved events remain available'
              : verification.status === 'ok' ? 'Calendar verified' : 'Calendar still needs attention',
            verification.lastError ? 'error' : verification.status === 'ok' ? 'ok' : 'error');
            await reloadSubscriptions();
          }
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
      const error = subscription.verification?.lastError
        ? h('p', { class: 'ical-subscription-error', text: subscription.verification.status === 'ok'
          ? `Last refresh failed; showing saved events. ${subscription.verification.lastError}`
          : subscription.verification.lastError }) : null;
      return h('article', { class: 'ical-subscription' },
        h('div', { class: 'ical-subscription-main' },
          h('div', { class: 'ical-subscription-title' },
            h('span', { class: 'ical-enabled' }, enabled),
            h('strong', { text: subscription.label }),
            h('span', { class: `status-badge ${state.className}`, text: state.label })),
          h('div', { class: 'ical-subscription-url', text: maskedCalendarUrl(subscription.url) }),
          h('div', { class: 'ical-subscription-meta' },
            `${subscription.verification?.eventCount || 0} events`,
            subscription.verification?.lastSuccess ? ` · updated ${fmtDate(subscription.verification.lastSuccess)}` : '',
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

  const proactive = h('fieldset', {},
    h('legend', {}, 'Offer'),
    toggle('offerProactively', s.offerProactively !== false, 'Let Jibo offer my report',
      'When he recognizes you, Jibo may ask if you want to hear it. You can always ask for it yourself.'));

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
  form.append(proactive, weather, news, commute, calendar,
    h('div', { class: 'save-bar' },
      h('p', {}, 'Changes apply the next time you ask for your report.'),
      saveBtn));

  onSubmit(form, async (e) => {
    e.preventDefault();
    saveBtn.disabled = true;
    const fd = Object.fromEntries(new FormData(form));
    const newsCats = {};
    for (const k of Object.keys(s.news.categories)) newsCats[k] = !!fd[`news_${k}`];
    const payload = {
      offerProactively: !!fd.offerProactively,
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

/**
 * The account photo: pick an image and it is resized on this device and saved
 * straight away. It updates in place rather than re-rendering the page, so
 * unsaved edits in the profile form below are not thrown away.
 */
function profilePhotoEditor(account) {
  let current = safePhotoPath(account.photoUrl);
  const preview = h('span', { class: 'profile-photo-preview' });
  const paintPreview = (src) => preview.replaceChildren(src
    ? h('img', { src, alt: '' })
    : h('span', { text: initials(account) }));
  paintPreview(current);

  const input = h('input', { type: 'file', accept: 'image/*', class: 'sr-only', tabindex: '-1', 'aria-hidden': 'true' });
  const choose = h('button', { type: 'button', class: 'btn btn-sm', on: { click: () => input.click() } });
  const remove = h('button', { type: 'button', class: 'btn btn-quiet btn-sm', on: { click: removePhoto } }, 'Remove');
  const hint = h('span', { class: 'field-hint' }, 'Resized on this device before it is uploaded.');
  const paintActions = () => {
    choose.replaceChildren(icon('image', 14), current ? 'Change photo' : 'Add a photo');
    remove.hidden = !current;
  };
  paintActions();

  const busy = (on) => {
    preview.classList.toggle('is-busy', on);
    choose.disabled = on;
    remove.disabled = on;
  };
  const saved = async (message) => {
    await refreshMe();
    current = safePhotoPath(me?.photoUrl);
    paintPreview(current);
    paintActions();
    notify(message);
  };

  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    if (!file.type.startsWith('image/') || file.size > 10_000_000) {
      notify('Choose an image under 10 MB.', 'error');
      return;
    }
    let objectUrl;
    busy(true);
    try {
      objectUrl = URL.createObjectURL(file);
      paintPreview(objectUrl);
      const image = new Image();
      image.src = objectUrl;
      await image.decode();
      const scale = Math.min(1, 1024 / Math.max(image.naturalWidth, image.naturalHeight));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
      canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
      const jpeg = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', .82));
      if (!jpeg || jpeg.size > 2_000_000) throw new Error('The resized photo is still over 2 MB. Choose a smaller image.');
      const response = await fetch('/api/me/photo', {
        method: 'POST', headers: { 'content-type': 'image/jpeg' }, body: jpeg,
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || 'Could not save photo');
      await saved('Profile photo saved');
    } catch (error) {
      paintPreview(current);
      notify(error.message || 'Could not read that image', 'error');
    } finally {
      busy(false);
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    }
  });

  async function removePhoto() {
    busy(true);
    const result = await api('DELETE', '/api/me/photo');
    busy(false);
    if (!result.ok) { notify(result.data.error || 'Could not remove photo', 'error'); return; }
    await saved('Profile photo removed');
  }

  return h('div', { class: 'profile-photo-editor' },
    preview,
    h('div', { class: 'profile-photo-text' },
      h('strong', { text: [account.firstName, account.lastName].filter(Boolean).join(' ') || 'Your profile' }),
      h('span', { class: 'field-hint', text: account.email }),
      h('div', { class: 'row' }, choose, remove),
      hint),
    input);
}

// Jibo's dialog says "he" for male, "she" for female and the person's name for
// anything else, so those are the choices offered. An account can also hold the
// original app's 'they' or 'other'; those show as Not set and are kept unless the
// person picks something else.
const GENDER_CHOICES = [['', 'Not set'], ['male', 'Male'], ['female', 'Female']];
const genderChoice = (value) => (value === 'male' || value === 'female' ? value : '');

async function renderProfile() {
  const title = 'Account';
  const description = 'Your profile, your messages, and how you sign in.';
  show(page(title, description, loading(5)));

  const meRes = await api('GET', '/api/me');
  const container = page(title, description);
  if (!meRes.ok) { container.append(errorBox('Not signed in.')); return show(container); }
  const a = meRes.data.account;

  container.append(h('section', { class: 'card account-hero' }, h('div', { class: 'card-body' }, profilePhotoEditor(a))));
  container.append(emailVerificationUi.accountCard(a));

  /* -- about you ---------------------------------------------------------- */

  const initialGender = genderChoice(a.gender);
  const aboutForm = h('form', { class: 'about-form' },
    h('div', { class: 'grid2' },
      field('First name', h('input', { name: 'firstName', value: a.firstName || '', autocomplete: 'given-name' })),
      field('Last name', h('input', { name: 'lastName', value: a.lastName || '', autocomplete: 'family-name' }))),
    h('div', { class: 'grid2' },
      field('Birthday', h('input', { type: 'date', name: 'birthdayDate', value: isoDay(a.birthday) }),
        'So Jibo can wish you a happy birthday.'),
      field('Gender', h('select', { name: 'gender' },
        ...GENDER_CHOICES.map(([value, label]) => h('option', { value, selected: initialGender === value }, label))),
        'Jibo uses this when he talks about you.')),
    h('div', { class: 'row' }, h('button', { type: 'submit', class: 'btn btn-primary' }, 'Save')));
  onSubmit(aboutForm, async (e) => {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(aboutForm));
    const body = {
      // Sent as typed, so a cleared name is actually cleared.
      firstName: fd.firstName ?? '',
      lastName: fd.lastName ?? '',
      // The control is a date picker; the API stores epoch milliseconds.
      birthday: fd.birthdayDate ? Date.parse(`${fd.birthdayDate}T00:00:00Z`) : null,
    };
    // Only a changed choice is sent, so a value this page does not offer is kept.
    if ((fd.gender || '') !== initialGender) body.gender = fd.gender || null;
    const res = await api('PUT', '/api/me', body);
    if (res.ok) { notify('Saved'); await refreshMe(); await renderProfile(); }
    else notify(res.data.error || 'Could not save', 'error');
  });
  container.append(card('About you', {}, aboutForm));

  /* -- messages ------------------------------------------------------------ */

  const alerts = h('select', { name: 'jotNotificationMode' },
    h('option', { value: 'tagged', selected: a.jotNotificationMode === 'tagged' || !a.jotNotificationMode }, 'Only messages for me'),
    h('option', { value: 'always', selected: a.jotNotificationMode === 'always' }, 'Every message in my loops'),
    h('option', { value: 'none', selected: a.jotNotificationMode === 'none' }, 'None'));
  let alertsValue = alerts.value;
  alerts.addEventListener('change', async () => {
    alerts.disabled = true;
    const res = await api('PUT', '/api/me', { jotNotificationMode: alerts.value });
    alerts.disabled = false;
    if (res.ok) { alertsValue = alerts.value; notify('Saved'); }
    else { alerts.value = alertsValue; notify(res.data.error || 'Could not save', 'error'); }
  });
  container.append(card('Messages', {},
    h('div', { class: 'setting-list' },
      h('div', { class: 'setting-row' }, liveSwitch({
        checked: a.messagingAllowed ?? true,
        label: 'Receive Jibo messages',
        hint: 'People in your loops can leave you messages, and Jibo delivers them.',
        save: (on) => api('PUT', '/api/me', { messagingAllowed: on }),
        saved: (on) => (on ? 'Messages turned on' : 'Messages turned off'),
      }))),
    field('Browser alerts', alerts, 'Which new messages this browser alerts you about, once notifications are on below.')));

  /* -- sign-in -------------------------------------------------------------- */

  let openLine = null;
  const signIn = h('div', { class: 'setting-lines' });
  const accountLine = (key, { label, value, hint, action, editor }) => {
    const editing = openLine === key;
    const button = h('button', { type: 'button', class: 'btn btn-sm', 'aria-expanded': String(editing) }, editing ? 'Cancel' : action);
    button.addEventListener('click', () => {
      openLine = editing ? null : key;
      paintSignIn();
      if (!editing) signIn.querySelector('.setting-line-editor input')?.focus();
    });
    return h('div', { class: `setting-line${editing ? ' is-editing' : ''}` },
      h('div', { class: 'setting-line-text' },
        h('span', { class: 'setting-line-label', text: label }),
        h('span', { class: 'setting-line-value', text: value }),
        hint ? h('span', { class: 'setting-line-hint', text: hint }) : null),
      button,
      editing ? h('div', {
        class: 'setting-line-editor',
        on: { keydown: (event) => { if (event.key === 'Escape') { openLine = null; paintSignIn(); } } },
      }, editor()) : null);
  };
  const emailEditor = () => {
    const form = h('form', { class: 'line-form' },
      h('div', { class: 'grid2' },
        field('New email address', h('input', { name: 'email', type: 'email', required: true, autocomplete: 'email' })),
        field('Current password', h('input', { name: 'currentPassword', type: 'password', required: true, autocomplete: 'current-password' }))),
      h('div', { class: 'row' }, h('button', { type: 'submit', class: 'btn btn-sm btn-primary' }, 'Send confirmation link')));
    onSubmit(form, async (e) => {
      e.preventDefault();
      const res = await api('POST', '/api/me/email', Object.fromEntries(new FormData(form)));
      if (!res.ok) { notify(res.data.error || 'Could not change email', 'error'); return; }
      notify('Check the new address for a confirmation link.');
      openLine = null;
      paintSignIn();
    });
    return form;
  };
  const passwordEditor = () => {
    const form = h('form', { class: 'line-form' },
      h('div', { class: 'grid2' },
        field('Current password', h('input', { name: 'currentPassword', type: 'password', required: true, autocomplete: 'current-password' })),
        field('New password', h('input', { name: 'newPassword', type: 'password', minlength: 8, required: true, autocomplete: 'new-password' }),
          'At least 8 characters.')),
      h('div', { class: 'row' }, h('button', { type: 'submit', class: 'btn btn-sm btn-primary' }, 'Change password')));
    onSubmit(form, async (e) => {
      e.preventDefault();
      const res = await api('POST', '/api/me/password', Object.fromEntries(new FormData(form)));
      if (!res.ok) { notify(res.data.error || 'Could not change password', 'error'); return; }
      // The server invalidates every session, including this one. Clear local
      // private content and explain the next step instead of leaving a dead form.
      clearPrivateView();
      await loopKeys.forgetAll();
      keyRevocationChannel?.postMessage({ type: 'logout', accountId: me?.id });
      badgesPainted = false;
      authNotice = 'Password changed. Sign in with your new password.';
      await route();
    });
    return form;
  };
  function paintSignIn() {
    signIn.replaceChildren(
      accountLine('email', {
        label: 'Email', value: a.email || '', action: 'Change…', editor: emailEditor,
        hint: openLine === 'email' ? 'Your address stays the same until you confirm the link sent to the new one.' : '',
      }),
      accountLine('password', { label: 'Password', value: '••••••••', action: 'Change…', editor: passwordEditor }));
  }
  paintSignIn();
  container.append(card('Sign-in', {}, signIn));

  // The installable app stays optional: everything also works in a mobile
  // browser. This card is the one place to install it or allow alerts.
  const appLines = h('div', { class: 'setting-lines' }, loading(2));
  container.append(card('App and notifications', {}, appLines));

  /* -- delete account ------------------------------------------------------- */

  const deleteCard = card('Delete account', {},
    h('div', { class: 'danger-line' },
      h('p', { text: 'Permanently delete your account and everything that’s only yours. You’ll be signed out everywhere.' }),
      h('button', { type: 'button', class: 'btn btn-sm btn-danger', on: { click: deleteAccountDialog } }, 'Delete account…')));
  deleteCard.classList.add('danger-card');
  container.append(deleteCard);
  show(container);

  const state = await browserPushState(api);
  const capabilities = state.capabilities;
  const line = ({ label, value, hint, actions = [] }) => h('div', { class: 'setting-line' },
    h('div', { class: 'setting-line-text' },
      h('span', { class: 'setting-line-label', text: label }), value,
      hint ? h('span', { class: 'setting-line-hint', text: hint }) : null),
    actions.length ? h('div', { class: 'row setting-line-actions' }, ...actions) : null);
  const button = (label, onClick, cls = 'btn btn-sm') => h('button', { type: 'button', class: cls, on: { click: onClick } }, label);

  const app = line({
    label: 'App',
    value: h('span', { class: capabilities.installed ? 'pill pill-ok' : 'pill' }, capabilities.installed ? 'Installed' : 'In the browser'),
    hint: capabilities.installed ? 'Installed on this device.'
      : capabilities.canPromptInstall ? 'Add the console to this device to open it like an app.'
        : capabilities.ios ? 'In Safari, use Share → Add to Home Screen to install it.'
          : 'Use your browser’s Install app option to add the console to this device.',
    actions: capabilities.canPromptInstall ? [button('Install app', async () => {
      const result = await promptInstall();
      notify(result.accepted ? 'The app is being installed.' : 'Install was not completed.', result.accepted ? 'ok' : 'error');
      await renderProfile();
    })] : [],
  });

  let alertsLine;
  if (!capabilities.push) {
    alertsLine = line({ label: 'Notifications', value: h('span', { class: 'pill' }, 'Unavailable'),
      hint: capabilities.secure ? 'This browser can’t show notifications from websites.' : 'Open the console over HTTPS to use notifications.' });
  } else if (!state.server.ok || !state.server.data.available) {
    alertsLine = line({ label: 'Notifications', value: h('span', { class: 'pill pill-warn' }, 'Not offered'),
      hint: state.server.ok ? 'This server hasn’t turned on browser notifications. Its operator can.'
        : (state.server.data?.error || 'Could not check whether this server offers notifications.') });
  } else if (state.permission === 'denied') {
    alertsLine = line({ label: 'Notifications', value: h('span', { class: 'pill pill-warn' }, 'Blocked'),
      hint: 'Allow notifications for this site in your browser’s settings, then come back here.' });
  } else if (state.subscription) {
    alertsLine = line({ label: 'Notifications', value: h('span', { class: 'pill pill-ok' }, h('span', { class: 'dot dot-live' }), 'On in this browser'),
      hint: 'New messages can alert this device. Alerts never include the message itself.',
      actions: [
        button('Send a test', async () => {
          const result = await api('POST', '/api/web-push/test');
          notify(result.ok ? 'Test notification sent.' : (result.data.error || 'Could not send a test notification.'), result.ok ? 'ok' : 'error');
        }),
        button('Turn off', async () => {
          try { await disableBrowserPush(api); notify('Notifications turned off in this browser.'); await renderProfile(); }
          catch (error) { notify(error.message || 'Could not turn notifications off.', 'error'); }
        }, 'btn btn-sm btn-danger'),
      ] });
  } else {
    const blockedUntilInstalled = capabilities.ios && !capabilities.installed;
    const enable = button('Turn on', async () => {
      try { await enableBrowserPush(api); notify('Notifications turned on in this browser.'); await renderProfile(); }
      catch (error) { notify(error.message || 'Could not turn notifications on.', 'error'); }
    }, 'btn btn-sm btn-primary');
    enable.disabled = blockedUntilInstalled;
    alertsLine = line({ label: 'Notifications', value: h('span', { class: 'pill' }, 'Off'),
      hint: blockedUntilInstalled ? 'Install the app from Safari’s Share menu first, then turn notifications on here.'
        : 'Turn on only on a device you trust.',
      actions: [enable] });
  }
  appLines.replaceChildren(app, alertsLine);
}

/**
 * Account deletion. The server first says what would go, in plain terms; nothing
 * is deleted until the password is entered here. Afterwards the console returns
 * to its signed-out start, saying the account is gone.
 */
function deleteAccountDialog() {
  let busy = false;
  const content = h('div', { class: 'removal-body' }, loading(3));
  const password = h('input', { type: 'password', name: 'password', autocomplete: 'current-password', required: true });
  const passwordField = field('Your password', password);
  passwordField.hidden = true;
  const problem = h('div', { class: 'notice notice-error', role: 'alert', hidden: true });
  const cancel = h('button', { class: 'btn', type: 'button' }, 'Cancel');
  const confirm = h('button', { class: 'btn btn-danger', type: 'submit', disabled: true }, 'Delete my account');
  const form = h('form', { class: 'delete-form' },
    h('h3', { text: 'Delete your account?' }),
    content, passwordField, problem,
    h('div', { class: 'row row-end delete-actions' }, cancel, confirm));
  const dialog = h('dialog', { class: 'modal removal-modal' }, form);
  const close = () => { dialog.close(); dialog.remove(); };
  cancel.addEventListener('click', close);
  dialog.addEventListener('cancel', (event) => { event.preventDefault(); if (!busy) close(); });
  password.addEventListener('input', () => { confirm.disabled = !password.value; problem.hidden = true; });
  document.body.append(dialog);
  dialog.showModal();

  const named = (loop) => loop.name || (loop.robot ? `${loop.robot}’s loop` : 'an unnamed loop');
  const list = (names) => (names.length < 3 ? names.join(' and ')
    : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`);

  void (async () => {
    const res = await apiRaw('GET', '/api/me/deletion');
    if (!res.ok) {
      content.replaceChildren(errorBox('Couldn’t check what deleting your account involves.', res.data.error));
      return;
    }
    const plan = res.data;
    if (plan.onlyAdministrator) {
      content.replaceChildren(h('div', { class: 'notice notice-warn' }, icon('alert', 16),
        h('div', {}, 'You’re the only administrator of this server. Make someone else an administrator before you delete your account.')));
      cancel.textContent = 'Close';
      confirm.hidden = true;
      return;
    }
    const goes = [];
    for (const loop of plan.loops) {
      const others = loop.people === 1 ? 'The other person in it loses it too.' : `The ${loop.people} other people in it lose it too.`;
      goes.push(h('li', {},
        h('strong', { text: named(loop) }),
        loop.robot
          ? ', the loop you own, and its Jibo. Jibo forgets everyone in it and has to be set up again from scratch.'
          : ', the loop you own, and everything in it.',
        loop.people ? ` ${others}` : ''));
    }
    const joined = plan.memberships.filter((loop) => !loop.invited);
    const invitations = plan.memberships.filter((loop) => loop.invited);
    if (joined.length) {
      goes.push(h('li', {}, 'Your place in ', h('strong', { text: list(joined.map(named)) }),
        '. The messages you sent there go; everyone else’s messages and photos stay.'));
    }
    if (invitations.length) {
      goes.push(h('li', {}, `Your ${invitations.length === 1 ? 'invitation' : 'invitations'} to `,
        h('strong', { text: list(invitations.map(named)) }), '.'));
    }
    goes.push(h('li', {}, 'Your profile, your photo, your settings and anything you uploaded.'));
    const shared = plan.loops.filter((loop) => loop.canHandOn);
    content.replaceChildren(
      h('p', { text: 'This can’t be undone. Deleting your account removes:' }),
      h('ul', { class: 'delete-list' }, ...goes),
      shared.length ? h('div', { class: 'notice' }, icon('users', 16),
        h('div', {}, `To keep ${list(shared.map(named))} for the others, make one of them the owner first, in `,
          h('a', { href: '#/loop', on: { click: close } }, 'Loops'), '.')) : null,
      plan.backupDays > 0
        ? h('p', { class: 'field-hint', text: `Backup copies that include your account are deleted within ${plan.backupDays} days.` })
        : null);
    passwordField.hidden = false;
    password.focus();
  })();

  onSubmit(form, async (event) => {
    event.preventDefault();
    if (!password.value || busy) return;
    busy = true;
    for (const control of [password, cancel, confirm]) control.disabled = true;
    confirm.textContent = 'Deleting…';
    const res = await apiRaw('POST', '/api/me/delete', { password: password.value });
    if (res.ok) {
      close();
      clearPrivateView();
      await loopKeys.forgetAll();
      await loopKeys.setAccount(null);
      keyRevocationChannel?.postMessage({ type: 'logout', accountId: me?.id });
      void dropBrowserPush().catch(() => {});
      me = null;
      badgesPainted = false;
      authNotice = 'Your account has been deleted.';
      if (location.hash && location.hash !== '#/') location.hash = '#/';
      else route();
      return;
    }
    busy = false;
    password.disabled = false;
    cancel.disabled = false;
    confirm.disabled = false;
    confirm.textContent = 'Delete my account';
    problem.replaceChildren(icon('alert', 16), h('div', { text: res.data.error || 'Your account couldn’t be deleted.' }));
    problem.hidden = false;
    if (res.status === 401) password.select();
  });
}

/* ==========================================================================
   Robots
   ========================================================================== */

const ROBOT_COLORS = [
  ['blue', 'Blue'], ['teal', 'Teal'], ['violet', 'Violet'],
  ['coral', 'Coral'], ['gold', 'Gold'], ['slate', 'Slate'],
];
const robotColorOf = (value) => (ROBOT_COLORS.some(([key]) => key === value) ? value : 'blue');
const robotName = (robot) => meaningfulText(robot?.loopName) || robot?.friendlyId || 'Jibo';

/** Jibo's one round eye on a disc of the robot's console color. */
const robotAvatar = (color, size = 'md') => h('span', {
  class: `robot-avatar robot-avatar-${size} robot-color-${robotColorOf(color)}`,
  'aria-hidden': 'true',
}, h('span', { class: 'robot-avatar-eye' }));

/** The read-only facts a robot reports about itself, skipping anything it left unset. */
function robotFacts(d) {
  const payload = d.getRobot?.payload && typeof d.getRobot.payload === 'object' && !Array.isArray(d.getRobot.payload)
    ? d.getRobot.payload : {};
  const locationSource = payload.locationOverride || payload;
  const location = [locationSource.city, locationSource.state, locationSource.country]
    .map(meaningfulText).filter(Boolean).join(', ');
  const remoteEnabled = typeof payload.remoteEnabled === 'boolean' ? payload.remoteEnabled : null;
  const facts = [
    row('Loop status', d.loop?.isSuspended
      ? h('span', { class: 'pill pill-error' }, 'Suspended')
      : h('span', { class: 'pill pill-ok' }, h('span', { class: 'dot' }), 'Active')),
    meaningfulText(payload.SSID) ? row('Wi-Fi network', meaningfulText(payload.SSID)) : null,
    location ? row('Location', location) : null,
    meaningfulText(payload.timezone) ? row('Time zone', meaningfulText(payload.timezone).replace(/_/g, ' ')) : null,
    meaningfulText(payload.platform) ? row('Platform', meaningfulText(payload.platform)) : null,
    meaningfulText(payload.serialNumber) ? row('Serial number', h('span', { class: 'mono' }, meaningfulText(payload.serialNumber))) : null,
    remoteEnabled === null ? null : row('Companion apps', remoteEnabled ? 'Allowed' : 'Off'),
    d.diagnostics
      ? h('div', { class: 'notice notice-warn' }, icon('alert', 16),
        h('div', {}, 'Additional robot status is unavailable right now. Basic loop information is still shown.'))
      : null,
  ];
  // replaceChildren() would render a null as the text "null".
  return facts.filter(Boolean);
}

/**
 * A switch that saves the moment it is flipped, and flips back if the save
 * fails. For single on/off preferences a separate Save button is only one more
 * thing to forget.
 */
function liveSwitch({ checked, label, hint, save, saved = 'Saved' }) {
  const input = h('input', { type: 'checkbox', checked: !!checked });
  const el = h('label', { class: 'switch' },
    input,
    h('span', { class: 'track' }),
    h('span', { class: 'switch-text' },
      h('span', {}, label),
      hint ? h('span', { class: 'switch-hint' }, hint) : null));
  input.addEventListener('change', async () => {
    const next = input.checked;
    input.disabled = true;
    el.classList.add('is-saving');
    const result = await save(next);
    input.disabled = false;
    el.classList.remove('is-saving');
    if (!result.ok) {
      input.checked = !next;
      notify(result.data?.error || 'Could not save that change', 'error');
      return;
    }
    notify(typeof saved === 'function' ? saved(next) : saved);
  });
  return el;
}

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

  container.append(h('div', { class: 'robot-list' }, ...list.map(robotCard)));
  show(container);
}

function robotCard(robot) {
  const detail = h('div', { class: 'robot-detail', hidden: true });
  let loaded = false;
  const more = h('button', { class: 'btn btn-quiet btn-sm', type: 'button', 'aria-expanded': 'false' },
    icon('chevron', 14, 'robot-more-caret'), 'More details');
  more.addEventListener('click', async () => {
    const open = detail.hidden;
    detail.hidden = !open;
    more.setAttribute('aria-expanded', String(open));
    more.lastChild.textContent = open ? 'Fewer details' : 'More details';
    if (!open || loaded) return;
    loaded = true;
    detail.replaceChildren(loading(2));
    const r = await api('GET', `/api/robot?loopId=${encodeURIComponent(robot.loopId || '')}`);
    if (!r.ok) {
      loaded = false; // let the next click try again
      detail.replaceChildren(errorBox('Could not load robot detail.', r.data.error));
      return;
    }
    detail.replaceChildren(...robotFacts(r.data));
  });

  const settings = robot.canManage && robot.loopId
    ? h('a', { class: 'btn btn-sm', href: `#/robot/${encodeURIComponent(robot.loopId)}` }, icon('sliders', 14), 'Settings')
    : h('span', { class: 'field-hint' }, 'Only the owner can change settings');

  return h('section', { class: 'card robot-card' },
    h('div', { class: 'robot-card-head' },
      robotAvatar(robot.avatarColor),
      h('div', { class: 'robot-card-title' },
        h('h3', { text: robotName(robot) }),
        h('span', { class: 'robot-id', text: robot.friendlyId })),
      h('div', { class: 'robot-card-status' }, connectionStatus(robot.connection))),
    h('div', { class: 'card-body' },
      row('Access', robot.canManage ? 'Owner' : 'Shared with you'),
      row('Last seen', robotLastSeen(robot.lastSeen)),
      row('Added', fmtDate(robot.created)),
      detail),
    h('div', { class: 'card-foot robot-card-foot' }, more, settings));
}

/* -- One robot's settings (#/robot/<loopId>[/<section>]) -------------------- */

const ROBOT_SETTINGS_TABS = [
  ['general', 'General', 'robot'],
  ['location', 'Location', 'pin'],
  ['holidays', 'Holidays', 'calendar'],
  ['wifi', 'Wi-Fi', 'wifi'],
  ['backup', 'Backup', 'lock'],
];

async function renderRobotSettings(loopId, initialTab = 'general') {
  const backLink = () => h('a', { class: 'link back-link', href: '#/robot' }, icon('back', 14), 'All robots');
  const loadingPage = page('Robot settings', 'Loading this Jibo…', loading(5));
  loadingPage.querySelector('.page-head').prepend(backLink());
  show(loadingPage);

  const [robots, detail] = await Promise.all([
    api('GET', '/api/robots'),
    api('GET', `/api/robot?loopId=${encodeURIComponent(loopId)}`),
  ]);
  const robot = robots.ok && Array.isArray(robots.data)
    ? robots.data.find((item) => String(item.loopId) === String(loopId)) : null;
  const fail = (title, message, detailText) => {
    const container = page(title, '');
    container.querySelector('.page-head').prepend(backLink());
    container.append(errorBox(message, detailText));
    show(container);
  };
  if (!robots.ok) return fail('Robot settings', 'Could not load your robots.', robots.data.error);
  if (!robot) return fail('Robot settings', 'This Jibo is not paired with your account.');
  if (!robot.canManage) return fail(robotName(robot), 'Only the loop owner can change this Jibo’s settings.');
  if (!detail.ok) return fail(robotName(robot), 'Could not load this Jibo’s settings.', detail.data.error);

  const d = detail.data;
  const payload = d.getRobot?.payload && typeof d.getRobot.payload === 'object' && !Array.isArray(d.getRobot.payload)
    ? d.getRobot.payload : {};
  const state = {
    loopId,
    name: meaningfulText(d.loop?.name) || robotName(robot),
    color: robotColorOf(d.loop?.avatarColor || robot.avatarColor),
    friendlyId: robot.friendlyId,
    payload,
  };

  const container = page(state.name, '');
  const heroAvatar = robotAvatar(state.color, 'lg');
  const heroTitle = h('h2', { text: state.name });
  container.querySelector('.page-head').replaceWith(h('div', { class: 'page-head robot-hero' },
    backLink(),
    h('div', { class: 'robot-hero-main' },
      heroAvatar,
      h('div', { class: 'robot-hero-text' },
        heroTitle,
        h('div', { class: 'robot-hero-meta' },
          h('span', { class: 'robot-id', text: state.friendlyId }),
          connectionStatus(d.connection))))));
  if (d.loop?.isSuspended) {
    container.append(h('div', { class: 'notice notice-error' }, icon('alert', 16),
      h('div', {}, 'This loop is suspended. Changes can still be saved, but Jibo will not use them until it is active again.')));
  }

  // The hero follows the General tab's unsaved choices, so a color can be
  // judged on the actual avatar before it is saved.
  const identity = {
    preview(color) {
      for (const cls of [...heroAvatar.classList]) if (cls.startsWith('robot-color-')) heroAvatar.classList.remove(cls);
      heroAvatar.classList.add(`robot-color-${robotColorOf(color)}`);
    },
    rename(name) {
      state.name = name;
      heroTitle.textContent = name;
      pageTitle.textContent = name;
      document.title = `${name} — Phoenix`;
    },
  };

  const builders = {
    general: () => robotGeneralPanel(state, identity, d),
    location: () => robotLocationPanel(state),
    holidays: () => robotHolidaysPanel(state),
    wifi: () => robotWifiPanel(state),
    backup: () => robotBackupPanel(state),
  };
  const tabs = h('div', { class: 'subnav robot-tabs', role: 'tablist', 'aria-label': 'Settings sections' });
  const panels = h('div', { class: 'robot-panels' });
  const built = new Map();
  const tabButtons = new Map();

  function select(key, { focus = false } = {}) {
    if (!builders[key]) key = 'general';
    for (const [name, button] of tabButtons) {
      const active = name === key;
      button.classList.toggle('active', active);
      button.setAttribute('aria-selected', String(active));
      button.tabIndex = active ? 0 : -1;
      if (active && focus) button.focus();
    }
    // Each section is built the first time it is shown. The map in Location
    // measures its container when it is created, so it must not be built hidden.
    if (!built.has(key)) {
      const panel = h('div', { class: 'robot-panel', role: 'tabpanel', id: `robot-panel-${key}`, 'aria-labelledby': `robot-tab-${key}` },
        builders[key]());
      built.set(key, panel);
      panels.append(panel);
    }
    for (const [name, panel] of built) panel.hidden = name !== key;
    history.replaceState(null, '', `#/robot/${encodeURIComponent(loopId)}${key === 'general' ? '' : `/${key}`}`);
  }

  for (const [key, label, iconName] of ROBOT_SETTINGS_TABS) {
    const button = h('button', {
      type: 'button', role: 'tab', id: `robot-tab-${key}`, 'aria-controls': `robot-panel-${key}`,
      on: { click: () => select(key) },
    }, icon(iconName, 15), h('span', {}, label));
    tabButtons.set(key, button);
    tabs.append(button);
  }
  tabs.addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const keys = ROBOT_SETTINGS_TABS.map(([key]) => key);
    const current = keys.indexOf([...tabButtons].find(([, b]) => b.classList.contains('active'))?.[0]);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? keys.length - 1
      : (current + (event.key === 'ArrowRight' ? 1 : -1) + keys.length) % keys.length;
    select(keys[next], { focus: true });
  });

  container.append(tabs, panels);
  show(container);
  select(initialTab);
}

function robotGeneralPanel(state, identity, d) {
  const nameInput = h('input', { name: 'name', value: state.name, maxlength: 80, required: true, autocomplete: 'off' });
  const swatches = h('div', { class: 'swatches' }, ...ROBOT_COLORS.map(([value, label]) =>
    h('label', { class: `swatch robot-color-${value}`, title: label },
      h('input', { type: 'radio', name: 'color', value, checked: value === state.color, 'aria-label': label }),
      h('span', { class: 'swatch-dot', 'aria-hidden': 'true' }))));
  swatches.addEventListener('change', (event) => identity.preview(event.target.value));

  const form = h('form', { class: 'robot-identity-form' },
    field('Name', nameInput, 'This is also the loop’s name, so everyone in the loop sees it.'),
    h('fieldset', { class: 'swatch-field' },
      h('legend', { class: 'field-label' }, 'Color'),
      swatches,
      h('span', { class: 'field-hint' }, 'Only changes how this Jibo appears in the console.')),
    h('div', { class: 'row' }, h('button', { type: 'submit', class: 'btn btn-primary' }, 'Save')));

  onSubmit(form, async () => {
    const name = nameInput.value.trim();
    const color = robotColorOf(new FormData(form).get('color'));
    if (!name) { notify('Give this Jibo a name', 'error'); nameInput.focus(); return; }
    if (name === state.name && color === state.color) { notify('Nothing has changed'); return; }
    const failures = [];
    if (name !== state.name) {
      const renamed = await api('PUT', '/api/loop', { loopId: state.loopId, name });
      if (renamed.ok) identity.rename(name);
      else failures.push(renamed.data.error || 'Could not rename Jibo');
    }
    if (color !== state.color) {
      const recolored = await api('PUT', '/api/robot/color', { loopId: state.loopId, color });
      if (recolored.ok) state.color = color;
      else { failures.push(recolored.data.error || 'Could not save the color'); identity.preview(state.color); }
    }
    notify(failures.length ? failures.join('. ') : 'Saved', failures.length ? 'error' : 'ok');
  });

  const companion = card('Companion apps', { sub: 'Remote control from other apps' },
    liveSwitch({
      checked: state.payload.remoteEnabled === true,
      label: 'Allow companion apps',
      hint: 'Lets apps you have authorized control this Jibo remotely, when his software supports it.',
      save: (enabled) => api('PUT', '/api/robot/properties', { loopId: state.loopId, remoteEnabled: enabled }),
      saved: (enabled) => (enabled ? 'Companion apps allowed' : 'Companion apps turned off'),
    }));

  return h('div', { class: 'stack' },
    card('Name and color', {}, form),
    companion,
    card('About this Jibo', {}, h('div', { class: 'kv-list' }, ...robotFacts(d))));
}

function timeZoneSelect(current) {
  const zones = new Set(['UTC', ...(Intl.supportedValuesOf?.('timeZone') || [])]);
  if (current) zones.add(current);
  const groups = new Map();
  for (const zone of [...zones].sort()) {
    const region = zone.includes('/') ? zone.split('/')[0] : 'Other';
    if (!groups.has(region)) groups.set(region, []);
    groups.get(region).push(zone);
  }
  return h('select', { name: 'timezone', required: true },
    ...[...groups].map(([region, list]) => h('optgroup', { label: region },
      ...list.map((zone) => h('option', { value: zone, selected: zone === current },
        zone.replace(/_/g, ' '))))));
}

function robotLocationPanel(state) {
  const existing = state.payload.locationOverride || {};
  const browserZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const savedZone = meaningfulText(state.payload.timezone) || meaningfulText(existing.timezone);
  const cityInput = h('input', { name: 'city', value: existing.city || '', maxlength: 120, placeholder: 'e.g. Somerville', autocomplete: 'off' });
  // A search result names the place; fill it in unless the person has typed
  // their own label since the last automatic fill.
  let autoCity = cityInput.value;
  const picker = createLocationPicker({
    places: [{ key: 'jibo', label: 'Jibo', point: { lat: existing.latitude ?? null, lng: existing.longitude ?? null } }],
    onChange: (key, point, meta) => {
      if (!meta?.label || cityInput.value !== autoCity) return;
      autoCity = meta.label.split(',')[0].trim().slice(0, 120);
      cityInput.value = autoCity;
    },
  });
  const form = h('form', { class: 'robot-location-form' },
    picker.element,
    h('div', { class: 'grid2' },
      field('Place name', cityInput, 'What Jibo calls this place. Searching an address fills it in.'),
      field('Time zone', timeZoneSelect(savedZone || browserZone),
        savedZone ? 'Jibo uses this for the time and your reminders.' : 'Preselected from this device. Change it if Jibo is somewhere else.')),
    h('div', { class: 'row' }, h('button', { type: 'submit', class: 'btn btn-primary' }, 'Save location')));
  onSubmit(form, async () => {
    const fd = Object.fromEntries(new FormData(form));
    const point = picker.value().jibo;
    if (point.lat == null || point.lng == null) { notify('Search, use your location, or click the map to place Jibo first', 'error'); return; }
    const result = await api('PUT', '/api/robot/properties', { loopId: state.loopId, location: {
      ...point, city: fd.city.trim(), timezone: fd.timezone,
    } });
    if (result.ok) {
      state.payload.locationOverride = { latitude: point.lat, longitude: point.lng, city: fd.city.trim(), timezone: fd.timezone };
      state.payload.timezone = fd.timezone;
    }
    notify(result.ok ? 'Location saved' : (result.data.error || 'Could not save location'), result.ok ? 'ok' : 'error');
  });
  return card('Location and time zone', { sub: 'Used for local weather and the time' }, form);
}

/** "2026-10-04" → "Sun, Oct 4, 2026" in the viewer's locale, read as a calendar day. */
const fmtCalendarDay = (value) => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(value)) return '';
  const date = new Date(`${value.slice(0, 10)}T12:00:00`);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString(undefined, {
    weekday: 'short', month: 'short', day: 'numeric', year: 'numeric',
  });
};

function robotHolidaysPanel(state) {
  const host = h('div', { class: 'stack' }, card(null, {}, loading(5)));
  void loadRobotHolidays(state, host);
  return host;
}

async function loadRobotHolidays(state, host) {
  const [result, loops] = await Promise.all([
    api('GET', `/api/robot/holidays?loopId=${encodeURIComponent(state.loopId)}`),
    api('GET', '/api/loop'),
  ]);
  if (!result.ok) { host.replaceChildren(errorBox('Could not load holidays.', result.data.error)); return; }
  const loop = loops.ok ? (loops.data.loops || []).find((item) => String(item.id) === String(state.loopId)) : null;
  const memberName = (memberId) => {
    const member = (loop?.members || []).find((m) => String(m.id) === String(memberId) || String(m.accountId) === String(memberId));
    return meaningfulText(member?.nickname) || meaningfulText(member?.account?.firstName) || null;
  };

  // ListHolidays answers a record once per upcoming occurrence (this year and
  // next). Show each once, at its next date.
  const today = new Date().toISOString().slice(0, 10);
  const byId = new Map();
  for (const item of Array.isArray(result.data.holidays) ? result.data.holidays : []) {
    if (!item?.id) continue;
    const list = byId.get(item.id) || [];
    list.push(item);
    byId.set(item.id, list);
  }
  const regular = [...byId.values()].map((occurrences) => {
    occurrences.sort((a, b) => String(a.date).localeCompare(String(b.date)));
    return occurrences.find((item) => String(item.date) >= today) || occurrences[0];
  }).sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const custom = (Array.isArray(result.data.custom) ? result.data.custom : [])
    .slice().sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const birthdays = regular.filter((item) => item.category === 'birthday');
  const standard = regular.filter((item) => item.category !== 'birthday');

  const holidaySwitch = (item, label) => liveSwitch({
    checked: item.isEnabled === true,
    label,
    hint: fmtCalendarDay(item.date),
    save: (enabled) => api('PUT', '/api/robot/holiday', { loopId: state.loopId, id: item.id, enabled }),
    saved: (enabled) => `${label} ${enabled ? 'turned on' : 'turned off'}`,
  });
  const reload = () => loadRobotHolidays(state, host);

  const birthdayCard = card('Birthdays', { sub: 'Jibo wishes people in this loop a happy birthday' },
    birthdays.length
      ? h('div', { class: 'setting-list' }, ...birthdays.map((item) => {
        const name = memberName(item.memberId);
        return h('div', { class: 'setting-row' }, holidaySwitch(item, name ? `${name}’s birthday` : 'A loop member’s birthday'));
      }))
      : h('p', { class: 'field-hint' }, 'When people in this loop add a birthday to their account, it appears here. ',
        h('a', { class: 'link', href: '#/profile' }, 'Add your birthday')));

  const addForm = h('form', { class: 'holiday-add' },
    field('Name', h('input', { name: 'name', required: true, maxlength: 80, placeholder: 'e.g. Adoption day', autocomplete: 'off' })),
    field('Date', h('input', { name: 'date', type: 'date', required: true })),
    h('button', { type: 'submit', class: 'btn' }, icon('plus', 14), 'Add'));
  onSubmit(addForm, async () => {
    const fd = Object.fromEntries(new FormData(addForm));
    const added = await api('PUT', '/api/robot/holidays/custom', { loopId: state.loopId, name: fd.name.trim(), date: fd.date });
    if (!added.ok) { notify(added.data.error || 'Could not add that date', 'error'); return; }
    notify(`${fd.name.trim()} added`);
    await reload();
  });
  const customRows = custom.map((item) => h('div', { class: 'setting-row' },
    liveSwitch({
      checked: item.isEnabled !== false,
      label: item.name || 'Untitled',
      hint: fmtCalendarDay(item.date),
      save: (enabled) => api('PUT', '/api/robot/holidays/custom', { loopId: state.loopId, id: item.id, name: item.name, date: item.date, enabled }),
      saved: (enabled) => `${item.name} ${enabled ? 'turned on' : 'turned off'}`,
    }),
    h('button', {
      type: 'button', class: 'icon-btn', 'aria-label': `Remove ${item.name}`, title: 'Remove',
      on: { click: async () => {
        const ok = await confirmDialog({
          title: `Remove “${item.name}”?`,
          body: 'Jibo will stop marking this date.',
          confirmLabel: 'Remove',
        });
        if (!ok) return;
        const deleted = await api('DELETE', '/api/robot/holidays/custom', { loopId: state.loopId, id: item.id });
        notify(deleted.ok ? `${item.name} removed` : (deleted.data.error || 'Could not remove that date'), deleted.ok ? 'ok' : 'error');
        if (deleted.ok) await reload();
      } },
    }, icon('trash', 16))));
  const customCard = card('Your own dates', { sub: 'Anniversaries, adoption days, anything worth marking' },
    customRows.length ? h('div', { class: 'setting-list' }, ...customRows) : null,
    addForm);

  const CATEGORY_LABELS = { national: 'National', public: 'Public', cultural: 'Cultural and religious' };
  const groups = new Map();
  for (const item of standard) {
    const key = CATEGORY_LABELS[item.category] ? item.category : 'other';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  const enabledCount = standard.filter((item) => item.isEnabled === true).length;
  const standardCard = card('Holidays', {
    sub: standard.length ? `${enabledCount} of ${standard.length} on` : 'From this server’s holiday calendar',
  }, standard.length
    ? [...Object.keys(CATEGORY_LABELS), 'other'].filter((key) => groups.has(key)).map((key) => h('div', { class: 'setting-group' },
      h('h4', { class: 'setting-group-title' }, CATEGORY_LABELS[key] || 'Other'),
      h('div', { class: 'setting-list' }, ...groups.get(key).map((item) =>
        h('div', { class: 'setting-row' }, holidaySwitch(item, item.name || 'Holiday'))))))
    : empty('No upcoming holidays', 'This server’s holiday calendar has no upcoming dates yet. Your own dates above still work.', 'calendar'));

  host.replaceChildren(birthdayCard, customCard, standardCard);
}

function robotWifiPanel(state) {
  const host = h('div', { class: 'stack' });
  const form = h('form', {},
    h('ol', { class: 'steps' },
      h('li', {}, h('strong', {}, 'Open Jibo’s Wi-Fi screen. '),
        'Use the menu on Jibo himself and wait until he asks to scan a code. The console cannot open that screen for you.'),
      h('li', {}, h('strong', {}, 'Enter the new network below. '),
        'Keep Jibo powered on and within range of it.'),
      h('li', {}, h('strong', {}, 'Hold the code up to his eye. '),
        `${state.name} keeps his loop, people and history. He does not become a new robot.`)),
    h('div', { class: 'grid2' },
      field('Network name (SSID)', h('input', { name: 'ssid', required: true, maxlength: 32, autocomplete: 'off', spellcheck: 'false' })),
      field('Password', h('input', { name: 'password', type: 'password', maxlength: 63, autocomplete: 'off' }),
        'Leave empty for an open network.')),
    h('div', { class: 'row' }, h('button', { type: 'submit', class: 'btn btn-primary' }, 'Show Wi-Fi code')));
  const formCard = card('Move to a new network', {}, form);
  host.append(formCard);

  onSubmit(form, async () => {
    const fd = Object.fromEntries(new FormData(form));
    const result = await api('POST', '/api/robots/wifi', { loopId: state.loopId, ssid: fd.ssid, password: fd.password });
    if (!result.ok) { notify(result.data.error || 'Could not create a Wi-Fi code', 'error'); return; }
    formCard.hidden = true;

    const codes = result.data.qr.codes;
    let frame = 0;
    const holder = h('div', { class: 'qr-codes', on: { click: () => { frame = (frame + 1) % codes.length; paint(); } } });
    // Two frames side by side, or the only one when the payload fits in one.
    const paint = () => holder.replaceChildren(...codes.slice(0, 2).map((_, i) =>
      h('div', { html: qrSvg(codes[(frame + i) % codes.length], 5) })));
    paint();
    const status = h('p', { class: 'field-hint qr-status' },
      h('span', { class: 'spinner', 'aria-hidden': 'true' }), 'Waiting for Jibo to scan…');
    const startOver = h('button', { type: 'button', class: 'btn btn-quiet btn-sm', on: { click: () => {
      stopPoll();
      qrCard.remove();
      formCard.hidden = false;
    } } }, icon('back', 14), 'Change network');
    const qrCard = card('Wi-Fi code', { sub: fd.ssid, actions: [startOver] },
      h('p', { class: 'instruct instruct-center' }, 'Hold this up to Jibo’s eye while his Wi-Fi screen is open.'),
      holder,
      codes.length > 1 ? h('p', { class: 'field-hint', style: 'text-align:center' }, 'Tap the codes to advance the frames.') : null,
      status);
    host.append(qrCard);

    stopPoll();
    pollTimer = setInterval(async () => {
      const check = await api('GET', `/api/robots/setup/status?token=${encodeURIComponent(result.data.token)}`);
      if (!check.ok) return;
      if (check.data.expired) {
        stopPoll();
        status.replaceChildren('This code expired.');
        status.style.color = 'var(--warn)';
        qrCard.querySelector('.card-body').append(h('div', { class: 'row', style: 'justify-content:center' },
          h('button', { type: 'button', class: 'btn btn-primary', on: { click: () => {
            qrCard.remove();
            formCard.hidden = false;
            form.requestSubmit();
          } } }, 'Make a new code')));
      } else if (check.data.complete) {
        stopPoll();
        holder.hidden = true;
        status.replaceChildren(icon('check', 15), ` ${state.name} is on ${fd.ssid}. His loop is unchanged.`);
        status.style.color = 'var(--ok)';
        notify('Wi-Fi changed');
      }
    }, 2000);
  });
  return host;
}

function robotBackupPanel(state) {
  return loopPrivacyPanel({ id: state.loopId, name: state.name, canManage: true }, { manage: true });
}

function loopPrivacyPanel(loop, { manage = false } = {}) {
  const statusText = h('span', { role: 'status', 'aria-live': 'polite' });
  const retry = h('button', { class: 'btn btn-sm', type: 'button', on: { click: async () => {
    try { await loopKeys.ensure(loop.id, { retry: true }); }
    catch (error) { notify(error.message, 'error'); }
  } } }, 'Connect to Jibo');
  const rememberInput = h('input', { type: 'checkbox', on: { change: async (event) => {
    try { await loopKeys.remember(loop.id, event.target.checked); }
    catch (error) { event.target.checked = loopKeys.isRemembered(loop.id); notify(error.message, 'error'); }
  } } });
  const remember = h('label', { class: 'secure-remember' }, rememberInput, 'Remember on this device until sign-out');
  const forget = h('button', { class: 'btn btn-ghost btn-sm', type: 'button', on: { click: async () => {
    await loopKeys.forget(loop.id);
    keyRevocationChannel?.postMessage({ type: 'forget', accountId: me?.id, loopId: loop.id });
    notify('This device’s loop key was forgotten');
  } } }, 'Forget this device’s key');
  const recovery = h('div', { class: 'secure-recovery' }, loading(1));
  const recoverySummary = h('summary', {}, 'Recovery and device access');
  const details = h('details', { open: manage }, recoverySummary, recovery);
  const panel = card(loop.name || 'Secure photos', { sub: 'Protected content stays encrypted on the server' },
    h('div', { class: 'secure-key-status' }, icon('lock', 16), statusText),
    h('div', { class: 'secure-key-controls' }, retry, remember, forget), details);
  let backup = null;
  let createForm = null;
  let restoreForm = null;
  const paint = () => {
    const state = loopKeys.state(loop.id);
    statusText.textContent = state.status === 'ready' ? 'Photos unlocked on this device'
      : state.status === 'connecting' ? 'Connecting securely to Jibo…'
        : state.error || 'Connect to Jibo to unlock protected photos';
    retry.hidden = state.status === 'ready' || state.status === 'connecting';
    retry.textContent = state.status === 'error' || state.status === 'waiting' ? 'Try again' : 'Connect to Jibo';
    remember.hidden = forget.hidden = state.status !== 'ready';
    rememberInput.checked = loopKeys.isRemembered(loop.id);
    if (createForm) createForm.hidden = state.status !== 'ready';
    if (restoreForm) restoreForm.hidden = state.status === 'ready';
    recoverySummary.textContent = state.status === 'ready' && backup?.canManageRecovery && backup.backupExists === false
      ? 'Create a recovery passphrase' : 'Recovery and device access';
  };
  const unsubscribe = loopKeys.subscribe((id) => { if (id === loop.id || id === null) paint(); });
  privateViewCleanup.add(unsubscribe);
  function passphraseForm(kind) {
    const current = h('input', { type: 'password', name: 'current', required: true, autocomplete: 'off' });
    const next = h('input', { type: 'password', name: 'next', required: true, minlength: 12, autocomplete: 'new-password' });
    const confirm = h('input', { type: 'password', name: 'confirm', required: true, minlength: 12, autocomplete: 'new-password' });
    const errorText = h('p', { class: 'secure-form-error', role: 'alert', hidden: true });
    const form = h('form', { class: 'secure-passphrase-form' },
      kind === 'change' ? field('Current recovery passphrase', current) : null,
      field(kind === 'change' ? 'New recovery passphrase' : 'Recovery passphrase', next,
        'Use at least 12 characters. This is separate from your account password.'),
      field('Confirm recovery passphrase', confirm),
      h('p', { class: 'field-hint' }, 'Save it somewhere safe. Encryption happens in this browser; your passphrase is not sent to Phoenix.'),
      errorText,
      h('button', { type: 'submit', class: 'btn btn-primary' }, kind === 'change' ? 'Change passphrase' : 'Create recovery passphrase'));
    onSubmit(form, async () => {
      errorText.hidden = true;
      try {
        if (next.value !== confirm.value) throw new Error('The passphrases do not match');
        if (kind === 'change' && next.value === current.value) throw new Error('Choose a different passphrase');
        if (kind === 'change') await loopKeys.changeBackup(loop.id, current.value, next.value);
        else await loopKeys.createBackup(loop.id, next.value);
        form.reset(); notify(kind === 'change' ? 'Recovery passphrase changed' : 'Recovery backup created');
        await loadRecovery();
      } catch (error) { errorText.textContent = error.message; errorText.hidden = false; }
    });
    return form;
  }
  async function loadRecovery() {
    try { backup = await loopKeys.backupStatus(loop.id); }
    catch (error) { recovery.replaceChildren(errorBox('Could not check recovery.', error.message)); return; }
    createForm = null;
    restoreForm = null;
    if (!backup.canManageRecovery) {
      recovery.replaceChildren(h('p', { class: 'field-hint' }, 'Your loop owner manages the recovery passphrase. Bring Jibo online to unlock this device.'));
    } else if (!backup.backupExists) {
      createForm = passphraseForm('create');
      recovery.replaceChildren(h('p', { class: 'field-hint' },
        'Recovery not configured. Once Jibo securely shares his existing key, create a recovery passphrase here. Without a backup, losing every device holding the key means losing access to protected content.'), createForm);
      if (manage) details.open = true;
    } else {
      const passphrase = h('input', { type: 'password', required: true, autocomplete: 'off' });
      const restoreError = h('p', { class: 'secure-form-error', role: 'alert', hidden: true });
      const restore = h('form', { class: 'secure-passphrase-form' }, field('Recovery passphrase', passphrase), restoreError,
        h('button', { class: 'btn btn-primary', type: 'submit' }, 'Unlock with recovery passphrase'));
      restoreForm = restore;
      onSubmit(restore, async () => {
        restoreError.hidden = true;
        try { await loopKeys.restore(loop.id, passphrase.value); restore.reset(); notify('Photos unlocked on this device'); }
        catch (error) { restoreError.textContent = error.message; restoreError.hidden = false; }
      });
      const change = h('details', {}, h('summary', {}, 'Change recovery passphrase'), passphraseForm('change'));
      recovery.replaceChildren(h('p', { class: 'field-hint' }, 'Recovery protected. You can unlock this browser with your passphrase even when Jibo is offline.'), restore, change);
    }
    paint();
  }
  paint(); void loadRecovery();
  void loopKeys.ensure(loop.id).catch(() => {});
  return panel;
}

// Blob URLs exist only in this view. Never send plaintext images through an
// HTTP endpoint/cache, and revoke them when navigating, forgetting or signing out.
function secureCapturePreview(record, attrs = {}) {
  const placeholder = h('span', { class: 'secure-media-placeholder', role: 'status' }, icon('lock', 20), h('span', {}, 'Unlocking…'));
  const wrap = h('span', { class: 'secure-media' }, placeholder);
  let objectUrl = null; let busy = false; let disposed = false; let reloadWhenReady = false;
  const release = () => { if (objectUrl) URL.revokeObjectURL(objectUrl); objectUrl = null; };
  const paintLocked = () => {
    release();
    placeholder.lastElementChild.textContent = loopKeys.state(record.loopId).status === 'connecting'
      ? 'Connecting to Jibo…' : 'Photos locked';
    wrap.replaceChildren(placeholder);
  };
  async function load() {
    if (busy || objectUrl || disposed) return;
    busy = true;
    try {
      const blob = await loopKeys.mediaBlob(record);
      if (disposed) return;
      objectUrl = URL.createObjectURL(blob);
      const image = blob.type.startsWith('image/')
        ? h('img', { ...attrs, src: objectUrl, loading: 'lazy', on: { error: () => {
          release(); placeholder.lastElementChild.textContent = 'Image unavailable'; wrap.replaceChildren(placeholder);
        } } })
        : h('span', { class: 'secure-media-placeholder' }, icon('image', 20), 'Open recording');
      wrap.replaceChildren(image);
    } catch (error) {
      if (!disposed) { placeholder.lastElementChild.textContent = record.isEncrypted && !loopKeys.has(record.loopId)
        ? 'Photos locked — connect above' : 'Capture unavailable'; wrap.title = error.message; wrap.replaceChildren(placeholder); }
    } finally { busy = false; if (reloadWhenReady && !disposed && !objectUrl && loopKeys.has(record.loopId)) {
      reloadWhenReady = false; void load();
    } else reloadWhenReady = false; }
  }
  const unsubscribe = loopKeys.subscribe((id) => {
    if (id !== record.loopId && id !== null) return;
    if (record.isEncrypted && !loopKeys.has(record.loopId)) paintLocked();
    else if (busy) reloadWhenReady = true;
    else void load();
  });
  privateViewCleanup.add(() => { disposed = true; release(); unsubscribe(); wrap.replaceChildren(placeholder); });
  void load();
  return wrap;
}

function renderTips() {
  const body = page('Get to know Jibo', 'Things to try once your Jibo is connected, and where to set him up.');
  const phrases = SAY_PHRASES;
  const tip = (href, iconName, title, text) => h('a', { class: 'tip', href },
    h('span', { class: 'tip-ic' }, icon(iconName, 18)),
    h('span', { class: 'tip-title' }, title, icon('arrow', 14, 'arrow')),
    h('span', { class: 'tip-text' }, text));
  body.append(
    h('section', { class: 'card say-card' },
      h('div', { class: 'card-body' },
        h('h3', {}, 'Say “Hey Jibo”, then ask'),
        h('p', { class: 'field-hint' }, 'Wait for the blue listening light, then speak. A few to start with:'),
        h('ul', { class: 'say-list' }, ...phrases.map((phrase) => h('li', {}, phrase))),
        h('p', { class: 'field-hint' }, 'If Jibo hears “Hey Jibo” but not the question, check his connection on the ',
          h('a', { class: 'link', href: '#/robot' }, 'Robots page'), '.'))),
    h('h3', { style: 'margin:2rem 0 .9rem;font-size:var(--t-base)' }, 'Set up next'),
    h('div', { class: 'tip-grid' },
      tip('#/settings', 'sliders', 'Personal report', 'Weather, news, your commute and calendar. Each person picks their own.'),
      tip('#/loop', 'users', 'People and loops', 'A loop is Jibo’s household. Add the people who live with him.'),
      tip('#/robot', 'robot', 'Robot settings', 'His name and color, location, holidays, and Wi-Fi.'),
      tip('#/gallery', 'image', 'Gallery', 'Photos Jibo takes show up here.'),
      tip('#/inbox', 'message', 'Messages', 'Leave messages for people in the loop, delivered by Jibo.')));
  show(body);
}

/* ==========================================================================
   Claim an already-paired robot
   ========================================================================== */

// Which shell the one-line command is written for. Windows runs it in WSL, which
// the DFU toolkit that puts Jibo in int-developer mode already needs there.
const CMD_PLATFORM_KEY = 'phoenix.cmdPlatform';
function detectCmdPlatform() {
  try {
    const saved = localStorage.getItem(CMD_PLATFORM_KEY);
    if (saved === 'windows' || saved === 'unix') return saved;
  } catch {}
  const name = navigator.userAgentData?.platform || navigator.platform || navigator.userAgent || '';
  return /win/i.test(name) ? 'windows' : 'unix';
}

function repointCommand(code, platform) {
  const run = `bash <(curl -fsSL https://jibo.io/repoint) --claim-code ${code}`;
  // wsl -e passes the quoted line to bash unchanged from both PowerShell and CMD.
  return platform === 'windows' ? `wsl -e bash -c "${run}"` : run;
}

async function renderClaim() {
  const publicJiboIo = /(^|\.)jibo\.io$/i.test(location.hostname);
  const container = page('Connect or migrate a Jibo', publicJiboIo
    ? 'One command checks your Jibo and takes the right setup path.'
    : 'Link a Jibo that was set up before to this account, using the credentials he already has.');
  container.querySelector('.page-head').prepend(
    h('a', { class: 'link', href: '#/add', style: 'display:inline-flex;align-items:center;gap:.35rem;margin-bottom:.75rem' },
      icon('back', 14), 'Choose a different path'));

  const body = h('div', { class: 'claim-result' }, loading(2));
  container.append(card('Run this on a computer on Jibo’s network', {}, body));
  show(container);

  const load = async () => {
    body.replaceChildren(loading(2));
    const res = await api('POST', '/api/robots/claim-code', {});
    if (!res.ok) {
      body.replaceChildren(errorBox('Could not create your command.', res.data?.error),
        h('div', {}, h('button', { type: 'button', class: 'btn btn-sm', on: { click: load } }, 'Try again')));
      return;
    }
    const { code, expires } = res.data;
    const renewRow = h('p', { class: 'field-hint claim-code-note' },
      icon('lock', 13), h('span', {}, `Private, one-use code for your account. It expires ${fmtDate(expires)}; opening this page again replaces it.`));

    if (!publicJiboIo) {
      const host = res.data.repointHost || '<server-ip>';
      const adoptionUrl = `${location.origin}${res.data.adoptionPath || '/api/adopt-robot'}`;
      const command = ['scripts/parity-robot/repoint-robot.sh', '--robot root@<robot-ip>', `--phoenix ${host}`,
        `--claim-code ${code}`, `--adoption-url ${adoptionUrl}`, '--yes'].join(' ');
      body.replaceChildren(...[
        h('p', { class: 'instruct' }, 'From a Phoenix checkout, replacing ', h('code', {}, '<robot-ip>'), ':'),
        h('div', { class: 'restart-cmd run-cmd' }, h('code', { text: command }), copyButton(() => command)),
        res.data.repointHost ? null : h('p', { class: 'field-hint' }, 'This server has not published its robot-repoint IP, so replace ',
          h('code', {}, '<server-ip>'), ' with the public IP the robot should reach.'),
        renewRow,
      ].filter(Boolean));
      return;
    }

    let platform = detectCmdPlatform();
    const commandText = h('code');
    const where = h('p', { class: 'field-hint' });
    const segment = h('div', { class: 'segment platform-switch', role: 'tablist', 'aria-label': 'Your computer' });
    const tabs = [['windows', 'Windows'], ['unix', 'macOS / Linux']].map(([value, label]) =>
      h('button', { type: 'button', class: 'tab', role: 'tab', 'data-platform': value,
        on: { click: () => { setPlatform(value, true); } } }, label));
    segment.append(h('span', { class: 'seg-thumb', 'aria-hidden': 'true' }), ...tabs);
    function setPlatform(value, remember) {
      platform = value;
      if (remember) { try { localStorage.setItem(CMD_PLATFORM_KEY, value); } catch {} }
      segment.dataset.active = value;
      for (const tab of tabs) {
        const on = tab.dataset.platform === value;
        tab.classList.toggle('active', on);
        tab.setAttribute('aria-selected', String(on));
      }
      commandText.textContent = repointCommand(code, value);
      where.replaceChildren(...(value === 'windows'
        ? ['Paste it into PowerShell or Command Prompt. It runs in WSL, which the ',
          h('a', { class: 'link', href: 'https://github.com/Paskooter/Jibo-DFU-Mod-Toolkit', target: '_blank', rel: 'noopener' }, 'DFU toolkit'),
          ' already uses.']
        : ['Paste it into a terminal.']));
    }
    setPlatform(platform, false);

    body.replaceChildren(
      h('p', { class: 'instruct' }, 'Jibo needs to be in ', h('strong', {}, 'int-developer'),
        ' mode and on your Wi-Fi. The command asks for his IP address, shows what it will change, and waits for you to confirm.'),
      segment,
      h('div', { class: 'restart-cmd run-cmd' }, commandText, copyButton(() => commandText.textContent)),
      where,
      renewRow,
      h('h4', { class: 'setting-group-title' }, 'What happens next'),
      h('ul', { class: 'outcome-list' },
        h('li', {}, h('strong', {}, 'Jibo was set up before: '), 'he is linked to your account, then downloads the latest OS, services, setup skill, and BE skill from this server. The full installation includes several restarts and can take a while.'),
        h('li', {}, h('strong', {}, 'Jibo is new or reset: '), 'he restarts into his setup screen. Then ',
          h('a', { class: 'link', href: '#/add/new' }, 'scan a setup QR code'), '; he updates once setup finishes.')),
      h('p', { class: 'field-hint' }, 'Either way, his calibration and identity are kept. When it finishes, check ',
        h('a', { class: 'link', href: '#/robot' }, 'Robots'), '.'));
  };
  await load();
}

/* ==========================================================================
   Connect a robot — first establish cloud target, then setup state
   ========================================================================== */

let pollTimer = null;
function stopPoll() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }

function renderAdd() {
  const container = page('Add a Jibo', 'Start with what you know; the SSH helper can detect the rest.');
  const cloudName = /(^|\.)jibo\.io$/i.test(location.hostname) ? 'jibo.io' : 'this Phoenix server';
  container.querySelector('.page-head').prepend(
    h('a', { class: 'link', href: '#/robot', style: 'display:inline-flex;align-items:center;gap:.35rem;margin-bottom:.75rem' },
      icon('back', 14), 'Back to robots'));
  const next = h('div', {});
  const chooseTarget = (alreadyPointed) => {
    next.replaceChildren(card('2. Choose the setup path', {},
      h('p', { class: 'field-hint' }, alreadyPointed
        ? 'If you are certain this is a newly unpaired robot with no old credentials, use QR setup directly. Otherwise, the SSH helper will check for credentials.'
        : 'Use the SSH helper. It looks for Jibo’s old credentials, even if he is showing a setup screen, then either links him to your account and updates him, or prepares him for QR setup.'),
      h('div', { class: 'row', style: 'margin-top:1.25rem' },
        h('a', { class: 'btn btn-primary', href: '#/claim' }, icon('link', 15), 'Check and prepare this Jibo'),
        alreadyPointed ? h('a', { class: 'btn', href: '#/add/new' }, icon('plus', 15), 'New, unpaired Jibo: QR setup') : null),
      h('p', { class: 'field-hint' }, 'A setup screen doesn’t prove the credentials are gone. If you’re unsure, run the check first; it keeps Jibo’s existing identity.'),
      h('button', { type: 'button', class: 'btn btn-quiet', on: { click: () => { next.replaceChildren(); } } },
        'Change my answer')));
  };
  container.append(card(`1. Has this Jibo already been pointed at ${cloudName}?`, {},
    h('p', { class: 'instruct' }, 'A factory-reset Jibo may show a setup screen while still pointing at the original, offline cloud.'),
    h('div', { class: 'row', style: 'margin-top:1.25rem' },
      h('button', { type: 'button', class: 'btn btn-primary', on: { click: () => chooseTarget(true) } }, 'Yes'),
      h('button', { type: 'button', class: 'btn', on: { click: () => chooseTarget(false) } }, 'No'),
      h('button', { type: 'button', class: 'btn', on: { click: () => chooseTarget(false) } }, 'I’m not sure')),
    h('p', { class: 'field-hint' }, '“No” and “I’m not sure” use the same safe repoint check. Jibo needs to be in int-developer mode so the helper can reach him over SSH.')),
  next,
  cloudName === 'jibo.io'
    ? h('p', { class: 'field-hint' }, 'Need more context? Read the ', h('a', { class: 'link', href: '/guide' }, 'setup guide'), '.')
    : null);
  show(container);
}

function renderAddRepointOobe() {
  // Old bookmarks reached a path that assumed "setup screen" meant "no
  // credentials". That assumption could destroy the user's best migration
  // route, so always send them through the credential-detecting helper.
  // Replace, not push: Back must not land here and bounce forward again.
  location.replace('#/claim');
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
      h('a', { href: '#/claim' }, 'repoint it first'), '.')));
  const errorLine = h('p', { class: 'error', hidden: true });
  const form = h('form', {},
    h('p', { class: 'field-hint' }, 'A Jibo already paired to this account keeps its loop, people, and history. A new Jibo gets a new loop.'),
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

  onSubmit(form, async (e) => {
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

    const paint = () => holder.replaceChildren(...codes.slice(0, 2).map((_, i) =>
      // qrSvg() returns SVG *markup*. It must go in as markup: a plain string
      // child is appended as a text node, which is why the setup code used to
      // render as a wall of literal <svg> source instead of a scannable code.
      h('div', { html: qrSvg(codes[(frame + i) % codes.length], 5) })));
    paint();

    const qrCard = card('Setup code', { sub: `${codes.length} frame${codes.length === 1 ? '' : 's'} · valid for 15 minutes` },
      h('p', { class: 'instruct instruct-center' }, 'Open the robot’s setup screen and hold this up to its eye.'),
      holder,
      codes.length > 1 ? h('p', { class: 'field-hint', style: 'text-align:center' }, 'Tap the codes to advance the frames.') : null,
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
  clearPrivateView();
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
        preview: { ...preview, loopId: loop.id },
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
    container.append(...visibleLoops.map((loop) => loopPrivacyPanel(loop)));
    container.append(failures.length === responses.length
      ? errorBox('Could not load the gallery.', failures[0]?.result.data.error)
      : empty('Nothing captured yet', 'Photographs the robot takes will appear here.', 'image'));
    return show(container);
  }

  const selected = new Map();
  container.append(h('div', { class: 'secure-loop-panels' }, ...visibleLoops.map((loop) => loopPrivacyPanel(loop))));
  const deleteBtn = h('button', {
    class: 'btn btn-danger btn-sm', type: 'button', disabled: true,
    on: { click: removeSelected },
  }, 'Delete selected');

  const syncDelete = () => {
    deleteBtn.disabled = selected.size === 0;
    deleteBtn.textContent = selected.size ? `Delete ${selected.size} selected` : 'Delete selected';
  };

  const grid = h('div', { class: 'media-grid' }, ...items.map((m) => h('div', {
    class: 'media-tile', 'data-path': m.path, 'data-loop': m.loopId,
  },
    h('button', { type: 'button', class: 'media-open', 'aria-label': `Open ${m.type} captured ${fmtDate(m.created)}`, on: { click: () => openMedia(m) } },
      secureCapturePreview(m.preview, { alt: `${m.type} captured ${fmtDate(m.created)}` })),
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
    const opener = document.activeElement;
    let objectUrl = null; let blob = null; let closed = false;
    const content = h('div', { class: 'capture-viewer-content', role: 'status' }, 'Unlocking capture…');
    const share = h('button', { type: 'button', class: 'btn btn-sm', disabled: true, hidden: typeof navigator.share !== 'function',
      on: { click: async () => {
        if (!blob) return;
        try {
          const extension = blob.type.startsWith('image/') ? (blob.type === 'image/png' ? 'png' : 'jpg') : 'mp4';
          const file = new File([blob], `jibo-${m.path}.${extension}`, { type: blob.type });
          if (navigator.canShare && !navigator.canShare({ files: [file] })) throw new Error('This device cannot share this capture');
          await navigator.share({ title: 'Jibo capture', files: [file] });
        } catch (error) { if (error.name !== 'AbortError') notify(error.message || 'Could not share this capture', 'error'); }
      } } }, icon('share', 14), 'Share');
    const download = h('a', { class: 'btn btn-sm', hidden: true }, icon('download', 14), 'Download');
    const close = () => {
      if (closed) return;
      closed = true; overlay.remove(); removeEventListener('keydown', onKey);
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      blob = null; privateViewCleanup.delete(close); opener?.focus?.();
    };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    const overlay = h('div', {
      class: 'overlay', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Capture viewer', tabindex: '-1',
      on: { click: (e) => { if (e.target === overlay) close(); } },
    }, content, h('p', {}, `${m.loopName || 'Loop'} · ${m.type} · ${fmtDate(m.created)}`),
      h('div', { class: 'row' }, share, download, h('button', { type: 'button', class: 'btn btn-sm', on: { click: close } }, 'Close')));
    const unsubscribe = loopKeys.subscribe((id) => { if ((id === null || id === m.loopId) && !loopKeys.has(m.loopId) && m.isEncrypted) close(); });
    privateViewCleanup.add(close);
    privateViewCleanup.add(unsubscribe);
    addEventListener('keydown', onKey); document.body.append(overlay); overlay.focus();
    void (async () => {
      try {
        const result = await loopKeys.mediaBlob(m);
        if (closed) return;
        blob = result; objectUrl = URL.createObjectURL(blob);
        const tag = blob.type.startsWith('video/') ? 'video' : blob.type.startsWith('audio/') ? 'audio' : 'img';
        const element = h(tag, { src: objectUrl, class: 'overlay-img', alt: `${m.type} captured ${fmtDate(m.created)}` });
        if (tag !== 'img') element.controls = true;
        element.addEventListener('error', () => { content.replaceChildren(errorBox('This capture could not be displayed.')); });
        content.replaceChildren(element);
        share.disabled = false;
        download.href = objectUrl; download.download = `jibo-${m.path}.${blob.type.startsWith('image/') ? (blob.type === 'image/png' ? 'png' : 'jpg') : 'mp4'}`; download.hidden = false;
      } catch (error) { if (!closed) content.replaceChildren(errorBox('Could not open this capture.', error.message)); }
    })();
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

    // Tagging yourself only alerts you about your own message.
    const people = inboxPeople(loop).filter((person) => person.id !== String(me?.id));
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
    onSubmit(compose, async (e) => {
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

// The parts of Jibo's software the update catalog publishes, in plain words.
const SOFTWARE_PARTS = {
  os: { name: 'Operating system', icon: 'chip', order: 0 },
  services: { name: 'System services', icon: 'server', order: 1 },
  '@be/be': { name: 'Skills and personality', icon: 'sparkles', order: 2 },
  'oobe-config': { name: 'Setup screens', icon: 'wifi', order: 3 },
};

function fmtBytes(value) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`;
  return `${Math.max(1, Math.round(bytes / 1e3))} KB`;
}

async function renderSystem() {
  const title = 'System';
  const description = 'The software this server gives your Jibo, and the services connected to him.';
  show(page(title, description, loading(4)));

  const [upd, ifttt] = await Promise.all([
    api('GET', '/api/update/status'),
    api('GET', '/api/ifttt'),
  ]);
  const container = page(title, description);

  /* -- Jibo software ------------------------------------------------------ */

  // The newest release of each part: the catalog can hold more than one while a
  // release is being replaced.
  const newest = new Map();
  for (const u of (upd.ok ? upd.data.updates || [] : [])) {
    if (!u || !u.subsystem || !u.toVersion) continue;
    const current = newest.get(u.subsystem);
    if (!current || String(u.toVersion).localeCompare(String(current.toVersion), undefined, { numeric: true }) > 0) {
      newest.set(u.subsystem, u);
    }
  }
  const parts = [...newest.values()].sort((a, b) => (SOFTWARE_PARTS[a.subsystem]?.order ?? 9) - (SOFTWARE_PARTS[b.subsystem]?.order ?? 9)
    || a.subsystem.localeCompare(b.subsystem));

  const softwareRow = (u) => {
    const part = SOFTWARE_PARTS[u.subsystem] || { name: u.subsystem, icon: 'download' };
    const meta = [u.created ? `Published ${fmtAgo(u.created)}` : '', fmtBytes(u.length)].filter(Boolean).join(' · ');
    return h('li', { class: 'software-row' },
      h('span', { class: 'software-ic' }, icon(part.icon, 17)),
      h('div', { class: 'software-main' },
        h('div', { class: 'software-name' }, h('b', { text: part.name }), h('span', { class: 'software-version', text: u.toVersion })),
        meaningfulText(u.changes) ? h('p', { class: 'software-notes', text: u.changes }) : null,
        meta ? h('span', { class: 'software-meta', text: meta }) : null));
  };

  const software = card('Jibo software', { sub: parts.length ? 'The latest release of each part, on this server' : null },
    upd.ok
      ? (parts.length
        ? h('ul', { class: 'software-list' }, ...parts.map(softwareRow))
        : empty('Nothing published yet', 'When this server publishes an update for Jibo, it appears here.', 'download'))
      : errorBox('Could not reach the update service.', upd.data.error));
  software.append(h('div', { class: 'card-foot software-foot' },
    icon('refresh', 15),
    h('span', {}, 'Jibo checks for these and installs them on his own. To check right away, say ',
      h('b', {}, '“Hey Jibo, check for updates.”'))));
  container.append(software);

  /* -- connected services ------------------------------------------------- */

  const connections = h('div', { class: 'service-list' });
  if (!ifttt.ok) {
    connections.append(errorBox('Could not load IFTTT.', ifttt.data.error));
  } else {
    const identity = ifttt.data.identity;
    const connected = !!(identity && identity.id);
    const applets = (ifttt.data.applets || []).filter((a) => meaningfulText(a?.text) || a?.id);
    connections.append(h('div', { class: 'service' },
      h('span', { class: 'service-ic' }, icon('link', 17)),
      h('div', { class: 'service-main' },
        h('div', { class: 'service-name' }, h('b', {}, 'IFTTT'),
          connected
            ? h('span', { class: 'pill pill-ok' }, h('span', { class: 'dot' }), 'Connected')
            : h('span', { class: 'pill' }, 'Not connected')),
        h('p', { class: 'service-text' }, connected
          ? `${applets.length ? `${applets.length} applet${applets.length === 1 ? '' : 's'} can use Jibo.` : 'No applets use Jibo yet.'} IFTTT manages this connection itself.`
          : 'Connect Jibo from IFTTT to let your applets use him. The connection is made and managed there, not here.'),
        applets.length ? h('ul', { class: 'applet-list' },
          ...applets.map((a) => h('li', {}, icon('arrow', 13), h('span', { text: meaningfulText(a.text) || String(a.id) })))) : null,
        ifttt.data.diagnostics
          ? h('div', { class: 'notice notice-warn' }, icon('alert', 15), h('div', { text: ifttt.data.diagnostics.message || 'IFTTT is unavailable right now.' }))
          : null)));
  }
  container.append(card('Connected services', {}, connections));

  /* -- about -------------------------------------------------------------- */

  const github = document.querySelector('.site-header [data-brand-attr*="links.github"], [data-brand-attr*="links.github"]')?.getAttribute('href')
    || 'https://github.com/Paskooter/phoenix';
  const safeGithub = /^https:\/\//.test(github) ? github.replace(/\/+$/, '') : 'https://github.com/Paskooter/phoenix';
  container.append(h('section', { class: 'card about-card' },
    h('div', { class: 'card-body' },
      h('div', { class: 'about-text' },
        h('h3', {}, 'About Phoenix'),
        h('p', {}, 'Phoenix is an open-source replacement for the cloud service Jibo was built to talk to. '
          + 'Found a problem, or have an idea? The project lives on GitHub.')),
      h('div', { class: 'row' },
        h('a', { class: 'btn btn-sm', href: safeGithub, target: '_blank', rel: 'noopener' }, 'Source on GitHub'),
        h('a', { class: 'btn btn-sm btn-quiet', href: `${safeGithub}/issues`, target: '_blank', rel: 'noopener' }, 'Report an issue')))));

  show(container);
}

/* ==========================================================================
   Administration
   ==========================================================================
   Six pages under #/admin for the people who run this server: an overview of
   how it is doing, its settings, every robot, everyone with an account, how
   long voice turns take, and the live log.

   Administrator access is a property of the signed-in account and the server
   re-checks it on every /api/admin/* route, so nothing here grants anything —
   it only decides what to draw. A hand-edited client gets 403s.
   ========================================================================== */

const ADMIN_TABS = [
  { hash: '#/admin', label: 'Overview', icon: 'server' },
  { hash: '#/admin/settings', label: 'Settings', icon: 'sliders' },
  { hash: '#/admin/robots', label: 'Robots', icon: 'robot' },
  { hash: '#/admin/people', label: 'People', icon: 'users' },
  { hash: '#/admin/voice-turns', label: 'Voice turns', icon: 'clock' },
  { hash: '#/admin/logs', label: 'Logs', icon: 'message' },
];

/** The admin page frame: heading, the admin tabs, and a body to fill. */
function adminPage(active, title, description) {
  const container = page(title, description);
  const nav = h('nav', { class: 'subnav admin-tabs', 'aria-label': 'Server administration' },
    ...ADMIN_TABS.map((tab) => h('a', {
      href: tab.hash,
      class: tab.hash === active ? 'active' : '',
      'aria-current': tab.hash === active ? 'page' : null,
    }, icon(tab.icon, 15), h('span', { text: tab.label }))));
  container.querySelector('.page-head').after(nav);
  container.classList.add('admin-page');
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
    container.append(card('This account isn’t an administrator', { sub: me ? (me.email || '') : '' },
      h('p', { class: 'field-hint' },
        'Only administrators can manage the server. An administrator can make you one from the People '
        + 'tab, or, on the server itself:'),
      h('div', { class: 'restart-cmd' },
        h('span', { class: 'prompt' }, '$'),
        h('code', { text: `node scripts/portal-grant-admin.mjs --email ${me?.email || 'you@example.com'}` }),
        copyButton(() => `node scripts/portal-grant-admin.mjs --email ${me?.email || 'you@example.com'}`))));
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

/** "Answers", "Answers and Hub", "Answers, Hub and Logs". */
function listText(names) {
  if (names.length < 3) return names.join(' and ');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/**
 * Name a set of services the way a sentence needs it: "Answers", "Answers and
 * History", "every service", or "5 services" once a list would be a paragraph.
 */
function servicesPhrase(ids, labelOf, everyId = []) {
  if (everyId.length && everyId.every((id) => ids.includes(id))) return 'every service';
  if (ids.length > 3) return `${ids.length} services`;
  return listText(ids.map(labelOf));
}

/** How long something has been running: "3 minutes", "5 hours", "12 days". */
function fmtUptime(since) {
  const ms = Date.now() - Number(since);
  if (!Number.isFinite(ms) || ms < 0) return '';
  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) return 'under a minute';
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? '' : 's'}`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'}`;
}

const fmtDuration = (ms) => (!Number.isFinite(ms) ? '—' : ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)} s`);

/* -- Restarting services ----------------------------------------------------- */

/**
 * Restart services through the launcher and show each one come back. Asks
 * first, explaining what a restart interrupts. Resolves true when every service
 * is running and answering again, false when it was cancelled or one did not.
 */
async function restartServices(ids, labels = {}, everyId = []) {
  const name = (id) => labels[id] || id;
  const hub = ids.includes('hub');
  const self = ids.includes('account');
  const phrase = servicesPhrase(ids, name, everyId);
  const yes = await confirmDialog({
    title: `Restart ${phrase}?`,
    body: [
      hub ? 'Robots talking to Jibo right now will be cut off for a few seconds, then reconnect by themselves.' : null,
      self ? 'This page reconnects by itself.' : null,
      !hub && !self ? 'It takes a few seconds; anything using it waits until it is back.' : null,
    ].filter(Boolean).join(' '),
    confirmLabel: ids.length === 1 ? 'Restart' : 'Restart them',
    danger: false,
  });
  if (!yes) return false;

  const steps = new Map(ids.map((id) => [id, {
    el: h('li', { class: 'restart-step is-waiting' },
      h('span', { class: 'restart-step-mark', 'aria-hidden': 'true' }),
      h('span', { class: 'restart-step-name', text: name(id) }),
      h('span', { class: 'restart-step-state', text: 'Stopping' })),
    done: false,
    failed: false,
  }]));
  const title = h('h3', { text: ids.length === 1 ? `Restarting ${name(ids[0])}` : 'Restarting services' });
  const note = h('p', { class: 'field-hint', text: '' });
  const closeBtn = h('button', { class: 'btn', type: 'button', disabled: true }, 'Close');
  const dialog = h('dialog', { class: 'modal restart-modal' }, title,
    h('ul', { class: 'restart-steps', role: 'list' }, ...[...steps.values()].map((s) => s.el)),
    note,
    h('div', { class: 'row row-end', style: 'margin-top:1.1rem' }, closeBtn));
  let finished = false;
  let resolveDone;
  const done = new Promise((resolve) => { resolveDone = resolve; });
  const close = () => { dialog.close(); dialog.remove(); resolveDone(finished && [...steps.values()].every((s) => s.done)); };
  closeBtn.addEventListener('click', close);
  dialog.addEventListener('cancel', (event) => { event.preventDefault(); if (finished) close(); });
  document.body.append(dialog);
  dialog.showModal();

  const setStep = (id, state, text) => {
    const step = steps.get(id);
    step.el.className = `restart-step is-${state}`;
    step.el.querySelector('.restart-step-state').textContent = text;
    step.done = state === 'done' || state === 'warn';
    step.failed = state === 'failed';
  };

  const start = await apiRaw('POST', '/api/admin/services/restart', { services: ids });
  if (!start.ok) {
    for (const id of ids) setStep(id, 'failed', 'Not restarted');
    note.textContent = start.data?.error || 'The restart couldn’t be requested.';
    finished = true;
    closeBtn.disabled = false;
    return done;
  }
  const requestedAt = Number(start.data.requestedAt) || Date.now();
  const deadline = Date.now() + 75_000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 700));
    const list = await apiRaw('GET', '/api/admin/services');
    if (!list.ok) {
      note.textContent = self ? 'Waiting for the console to come back…' : 'Checking…';
      continue;
    }
    note.textContent = '';
    for (const id of ids) {
      const service = (list.data.services || []).find((s) => s.id === id);
      if (!service) continue;
      const restarted = Number(service.startedAt) >= requestedAt - 1000;
      if (!restarted) setStep(id, 'waiting', service.state === 'restarting' ? 'Stopping' : 'Waiting');
      else if (service.state === 'stopped') setStep(id, 'failed', 'Didn’t start');
      else if (service.state === 'running' && service.healthy && service.safeMode) setStep(id, 'warn', 'Running without saved settings');
      else if (service.state === 'running' && service.healthy) setStep(id, 'done', 'Running');
      else setStep(id, 'starting', 'Starting');
    }
    if ([...steps.values()].every((s) => s.done || s.failed)) break;
  }
  for (const [id, step] of steps) if (!step.done && !step.failed) setStep(id, 'failed', 'Not back yet');
  const failed = [...steps.values()].filter((s) => s.failed).length;
  const warned = [...steps.values()].some((s) => s.el.classList.contains('is-warn'));
  title.textContent = failed
    ? `${failed === ids.length ? 'The restart' : 'Part of the restart'} didn’t work`
    : (ids.length === 1 ? `${name(ids[0])} restarted` : 'Restarted');
  note.textContent = failed
    ? 'A service that doesn’t come back usually says why in the Logs tab.'
    : warned ? 'A service stopped right after starting with your saved settings, so it was started without them. Check its settings.'
      : 'Everything is running with the latest settings.';
  finished = true;
  closeBtn.disabled = false;
  closeBtn.classList.add('btn-primary');
  closeBtn.focus();
  return done;
}

/* -- Overview ---------------------------------------------------------------- */

function serviceTone(service) {
  if (service.state === 'restarting') return 'busy';
  if (service.state !== 'running') return 'down';
  if (service.healthy === false) return 'down';
  if (service.safeMode) return 'warn';
  return service.healthy ? 'up' : 'unknown';
}

function serviceStatusText(service) {
  if (service.state === 'restarting') return 'Restarting';
  if (service.state !== 'running') return 'Stopped';
  if (service.healthy === false) return 'Not answering';
  return 'Running';
}

async function renderAdminOverview() {
  const container = adminPage('#/admin', 'Your server', 'How Phoenix is running, and anything that needs you.');
  show(container);
  if (!(await adminGate(container))) return;
  const body = h('div', { class: 'adm-overview' }, loading(5));
  container.append(body);

  let labels = {};
  const load = async ({ quiet = false } = {}) => {
    const res = await api('GET', '/api/admin/overview');
    if (!res.ok) {
      if (!quiet) body.replaceChildren(errorBox('Could not read the server’s status.', res.data.error));
      return;
    }
    labels = Object.fromEntries((res.data.services || []).map((s) => [s.id, s.label]));
    body.replaceChildren(...overviewParts(res.data));
  };

  const restart = async (ids) => {
    const list = ids === 'all' ? Object.keys(labels) : ids;
    if (!list.length) return;
    await restartServices(list, labels, Object.keys(labels));
    await load({ quiet: true });
  };

  function overviewParts(d) {
    const services = d.services || [];
    const main = services.filter((s) => !s.minor);
    const down = main.filter((s) => serviceTone(s) === 'down');
    const attention = d.attention || [];
    // The hero answers one question, is it running; everything else is in the list below it.
    const tone = down.length || attention.some((a) => a.level === 'error') ? 'error' : 'ok';
    const release = d.phoenix?.release;
    const heroTitle = !main.length ? 'Phoenix is running'
      : down.length ? `${down.length} ${down.length === 1 ? 'service isn’t' : 'services aren’t'} running`
        : 'Everything’s running';
    const facts = [
      main.length ? `${main.length - down.length} of ${main.length} services up` : null,
      d.counts.online !== null ? `${d.counts.online} of ${d.counts.robots} ${d.counts.robots === 1 ? 'robot' : 'robots'} online`
        : `${d.counts.robots} ${d.counts.robots === 1 ? 'robot' : 'robots'}`,
      `${d.counts.people} ${d.counts.people === 1 ? 'person' : 'people'}`,
    ].filter(Boolean);

    const hero = h('section', { class: `card adm-hero adm-tone-${tone}` },
      h('div', { class: 'adm-hero-main' },
        h('span', { class: 'adm-hero-mark', 'aria-hidden': 'true' }, icon(tone === 'ok' ? 'check' : 'alert', 22)),
        h('div', { class: 'adm-hero-text' },
          h('h2', { text: heroTitle }),
          h('p', {},
            release ? h('span', {}, 'Phoenix ', h('code', { text: release.commit })) : 'Phoenix',
            d.phoenix?.startedAt ? ` · running for ${fmtUptime(d.phoenix.startedAt)}` : '',
            d.phoenix?.node ? ` · Node ${d.phoenix.node.replace(/^v/, '')}` : ''))),
      h('ul', { class: 'adm-hero-facts', role: 'list' }, ...facts.map((fact) => h('li', { text: fact }))));

    const parts = [hero];

    if (attention.length) {
      const serious = attention.some((a) => a.level !== 'info');
      const list = h('ul', { class: 'adm-attention', role: 'list' }, ...attention.map((item) => {
        const action = item.action;
        let button = null;
        if (action?.restart && d.control?.available) {
          button = h('button', { type: 'button', class: `btn btn-sm${item.level === 'error' ? ' btn-primary' : ''}`,
            on: { click: () => restart(action.restart) } }, action.label);
        } else if (action?.href) {
          button = h('a', { class: 'btn btn-sm', href: action.href }, action.label);
        }
        return h('li', { class: `adm-attention-item is-${item.level}` },
          h('span', { class: 'adm-attention-ic', 'aria-hidden': 'true' }, icon(item.level === 'info' ? 'sparkles' : 'alert', 15)),
          h('div', { class: 'adm-attention-text' }, h('strong', { text: item.title }), item.body ? h('span', { text: item.body }) : null),
          button);
      }));
      const attentionCard = card(serious ? 'Needs your attention' : 'Worth knowing', {}, list);
      attentionCard.classList.add('adm-attention-card');
      parts.push(attentionCard);
    }

    /* services */
    const serviceRow = (s) => {
      const tone2 = serviceTone(s);
      const meta = [];
      if (s.state === 'running' && s.startedAt) meta.push(`up ${fmtUptime(s.startedAt)}`);
      if (s.state === 'running' && s.latencyMs !== null && s.latencyMs !== undefined) meta.push(`${s.latencyMs} ms`);
      const tags = [];
      if (s.safeMode && s.state === 'running') tags.push(h('span', { class: 'pill pill-warn', text: 'Without saved settings' }));
      if (s.pendingSettings) tags.push(h('span', { class: 'pill pill-accent', text: `${s.pendingSettings} change${s.pendingSettings === 1 ? '' : 's'} to apply` }));
      return h('li', { class: `adm-service is-${tone2}` },
        h('span', { class: 'adm-service-dot', title: serviceStatusText(s), 'aria-hidden': 'true' }),
        h('div', { class: 'adm-service-main' },
          h('div', { class: 'adm-service-name' }, h('strong', { text: s.label }), ...tags),
          h('span', { class: 'adm-service-desc', text: s.description })),
        h('div', { class: 'adm-service-meta' },
          h('span', { class: 'adm-service-state', text: serviceStatusText(s) }),
          meta.length ? h('span', { text: meta.join(' · ') }) : null),
        d.control?.available ? h('button', {
          type: 'button', class: 'icon-btn adm-service-restart', title: `Restart ${s.label}`, 'aria-label': `Restart ${s.label}`,
          on: { click: () => restart([s.id]) },
        }, icon('refresh', 15)) : null);
    };
    const servicesBody = [];
    if (!services.length) {
      servicesBody.push(h('p', { class: 'field-hint',
        text: d.control?.available === false
          ? 'This server’s services aren’t run by Phoenix’s launcher, so their status isn’t available here.'
          : 'No services are reported.' }));
    } else {
      servicesBody.push(h('ul', { class: 'adm-services', role: 'list' }, ...main.map(serviceRow)));
      const minor = services.filter((s) => s.minor);
      if (minor.length) {
        servicesBody.push(h('details', { class: 'adm-more' },
          h('summary', {}, icon('chevron', 14, 'adm-more-caret'), `Developer skills (${minor.length})`),
          h('ul', { class: 'adm-services', role: 'list' }, ...minor.map(serviceRow))));
      }
    }
    const servicesCard = card('Services', {
      sub: main.length ? `${main.length - down.length} of ${main.length} running` : null,
      actions: d.control?.available && services.length ? [h('button', { type: 'button', class: 'btn btn-sm',
        on: { click: () => restart('all') } }, icon('refresh', 14), 'Restart all…')] : null,
    }, ...servicesBody);
    servicesCard.classList.add('adm-services-card');

    /* activity */
    const v = d.voice;
    let activity;
    if (!v) {
      activity = h('p', { class: 'field-hint', text: 'Voice timing isn’t available from the voice gateway right now.' });
    } else if (!v.turns) {
      activity = h('div', { class: 'adm-activity' },
        h('div', { class: 'adm-big' }, h('strong', { text: '0' }), h('span', { text: 'voice turns in the last hour' })),
        h('p', { class: 'field-hint', text: 'Nobody has talked to a Jibo on this server in the last hour.' }));
    } else {
      const total = Math.max(1, v.understood + v.missed + v.failed);
      const share = (n) => `${((n / total) * 100).toFixed(1)}%`;
      activity = h('div', { class: 'adm-activity' },
        h('div', { class: 'adm-big' }, h('strong', { text: String(v.turns) }),
          h('span', { text: `voice turn${v.turns === 1 ? '' : 's'} in the last hour` })),
        h('div', { class: 'adm-split', role: 'img', 'aria-label': `${v.understood} understood, ${v.missed} not understood, ${v.failed} failed` },
          h('span', { class: 'is-ok', style: `width:${share(v.understood)}` }),
          h('span', { class: 'is-miss', style: `width:${share(v.missed)}` }),
          h('span', { class: 'is-fail', style: `width:${share(v.failed)}` })),
        h('ul', { class: 'adm-legend', role: 'list' },
          h('li', { class: 'is-ok' }, `${v.understood} understood`),
          h('li', { class: 'is-miss' }, `${v.missed} not understood`),
          v.failed ? h('li', { class: 'is-fail' }, `${v.failed} failed`) : null),
        h('dl', { class: 'adm-facts' },
          h('div', {}, h('dt', { text: 'Typical reply' }), h('dd', { text: fmtDuration(v.medianMs) })),
          h('div', {}, h('dt', { text: 'Slowest 10%' }), h('dd', { text: fmtDuration(v.p90Ms) }))));
    }
    const activityCard = card('Voice activity', { actions: [h('a', { class: 'ov-link', href: '#/admin/voice-turns' }, 'Details', icon('arrow', 13))] }, activity);

    /* people, robots, loops */
    const countRow = (href, iconName, label, value, note) => h('a', { class: 'adm-count', href },
      h('span', { class: 'adm-count-ic' }, icon(iconName, 16)),
      h('span', { class: 'adm-count-label', text: label }),
      h('span', { class: 'adm-count-note', text: note || '' }),
      h('strong', { text: String(value) }),
      icon('chevron', 14, 'adm-count-go'));
    const countsCard = card('On this server', {},
      h('div', { class: 'adm-counts' },
        countRow('#/admin/people', 'users', 'People', d.counts.people, `${d.counts.admins} administrator${d.counts.admins === 1 ? '' : 's'}`),
        countRow('#/admin/robots', 'robot', 'Robots', d.counts.robots, d.counts.online !== null ? `${d.counts.online} online now` : ''),
        countRow('#/admin/robots', 'home', 'Loops', d.counts.loops, '')));

    /* storage */
    let storageCard = null;
    if (d.disk && d.disk.total > 0) {
      const used = d.disk.total - d.disk.free;
      const pct = Math.min(100, Math.max(0, (used / d.disk.total) * 100));
      storageCard = card('Storage', {},
        h('div', { class: 'adm-disk' },
          h('div', { class: 'adm-big' }, h('strong', { text: fmtBytes(d.disk.free) }), h('span', { text: `free of ${fmtBytes(d.disk.total)}` })),
          h('div', { class: `adm-meter${pct > 90 ? ' is-full' : pct > 75 ? ' is-high' : ''}`, role: 'meter',
            'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(Math.round(pct)), 'aria-label': 'Disk used' },
          h('span', { style: `width:${pct.toFixed(1)}%` })),
          h('p', { class: 'field-hint' }, 'Data is kept in ', h('code', { text: d.disk.path }))));
    }

    parts.push(h('div', { class: 'adm-columns' },
      h('div', { class: 'adm-col-main' }, servicesCard),
      h('div', { class: 'adm-col-side' }, activityCard, countsCard, storageCard)));
    return parts;
  }

  await load();
  stopPoll();
  pollTimer = setInterval(() => {
    // Only refresh while nobody is looking at a dialog.
    if (!document.querySelector('dialog[open]')) load({ quiet: true });
  }, 20_000);
}

/* -- Settings ---------------------------------------------------------------- */

const adminSettingsUi = { open: null, search: '', advanced: new Set(), serverOpen: false };

function settingDisplayValue(s) {
  const unit = s.unit ? ` ${s.unit}` : '';
  const effective = s.value ?? (s.source === 'default' ? s.default : null);
  if (s.type === 'secret') {
    if (!s.isSet) return h('span', { class: 'setting-value is-empty', text: 'Not set' });
    return h('span', { class: 'setting-value' }, h('span', { class: 'pill' }, icon('lock', 11), 'Set'),
      s.hint ? h('span', { class: 'setting-secret-hint', text: `ends in ${s.hint}` }) : null);
  }
  if (s.type === 'bool') {
    const on = (effective ?? 'false') === 'true';
    return h('span', { class: `setting-value${s.source === 'default' ? ' is-default' : ''}`, text: on ? 'On' : 'Off' });
  }
  if (s.type === 'enum') {
    const option = (s.options || []).find((o) => o.value === (effective ?? ''));
    return h('span', { class: `setting-value${s.source === 'default' ? ' is-default' : ''}`, text: option ? option.label : String(effective ?? '') });
  }
  if (effective === null || effective === undefined || effective === '') {
    return h('span', { class: 'setting-value is-empty', text: s.type === 'number' && s.placeholder === 'Built-in' ? 'Built-in' : 'Not set' });
  }
  const mono = ['url', 'host', 'string', 'email', 'path'].includes(s.type);
  return h('span', { class: `setting-value${mono ? ' is-mono' : ''}${s.source === 'default' ? ' is-default' : ''}`, title: String(effective) },
    `${effective}${s.type === 'number' ? unit : ''}`);
}

function settingSourceTag(s, serverFile) {
  if (s.source === 'console') return h('span', { class: 'pill pill-accent', title: 'Saved in the console', text: 'Set here' });
  if (s.source === 'server') return h('span', { class: 'pill', title: serverFile?.path ? `From ${serverFile.path}` : 'From the server', text: 'Server' });
  // A default value is shown muted instead: a tag means someone chose the value.
  return null;
}

async function renderAdminSettings(params) {
  const container = adminPage('#/admin/settings', 'Settings',
    'How this server behaves. A change takes effect when the services that use it restart, which you can do right here.');
  show(container);
  if (!(await adminGate(container))) return;

  const body = h('div', { class: 'adm-settings-page' }, loading(6));
  container.append(body);
  const res = await api('GET', '/api/admin/settings');
  if (!res.ok) { body.replaceChildren(errorBox('Could not load the settings.', res.data.error)); return; }
  let data = res.data;
  if (!data.control?.available) {
    const sub = container.querySelector('.page-head p');
    if (sub) sub.textContent = 'How this server behaves, and where each value comes from.';
  }
  const ui = adminSettingsUi;
  ui.open = null;
  const focusGroup = params?.get('group') || null;

  const serviceLabel = (id) => data.services?.[id]?.label || id;
  const byGroup = () => {
    const map = new Map(data.groups.map((g) => [g.id, []]));
    for (const s of data.settings) map.get(s.group)?.push(s);
    return map;
  };

  const save = async (key, value) => {
    const result = await api('PUT', '/api/admin/settings', { changes: { [key]: value } });
    if (!result.ok) return result;
    data = result.data;
    ui.open = null;
    const restart = result.data.restart || [];
    if (!result.data.saved?.length) notify('No change — that was already the value.');
    else if (restart.length) {
      const phrase = servicesPhrase(restart, serviceLabel, data.running || []);
      notify(`Saved. ${phrase[0].toUpperCase()}${phrase.slice(1)} ${restart.length === 1 || phrase === 'every service' ? 'needs' : 'need'} a restart to use it.`);
    }
    else notify('Saved.');
    paint();
    return result;
  };

  const restartPending = async (ids) => {
    const ok = await restartServices(ids, Object.fromEntries(ids.map((id) => [id, serviceLabel(id)])), data.running || []);
    const fresh = await api('GET', '/api/admin/settings');
    if (fresh.ok) { data = fresh.data; paint(); }
    return ok;
  };

  /* one editable setting ------------------------------------------------ */
  function editorFor(s) {
    const error = h('p', { class: 'error setting-error', role: 'alert', hidden: true });
    const showError = (message) => { error.textContent = message; error.hidden = !message; };
    const fallbackLabel = s.overrides ? 'Use the server’s value' : 'Reset to default';
    const fallback = s.source === 'console'
      ? h('button', { type: 'button', class: 'btn btn-sm btn-quiet', on: { click: async (event) => {
        event.currentTarget.disabled = true;
        const out = await save(s.key, null);
        if (!out.ok) showError(out.data?.errors?.[s.key] ? `This ${out.data.errors[s.key]}.` : (out.data?.error || 'Could not save.'));
      } } }, fallbackLabel)
      : null;

    let form;
    if (s.type === 'enum') {
      const current = s.value ?? (s.source === 'default' ? (s.default ?? '') : '');
      const choices = (s.options || []).map((o) => h('label', { class: `choice${o.value === current ? ' is-selected' : ''}` },
        h('input', { type: 'radio', name: `setting-${s.key}`, value: o.value, checked: o.value === current,
          on: { change: () => {
            for (const label of form.querySelectorAll('.choice')) label.classList.toggle('is-selected', label.querySelector('input').checked);
          } } }),
        h('span', { class: 'choice-text' }, h('b', { text: o.label }), o.hint ? h('span', { text: o.hint }) : null)));
      form = h('form', { class: 'line-form setting-editor' },
        h('div', { class: `choice-grid${choices.length > 2 ? ' choice-grid-wide' : ''}` }, ...choices),
        error,
        h('div', { class: 'row' }, h('button', { type: 'submit', class: 'btn btn-sm btn-primary' }, 'Save'), fallback));
      onSubmit(form, async (event) => {
        event.preventDefault();
        const picked = form.querySelector('input[type=radio]:checked');
        if (!picked) return;
        const out = await save(s.key, picked.value);
        if (!out.ok) showError(out.data?.errors?.[s.key] ? `This ${out.data.errors[s.key]}.` : (out.data?.error || 'Could not save.'));
      });
      return form;
    }

    const secret = s.type === 'secret';
    const input = h('input', {
      name: 'value',
      type: secret ? 'password' : s.type === 'email' ? 'email' : s.type === 'url' ? 'url' : 'text',
      inputmode: s.type === 'number' ? 'decimal' : null,
      value: secret ? '' : (s.value ?? ''),
      placeholder: secret ? (s.isSet ? 'Paste the new value' : 'Paste it here') : (s.placeholder || (s.default ? String(s.default) : '')),
      autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false',
      'aria-label': s.label,
    });
    const showBtn = secret ? h('button', { type: 'button', class: 'btn btn-sm btn-quiet', on: { click: () => {
      input.type = input.type === 'password' ? 'text' : 'password';
      showBtn.textContent = input.type === 'password' ? 'Show' : 'Hide';
    } } }, 'Show') : null;
    form = h('form', { class: 'line-form setting-editor' },
      h('div', { class: 'setting-input' }, input, s.unit ? h('span', { class: 'setting-unit', text: s.unit }) : null, showBtn),
      error,
      h('div', { class: 'row' }, h('button', { type: 'submit', class: 'btn btn-sm btn-primary' }, 'Save'), fallback));
    input.addEventListener('input', () => showError(''));
    onSubmit(form, async (event) => {
      event.preventDefault();
      const value = input.value.trim();
      if (!value) { showError(secret ? 'Paste a value, or cancel.' : (s.source === 'console' ? `Leave it empty with “${fallbackLabel}”.` : 'Type a value, or cancel.')); return; }
      const out = await save(s.key, value);
      if (!out.ok) {
        const message = out.data?.errors?.[s.key];
        showError(message ? `This ${message}.` : (Object.values(out.data?.errors || {})[0] || out.data?.error || 'Could not save.'));
      }
    });
    return form;
  }

  function settingLine(s) {
    const editable = s.editable && data.control.available;
    const editing = ui.open === s.key;
    const warning = (data.warnings || []).find((w) => w.key === s.key);
    const pending = (s.pending || []).filter(Boolean);

    let action = null;
    if (editable && s.type === 'bool') {
      const on = ((s.value ?? (s.source === 'default' ? s.default : null)) ?? 'false') === 'true';
      const input = h('input', { type: 'checkbox', checked: on, 'aria-label': s.label });
      action = h('label', { class: 'switch switch-compact' }, input, h('span', { class: 'track' }));
      input.addEventListener('change', async () => {
        input.disabled = true;
        const out = await save(s.key, input.checked ? 'true' : 'false');
        if (!out.ok) { input.checked = !input.checked; input.disabled = false; notify(out.data?.error || 'Could not save that.', 'error'); }
      });
    } else if (editable) {
      const hasValue = s.isSet || s.type === 'enum' || (s.default !== null && s.default !== undefined && s.default !== '');
      const label = editing ? 'Cancel' : s.type === 'secret' ? (s.isSet ? 'Replace…' : 'Add…') : (hasValue ? 'Change…' : 'Set…');
      action = h('button', { type: 'button', class: 'btn btn-sm', 'aria-expanded': String(editing), on: { click: () => {
        ui.open = editing ? null : s.key;
        paint();
        if (!editing) body.querySelector(`[data-key="${s.key}"] .setting-editor input:not([type=radio])`)?.focus();
      } } }, label);
    }

    const notes = [];
    if (s.overrides) {
      notes.push(h('span', { class: 'setting-note' }, 'Replaces the server’s value',
        s.serverValue ? h('span', {}, ' (', h('code', { text: s.serverValue }), ')') : null, '.'));
    }
    if (pending.length) {
      notes.push(h('span', { class: 'setting-note is-pending' }, h('span', { class: 'dot', 'aria-hidden': 'true' }),
        `Waiting for ${listText(pending.map(serviceLabel))} to restart.`));
    }
    if (warning) notes.push(h('span', { class: 'setting-note is-warn' }, icon('alert', 12), warning.message));

    return h('div', { class: `setting-line adm-setting${editing ? ' is-editing' : ''}${pending.length ? ' is-pending' : ''}`, 'data-key': s.key,
      'data-search': `${s.label} ${s.help} ${s.key}`.toLowerCase() },
      h('div', { class: 'setting-line-text' },
        h('span', { class: 'setting-line-label', text: s.label }),
        settingDisplayValue(s),
        settingSourceTag(s, data.serverFile),
        h('span', { class: 'setting-line-hint', text: s.help }),
        ...notes),
      action ? h('div', { class: 'setting-line-actions' }, action) : null,
      editing ? h('div', { class: 'setting-line-editor', on: { keydown: (event) => {
        if (event.key === 'Escape') { ui.open = null; paint(); }
      } } }, editorFor(s)) : null);
  }

  function serverLine(s) {
    return h('div', { class: 'adm-server-line', 'data-key': s.key, 'data-search': `${s.label} ${s.help} ${s.key}`.toLowerCase() },
      h('div', { class: 'adm-server-label' }, h('strong', { text: s.label }), h('span', { text: s.help })),
      h('div', { class: 'adm-server-value' }, settingDisplayValue(s), settingSourceTag(s, data.serverFile)));
  }

  /** The settings only the server's file can change: there to look up, so folded away. */
  function serverSection(serverGroups, groups) {
    if (!serverGroups.length) return null;
    const count = serverGroups.reduce((n, g) => n + groups.get(g.id).length, 0);
    const section = h('details', { class: 'adm-server', open: ui.serverOpen,
      on: { toggle: () => { ui.serverOpen = section.open; } } },
    h('summary', { class: 'adm-server-intro' },
      h('span', { class: 'adm-server-intro-text' },
        h('h2', { text: 'Installed with the server' }),
        h('span', { class: 'adm-server-intro-sub' }, 'Addresses, keys, storage and software. Change them in ',
          data.serverFile?.path ? h('code', { text: data.serverFile.path }) : 'the server’s environment file',
          ' on the server, then restart Phoenix.')),
      h('span', { class: 'adm-server-toggle' },
        h('span', { class: 'adm-server-show', text: `Show ${count}` }),
        h('span', { class: 'adm-server-hide', text: 'Hide' }),
        icon('chevron', 14, 'adm-more-caret'))),
    ...serverGroups.map((g) => groupCard(g, groups.get(g.id))));
    return section;
  }

  function pendingText(ids) {
    const phrase = servicesPhrase(ids, serviceLabel, data.running || []);
    const subject = `${phrase[0].toUpperCase()}${phrase.slice(1)}`;
    return `${subject} ${ids.length === 1 || phrase === 'every service' ? 'is' : 'are'} still running without them.`;
  }

  /** Which services a group's changes restart, briefly. */
  function restartsText(services) {
    const running = data.running || [];
    if (running.length && running.every((id) => services.includes(id))) return 'Restarts every service';
    if (services.length > 3) return 'Restarts several services';
    return `Restarts ${listText(services.map(serviceLabel))}`;
  }

  function groupCard(group, items) {
    const services = [...new Set(items.flatMap((s) => s.restart || []))];
    const basic = items.filter((s) => !s.advanced);
    const advanced = items.filter((s) => s.advanced);
    const showAll = ui.advanced.has(group.id) || advanced.some((s) => s.key === ui.open || s.source === 'console');
    const kids = [];
    if (group.editable) {
      kids.push(h('div', { class: 'setting-lines' }, ...basic.map(settingLine)));
      if (advanced.length) {
        const more = h('details', { class: 'adm-more', open: showAll,
          on: { toggle: () => { if (more.open) ui.advanced.add(group.id); else ui.advanced.delete(group.id); } } },
        h('summary', {}, icon('chevron', 14, 'adm-more-caret'), `More settings (${advanced.length})`),
        h('div', { class: 'setting-lines' }, ...advanced.map(settingLine)));
        kids.push(more);
      }
    } else {
      kids.push(h('div', { class: 'adm-server-lines' }, ...items.map(serverLine)));
    }
    return h('section', { class: `card adm-group${group.editable ? '' : ' is-server'}`, id: `adm-group-${group.id}`, 'data-group': group.id },
      h('header', { class: 'adm-group-head' },
        h('span', { class: 'adm-group-ic', 'aria-hidden': 'true' }, icon(group.icon || 'sliders', 17)),
        h('div', {}, h('h3', { text: group.label }), h('p', { text: group.blurb })),
        group.editable && services.length && data.control.available
          ? h('span', { class: 'adm-group-restarts', text: restartsText(services) }) : null),
      h('div', { class: 'card-body' }, ...kids));
  }

  function historyCard() {
    if (!data.history?.length) return null;
    const settingsByKey = new Map(data.settings.map((s) => [s.key, s]));
    const show2 = (key, value) => {
      const s = settingsByKey.get(key);
      if (value === null || value === undefined) return 'nothing';
      if (s?.type === 'enum') return (s.options || []).find((o) => o.value === value)?.label || value;
      if (s?.type === 'bool') return value === 'true' ? 'on' : 'off';
      return `${value}${s?.unit ? ` ${s.unit}` : ''}`;
    };
    const verb = { set: 'set', changed: 'changed', replaced: 'replaced', removed: 'removed' };
    const rows = data.history.slice(0, 12).flatMap((entry) => entry.changes.map((change) => h('li', { class: 'adm-history-item' },
      h('span', { class: 'adm-history-what' },
        h('strong', { text: change.label }), ' ',
        change.action === 'changed' ? `changed from ${show2(change.key, change.from)} to ${show2(change.key, change.to)}`
          : change.action === 'set' && change.to !== undefined ? `set to ${show2(change.key, change.to)}`
            : verb[change.action] || change.action),
      h('span', { class: 'adm-history-who', text: [entry.by, fmtSince(entry.at)].filter(Boolean).join(' · ') }))));
    const c = card('Recent changes', {}, h('ul', { class: 'adm-history', role: 'list' }, ...rows));
    c.classList.add('adm-history-card');
    return c;
  }

  /* the whole page ------------------------------------------------------- */
  const search = h('input', { type: 'search', class: 'adm-search', placeholder: 'Search settings', 'aria-label': 'Search settings', value: ui.search });
  search.addEventListener('input', debounce(() => { ui.search = search.value.trim().toLowerCase(); applySearch(); }, 120));

  function applySearch() {
    const term = ui.search;
    let shown = 0;
    for (const line of body.querySelectorAll('[data-search]')) {
      const visible = !term || line.dataset.search.includes(term);
      line.hidden = !visible;
      if (visible) shown += 1;
    }
    for (const section of body.querySelectorAll('.adm-group')) {
      const any = [...section.querySelectorAll('[data-search]')].some((line) => !line.hidden);
      section.hidden = !any;
      // A match among the advanced or server settings opens them.
      if (term && any) section.querySelectorAll('details.adm-more').forEach((d) => { if ([...d.querySelectorAll('[data-search]')].some((l) => !l.hidden)) d.open = true; });
      const fold = section.closest('details.adm-server');
      if (term && any && fold) fold.open = true;
    }
    const none = body.querySelector('.adm-search-empty');
    if (none) none.hidden = shown > 0;
  }

  function paint() {
    const groups = byGroup();
    const editableGroups = data.groups.filter((g) => g.editable && groups.get(g.id)?.length);
    const serverGroups = data.groups.filter((g) => !g.editable && groups.get(g.id)?.length);
    const pendingIds = [...new Set(data.settings.flatMap((s) => s.pending || []))]
      .filter((id) => (data.running || []).includes(id));

    const notices = [];
    if (!data.control.available) {
      notices.push(h('div', { class: 'notice' }, icon('lock', 15),
        h('div', {}, h('strong', { text: 'Settings are read-only here' }), h('div', { class: 'field-hint', text: data.control.message }))));
    }
    if (data.settingsError) notices.push(errorBox(data.settingsError, 'Saving a setting starts a fresh file.'));

    const pendingBar = pendingIds.length ? h('div', { class: 'adm-pending', role: 'status' },
      h('span', { class: 'adm-pending-dot', 'aria-hidden': 'true' }),
      h('div', { class: 'adm-pending-text' },
        h('strong', { text: 'Restart to apply your changes' }),
        h('span', { text: pendingText(pendingIds) })),
      h('button', { type: 'button', class: 'btn btn-primary btn-sm', on: { click: () => restartPending(pendingIds) } }, icon('refresh', 14), 'Restart now')) : null;

    const navLink = (g) => h('a', { href: `#/admin/settings?group=${g.id}`, 'data-group': g.id, on: { click: (event) => {
      event.preventDefault();
      jumpTo(g.id);
    } } }, icon(g.icon || 'sliders', 14), h('span', { text: g.label }),
    groups.get(g.id).some((s) => s.source === 'console') ? h('span', { class: 'adm-nav-dot', title: 'Has settings saved here' }) : null);
    const nav = h('nav', { class: 'adm-settings-nav', 'aria-label': 'Setting groups' },
      ...editableGroups.map(navLink),
      serverGroups.length ? h('span', { class: 'adm-nav-heading', text: 'Installed with the server' }) : null,
      ...serverGroups.map(navLink));

    const main = h('div', { class: 'adm-settings-main' },
      h('div', { class: 'adm-search-row' }, icon('search', 15), search),
      h('p', { class: 'adm-search-empty', hidden: true, text: 'No setting matches that.' }),
      ...editableGroups.map((g) => groupCard(g, groups.get(g.id))),
      serverSection(serverGroups, groups),
      historyCard());

    body.replaceChildren(...notices, pendingBar || '', h('div', { class: 'adm-settings' }, nav, main));
    applySearch();
    observeGroups(nav);
  }

  function jumpTo(id) {
    const target = body.querySelector(`#adm-group-${id}`);
    if (!target) return;
    const fold = target.closest('details.adm-server');
    if (fold && !fold.open) fold.open = true;
    target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    target.classList.remove('is-flash');
    void target.offsetWidth;
    target.classList.add('is-flash');
    history.replaceState(null, '', `#/admin/settings?group=${id}`);
  }

  let observer = null;
  function observeGroups(nav) {
    observer?.disconnect();
    if (!('IntersectionObserver' in window)) return;
    observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const id = entry.target.dataset.group;
        for (const a of nav.querySelectorAll('a')) a.classList.toggle('current', a.dataset.group === id);
      }
    }, { rootMargin: '-25% 0px -65% 0px' });
    for (const section of body.querySelectorAll('.adm-group')) observer.observe(section);
  }

  paint();
  if (focusGroup) requestAnimationFrame(() => jumpTo(focusGroup));
}

/* -- Robots ------------------------------------------------------------------ */

async function renderAdminRobots() {
  const container = adminPage('#/admin/robots', 'Robots', 'Every Jibo on this server, with its loop and owner.');
  show(container);
  if (!(await adminGate(container))) return;
  const body = h('div', { class: 'adm-robots' }, loading(4));
  container.append(body);

  const res = await api('GET', '/api/admin/fleet');
  if (!res.ok) { body.replaceChildren(errorBox('Could not list the robots.', res.data.error)); return; }
  const { robots, loops } = res.data;
  const state = { search: '', filter: 'all' };

  const online = robots.filter((r) => r.online === true).length;
  const known = robots.some((r) => r.online !== null);
  const statusPill = (r) => (r.online === true
    ? h('span', { class: 'pill pill-ok' }, h('span', { class: 'dot dot-live' }), 'Online')
    : r.online === false
      ? h('span', { class: 'pill', title: r.lastSeen ? `Last seen ${fmtDate(r.lastSeen)}` : 'Not seen yet' },
        r.lastSeen ? `Last seen ${fmtSince(r.lastSeen)}` : 'Not seen yet')
      : h('span', { class: 'pill pill-quiet', text: 'Unknown' }));

  const robotRow = (r) => h('li', { class: 'adm-row', 'data-search': `${r.name || ''} ${r.friendlyId} ${r.owner?.name || ''} ${r.owner?.email || ''}`.toLowerCase(),
    'data-online': String(r.online) },
  robotAvatar(r.color, 'sm'),
  h('div', { class: 'adm-row-main' },
    h('strong', { text: r.name || r.friendlyId }),
    h('span', { class: 'adm-row-sub' },
      r.name ? h('code', { text: r.friendlyId }) : null,
      r.owner ? `${r.name ? ' · ' : ''}${r.owner.name || r.owner.email}` : (r.name ? '' : 'No loop'),
      r.loopId ? ` · ${r.people} ${r.people === 1 ? 'person' : 'people'}` : '')),
  statusPill(r),
  h('button', { type: 'button', class: 'btn btn-sm btn-quiet btn-danger-quiet', on: { click: () => removalDialog({ robot: r.friendlyId }) } },
    icon('trash', 14), h('span', { class: 'hide-sm', text: 'Remove…' })));

  const loopRow = (l) => h('li', { class: 'adm-row', 'data-search': `${l.name || ''} ${l.robot || ''} ${l.owner?.name || ''} ${l.owner?.email || ''}`.toLowerCase() },
    robotAvatar(l.color, 'sm'),
    h('div', { class: 'adm-row-main' },
      h('strong', { text: l.name || 'Unnamed loop' }),
      h('span', { class: 'adm-row-sub' },
        l.owner ? (l.owner.name || l.owner.email) : 'No owner',
        ` · ${l.people} ${l.people === 1 ? 'person' : 'people'}`,
        l.invited ? ` · ${l.invited} invited` : '',
        l.robot ? '' : ' · no robot')),
    l.suspended ? h('span', { class: 'pill pill-warn', text: 'Suspended' }) : h('span', {}),
    h('button', { type: 'button', class: 'btn btn-sm btn-quiet btn-danger-quiet', on: { click: () => removalDialog({ loopId: l.id }) } },
      icon('trash', 14), h('span', { class: 'hide-sm', text: 'Remove…' })));

  const robotList = h('ul', { class: 'adm-list', role: 'list' }, ...robots.map(robotRow));
  const noMatch = h('p', { class: 'adm-search-empty', hidden: true, text: 'No robot matches that.' });
  const search = h('input', { type: 'search', class: 'adm-search', placeholder: 'Search by name, owner or email', 'aria-label': 'Search robots' });
  const chip = (value, label) => h('button', { type: 'button', class: `chip-btn${state.filter === value ? ' is-active' : ''}`, 'data-filter': value,
    on: { click: () => { state.filter = value; apply(); } } }, label);
  const chips = known ? h('div', { class: 'chip-row' }, chip('all', `All ${robots.length}`), chip('online', `Online ${online}`), chip('offline', `Offline ${robots.length - online}`)) : null;
  const apply = () => {
    state.search = search.value.trim().toLowerCase();
    let shown = 0;
    for (const row of robotList.children) {
      const matches = !state.search || row.dataset.search.includes(state.search);
      const filterOk = state.filter === 'all' || (state.filter === 'online' ? row.dataset.online === 'true' : row.dataset.online !== 'true');
      row.hidden = !(matches && filterOk);
      if (!row.hidden) shown += 1;
    }
    noMatch.hidden = shown > 0 || !robots.length;
    chips?.querySelectorAll('.chip-btn').forEach((b) => b.classList.toggle('is-active', b.dataset.filter === state.filter));
  };
  search.addEventListener('input', debounce(apply, 100));

  const robotsCard = card('Every robot', { sub: known ? `${online} of ${robots.length} online` : `${robots.length}` },
    robots.length ? h('div', { class: 'adm-toolbar' }, search, chips) : null,
    robots.length ? robotList : empty('No robots yet', 'A robot appears here once someone sets it up or migrates it to this server.', 'robot'),
    noMatch);
  robotsCard.classList.add('adm-list-card');

  const orphans = loops.filter((l) => !l.robot);
  // Most loops are their robot's; the list matters for removing one loop, or one left without a robot.
  const loopsCard = h('details', { class: 'card adm-disclosure adm-list-card', open: orphans.length > 0 },
    h('summary', {}, h('span', { class: 'adm-group-ic', 'aria-hidden': 'true' }, icon('home', 16)),
      h('div', {}, h('strong', { text: `Loops (${loops.length})` }),
        h('span', { text: orphans.length ? `${orphans.length} without a robot` : 'The household around each Jibo. Remove one here without removing its robot.' })),
      icon('chevron', 15, 'adm-more-caret')),
    h('div', { class: 'card-body' },
      loops.length ? h('ul', { class: 'adm-list', role: 'list' }, ...loops.map(loopRow)) : empty('No loops', 'Setting up a robot creates its loop.', 'users')));

  /* manual adoption, for the rare robot that predates everything else */
  const result = h('pre', { class: 'json', hidden: true });
  const adoptForm = h('form', { class: 'adm-adopt' },
    h('p', { class: 'field-hint' },
      'For a robot that finished setup with the original cloud years ago and can’t run the migration command. '
      + 'This creates its credentials and a loop, and shows what to write to the robot.'),
    h('div', { class: 'grid2' },
      field('Robot name', h('input', { name: 'friendlyId', placeholder: 'castle-cylinder-fig-quilt', required: true, autocapitalize: 'off', spellcheck: 'false' }),
        'The four-word name the robot reports.'),
      field('Owner email', h('input', { name: 'ownerEmail', type: 'email', placeholder: 'Optional' }),
        'Someone with an account here. Leave it empty to adopt it without an owner.')),
    h('label', { class: 'check-row' }, h('input', { name: 'transferExisting', type: 'checkbox' }),
      h('span', {}, 'Move it here even if another account on this server owns it')),
    h('div', { class: 'row' }, h('button', { type: 'submit', class: 'btn btn-primary' }, 'Adopt robot')),
    result);
  onSubmit(adoptForm, async (e) => {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(adoptForm));
    const out = await api('POST', '/api/admin/adopt', {
      friendlyId: fd.friendlyId, ownerEmail: fd.ownerEmail || undefined, transferExisting: fd.transferExisting === 'on',
    });
    result.hidden = false;
    if (!out.ok) { result.textContent = `Error: ${out.data.error}`; return; }
    result.textContent = ['# Write this to /var/jibo/credentials.json on the robot:',
      JSON.stringify(out.data.credentialsJson, null, 2), '', '# Then point the robot at this server:',
      ...(out.data.instructions || [])].join('\n');
    notify('Robot adopted');
  });
  const adopt = h('details', { class: 'card adm-disclosure' },
    h('summary', {}, h('span', { class: 'adm-group-ic', 'aria-hidden': 'true' }, icon('plus', 16)),
      h('div', {}, h('strong', { text: 'Adopt a robot by hand' }), h('span', { text: 'Only for a robot that can’t be migrated with the repoint command.' })),
      icon('chevron', 15, 'adm-more-caret')),
    h('div', { class: 'card-body' }, adoptForm));

  body.replaceChildren(robotsCard, orphans.length ? h('div', { class: 'notice notice-warn' }, icon('alert', 15),
    h('div', {}, `${orphans.length} ${orphans.length === 1 ? 'loop has' : 'loops have'} no robot. Remove ${orphans.length === 1 ? 'it' : 'them'} if nobody needs ${orphans.length === 1 ? 'it' : 'them'}.`)) : '',
  loopsCard, adopt);
  apply();
}

/**
 * Remove a robot (and its loops) or a single loop from every service. Shows the
 * server's own preview of what would go, and requires the robot's name or the
 * loop id to be typed before anything is removed.
 */
function removalDialog(target) {
  const title = h('h3', { text: target.robot ? `Remove ${target.robot}?` : 'Remove this loop?' });
  const content = h('div', { class: 'removal-body' }, loading(4));
  const close = () => { dialog.close(); dialog.remove(); };
  const cancel = h('button', { class: 'btn', type: 'button', on: { click: close } }, 'Cancel');
  const confirmInput = h('input', { autocomplete: 'off', spellcheck: 'false', autocapitalize: 'off', disabled: true });
  const remove = h('button', { class: 'btn btn-danger', type: 'button', disabled: true }, icon('trash', 15), 'Remove');
  const confirmField = field('', confirmInput);
  confirmField.hidden = true;
  const dialog = h('dialog', { class: 'modal removal-modal' }, title, content, confirmField,
    h('div', { class: 'row row-end', style: 'margin-top:1.25rem' }, cancel, remove));
  dialog.addEventListener('cancel', (event) => { event.preventDefault(); close(); });
  document.body.append(dialog);
  dialog.showModal();

  const countsText = (removed) => Object.entries(removed || {})
    .map(([name, count]) => `${count} ${name.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase()}`).join(', ');
  const serviceRows = (services) => (services || []).map((entry) => {
    if (entry.skipped || entry.error) {
      return row(prettyLabel(entry.service), h('span', { class: 'pill pill-warn' }, entry.skipped ? `skipped: ${entry.skipped}` : entry.error));
    }
    const parts = [...(entry.stores || []).map((store) => `${store.name} (${countsText(store.removed)})`),
      ...(entry.directories || []).map((label) => `folder ${label}`)];
    return row(prettyLabel(entry.service), parts.length ? parts.join('; ') : 'nothing stored');
  });

  void (async () => {
    const preview = await apiRaw('POST', '/api/admin/removal/preview', target);
    if (!preview.ok) { content.replaceChildren(errorBox('Could not prepare the removal.', preview.data.error)); return; }
    const plan = preview.data;
    const account = plan.account;
    content.replaceChildren(
      h('p', { class: 'field-hint' }, plan.kind === 'robot'
        ? 'This removes the robot, every loop it belongs to, and everything the server keeps for them. The owners’ own accounts stay. Afterwards the server has never heard of this robot, so it can be set up again from scratch.'
        : 'This removes the loop and everything the server keeps for it. Its robot, if any, stays.'),
      h('div', { class: 'kv-list' },
        account.robot ? row('Robot account', h('code', { text: account.robot.friendlyId })) : null,
        ...account.loops.map((loop) => row('Loop', `${loop.name || 'Unnamed'} · ${loop.ownerEmail || 'no owner'} · ${loop.members} member${loop.members === 1 ? '' : 's'}`)),
        Object.keys(account.removed).length || account.memberships
          ? row('Other account records', [countsText(account.removed), account.memberships ? `${account.memberships} membership(s) in other loops` : ''].filter(Boolean).join(', '))
          : null,
        ...serviceRows(plan.services)),
      h('p', { class: 'field-hint' }, 'Each service saves a backup under removal-backups/ before it removes anything.'));
    confirmField.querySelector('.field-label').replaceChildren('Type ', h('code', { text: plan.confirmWith }), ' to confirm');
    confirmField.hidden = false;
    confirmInput.disabled = false;
    confirmInput.focus();
    confirmInput.addEventListener('input', () => {
      remove.disabled = confirmInput.value.trim().toLowerCase() !== plan.confirmWith.toLowerCase();
    });
    remove.addEventListener('click', async () => {
      remove.disabled = true;
      cancel.disabled = true;
      confirmInput.disabled = true;
      const done = await apiRaw('POST', '/api/admin/removal', { ...target, confirm: confirmInput.value.trim() });
      cancel.disabled = false;
      if (!done.ok) {
        content.prepend(errorBox('The removal did not complete.', done.data.error));
        confirmInput.disabled = false;
        return;
      }
      content.replaceChildren(
        h('div', { class: 'notice notice-ok' }, icon('check', 16), h('div', {}, `${plan.label} was removed from this server.`)),
        h('div', { class: 'kv-list' },
          row('Account backup', h('code', { text: done.data.account.backupDir })),
          ...(done.data.services || []).filter((entry) => entry.backupDir)
            .map((entry) => row(`${prettyLabel(entry.service)} backup`, h('code', { text: entry.backupDir })))));
      confirmField.hidden = true;
      remove.hidden = true;
      cancel.replaceChildren('Close');
      cancel.addEventListener('click', () => renderAdminRobots(), { once: true });
      notify(`${plan.label} removed`);
    });
  })();
}

/* -- People ------------------------------------------------------------------ */

async function renderAdminPeople() {
  const container = adminPage('#/admin/people', 'People',
    'Everyone with an account on this server, and who can manage it.');
  show(container);
  if (!(await adminGate(container))) return;
  const body = h('div', { class: 'adm-people' }, loading(4));
  container.append(body);

  const res = await api('GET', '/api/admin/admins');
  if (!res.ok) { body.replaceChildren(errorBox('Could not list accounts.', res.data.error)); return; }
  const { accounts, adminCount } = res.data;
  const state = { filter: 'all' };

  const personRow2 = (a) => {
    const isSelf = me && a.id === me.id;
    const name = [a.firstName, a.lastName].filter(Boolean).join(' ');
    const actions = [];
    if (a.isAdmin && !isSelf) {
      actions.push(h('button', { type: 'button', class: 'btn btn-sm btn-quiet btn-danger-quiet', on: { click: () => setAdmin(a, false) } }, 'Remove administrator'));
    } else if (!a.isAdmin) {
      actions.push(h('button', { type: 'button', class: 'btn btn-sm', on: { click: () => setAdmin(a, true) } }, 'Make administrator'));
    }
    return h('li', { class: 'adm-row', 'data-search': `${name} ${a.email}`.toLowerCase(), 'data-admin': String(a.isAdmin), 'data-active': String(a.isActive) },
      personAvatar(name || a.email, { key: a.id, size: 'sm' }),
      h('div', { class: 'adm-row-main' },
        h('strong', {}, name || a.email,
          isSelf ? h('span', { class: 'pill', text: 'You' }) : null),
        h('span', { class: 'adm-row-sub' },
          name ? a.email : null,
          `${name ? ' · ' : ''}${a.loops ? `in ${a.loops} loop${a.loops === 1 ? '' : 's'}` : 'in no loop'}`,
          a.created ? ` · joined ${fmtDay(a.created)}` : '')),
      h('div', { class: 'adm-row-tags' },
        a.isAdmin ? h('span', { class: 'pill pill-accent' }, icon('lock', 11), 'Administrator') : null,
        a.isActive ? null : h('span', { class: 'pill pill-warn', text: 'Not confirmed' })),
      h('div', { class: 'adm-row-actions' }, ...actions));
  };

  const list = h('ul', { class: 'adm-list', role: 'list' }, ...accounts.map(personRow2));
  const noMatch = h('p', { class: 'adm-search-empty', hidden: true, text: 'Nobody matches that.' });
  const search = h('input', { type: 'search', class: 'adm-search', placeholder: 'Search by name or email', 'aria-label': 'Search people' });
  const pending = accounts.filter((a) => !a.isActive).length;
  const chip = (value, label) => h('button', { type: 'button', class: `chip-btn${state.filter === value ? ' is-active' : ''}`, 'data-filter': value,
    on: { click: () => { state.filter = value; apply(); } } }, label);
  const chips = h('div', { class: 'chip-row' },
    chip('all', `Everyone ${accounts.length}`), chip('admins', `Administrators ${adminCount}`),
    pending ? chip('pending', `Not confirmed ${pending}`) : null);
  const apply = () => {
    const term = search.value.trim().toLowerCase();
    let shown = 0;
    for (const item of list.children) {
      const ok = (!term || item.dataset.search.includes(term))
        && (state.filter === 'all' || (state.filter === 'admins' ? item.dataset.admin === 'true' : item.dataset.active === 'false'));
      item.hidden = !ok;
      if (ok) shown += 1;
    }
    noMatch.hidden = shown > 0;
    chips.querySelectorAll('.chip-btn').forEach((b) => b.classList.toggle('is-active', b.dataset.filter === state.filter));
  };
  search.addEventListener('input', debounce(apply, 100));

  const parts = [];
  if (adminCount === 1) {
    parts.push(h('div', { class: 'notice notice-warn' }, icon('alert', 15),
      h('div', {}, h('strong', { text: 'You’re the only administrator' }),
        h('div', { class: 'field-hint', text: 'If you lose access to your account, nobody can manage this server from here. Make someone you trust an administrator too.' }))));
  }
  const peopleCard = card('Accounts', { sub: `${accounts.length} ${accounts.length === 1 ? 'person' : 'people'} · ${adminCount} administrator${adminCount === 1 ? '' : 's'}` },
    h('div', { class: 'adm-toolbar' }, search, chips), list, noMatch);
  peopleCard.classList.add('adm-list-card');
  parts.push(peopleCard);

  parts.push(h('details', { class: 'card adm-disclosure' },
    h('summary', {}, h('span', { class: 'adm-group-ic', 'aria-hidden': 'true' }, icon('lock', 16)),
      h('div', {}, h('strong', { text: 'If nobody can sign in' }), h('span', { text: 'Grant or remove access from the server’s command line.' })),
      icon('chevron', 15, 'adm-more-caret')),
    h('div', { class: 'card-body' },
      h('p', { class: 'field-hint', text: 'Run these in Phoenix’s folder on the server:' }),
      ...['node scripts/portal-grant-admin.mjs --list',
        'node scripts/portal-grant-admin.mjs --email you@example.com',
        'node scripts/portal-grant-admin.mjs --email you@example.com --revoke',
      ].map((cmd) => h('div', { class: 'restart-cmd' }, h('span', { class: 'prompt' }, '$'), h('code', { text: cmd }), copyButton(() => cmd))))));

  body.replaceChildren(...parts);
  apply();

  async function setAdmin(account, grant) {
    const label = [account.firstName, account.lastName].filter(Boolean).join(' ') || account.email;
    const yes = await confirmDialog({
      title: grant ? `Make ${label} an administrator?` : `Remove ${label} as an administrator?`,
      body: grant
        ? 'They’ll be able to change this server’s settings, restart its services, remove robots and loops, and make others administrators.'
        : 'They lose access to these pages straight away; the check happens on every request.',
      confirmLabel: grant ? 'Make administrator' : 'Remove',
      danger: !grant,
    });
    if (!yes) return;
    const out = await api('POST', '/api/admin/admins', { email: account.email, grant });
    if (!out.ok) { notify(out.data.error || 'Could not change access', 'error'); return; }
    notify(grant ? `${label} is now an administrator` : `${label} is no longer an administrator`);
    await renderAdminPeople();
  }
}

/* ==========================================================================
   Auth screen
   ========================================================================== */

let authNotice = '';
let pendingActivationEmail = '';
let authResendUntil = 0;
let publicMailAction = null;
const INVITATION_STORAGE_KEY = 'phoenix.pendingInvitation';
let pendingInvitation = (() => {
  try {
    const saved = JSON.parse(sessionStorage.getItem(INVITATION_STORAGE_KEY));
    return saved && typeof saved.email === 'string' && typeof saved.loopId === 'string' ? saved : null;
  } catch { return null; }
})();

function savePendingInvitation() {
  try { sessionStorage.setItem(INVITATION_STORAGE_KEY, JSON.stringify(pendingInvitation)); } catch { /* optional browser storage */ }
}

function clearPendingInvitation() {
  pendingInvitation = null;
  try { sessionStorage.removeItem(INVITATION_STORAGE_KEY); } catch { /* optional browser storage */ }
}

function clearPublicMailUrl() {
  // Keep a user-selected hash route, but remove the bearer code from history
  // and from anything they might copy from the address bar.
  // The console lives at /app; `/` is the public landing page, so a reload
  // after following a mail link must not drop the user out of the console.
  history.replaceState(null, '', `/app${location.hash || ''}`);
}

async function consumePublicMailAction() {
  const params = new URLSearchParams(location.search);
  const code = params.get('code') || '';
  if (['/invite', '/create', '/home'].includes(location.pathname)) {
    pendingInvitation = {
      email: params.get('email') || '',
      loopId: params.get('loopId') || '',
      signup: location.pathname === '/create' || params.get('signup') === '1',
    };
    savePendingInvitation();
    // Old invitations may contain a code. Never retain it in storage/history.
    history.replaceState(null, '', '/app#/loop');
    authNotice = `You have been invited to a Jibo loop. Sign in or create an account${pendingInvitation.email ? ` with ${pendingInvitation.email}` : ''} to review the invitation.`;
    return;
  }
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
  // Auth mode chooses these strings from branding below. A later generic
  // brand binding must not overwrite signup, recovery or invitation copy.
  for (const element of frag.querySelectorAll('#auth-title, #auth-sub')) element.removeAttribute('data-brand');
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

  let mode = publicMailAction?.type === 'reset' ? 'reset' : (pendingInvitation?.signup ? 'signup' : 'login');
  if (pendingInvitation?.email) email.value = pendingInvitation.email;
  // The sign-in and sign-up headings are the instance's to word (branding.json
  // `console.*`); these strings are only the fallback when it says nothing.
  const branded = (path, fallback) => {
    const value = pick(getBrandSync(), path);
    return typeof value === 'string' && value ? value : fallback;
  };
  const COPY = {
    login: {
      title: branded('console.signInTitle', 'Welcome back'),
      sub: pendingInvitation ? 'Sign in to the Phoenix console to review and accept your invitation.'
        : branded('console.signInBody', 'Sign in to your Phoenix console account.'),
      cta: 'Sign in',
    },
    signup: {
      title: branded('console.signUpTitle', 'Create an account'),
      sub: pendingInvitation ? 'Create your console account with the invited email, then verify it to join the loop.'
        : branded('console.signUpBody', 'This account lives on this server only.'),
      cta: 'Create account',
    },
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
    if (pendingInvitation) { pendingInvitation.signup = next === 'signup'; savePendingInvitation(); }
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
    resend.hidden = !(next === 'login' || next === 'signup');
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
  let resendTimer = null;
  const paintResend = () => {
    if (!resend.isConnected) { clearInterval(resendTimer); return; }
    const seconds = Math.max(0, Math.ceil((authResendUntil - Date.now()) / 1000));
    resend.disabled = seconds > 0;
    resend.textContent = seconds ? `Resend verification email in ${seconds}s` : 'Resend verification email';
    if (!seconds && resendTimer) { clearInterval(resendTimer); resendTimer = null; }
  };
  paintResend();
  if (authResendUntil > Date.now()) resendTimer = setInterval(paintResend, 1000);
  resend.addEventListener('click', async () => {
    const recipient = email.value.trim() || pendingActivationEmail;
    if (!recipient || !email.reportValidity()) {
      setMessage('Enter your email address first.', true);
      return;
    }
    resend.disabled = true;
    const res = await api('POST', '/api/signup/resend', { email: recipient });
    if (res.ok || res.status === 429) {
      authResendUntil = Date.now() + (Number(res.data.retryAfterSeconds) || 60) * 1000;
      if (!resendTimer) resendTimer = setInterval(paintResend, 1000);
    }
    paintResend();
    setMessage(res.ok ? 'If this address needs verification, an email will be sent when the resend limit allows it. Check your inbox and spam folder.'
      : (res.data.error || 'Could not resend the confirmation email.'), !res.ok);
  });

  onSubmit(form, async (e) => {
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
      authNotice = res.data.emailSent
        ? 'Check your inbox and follow the verification link before signing in.'
        : 'Your account was created, but the verification email could not be sent. Request another email in a minute.';
      authResendUntil = Date.now() + 60000;
      paintResend();
      if (!resendTimer) resendTimer = setInterval(paintResend, 1000);
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
  const closeMenu = () => {
    if (!menu || menu.hidden) return;
    menu.hidden = true;
    chipBtn?.setAttribute('aria-expanded', 'false');
  };
  // Choosing an item (Account settings, Theme, …) is the end of the menu's job;
  // before this it stayed open over the page it had just navigated to.
  menu?.addEventListener('click', (e) => { if (e.target.closest('[role="menuitem"]')) closeMenu(); });
  document.addEventListener('click', (e) => {
    if (menu && !menu.hidden && !menu.contains(e.target) && !chipBtn?.contains(e.target)) {
      menu.hidden = true;
      chipBtn?.setAttribute('aria-expanded', 'false');
    }
  });
  addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    closeMenu();
    closeNav();
  });

  document.getElementById('logout')?.addEventListener('click', async () => {
    clearPrivateView();
    await loopKeys.forgetAll();
    // A sign-out is a reasonable expectation of privacy on a shared device.
    // Remove the browser's subscription before invalidating the session.
    try { await disableBrowserPush(apiRaw); } catch { /* no subscription or offline */ }
    await apiRaw('POST', '/api/logout');
    keyRevocationChannel?.postMessage({ type: 'logout', accountId: me?.id });
    me = null;
    badgesPainted = false;
    // Changing the hash routes by itself; only an unchanged hash needs a nudge.
    if (location.hash && location.hash !== '#/') location.hash = '#/';
    else route();
  });
}

function paintNav(hash) {
  for (const a of document.querySelectorAll('#nav .nav-item')) {
    const route = a.dataset.route;
    // Every #/admin/* sub-route keeps the one Administration item highlighted;
    // the sub-navigation inside the page says which of them you are on.
    const active = route === hash
      || (route === '#/admin' && hash.startsWith('#/admin'))
      || (route === '#/home-assistant' && hash === '#/home-assistant-legacy');
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
   Home Assistant
   ========================================================================== */

// Home Assistant pairs directly with each Jibo on the owner's network: pairing
// starts on Jibo and finishes in Home Assistant. This page guides that and
// opens the right pages in the owner's own Home Assistant. It never receives a
// pairing key, certificate pin or Home Assistant address, so it cannot see
// whether a Jibo is paired and does not pretend to. Older cloud links, made
// with Phoenix 0.2, keep their own page.
const HA_REPO = 'https://github.com/Paskooter/phoenix-home-assistant';
const HA_DOCS = `${HA_REPO}/blob/main/docs`;
const HA_MY = 'https://my.home-assistant.io/redirect';
const HA_LINKS = Object.freeze({
  hacs: `${HA_MY}/hacs_repository/?owner=Paskooter&repository=phoenix-home-assistant&category=integration`,
  add: `${HA_MY}/config_flow_start/?domain=phoenix`,
  integration: `${HA_MY}/integration/?domain=phoenix`,
  expose: `${HA_MY}/voice_assistants/`,
  areas: `${HA_MY}/areas/`,
  install: `${HA_DOCS}/installation.md#hacs-or-manual-installation`,
  remove: `${HA_DOCS}/installation.md#disable-or-remove`,
  help: `${HA_DOCS}/troubleshooting.md`,
});
// The address the integration's setup form suggests; other servers replace it.
const HA_DEFAULT_SERVER = 'https://jibo.io';
const HA_CODE_LIFETIME_MS = 10 * 60 * 1000;
const HA_INSTALLATION_LIMIT = 4;

const HA_ERRORS = {
  select_robots: 'Choose at least one Jibo.',
  robot_not_owned: 'Only the owner of an active loop can link its Jibo.',
  robot_already_linked: 'That Jibo is already linked. Disconnect it first to link it again.',
  installation_limit: 'You’ve linked four Home Assistants, the most for one account. Disconnect one to add another.',
  invalid_name: 'Use a name of 1 to 80 characters.',
  forbidden: 'Only a Jibo’s owner can link him to Home Assistant.',
};
const haError = (result, fallback) => HA_ERRORS[result.data?.error] || result.data?.error || fallback;

// Only phrases Phoenix hands to Home Assistant, each one exercised against its
// built-in Assist agent. Anything else goes through “ask Home Assistant to…”.
const HA_PHRASES = [
  ['Lights', ['Turn on the kitchen lights', 'Set the bedroom light brightness to fifty percent', 'Set bedroom light to blue']],
  ['Switches', ['Turn off garden switch']],
  ['Scenes and scripts', ['Activate the dinner scene', 'Run relax script']],
  ['Anything else Assist understands', ['Ask Home Assistant to …']],
];

// A code is shown once and never written to browser storage. It is kept in
// this page's memory, for the account that asked for it, so stepping to
// another part of the console and back does not lose it; a reload does.
let haCodeMemory = null;

const haOut = (href, label, className = 'btn btn-sm') => h('a', {
  class: className, href, target: '_blank', rel: 'noopener noreferrer',
}, label, icon('external', 13));

/** Home Assistant's end of a link: a house with a signal, in the cool tone. */
const haTile = (size = 'md') => h('span', { class: `ha-tile ha-tile-${size}`, 'aria-hidden': 'true' }, icon('smartHome', 24));

/**
 * Jibo, the link and Home Assistant. The state is idle (not linked yet),
 * waiting, live or down; only a live link moves.
 */
function haBridge(robots, state, size = 'md') {
  const shown = robots.length ? robots.slice(0, 3) : [{}];
  return h('span', { class: `ha-bridge ha-bridge-${size} is-${state}`, 'aria-hidden': 'true' },
    h('span', { class: 'ha-bridge-robots' }, shown.map((robot) => robotAvatar(robot.avatarColor, size))),
    h('span', { class: 'ha-bridge-line' }),
    haTile(size));
}

const haRobotChip = (robot) => h('span', { class: 'ha-robot', title: robot.friendlyId },
  robotAvatar(robot.avatarColor, 'xs'), h('span', { text: robotName(robot) }));

/** "9:05" — minutes and seconds left. */
const fmtCountdown = (ms) => {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
};

/**
 * When a code runs out, on this browser's clock. The browser and the server can
 * disagree about the time; a code always lasts ten minutes, so an impossible
 * remainder falls back to that.
 */
function haDeadline(expiresAt) {
  const remaining = Number(expiresAt) - Date.now();
  return Date.now() + (remaining > 0 && remaining <= HA_CODE_LIFETIME_MS + 5000 ? remaining : HA_CODE_LIFETIME_MS);
}

/** The countdown under a code: a draining bar and the time left. */
function haTimer(deadline) {
  const fill = h('span', { class: 'ha-timer-fill' });
  const left = h('b');
  const el = h('div', { class: 'ha-timer' },
    h('div', { class: 'ha-timer-track', 'aria-hidden': 'true' }, fill),
    h('div', { class: 'ha-timer-text' },
      h('span', { role: 'timer' }, 'Expires in ', left),
      h('span', {}, 'Works once')));
  const update = () => {
    const remaining = deadline - Date.now();
    left.textContent = fmtCountdown(remaining);
    fill.style.transform = `scaleX(${Math.min(1, Math.max(0, remaining / HA_CODE_LIFETIME_MS))})`;
    el.classList.toggle('is-low', remaining <= 60000);
  };
  update();
  return { el, update };
}

/** The connection code, its groups set apart so it is easy to read aloud or type. */
const haCodeText = (code) => h('code', { class: 'ha-connection-code' },
  code.split('-').flatMap((group, i) => (i ? [h('span', { class: 'ha-code-sep' }, '-'), h('wbr'), group] : [group])));

function haInstallationFacts(installation) {
  const connected = installation.connected === true;
  const seen = Number(installation.lastConnectedAt) || 0;
  const created = Number(installation.createdAt) || 0;
  // Home Assistant needs a moment to connect after it is linked. That is not
  // yet a problem worth a warning.
  const connecting = !connected && !seen && created > 0 && Date.now() - created < 60000;
  const meta = [
    connected ? (installation.haVersion ? `Home Assistant ${installation.haVersion}` : 'Home Assistant')
      : connecting ? '' : seen ? `Last connected ${fmtSince(seen)}` : 'Hasn’t connected yet',
    connecting ? 'Linked just now' : created ? `Linked ${fmtAgo(created)}` : '',
  ].filter(Boolean);
  return { connected, connecting, seen, meta, state: connected ? 'live' : connecting ? 'waiting' : 'down' };
}

/** One linked Home Assistant: whether it is connected, which Jibos use it, and its actions. */
function haInstallationCard(installation, robotFor, onDisconnect, onAnnouncements) {
  const facts = haInstallationFacts(installation);
  const robots = (installation.robots || []).map(robotFor);
  const name = meaningfulText(installation.name) || 'Home Assistant';
  const status = facts.connected
    ? h('span', { class: 'pill pill-ok' }, h('span', { class: 'dot dot-live' }), 'Connected')
    : facts.connecting
      ? h('span', { class: 'pill' }, h('span', { class: 'spinner' }), 'Connecting')
      : h('span', { class: 'pill pill-warn' }, 'Not connected');
  const announcements = toggle('announcements', installation.announcementsEnabled === true,
    'Allow Home Assistant announcements',
    'Home Assistant can speak through these Jibos while they’re idle, using Jibo’s current volume. Set quiet hours in Home Assistant. Off until you choose to allow it.');
  announcements.querySelector('input').addEventListener('change', async (event) => {
    const input = event.target;
    const enabled = input.checked;
    input.disabled = true;
    const saved = await onAnnouncements(installation, enabled);
    if (!saved) input.checked = installation.announcementsEnabled === true;
    input.disabled = false;
  });
  return h('section', { class: `card ha-install is-${facts.state}` },
    h('div', { class: 'ha-install-head' },
      haBridge(robots, facts.state),
      h('div', { class: 'ha-install-title' },
        h('h3', { text: name }),
        h('span', { class: 'ha-install-meta' }, facts.meta.map((fact) => h('span', { text: fact })))),
      h('div', { class: 'ha-install-status' }, status)),
    h('div', { class: 'card-body ha-install-body' },
      h('div', {},
        h('span', { class: 'ha-label' }, robots.length === 1 ? 'Linked Jibo' : 'Linked Jibos'),
        h('div', { class: 'ha-robots' }, robots.map(haRobotChip))),
      announcements,
      facts.state === 'down'
        ? h('div', { class: 'notice notice-warn' }, icon('alert', 16), h('div', {}, facts.seen
          ? 'Jibo can’t reach this Home Assistant right now. Check that it’s running and online. It reconnects by itself, usually within a minute.'
          : 'Home Assistant hasn’t connected yet. Check that it can reach this server, then reload Phoenix in Home Assistant.'))
        : null),
    h('div', { class: 'card-foot ha-install-foot' },
      facts.connected ? haOut(HA_LINKS.expose, 'Choose devices') : haOut(HA_LINKS.integration, 'Open in Home Assistant'),
      h('button', { class: 'btn btn-sm btn-quiet ha-disconnect', type: 'button', on: { click: () => onDisconnect(installation) } },
        'Disconnect')));
}

/** A redraw only when something a person can see has changed. */
function haInstallationKey(installation, robotFor) {
  const facts = haInstallationFacts(installation);
  return JSON.stringify([installation.name, facts.meta, facts.state, installation.announcementsEnabled === true,
    (installation.robots || []).map((id) => { const robot = robotFor(id); return [robotName(robot), robot.avatarColor]; })]);
}

/** One numbered step. The number is drawn, so the step is also named for screen readers. */
const haStep = (n, state, title, ...body) => h('li', { class: `ha-step is-${state}`, 'aria-current': state === 'active' ? 'step' : null },
  h('span', { class: 'ha-step-mark', 'aria-hidden': 'true' }, state === 'done' ? icon('check', 14) : String(n)),
  h('div', { class: 'ha-step-title' },
    h('span', { class: 'sr-only' }, state === 'done' ? `Step ${n}, done: ` : `Step ${n}: `), title),
  h('div', { class: 'ha-step-body' }, ...body));

function haSayCard() {
  return h('section', { class: 'card say-card ha-say' },
    h('div', { class: 'card-body' },
      h('h3', {}, 'Say “Hey Jibo”, then…'),
      ...HA_PHRASES.map(([label, phrases]) => h('div', { class: 'ha-say-group' },
        h('h4', { text: label }),
        h('ul', { class: 'ha-say-list' }, phrases.map((phrase) => h('li', { text: phrase }))))),
      h('p', { class: 'field-hint' }, 'Use the names, aliases and areas your devices have in Home Assistant.')));
}

const haNote = (iconName, title, text) => h('li', { class: 'ha-note' },
  h('span', { class: 'ha-note-ic' }, icon(iconName, 15)),
  h('div', {}, h('b', { text: title }), text));

function haNotesCard() {
  return card('Good to know', {},
    h('ul', { class: 'ha-notes' },
      haNote('lock', 'The older server relay', 'This older connection sends Home Assistant commands through Phoenix. Update to direct pairing to use the local connection.'),
      haNote('eye', 'You choose what Jibo can reach', 'He can use only what you expose to Assist. Expose scripts with care.'),
      haNote('message', 'English, one request at a time', 'Requests joined with “and” or “then” aren’t supported yet.'),
      haNote('alert', 'If Jibo can’t confirm a result', 'It may have worked anyway. Check the device before asking again.')),
    haOut(HA_LINKS.help, 'Setup guide and troubleshooting', 'ov-link'));
}

function haNoRobots(robots) {
  const shared = robots.length > 0;
  return h('section', { class: 'card' }, h('div', { class: 'card-body' }, h('div', { class: 'empty ha-empty' },
    haBridge(robots, 'idle'),
    h('h4', {}, shared ? 'Only a Jibo’s owner can link him' : 'Bring your Jibo online first'),
    h('p', {}, shared
      ? `Each Jibo’s owner links him to Home Assistant. Ask the owner of ${listText(robots.map(robotName))} to do it from their console.`
      : 'Once your Jibo is connected to this server, you can link him to Home Assistant here.'),
    shared ? null : h('a', { class: 'btn btn-primary', href: '#/add' }, icon('plus', 15), 'Add a Jibo'))));
}

/* -- Direct pairing ----------------------------------------------------------- */

// The versions the direct beta was released and checked with.
const HA_DIRECT = Object.freeze({
  integration: '0.3.0b3', homeAssistant: '2026.8.1', be: '13.2.2', services: '13.0.8', os: '13.0.7',
});

// What to say once a Jibo is paired: [group, hint, phrases]. Every phrase fits
// a pattern Phoenix hands to the paired Home Assistant and follows the
// integration's own examples; anything else goes through “ask Home Assistant
// to…”.
const HA_DIRECT_PHRASES = [
  ['Lights and switches', '', ['Turn on the kitchen lights', 'Set the bedroom light brightness to fifty percent',
    'Set the bedroom light to blue', 'Turn on the garden switch']],
  ['Scenes and scripts', '', ['Activate the dinner scene', 'Run the relax script']],
  ['In Jibo’s room', 'Once he has an Area', ['Turn on the lights here', 'Are the lights here on?']],
  ['Questions', '', ['What is the kitchen temperature?', 'Are the kitchen lights on?']],
  ['Follow-ups', 'Within 30 seconds', ['Turn them off', 'Make them dimmer']],
  ['Anything else Assist understands', '', ['Ask Home Assistant to …']],
];

/** Labels as they read on screen, joined like a menu path: Settings › Home Assistant. */
const haPath = (...labels) => h('span', { class: 'ha-path' },
  labels.flatMap((label, i) => [i ? h('span', { class: 'ha-path-sep', 'aria-hidden': 'true' }, '›') : null, h('b', { text: label })]));

/** A button that opens the owner's own Home Assistant at the right page. */
const haOpen = (href, label, primary = false) => h('a', {
  class: `btn btn-sm ha-open${primary ? ' btn-primary' : ''}`, href, target: '_blank', rel: 'noopener noreferrer',
}, icon('smartHome', 15), label, icon('external', 13));

/**
 * Jibo and Home Assistant each show eight digits, and matching them is what
 * proves the two are pairing with each other. Drawn blank, so the picture is
 * never mistaken for a real code.
 */
function haDigits() {
  const side = (label) => h('div', { class: 'ha-digits-side' },
    h('span', { class: 'ha-digits-label', text: label }),
    h('span', { class: 'ha-digits-boxes' }, Array.from({ length: 8 }, () => h('span', { class: 'ha-digit' }))));
  return h('div', { class: 'ha-digits', 'aria-hidden': 'true' },
    side('On Jibo'), h('span', { class: 'ha-digits-eq' }, '='), side('In Home Assistant'));
}

// The steps, in the order the two-minute pairing window needs: Home
// Assistant's form is open before Jibo starts it. `again` steps are repeated
// for every Jibo; the integration is installed once. A step's body is told
// whether it is the step to do next, so only that step's action leads.
const HA_DIRECT_STEPS = [
  {
    id: 'update', again: true, title: 'Update Jibo',
    body: () => [
      h('p', {}, 'Jibo needs ', h('b', {}, `BE ${HA_DIRECT.be}`), ' and ', h('b', {}, `Services ${HA_DIRECT.services}`),
        `, on OS ${HA_DIRECT.os}. He installs updates from this server by himself. To check now, say `,
        h('b', {}, '“Hey Jibo, check for updates.”')),
      h('a', { class: 'ov-link', href: '#/system' }, 'Jibo software on this server', icon('arrow', 14)),
    ],
  },
  {
    id: 'install', title: 'Install Phoenix in Home Assistant',
    body: (next) => [
      h('p', {}, 'Open Phoenix in HACS, turn on beta versions and download ', h('b', {}, HA_DIRECT.integration),
        `. Then restart Home Assistant. It needs Home Assistant ${HA_DIRECT.homeAssistant} or newer.`),
      h('div', { class: 'ha-actions' }, haOpen(HA_LINKS.hacs, 'Open in HACS', next),
        haOut(HA_LINKS.install, 'Install by hand', 'btn btn-sm btn-quiet')),
    ],
  },
  {
    id: 'form', again: true, title: 'Open the Phoenix setup', tag: ['clock', 'Before pairing', 'time'],
    body: (next) => [
      h('p', {}, 'In Home Assistant, go to ', haPath('Settings', 'Devices & services', 'Add integration', 'Phoenix'),
        ' and leave the form open. Jibo’s pairing window only lasts two minutes, so have this ready first.'),
      h('div', { class: 'ha-actions' }, haOpen(HA_LINKS.add, 'Add Phoenix', next)),
    ],
  },
  {
    id: 'pair', again: true, title: 'Start pairing on Jibo', tag: ['clock', 'Two minutes', 'time'],
    body: () => [
      h('p', {}, 'On Jibo’s screen, open ', haPath('Settings', 'Home Assistant', 'Start pairing'), '.'),
      h('p', {}, 'Type the host and port he shows, usually ', h('b', {}, '9443'),
        ', into the Home Assistant form. Home Assistant has to be able to reach Jibo on your network.'),
    ],
  },
  {
    id: 'compare', again: true, title: 'Check that the eight digits match', tag: ['lock', 'Keeps it safe', 'safe'],
    body: () => [
      haDigits(),
      h('p', {}, 'If every digit matches, tap ', h('b', {}, 'Approve'), ' on Jibo, then confirm in Home Assistant.'),
      h('div', { class: 'notice notice-warn' }, icon('alert', 16),
        h('div', {}, 'If any digit is different, or you didn’t start this pairing, cancel on both.')),
    ],
  },
  {
    id: 'finish', again: true, title: 'Choose what Jibo can control',
    body: (next) => [
      h('p', {}, 'Tap ', h('b', {}, 'Done'), ' and leave Settings so Jibo shows his face. In Home Assistant, give Jibo an ',
        h('b', {}, 'Area'), ' and expose the devices he may use. Start with one light.'),
      h('div', { class: 'ha-actions' }, haOpen(HA_LINKS.expose, 'Expose devices', next), haOpen(HA_LINKS.areas, 'Areas')),
    ],
  },
];

// Ticked steps are a convenience for whoever is following the guide in this
// browser, kept for the signed-in account. They are the owner's own marks,
// never a pairing status.
const HA_GUIDE_KEY = 'phoenix.homeAssistantGuide';
function haGuideProgress(accountId) {
  const known = new Set(HA_DIRECT_STEPS.map((step) => step.id));
  let done = new Set();
  try {
    const saved = JSON.parse(localStorage.getItem(HA_GUIDE_KEY) || 'null');
    if (saved?.accountId === accountId && Array.isArray(saved.done)) done = new Set(saved.done.filter((id) => known.has(id)));
  } catch { /* browser storage is optional */ }
  const save = () => {
    try {
      if (done.size) localStorage.setItem(HA_GUIDE_KEY, JSON.stringify({ accountId, done: [...done] }));
      else localStorage.removeItem(HA_GUIDE_KEY);
    } catch { /* browser storage is optional */ }
  };
  return { done, save };
}

/** One step of the guide. A finished step folds down to its title. */
function haGuideStep(step, n, state, onToggle) {
  const finished = state === 'done';
  const check = h('input', { class: 'ha-check', type: 'checkbox', checked: finished, 'data-step': step.id });
  check.addEventListener('change', () => onToggle(step.id));
  const [tagIcon, tagText, tagTone] = step.tag || [];
  return h('li', { class: `ha-step is-${state}`, 'aria-current': state === 'active' ? 'step' : null },
    h('span', { class: 'ha-step-mark', 'aria-hidden': 'true' }, finished ? icon('check', 14) : String(n)),
    h('div', { class: 'ha-step-title' },
      h('span', { class: 'ha-step-head' },
        h('span', { class: 'ha-step-name' }, h('span', { class: 'sr-only' }, `Step ${n}: `), step.title),
        step.tag && !finished ? h('span', { class: `ha-step-tag is-${tagTone}` }, icon(tagIcon, 12), tagText) : null),
      h('label', { class: 'ha-step-done' }, check, h('span', {}, 'Done'), h('span', { class: 'sr-only' }, `: ${step.title}`))),
    finished ? null : h('div', { class: 'ha-step-body' }, ...step.body(state === 'active')));
}

/** The pairing guide: who is being paired with what, what is needed, and the steps. */
function haGuideCard(accountId) {
  const { done, save } = haGuideProgress(accountId);
  const total = HA_DIRECT_STEPS.length;
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

  const heroRobots = h('span', { class: 'ha-bridge-robots' }, robotAvatar('blue', 'lg'));
  const fill = h('span', { class: 'ha-progress-fill' });
  const count = h('span', { class: 'ha-progress-count' });
  const meter = h('div', { class: 'ha-progress', role: 'progressbar', 'aria-label': 'Pairing guide',
    'aria-valuemin': '0', 'aria-valuemax': String(total) }, h('span', { class: 'ha-progress-track' }, fill), count);
  const steps = h('ol', { class: 'ha-steps' });
  const foot = h('div', { class: 'card-foot ha-guide-foot' });
  const el = h('section', { class: 'card ha-setup is-first ha-guide' },
    h('div', { class: 'ha-guide-hero' },
      h('span', { class: 'ha-bridge ha-bridge-lg is-local', 'aria-hidden': 'true' },
        heroRobots, h('span', { class: 'ha-bridge-line' }, h('span', { class: 'ha-bridge-lock' }, icon('lock', 12))), haTile('lg')),
      h('h3', {}, 'Pair Jibo with Home Assistant'),
      h('div', { class: 'ha-guide-intro' },
        h('p', {}, 'Home Assistant talks to Jibo directly over your home network. Pairing happens on Jibo’s screen and in Home Assistant, so there’s nothing to type in here.'),
        h('ul', { class: 'ha-needs', 'aria-label': 'You’ll need' },
          h('li', {}, icon('smartHome', 14), `Home Assistant ${HA_DIRECT.homeAssistant} or newer`),
          h('li', {}, icon('download', 14), `Phoenix integration ${HA_DIRECT.integration}`),
          h('li', {}, icon('robot', 14), `Jibo BE ${HA_DIRECT.be} · Services ${HA_DIRECT.services}`)))),
    h('div', { class: 'ha-guide-bar' }, meter),
    steps,
    foot);

  const reset = (keepInstalled) => {
    for (const step of HA_DIRECT_STEPS) if (!keepInstalled || step.again) done.delete(step.id);
    save();
    paint();
    steps.querySelector('.is-active .ha-check')?.focus({ preventScroll: true });
    steps.querySelector('.is-active')?.scrollIntoView({ block: 'nearest', behavior: reducedMotion ? 'auto' : 'smooth' });
  };

  function paint() {
    const next = HA_DIRECT_STEPS.find((step) => !done.has(step.id));
    steps.replaceChildren(...HA_DIRECT_STEPS.map((step, i) =>
      haGuideStep(step, i + 1, done.has(step.id) ? 'done' : step === next ? 'active' : 'ready', toggle)));
    el.classList.toggle('is-complete', !next);
    fill.style.width = `${(done.size / total) * 100}%`;
    count.textContent = done.size ? `${done.size} of ${total} done` : `${total} steps · tick each one off as you go`;
    meter.setAttribute('aria-valuenow', String(done.size));
    meter.setAttribute('aria-valuetext', `${done.size} of ${total} steps done`);
    // replaceChildren() would draw a null as the text "null".
    foot.replaceChildren(...(next
      ? [h('span', { class: 'field-hint' }, 'Pair each Jibo on his own. Each one gets his own Phoenix entry in Home Assistant.'),
        done.size ? h('button', { class: 'btn btn-sm btn-quiet', type: 'button', on: { click: () => reset(false) } }, 'Start over') : null]
      : [h('div', { class: 'ha-ready', role: 'status' },
        h('span', { class: 'ha-done-ic' }, icon('check', 18)),
        h('div', {}, h('b', {}, 'That’s everything'),
          h('span', {}, 'Now say “Hey Jibo, turn on the …” with the name of a light you exposed.'))),
      h('button', { class: 'btn btn-sm', type: 'button', on: { click: () => reset(true) } }, icon('plus', 14), 'Pair another Jibo')]
    ).filter(Boolean));
  }

  function toggle(id) {
    if (done.has(id)) done.delete(id); else done.add(id);
    save();
    paint();
    // Keep the keyboard where it was, and bring the next step into view.
    steps.querySelector(`[data-step="${id}"]`)?.focus({ preventScroll: true });
    steps.querySelector('.is-active')?.scrollIntoView({ block: 'nearest', behavior: reducedMotion ? 'auto' : 'smooth' });
  }

  paint();
  return {
    el,
    setRobots(robots) {
      if (robots.length) heroRobots.replaceChildren(...robots.slice(0, 3).map((robot) => robotAvatar(robot.avatarColor, 'lg')));
    },
  };
}

function haDirectSayCard() {
  return h('section', { class: 'card say-card ha-say' },
    h('div', { class: 'card-body' },
      h('h3', {}, 'Say “Hey Jibo”, then…'),
      ...HA_DIRECT_PHRASES.map(([label, hint, phrases]) => h('div', { class: 'ha-say-group' },
        h('h4', {}, label, hint ? h('span', { class: 'ha-say-hint', text: hint }) : null),
        h('ul', { class: 'ha-say-list is-flow' }, phrases.map((phrase) => h('li', { text: phrase }))))),
      h('p', { class: 'field-hint' }, 'Use the names, aliases and areas your devices have in Home Assistant.')));
}

/** Who does what, and what stays where. */
function haHowCard() {
  const jibo = h('span', { class: 'ha-flow-jibo' }, robotAvatar('blue'));
  const node = (visual, name, role) => h('div', { class: 'ha-flow-node' }, visual, h('b', { text: name }), h('span', { text: role }));
  const el = card('How it works', {},
    h('figure', { class: 'ha-flow' },
      node(h('span', { class: 'ha-flow-ic' }, icon('mic', 18)), 'Phoenix', 'Turns speech into text'),
      h('span', { class: 'ha-flow-link is-voice', 'aria-hidden': 'true' }),
      node(jibo, 'Jibo', 'Sends your request'),
      h('span', { class: 'ha-flow-link is-local', 'aria-hidden': 'true' }, h('span', { class: 'ha-flow-lock' }, icon('lock', 11))),
      node(haTile(), 'Home Assistant', 'Runs it and replies'),
      h('figcaption', { class: 'sr-only' }, 'Phoenix turns what you say into text. Jibo sends the request to Home Assistant over a paired, encrypted connection on your network, and Home Assistant runs it.')),
    h('ul', { class: 'ha-notes' },
      haNote('lock', 'Private to your network', 'The connection is encrypted and needs no port forwarding. Never open Jibo’s port 9443 to the Internet.'),
      haNote('mic', 'Phoenix still hears you', 'It turns your voice into text, so voice control needs this server. Pairing keys, your Home Assistant address and device results stay off it.'),
      haNote('message', 'One request at a time, in English', 'Requests joined with “and” or “then” aren’t supported yet.'),
      haNote('alert', 'If Jibo can’t confirm a result', 'It may have worked anyway. Check the device before asking again.')),
    haOut(HA_LINKS.help, 'Troubleshooting', 'ov-link'));
  el.classList.add('ha-how');
  return { el, setRobot(robot) { if (robot) jibo.replaceChildren(robotAvatar(robot.avatarColor)); } };
}

/** Everything after pairing is managed in Home Assistant itself. */
function haManageSection() {
  const tile = (iconName, title, text, href, go) => h('a', { class: 'tip ha-manage', href, target: '_blank', rel: 'noopener noreferrer' },
    h('span', { class: 'tip-ic' }, icon(iconName, 18)),
    h('span', { class: 'tip-title' }, title),
    h('span', { class: 'tip-text' }, text),
    h('span', { class: 'ha-manage-go' }, go, icon('external', 13)));
  return h('section', { class: 'ha-manage-section', 'aria-labelledby': 'ha-manage-title' },
    h('div', { class: 'ov-head' },
      h('h3', { id: 'ha-manage-title' }, 'After pairing, everything lives in Home Assistant')),
    h('div', { class: 'tip-grid ha-manage-grid' },
      tile('wifi', 'Connection and sensors', 'See that Jibo is connected, plus his battery, head touch and 13 more sensors.', HA_LINKS.integration, 'Open Phoenix'),
      tile('eye', 'What Jibo can control', 'Expose the lights, switches, scenes and scripts he may use. Expose scripts with care.', HA_LINKS.expose, 'Expose devices'),
      tile('pin', 'Jibo’s room', 'Give Jibo an Area, so “turn on the lights here” means the room he’s in.', HA_LINKS.areas, 'Areas'),
      tile('sliders', 'Routines and voice', 'Add your own phrases for scenes and scripts, or pick another conversation agent, in Phoenix › Configure.', HA_LINKS.integration, 'Open Phoenix'),
      tile('bell', 'Announcements', 'Let automations speak through Jibo, with quiet hours. Off until you allow it in Phoenix › Configure.', HA_LINKS.integration, 'Open Phoenix'),
      tile('trash', 'Disconnect', 'Delete Jibo’s Phoenix entry in Home Assistant. If Jibo is offline, also choose Forget on his Home Assistant screen.', HA_LINKS.remove, 'How to remove')));
}

/** Older cloud links still exist: say what happens to them, and where they are managed. */
function haOlderLinksNotice(installations, robotFor) {
  const robots = [...new Set(installations.flatMap((installation) => installation.robots || []))].map(robotFor);
  return h('section', { class: 'card ha-older' },
    h('div', { class: 'ha-older-body' },
      h('span', { class: 'ha-older-ic' }, icon('link', 18)),
      h('div', { class: 'ha-older-text' },
        h('b', {}, installations.length === 1 ? 'You still have an older cloud link'
          : `You still have ${installations.length} older cloud links`),
        h('p', {}, 'Links made with Phoenix 0.2 send commands through this server. Pair Jibo directly and Home Assistant removes the old link by itself. If it couldn’t reach this server, disconnect the old link here.'),
        robots.length ? h('div', { class: 'ha-robots' }, robots.map(haRobotChip)) : null),
      h('a', { class: 'btn btn-sm', href: '#/home-assistant-legacy' }, 'Manage older cloud links', icon('arrow', 14, 'arrow'))));
}

async function renderHomeAssistant() {
  const container = page('Home Assistant', 'Pair Home Assistant directly with Jibo on your home network, then ask him to run your lights, scenes and more.');
  const head = container.querySelector('.page-head');
  head.classList.add('ha-head');
  head.querySelector('h2').append(h('span', { class: 'pill pill-accent' }, 'Beta'));

  const guide = haGuideCard(me?.id || '');
  const how = haHowCard();
  const notice = h('div', { class: 'ha-slot ha-notices', 'aria-live': 'polite' });
  const older = h('div', { class: 'ha-slot' });
  container.append(notice,
    h('div', { class: 'ha-layout' },
      h('div', { class: 'ha-main' }, guide.el),
      h('div', { class: 'ha-aside' }, haDirectSayCard(), how.el)),
    haManageSection(),
    older);
  show(container);

  // Nothing above waits for the server. The robots give the drawings their
  // colors, and older cloud links are only read, to say whether any remain.
  const [robots, links] = await Promise.all([api('GET', '/api/robots'), api('GET', '/api/home-assistant')]);
  const robotList = robots.ok && Array.isArray(robots.data) ? robots.data : [];
  if (robots.ok) {
    setBadge('badge-robots', robotList.length);
    const shown = [...robotList.filter((robot) => robot.canManage), ...robotList.filter((robot) => !robot.canManage)];
    guide.setRobots(shown);
    how.setRobot(shown[0]);
    if (!robotList.length) {
      notice.append(h('div', { class: 'notice notice-accent ha-norobot' }, icon('robot', 16),
        h('div', {}, h('b', {}, 'Add your Jibo to this server first. '),
          'Phoenix still turns what you say into text, so voice control needs Jibo connected here.'),
        h('a', { class: 'btn btn-sm', href: '#/add' }, icon('plus', 14), 'Add a Jibo')));
    }
  }
  const byId = new Map(robotList.map((robot) => [robot.friendlyId, robot]));
  const installations = links.ok && Array.isArray(links.data?.installations) ? links.data.installations : [];
  if (installations.length) {
    notice.append(haOlderLinksNotice(installations, (id) => byId.get(id) || { friendlyId: id, avatarColor: 'slate' }));
  } else {
    older.append(h('p', { class: 'ha-older-quiet' }, 'Set up Home Assistant with the older cloud beta? ',
      h('a', { class: 'link', href: '#/home-assistant-legacy' }, 'Manage older cloud links')));
  }
}

async function renderLegacyHomeAssistant() {
  const frame = () => {
    const container = page('Older Home Assistant links', 'Manage connections created with Phoenix 0.2. These use the server relay.');
    const head = container.querySelector('.page-head');
    head.classList.add('ha-head');
    head.prepend(h('a', { class: 'link back-link', href: '#/home-assistant' }, icon('back', 14), 'Home Assistant'));
    head.querySelector('h2').append(h('span', { class: 'pill pill-accent' }, 'Beta'));
    return container;
  };
  const placeholder = frame();
  placeholder.append(loading(4));
  show(placeholder);

  const [robots, initial] = await Promise.all([api('GET', '/api/robots'), api('GET', '/api/home-assistant')]);
  const container = frame();
  if (!robots.ok || !initial.ok) {
    container.append(
      errorBox(robots.ok ? 'Could not check Home Assistant.' : 'Could not load your robots.', (robots.ok ? initial : robots).data?.error),
      h('div', {}, h('button', { class: 'btn btn-sm', type: 'button', on: { click: () => renderLegacyHomeAssistant() } },
        icon('refresh', 14), 'Try again')));
    return show(container);
  }

  const robotList = Array.isArray(robots.data) ? robots.data : [];
  setBadge('badge-robots', robotList.length);
  const owned = robotList.filter((robot) => robot.canManage);
  const byId = new Map(robotList.map((robot) => [robot.friendlyId, robot]));
  const robotFor = (id) => byId.get(id) || { friendlyId: id, avatarColor: 'slate' };

  const main = h('div', { class: 'ha-main' });
  const layout = h('div', { class: 'ha-layout' }, main, h('div', { class: 'ha-aside' }, haSayCard(), haNotesCard()));
  container.append(layout);
  if (!owned.length) {
    main.append(haNoRobots(robotList));
    return show(container);
  }

  let status = initial.data;
  const accountId = me?.id;
  const server = location.origin;
  const insecure = location.protocol !== 'https:';
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

  // The code flow: pick Jibos, show a code, then linked (or expired). The mode
  // is fixed when a code is made, so the card does not change shape the moment
  // its own link appears.
  const fresh = () => ({ phase: 'pick', mode: null, expanded: false, selected: new Set(), touched: false, name: 'Home Assistant',
    code: '', deadline: 0, robots: [], known: new Set(), installationId: null, announced: false, note: '' });
  const kept = haCodeMemory?.accountId === accountId && haCodeMemory.deadline > Date.now() ? haCodeMemory : null;
  const flow = kept ? { ...fresh(), ...kept.flow, selected: new Set(kept.flow.robots), touched: true } : fresh();
  const remember = () => {
    haCodeMemory = flow.phase === 'code' ? { accountId, deadline: flow.deadline, flow: {
      phase: 'code', mode: flow.mode, code: flow.code, deadline: flow.deadline, robots: flow.robots, name: flow.name, known: flow.known,
    } } : null;
  };

  const notice = h('div', { class: 'ha-slot', 'aria-live': 'polite' });
  const installs = h('div', { class: 'ha-installs ha-slot' });
  const setupSlot = h('div', { class: 'ha-slot' });
  main.append(notice, installs, setupSlot);

  /* -- linked Home Assistants -------------------------------------------- */

  const drawn = new Map();
  function paintInstalls() {
    const list = [...(status.installations || [])].sort((a, b) => Number(a.createdAt || 0) - Number(b.createdAt || 0));
    const next = list.map((installation) => {
      const key = haInstallationKey(installation, robotFor);
      const current = drawn.get(installation.id);
      if (current?.key === key) return current;
      const element = haInstallationCard(installation, robotFor, disconnect, setAnnouncements);
      return { key, element };
    });
    drawn.clear();
    list.forEach((installation, i) => drawn.set(installation.id, next[i]));
    // Unchanged cards stay where they are, so their live dots keep moving.
    const elements = next.map((item) => item.element);
    if (elements.length !== installs.children.length || elements.some((element, i) => installs.children[i] !== element)) {
      installs.replaceChildren(...elements);
    }
  }

  async function disconnect(installation) {
    const name = meaningfulText(installation.name) || 'Home Assistant';
    const confirmed = await confirmDialog({
      title: `Disconnect ${name}?`,
      body: 'Jibo stops using it right away. Linking it again takes a new code. If you’re done with it, remove Phoenix from Home Assistant too.',
      confirmLabel: 'Disconnect',
    });
    if (!confirmed) return;
    const result = await api('DELETE', '/api/home-assistant', { installationId: installation.id });
    if (!result.ok && result.status !== 404) { notify(haError(result, 'Could not disconnect it.'), 'error'); return; }
    notify(`${name} is disconnected`);
    await refresh(true);
  }

  async function setAnnouncements(installation, enabled) {
    const result = await api('PUT', '/api/home-assistant/installation', {
      installationId: installation.id, announcementsEnabled: enabled,
    });
    if (!result.ok) { notify(result.data?.error === 'not_found'
      ? 'This Home Assistant is no longer linked.' : 'Could not save announcement permission.', 'error'); return false; }
    installation.announcementsEnabled = enabled;
    notify(enabled ? 'Home Assistant announcements allowed' : 'Home Assistant announcements turned off');
    await refresh(true);
    return true;
  }

  /* -- linking a Jibo ------------------------------------------------------ */

  let setupKey = '';
  let timer = null;

  async function requestCode(robotIds, name) {
    const result = await api('POST', '/api/home-assistant/codes', { robotIds, name });
    if (!result.ok) return result;
    Object.assign(flow, {
      phase: 'code', mode: (status.installations || []).length ? 'more' : 'first', code: result.data.code,
      deadline: haDeadline(result.data.expiresAt), robots: robotIds, name, note: '', announced: false,
      known: new Set((status.installations || []).map((installation) => installation.id)), installationId: null,
    });
    remember();
    status = { ...status, pending: [{ expiresAt: result.data.expiresAt }] };
    paint();
    // The code is what the person needs next: bring it into view and give it
    // focus, so it is also the next thing read out and reached by keyboard.
    const panel = setupSlot.querySelector('.ha-code');
    panel?.focus({ preventScroll: true });
    panel?.scrollIntoView({ block: 'nearest', behavior: reducedMotion ? 'auto' : 'smooth' });
    return result;
  }

  async function cancelCode(event) {
    const button = event.currentTarget;
    button.disabled = true;
    const result = await api('DELETE', '/api/home-assistant/codes');
    button.disabled = false;
    if (!result.ok) { notify(haError(result, 'Could not cancel the code.'), 'error'); return; }
    Object.assign(flow, { phase: 'pick', code: '', note: '' });
    remember();
    status = { ...status, pending: [] };
    paint();
    notify('Code cancelled');
  }

  function finish() {
    Object.assign(flow, fresh());
    remember();
    paint();
  }

  function setupCard(mode, available, made) {
    const first = mode === 'first';
    const phase = flow.phase;
    const waitingRobots = available.length === 1
      ? `${robotName(available[0])} isn’t linked yet` : `${available.length} Jibos aren’t linked yet`;
    // Once a home is linked, linking another Jibo is a quiet offer that opens
    // when asked for, rather than a whole form under the link that matters.
    if (!first && phase === 'pick' && !flow.expanded) {
      return h('button', { class: 'ha-add', type: 'button', 'aria-expanded': 'false', on: { click: () => {
        flow.expanded = true;
        paintSetup();
        setupSlot.querySelector('.ha-check')?.focus();
      } } },
      h('span', { class: 'jibo-add-ic' }, icon('plus', 18)),
      h('span', { class: 'ha-add-text' }, h('b', {}, 'Link another Jibo'), h('span', { text: waitingRobots })));
    }
    const showing = phase === 'code';
    const done = phase === 'linked';
    const connected = done && made?.connected === true;
    const pickedRobots = (phase === 'pick' ? available.filter((robot) => flow.selected.has(robot.friendlyId)) : flow.robots.map(robotFor));

    /* The bridge in the heading follows the Jibos being picked. */
    const heroRobots = h('span', { class: 'ha-bridge-robots' });
    const paintHero = (list) => heroRobots.replaceChildren(...(list.length ? list : available.slice(0, 1)).slice(0, 3)
      .map((robot) => robotAvatar(robot.avatarColor, 'lg')));
    paintHero(pickedRobots);
    const heroState = connected ? 'live' : (showing || done) ? 'waiting' : 'idle';

    /* Step: choose Jibos. */
    let chooseBody;
    if (phase === 'pick') {
      const error = h('p', { class: 'error', role: 'alert', hidden: true });
      const picker = h('fieldset', { class: 'ha-pick' },
        h('legend', { class: 'sr-only' }, 'Jibos to link'),
        available.map((robot) => h('label', { class: 'ha-option' },
          robotAvatar(robot.avatarColor, 'sm'),
          h('span', { class: 'ha-option-text' },
            h('b', { text: robotName(robot) }),
            h('span', { text: robot.friendlyId, title: robot.friendlyId })),
          h('input', { class: 'ha-check', type: 'checkbox', name: 'robot', value: robot.friendlyId,
            checked: flow.selected.has(robot.friendlyId) }))));
      picker.addEventListener('change', (event) => {
        flow.touched = true;
        if (event.target.checked) flow.selected.add(event.target.value);
        else flow.selected.delete(event.target.value);
        error.hidden = true;
        paintHero(available.filter((robot) => flow.selected.has(robot.friendlyId)));
      });
      const name = h('input', { name: 'name', value: flow.name, maxlength: '80', autocomplete: 'off',
        on: { input: (event) => { flow.name = event.target.value; } } });
      const form = h('form', { class: 'ha-get' },
        picker,
        available.length > 1 ? h('p', { class: 'field-hint' }, 'Only the Jibos you choose can control this home.') : null,
        h('div', { class: 'ha-get-row' },
          field('Connection name', name),
          h('button', { class: 'btn btn-primary', type: 'submit' }, icon('link', 15), 'Get connection code')),
        error);
      onSubmit(form, async () => {
        const selected = available.filter((robot) => flow.selected.has(robot.friendlyId)).map((robot) => robot.friendlyId);
        const say = (message) => { error.textContent = message; error.hidden = false; };
        if (!selected.length) { say(HA_ERRORS.select_robots); picker.querySelector('input')?.focus(); return; }
        const result = await requestCode(selected, flow.name.trim() || 'Home Assistant');
        if (!result.ok) say(haError(result, 'Could not create a connection code.'));
      });
      chooseBody = [form];
    } else {
      chooseBody = [h('div', { class: 'ha-robots' }, flow.robots.map((id) => haRobotChip(robotFor(id))))];
    }

    /* Step: enter the code in Home Assistant. */
    const httpsNote = insecure
      ? h('div', { class: 'notice notice-warn' }, icon('alert', 16),
        h('div', {}, 'Home Assistant links only to a trusted HTTPS address, and this page is open over HTTP. Give Home Assistant this server’s HTTPS address instead.'))
      : null;
    let codeBody;
    if (phase === 'pick') {
      const waiting = (status.pending || []).length;
      codeBody = [
        h('p', {}, first
          ? 'Your one-time code appears here. It lasts ten minutes, so install Phoenix first.'
          : 'Your one-time code appears here. It lasts ten minutes.'),
        flow.note ? h('div', { class: 'notice' }, icon('clock', 16), h('div', { text: flow.note })) : null,
        waiting ? h('div', { class: 'notice' }, icon('clock', 16), h('div', {},
          'A code you made earlier is still waiting. Codes are shown only once, so get a new one if you need it. ',
          h('button', { class: 'link', type: 'button', on: { click: cancelCode } }, 'Cancel the old code'))) : null,
        httpsNote,
      ];
    } else if (showing) {
      timer = haTimer(flow.deadline);
      codeBody = [
        h('div', { class: 'ha-code', role: 'group', tabindex: '-1', 'aria-label': 'One-time connection code' },
          h('span', { class: 'ha-code-label' }, 'One-time connection code'),
          h('div', { class: 'ha-code-row' }, haCodeText(flow.code), copyButton(() => flow.code)),
          timer.el),
        h('p', {}, first
          ? 'In Home Assistant, add the Phoenix integration and enter this code.'
          : 'In Home Assistant, add Phoenix again and enter this code. Each link appears there as its own Phoenix entry.'),
        h('div', { class: 'ha-actions' }, haOut(HA_LINKS.add, 'Add Phoenix in Home Assistant', 'btn btn-primary btn-sm')),
        h('div', { class: 'ha-server' },
          h('span', { class: 'ha-label' }, 'Phoenix server URL'),
          h('div', { class: 'restart-cmd run-cmd' }, h('code', { text: server }), copyButton(() => server)),
          h('p', { class: 'field-hint' }, server === HA_DEFAULT_SERVER
            ? 'Home Assistant fills this in for you.'
            : `Home Assistant suggests ${HA_DEFAULT_SERVER}. Replace it with this address.`)),
        httpsNote,
        h('div', { class: 'ha-wait' },
          h('span', { class: 'spinner', 'aria-hidden': 'true' }),
          h('span', { role: 'status' }, 'Waiting for Home Assistant…'),
          h('button', { class: 'btn btn-sm btn-quiet', type: 'button', on: { click: cancelCode } }, 'Cancel code')),
        h('p', { class: 'field-hint' }, 'Relinking? Enter the code where Home Assistant asks you to relink Phoenix.'),
      ];
    } else if (phase === 'expired') {
      const again = h('button', { class: 'btn btn-primary btn-sm', type: 'button' }, 'Get a new code');
      again.addEventListener('click', async () => {
        again.disabled = true;
        const result = await requestCode(flow.robots, flow.name);
        again.disabled = false;
        if (!result.ok) notify(haError(result, 'Could not create a connection code.'), 'error');
      });
      codeBody = [
        h('div', { class: 'notice notice-warn' }, icon('clock', 16), h('div', {}, 'This code expired before Home Assistant used it.')),
        h('div', { class: 'ha-actions' }, again,
          h('button', { class: 'btn btn-sm btn-quiet', type: 'button', on: { click: finish } }, 'Choose again')),
      ];
    } else {
      const slow = !connected && made && Date.now() - Number(made.createdAt || 0) > 60000;
      const names = listText(flow.robots.map((id) => robotName(robotFor(id))));
      codeBody = [h('div', { class: `ha-done${connected ? '' : ' is-waiting'}`, role: 'status' },
        connected ? h('span', { class: 'ha-done-ic' }, icon('check', 18)) : h('span', { class: 'spinner', 'aria-hidden': 'true' }),
        h('div', {},
          h('b', {}, connected
            ? `Connected to Home Assistant${made.haVersion ? ` ${made.haVersion}` : ''}`
            : 'Linked. Waiting for Home Assistant to connect…'),
          h('span', {}, connected
            ? `${names} can use it now.`
            : slow ? 'This is taking a while. Check that Home Assistant can reach this server.' : 'This usually takes a few seconds.')))];
    }

    const exposeStep = (n, state) => haStep(n, state, 'Choose what Jibo can control',
      h('p', {}, 'In Home Assistant, expose the lights, switches, scenes and scripts he may use to Assist. Start with one light that has a clear name.'),
      h('div', { class: 'ha-actions' }, haOut(HA_LINKS.expose, 'Open Assist settings', done ? 'btn btn-primary btn-sm' : 'btn btn-sm')));
    const chooseTitle = (phase === 'pick' ? available.length : flow.robots.length) === 1 ? 'Choose your Jibo' : 'Choose your Jibos';
    const codeState = showing || phase === 'expired' ? 'active' : done ? 'done' : 'todo';
    const steps = first
      ? [
        // Only Home Assistant using a code proves Phoenix is installed there.
        haStep(1, done ? 'done' : 'ready', 'Install Phoenix in Home Assistant', ...(done ? [] : [
          h('p', {}, 'Add the Phoenix integration from HACS, then restart Home Assistant. It’s a beta, so allow beta versions when HACS asks which version to download.'),
          h('div', { class: 'ha-actions' },
            haOut(HA_LINKS.hacs, 'Open in HACS'),
            haOut(HA_LINKS.install, 'Installation guide', 'btn btn-sm btn-quiet'))])),
        haStep(2, phase === 'pick' ? 'ready' : 'done', chooseTitle, ...chooseBody),
        haStep(3, codeState, 'Enter the code in Home Assistant', ...codeBody),
        exposeStep(4, done ? 'active' : 'ready'),
      ]
      : [
        haStep(1, phase === 'pick' ? 'ready' : 'done', chooseTitle, ...chooseBody),
        haStep(2, codeState, 'Enter the code in Home Assistant', ...codeBody),
      ];

    const head = first
      ? h('div', { class: 'ha-setup-hero' },
        h('span', { class: `ha-bridge ha-bridge-lg is-${heroState}`, 'aria-hidden': 'true' },
          heroRobots, h('span', { class: 'ha-bridge-line' }), haTile('lg')),
        h('div', { class: 'ha-setup-hero-text' },
          h('h3', {}, 'Connect Jibo to Home Assistant'),
          h('p', {}, 'Four steps, and he can switch lights, set scenes and run scripts for you.')))
      : h('div', { class: 'card-head' },
        h('h3', {}, 'Link another Jibo'),
        phase === 'pick' ? h('span', { class: 'sub', text: waitingRobots }) : null,
        phase === 'pick' ? h('span', { class: 'spacer' }) : null,
        phase === 'pick' ? h('button', { class: 'btn btn-sm btn-quiet', type: 'button', on: { click: () => {
          flow.expanded = false;
          paintSetup();
        } } }, 'Not now') : null);
    return h('section', { class: `card ha-setup${first ? ' is-first' : ''}` },
      head,
      h('ol', { class: 'ha-steps' }, steps),
      done ? h('div', { class: 'card-foot ha-setup-foot' },
        h('span', { class: 'field-hint' }, 'Then say “Hey Jibo” and try one of the phrases on this page.'),
        h('button', { class: 'btn btn-sm', type: 'button', on: { click: finish } }, 'Done')) : null);
  }

  function paintSetup() {
    const installations = status.installations || [];
    const linked = new Set(installations.flatMap((installation) => installation.robots || []));
    const available = owned.filter((robot) => !linked.has(robot.friendlyId));
    for (const id of [...flow.selected]) if (!available.some((robot) => robot.friendlyId === id)) flow.selected.delete(id);
    // One Jibo to link is chosen for you; with several, the choice is yours.
    if (flow.phase === 'pick' && !flow.touched && available.length === 1) flow.selected.add(available[0].friendlyId);

    const mode = flow.phase === 'pick' ? (installations.length ? 'more' : 'first') : flow.mode;
    const made = installations.find((installation) => installation.id === flow.installationId);
    const limited = flow.phase === 'pick' && installations.length >= HA_INSTALLATION_LIMIT;
    const slow = !!made && !made.connected && Date.now() - Number(made.createdAt || 0) > 60000;
    const key = JSON.stringify([flow.phase, mode, flow.expanded, available.map((robot) => robot.friendlyId),
      flow.phase === 'pick' ? (status.pending || []).length : 0, made?.connected, made?.haVersion, flow.note, limited, slow]);
    if (key !== setupKey) {
      setupKey = key;
      timer = null;
      let view = null;
      if (flow.phase !== 'pick' || available.length) {
        view = limited ? card('Link another Jibo', {}, h('p', { class: 'field-hint' }, HA_ERRORS.installation_limit))
          : setupCard(mode, available, made);
      }
      setupSlot.replaceChildren(...(view ? [view] : []));
    }
    // While a code is out, the linking card leads, so a new link appearing
    // below it does not push it down the page.
    const lead = flow.phase === 'pick' ? installs : setupSlot;
    if (notice.nextElementSibling !== lead) main.append(lead, lead === installs ? setupSlot : installs);
  }

  function paint() {
    paintInstalls();
    paintSetup();
    // Linked homes take the full width, with what to say and what to expect
    // side by side beneath. A first link keeps the setup layout until Done.
    const installed = (status.installations || []).length > 0;
    layout.classList.toggle('is-steady', installed && !(flow.phase !== 'pick' && flow.mode === 'first'));
  }

  /* -- staying current ------------------------------------------------------ */

  function detect() {
    const installations = status.installations || [];
    // A code redeemed in its last second still links, so an expired code is
    // watched for as well.
    if (flow.phase === 'code' || flow.phase === 'expired') {
      const made = installations.find((installation) => !flow.known.has(installation.id)
        && flow.robots.every((id) => (installation.robots || []).includes(id)));
      if (made) {
        Object.assign(flow, { phase: 'linked', installationId: made.id, code: '', announced: made.connected === true });
        remember();
        notify(made.connected ? 'Home Assistant is connected' : 'Home Assistant is linked');
      } else if (flow.phase === 'code' && !(status.pending || []).length) {
        const expired = Date.now() >= flow.deadline - 2000;
        Object.assign(flow, { phase: expired ? 'expired' : 'pick', code: '',
          note: expired ? '' : 'Your code was cancelled or replaced. Get a new one when you’re ready.' });
        remember();
      }
    }
    if (flow.phase === 'linked') {
      const made = installations.find((installation) => installation.id === flow.installationId);
      if (!made) Object.assign(flow, fresh()); // disconnected meanwhile, perhaps from another tab
      else if (made.connected && !flow.announced) {
        flow.announced = true;
        notify('Home Assistant is connected');
      }
    }
  }

  let issued = 0;
  let applied = 0;
  let inFlight = 0;
  async function refresh(force = false) {
    if (inFlight && !force) return;
    const seq = ++issued;
    inFlight += 1;
    const result = await api('GET', '/api/home-assistant');
    inFlight -= 1;
    if (seq < applied) return; // a newer answer has already been drawn
    applied = seq;
    if (!result.ok) {
      notice.replaceChildren(errorBox('Could not check Home Assistant just now.', result.data?.error));
      return;
    }
    notice.replaceChildren();
    status = result.data;
    detect();
    paint();
  }

  detect();
  paint();
  show(container);

  // One clock for the page: the code's countdown every second, and the link's
  // state every five seconds, or every two while waiting on Home Assistant.
  // A hidden tab asks nothing, and catches up the moment it is shown again.
  let ticks = 0;
  let wasHidden = false;
  stopPoll();
  pollTimer = setInterval(() => {
    ticks += 1;
    if (flow.phase === 'code' && Date.now() >= flow.deadline) {
      Object.assign(flow, { phase: 'expired', code: '' });
      remember();
      paint();
    }
    timer?.update();
    if (document.hidden) { wasHidden = true; return; }
    const waiting = flow.phase === 'code'
      || (flow.phase === 'linked' && !(status.installations || []).find((item) => item.id === flow.installationId)?.connected);
    if (wasHidden || ticks % (waiting ? 2 : 5) === 0) void refresh();
    wasHidden = false;
  }, 1000);
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
  '#/home-assistant': renderHomeAssistant,
  '#/home-assistant-legacy': renderLegacyHomeAssistant,
  '#/tips': renderTips,
  '#/claim': renderClaim,
  '#/gallery': renderGallery,
  '#/inbox': renderInbox,
  '#/system': renderSystem,
  '#/add': renderAdd,
  '#/add/repoint-oobe': renderAddRepointOobe,
  '#/add/new': renderAddNew,
};

/* -- Voice turns ------------------------------------------------------------- */

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

const VOICE_OUTCOME_LABELS = Object.freeze({
  skill: 'Answered', listen: 'Handled on Jibo', redirect: 'Redirected', ok: 'Done', matched: 'Matched',
  unmatched: 'Not understood', remote_error: 'Service error', timeout: 'Timed out', error: 'Error',
  cancelled: 'Cancelled', abandoned: 'Abandoned',
});

function voiceOutcome(turn) {
  const route = (turn.stages || []).find((stage) => stage.stage === 'route');
  if (turn.outcome === 'listen' && route?.outcome === 'unmatched') return { label: 'Not understood', tone: 'warn' };
  if (['error', 'timeout', 'remote_error', 'abandoned', 'cancelled'].includes(turn.outcome)) {
    return { label: VOICE_OUTCOME_LABELS[turn.outcome], tone: 'error' };
  }
  if (!turn.outcome) return { label: 'In progress', tone: 'quiet' };
  return { label: VOICE_OUTCOME_LABELS[turn.outcome] || 'Done', tone: 'ok' };
}

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
    'How long Jibo takes to answer, step by step. Never what was said, or who said it.');
  show(container);
  if (!(await adminGate(container))) return;

  const state = { range: '3600000', turnId: '', outcome: '', stage: '', loading: false, expanded: new Set() };
  const summary = h('div', { class: 'adm-voice-summary' });
  const body = h('div', { class: 'voice-turn-results' }, loading(5));
  const status = h('span', { class: 'adm-toolbar-status', text: 'Loading…' });
  const idInput = h('input', {
    type: 'search', class: 'adm-search', placeholder: 'Find a turn by its ID',
    'aria-label': 'Find an exact voice turn ID',
  });
  const rangeSelect = h('select', { 'aria-label': 'Time range' },
    ...[['900000', 'Last 15 minutes'], ['3600000', 'Last hour'], ['21600000', 'Last 6 hours'], ['0', 'Everything kept']]
      .map(([value, label]) => h('option', { value, selected: value === state.range }, label)));
  const outcomeSelect = h('select', { 'aria-label': 'Filter by outcome' }, h('option', { value: '' }, 'Every outcome'));
  const stageSelect = h('select', { 'aria-label': 'Filter by stage' }, h('option', { value: '' }, 'Every stage'));
  const refresh = h('button', { class: 'btn btn-sm btn-quiet', type: 'button' }, icon('refresh', 14), 'Refresh');

  const listCard = card('Recent turns', { actions: [status, refresh] },
    h('div', { class: 'adm-toolbar' }, rangeSelect, outcomeSelect, stageSelect, idInput),
    body);
  listCard.classList.add('adm-list-card', 'adm-voice-card');
  container.append(summary, listCard, h('p', { class: 'adm-footnote' },
    icon('lock', 12), 'Timing only: no transcript, audio, robot or account identity, credentials or log lines. '
      + 'The voice gateway keeps the most recent turns for a limited time (Settings → Logs and data).'));

  function options(select, values, selected, allLabel) {
    const current = select.value || selected || '';
    // Rebuilding a <select> closes it in most browsers, and this runs on every
    // five-second poll; only touch it when the offered values actually change.
    const offered = [...select.options].slice(1).map((option) => option.value);
    if (offered.length === values.length && offered.every((value, i) => value === values[i])) return;
    select.replaceChildren(h('option', { value: '' }, allLabel),
      ...values.map((value) => h('option', { value, selected: value === current },
        select === outcomeSelect ? (VOICE_OUTCOME_LABELS[value] || value) : voiceStageLabel(value))));
  }

  function paintSummary(turns) {
    if (!turns.length) { summary.replaceChildren(); return; }
    const finished = turns.filter((t) => Number.isFinite(t.totalMs) && voiceOutcome(t).tone !== 'error');
    const times = finished.map((t) => t.totalMs).sort((a, b) => a - b);
    const pick = (p) => (times.length ? times[Math.min(times.length - 1, Math.floor(times.length * p))] : null);
    const understood = turns.filter((t) => (t.stages || []).some((s) => s.stage === 'route' && s.outcome === 'matched')).length;
    const failed = turns.filter((t) => voiceOutcome(t).tone === 'error').length;
    const asr = turns.map((t) => (t.stages || []).find((s) => s.stage === 'asr')?.durationMs).filter(Number.isFinite).sort((a, b) => a - b);
    const tile = (label, value, note) => h('div', { class: 'adm-tile' }, h('span', { class: 'adm-tile-label', text: label }),
      h('strong', { text: value }), note ? h('span', { class: 'adm-tile-note', text: note }) : null);
    summary.replaceChildren(
      tile('Turns', String(turns.length), 'in this view'),
      tile('Typical reply', fmtDuration(pick(0.5)), `slowest 10%: ${fmtDuration(pick(0.9))}`),
      tile('Understood', `${Math.round((understood / turns.length) * 100)}%`, `${understood} of ${turns.length}`),
      tile('Listening', fmtDuration(asr.length ? asr[Math.floor(asr.length / 2)] : null), failed ? `${failed} failed` : 'speech to text'));
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
    paintSummary(turns);
    if (!turns.length) {
      body.replaceChildren(empty('No voice turns here', 'Try a longer time range, or clear a filter. Turns appear as people talk to their Jibo.', 'clock'));
      return;
    }
    const list = h('div', { class: 'voice-turn-list', role: 'list' });
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
          h('div', {}, h('strong', { text: 'Step by step' }),
            h('p', { id: scaleId, class: 'field-hint', text: scale === null
              ? 'This older turn doesn’t record when each step started.'
              : `From the start of the turn to ${fmtMs(scale)}. Work running alongside the reply is shown separately.` })),
          h('div', { class: 'voice-timeline-axis', 'aria-hidden': 'true' },
            h('span', { text: '0 ms' }), h('span', { text: scale === null ? '' : fmtMs(scale) }))),
        scale !== null && h('div', { class: 'voice-waterfall', 'aria-describedby': scaleId },
          h('div', { class: 'voice-waterfall-section' },
            h('div', { class: 'voice-waterfall-section-title', text: 'Reply' }),
            mainStages.length
              ? [
                tapeLanes(mainLanes, turnStartedAt, scale, completionOffset, 'Overlap lane'),
                tapeDetails(mainStages, turnStartedAt),
              ]
              : h('p', { class: 'field-hint', text: 'No timed steps were recorded for the reply.' })),
          backgroundStages.length && h('div', { class: 'voice-waterfall-section voice-waterfall-background' },
            h('div', { class: 'voice-waterfall-section-title', text: 'Alongside the reply' }),
            h('p', { class: 'field-hint', text: 'This work may finish after the reply is ready.' }),
            tapeLanes(backgroundLanes, turnStartedAt, scale, completionOffset, 'Background lane'),
            tapeDetails(backgroundStages, turnStartedAt)),
          h('div', { class: 'voice-completion-note' },
            h('span', { class: 'voice-completion-dot', 'aria-hidden': 'true' }),
            h('strong', { text: `Reply ready at +${fmtMs(Math.max(0, (completionAt || turnStartedAt) - turnStartedAt))}` })),
          unavailableStages > 0 && h('p', { class: 'field-hint', text: `${unavailableStages} older step${unavailableStages === 1 ? '' : 's'} can’t be placed on this timeline.` })),
        h('div', { class: 'voice-timeline-legend', 'aria-label': 'Colour key' },
          h('span', { class: 'voice-legend voice-tone-asr', text: 'Speech' }),
          h('span', { class: 'voice-legend voice-tone-language', text: 'Understanding' }),
          h('span', { class: 'voice-legend voice-tone-skill', text: 'Skill' }),
          h('span', { class: 'voice-legend voice-tone-response', text: 'Reply' }),
          h('span', { class: 'voice-legend voice-tone-background', text: 'Background' })));
      if (turn.asr) {
        timeline.append(h('div', { class: 'voice-asr' },
          h('div', { class: 'voice-asr-heading' }, h('strong', { text: 'Speech recognition' }),
            h('span', { class: 'field-hint', text: 'As the recognizer reported them.' })),
          asrTimingList(turn.asr)));
      }
      const outcome = voiceOutcome(turn);
      detail.append(h('summary', { class: 'voice-turn-row' },
        h('span', { class: 'voice-turn-time', text: fmtDate(turn.startedAt) }),
        h('span', { class: `pill pill-${outcome.tone}`, text: outcome.label }),
        h('strong', { class: 'voice-turn-total', text: fmtDuration(turn.totalMs) }),
        h('code', { class: 'voice-turn-id', text: turn.turnId }),
        icon('chevron', 14, 'voice-turn-caret')), timeline);
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
      summary.replaceChildren();
      body.replaceChildren(errorBox('Voice timing isn’t available from the voice gateway.', res.data.error || 'Try again in a moment.'));
      return;
    }
    options(outcomeSelect, res.data.outcomes || [], state.outcome, 'Every outcome');
    options(stageSelect, res.data.stages || [], state.stage, 'Every stage');
    draw(res.data.turns || []);
    status.textContent = `Updated ${new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })}`;
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

/* -- Logs -------------------------------------------------------------------- */

/**
 * The server's own log lines, live.
 *
 * This polls with a cursor instead of holding a stream open. The shared service
 * boundary serialises a route's return value and ends the response, so a
 * server-sent-event endpoint would mean changing that boundary for one screen;
 * a one-second cursor poll is a few hundred bytes and reads as live.
 *
 * Native deployments read retained logs from all services. Installations
 * without a shared log directory use the account process's live buffer.
 *
 * The level selector filters what was recorded. It cannot reveal lines the
 * service suppressed at its own LOG_LEVEL — set Log detail to Everything in
 * Settings to see debug lines.
 */
async function renderAdminLogs() {
  const container = adminPage('#/admin/logs', 'Logs', 'Recent service activity and errors, updated as they happen.');
  show(container);
  if (!(await adminGate(container))) return;

  const state = { cursor: 0, level: '', ns: '', find: '', paused: false, shown: 0, dropped: 0, inFlight: false, generation: 0 };

  const list = h('div', { class: 'log-list', role: 'log', 'aria-live': 'polite' });
  const status = h('span', { class: 'adm-toolbar-status', text: 'Connecting…' });
  const coverage = h('p', { class: 'adm-footnote' });
  const levels = [['', 'All'], ['error', 'Errors'], ['warn', 'Warnings'], ['info', 'Info'], ['debug', 'Debug']];
  const levelSeg = h('div', { class: 'seg', role: 'radiogroup', 'aria-label': 'Lowest level shown' },
    ...levels.map(([value, label]) => h('button', {
      type: 'button', role: 'radio', 'aria-checked': String(value === state.level), class: value === state.level ? 'is-active' : '',
      'data-level': value, on: { click: () => {
        state.level = value;
        for (const b of levelSeg.children) { b.classList.toggle('is-active', b.dataset.level === value); b.setAttribute('aria-checked', String(b.dataset.level === value)); }
        applyFilter();
      } },
    }, label)));
  const nsInput = h('input', { type: 'search', class: 'adm-search', placeholder: 'Service, e.g. account', 'aria-label': 'Only lines from this service' });
  const findInput = h('input', { type: 'search', class: 'adm-search', placeholder: 'Find in lines', 'aria-label': 'Only lines containing' });

  function lineText(line) {
    const extras = Object.entries(line)
      .filter(([k]) => !['t', 'level', 'ns', 'msg', 'seq'].includes(k))
      .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`)
      .join(' ');
    return { extras, all: `${line.ns || ''} ${line.msg || ''} ${extras}`.toLowerCase() };
  }

  function appendLine(line) {
    const time = new Date(line.t);
    const stamp = Number.isNaN(time.getTime()) ? '' : time.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const { extras, all } = lineText(line);
    const el = h('div', { class: `log-line log-${line.level}`, 'data-text': all },
      h('span', { class: 'log-time', text: stamp }),
      h('span', { class: `log-badge log-badge-${line.level}`, text: line.level }),
      h('span', { class: 'log-ns-name', text: line.ns || '' }),
      h('span', { class: 'log-msg', text: line.msg }),
      extras ? h('span', { class: 'log-extras', text: extras }) : null);
    el.hidden = !!state.find && !all.includes(state.find);
    list.append(el);
    state.shown += 1;
  }

  // Newest at the bottom, like a terminal. Only auto-scroll if the reader is
  // already at the bottom, so scrolling back to read something is not yanked
  // away by the next line.
  const atBottom = () => list.scrollHeight - list.scrollTop - list.clientHeight < 40;
  // Keep the DOM bounded no matter how long the tab is left open.
  const trim = () => { while (list.childElementCount > 500) list.firstElementChild.remove(); };

  async function tick() {
    // A slow response must not overlap the next one-second tick: both would
    // read from the same cursor and every line would be appended twice.
    if (state.paused || state.inFlight) return;
    state.inFlight = true;
    const generation = state.generation;
    const q = new URLSearchParams({ since: String(state.cursor), limit: '200' });
    if (state.level) q.set('level', state.level);
    if (state.ns) q.set('ns', state.ns);
    let res;
    try { res = await api('GET', `/api/admin/logs?${q.toString()}`); }
    finally { state.inFlight = false; }
    // A filter changed while this was in flight; its lines belong to the old view.
    if (generation !== state.generation) { tick(); return; }
    if (!res.ok) { status.textContent = res.data?.error || 'Could not read the log'; return; }
    if (res.data.reset) { list.replaceChildren(); state.shown = 0; state.dropped = 0; }
    coverage.textContent = (res.data.scope === 'server-files'
      ? 'All native services · last 7 days · history survives restarts. '
      : 'This service’s live log buffer. ')
      + 'The latest matching lines are shown. Debug lines require Log detail set to Everything.'
      + (res.data.truncated || res.data.unreadableFiles ? ' Some retained files exceed the read limit or could not be read; inspect the server logs for the complete history.' : '');
    const stick = atBottom();
    state.cursor = res.data.cursor;
    const events = res.data.events || [];
    for (const line of events) appendLine(line);
    if (events.length) trim();
    if (!list.childElementCount) list.append(h('p', { class: 'log-empty', text: 'Nothing logged yet at this level.' }));
    else list.querySelector('.log-empty')?.remove();
    status.textContent = state.paused ? 'Paused'
      : `${state.shown} line${state.shown === 1 ? '' : 's'}${res.data.dropped > state.dropped ? ` · ${res.data.dropped - state.dropped} dropped` : ''}`;
    state.dropped = res.data.dropped;
    if (events.length && stick) list.scrollTop = list.scrollHeight;
  }

  // A filter change re-reads from the start of the buffer, because the filter
  // changes which lines exist as far as this view is concerned.
  function applyFilter() {
    state.ns = nsInput.value.trim();
    state.cursor = 0;
    state.shown = 0;
    state.generation += 1;
    list.replaceChildren();
    tick();
  }
  nsInput.addEventListener('input', debounce(applyFilter, 300));
  findInput.addEventListener('input', debounce(() => {
    state.find = findInput.value.trim().toLowerCase();
    for (const line of list.querySelectorAll('.log-line')) line.hidden = !!state.find && !line.dataset.text.includes(state.find);
  }, 120));

  const pause = h('button', { class: 'btn btn-sm btn-quiet', type: 'button' }, icon('clock', 14), 'Pause');
  pause.addEventListener('click', () => {
    state.paused = !state.paused;
    pause.replaceChildren(icon(state.paused ? 'refresh' : 'clock', 14), state.paused ? 'Resume' : 'Pause');
    status.textContent = state.paused ? 'Paused' : status.textContent;
    if (!state.paused) tick();
  });
  const clear = h('button', { class: 'btn btn-sm btn-quiet', type: 'button', on: { click: () => { list.replaceChildren(); state.shown = 0; } } }, 'Clear');

  const logCard = card('Live log', { actions: [status, pause, clear] },
    h('div', { class: 'adm-toolbar' }, levelSeg, nsInput, findInput),
    list);
  logCard.classList.add('adm-log-card');
  container.append(logCard, coverage);

  await tick();
  stopPoll();
  pollTimer = setInterval(tick, 1000);
}

/**
 * The admin area. Kept out of ROUTES because reaching it does not require the
 * signed-in-and-nav-highlighted treatment the household surfaces get: the
 * server decides who may see it, and it has its own sub-navigation. A route may
 * carry a query (#/admin/settings?group=mail), which is passed to its renderer.
 */
const ADMIN_ROUTES = {
  '#/admin': renderAdminOverview,
  '#/admin/settings': renderAdminSettings,
  '#/admin/robots': renderAdminRobots,
  '#/admin/people': renderAdminPeople,
  '#/admin/voice-turns': renderAdminVoiceTurns,
  '#/admin/logs': renderAdminLogs,
};

async function route() {
  clearPrivateView();
  navSeq += 1;
  stopPoll();
  await consumePublicMailAction();
  // `/admin` is served by the same shell; treat the path as the route so the
  // bare URL works rather than silently landing on the overview.
  const requestedHash = (location.pathname === '/admin' && !location.hash) ? '#/admin' : (location.hash || '#/');
  // Preserve bookmarks for the former People and technical Messages pages.
  // Both now have a single, user-facing destination.
  const legacyRoute = {
    '#/people': '#/loop', '#/messaging': '#/inbox', '#/admin/config': '#/admin/settings', '#/admin/admins': '#/admin/people',
  }[requestedHash];
  const hash = legacyRoute || requestedHash;
  if (legacyRoute) history.replaceState(null, '', legacyRoute);
  // An admin page may carry a query after its route: #/admin/settings?group=mail.
  const [adminRoute, adminQuery = ''] = hash.split('?');

  await refreshMe();

  if (ADMIN_ROUTES[adminRoute]) {
    // Administrator access follows the signed-in account, so there is nothing to
    // unlock here: a signed-out visitor gets the sign-in screen instead, and a
    // signed-in non-admin is told so rather than being asked for a password.
    if (!me) return renderAuth();
    shell.hidden = false;
    authRoot.hidden = true;
    paintNav(adminRoute);
    try {
      await ADMIN_ROUTES[adminRoute](new URLSearchParams(adminQuery));
    } catch (error) {
      show(page('Something went wrong', '',
        errorBox('This page failed to render.', String(error?.message || error))));
    }
    return undefined;
  }

  if (!me) return renderAuth();

  // One robot's settings: #/robot/<loopId>, optionally /<section>.
  const robotSettings = /^#\/robot\/([^/]+)(?:\/([a-z]+))?$/.exec(hash);
  paintNav(robotSettings ? '#/robot' : (ROUTES[hash] ? hash : '#/'));
  const render = robotSettings
    ? () => renderRobotSettings(decodeURIComponent(robotSettings[1]), robotSettings[2])
    : (ROUTES[hash] || renderHome);
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
