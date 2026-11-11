// The shared resend controls in the console, driven with a tiny fake DOM so the
// insert-after-await timing of the Account page is deterministic.
import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.addEventListener ??= () => {};
const { createEmailVerificationUi } = await import('../portal/email-verification.js');

function h(tag, attrs = {}, ...children) {
  const node = { tag, attrs, children: children.flat().filter(Boolean), isConnected: false,
    disabled: !!attrs.disabled, textContent: typeof children[0] === 'string' ? children[0] : attrs.text || '' };
  node.replaceChildren = (...next) => { node.children = next; };
  node.append = (...next) => { node.children.push(...next); setConnected(node, node.isConnected); };
  return node;
}
const walk = (node, fn) => { if (!node || typeof node !== 'object') return; fn(node); for (const child of node.children || []) walk(child, fn); };
const find = (root, attr) => { let hit = null; walk(root, (node) => { if (!hit && node.attrs?.[attr] !== undefined) hit = node; }); return hit; };
const setConnected = (root, value) => walk(root, (node) => { node.isConnected = value; });
const settle = () => new Promise((done) => setImmediate(done));

function harness(status) {
  const account = { id: 'a1', email: 'person@fixture.test', emailVerified: false };
  let calls = 0;
  const ui = createEmailVerificationUi({
    api: async () => { calls += 1; return { ok: true, data: status }; },
    h, icon: () => null, notify: () => {}, getAccount: () => account, refreshAccount: async () => {},
  });
  return { ui, account, calls: () => calls };
}

test('the Account card button is enabled when its card is inserted after an await', async () => {
  const { ui, account } = harness({ available: true, emailVerified: false, retryAfterSeconds: 0 });
  const card = ui.accountCard(account);
  // renderProfile awaits other cards before it shows this one.
  await settle();
  setConnected(card, true);
  const button = find(card, 'data-verification-resend');
  assert.equal(button.disabled, false);
  assert.equal(button.textContent, 'Send verification email');
});

test('after a reload the banner status check also paints the not-yet-shown Account card', async () => {
  const { ui, account, calls } = harness({ available: true, emailVerified: false, retryAfterSeconds: 0 });
  const banner = h('div');
  banner.isConnected = true;
  ui.paintBanner(banner, account);
  const card = ui.accountCard(account); // status check is shared, so no second request
  await settle();
  setConnected(card, true);
  assert.equal(calls(), 1);
  assert.equal(find(card, 'data-verification-resend').disabled, false);
});

test('a cooldown from the server keeps a late-inserted button disabled with its countdown', async () => {
  const { ui, account } = harness({ available: true, emailVerified: false, retryAfterSeconds: 42 });
  const card = ui.accountCard(account);
  await settle();
  setConnected(card, true);
  const button = find(card, 'data-verification-resend');
  assert.equal(button.disabled, true);
  assert.match(button.textContent, /^Resend in 4[12]s$/);
});

test('a button that was shown and then removed stops being painted', async () => {
  const { ui, account } = harness({ available: true, emailVerified: false, retryAfterSeconds: 0 });
  const first = ui.accountCard(account);
  setConnected(first, true);
  await settle();
  const old = find(first, 'data-verification-resend');
  setConnected(first, false);
  old.textContent = 'gone';
  // A later repaint (the replacement card) must not touch the removed one.
  const second = ui.accountCard(account);
  setConnected(second, true);
  await settle();
  assert.equal(old.textContent, 'gone');
  assert.equal(find(second, 'data-verification-resend').disabled, false);
});
