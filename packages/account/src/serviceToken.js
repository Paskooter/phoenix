import { randomUUID } from 'node:crypto';
import { createOwnerAccount, mintSetupToken } from './model.js';

export function createServiceSetupToken(store, { uuid = randomUUID } = {}) {
  const postfix = uuid();
  const account = createOwnerAccount(store, {
    email: `service-mode-${postfix}@jibo.com`, password: postfix,
  });
  // AccountController.create updates the first matching invitation after the
  // account save. Loop.update sets one member accountId without save hooks.
  const existing = [...store.loops.values()].find(loop => loop.isDeleted !== true
    && (loop.members || []).some(member => member.memberProperties?.email === account.email));
  if (existing) {
    const next = JSON.parse(JSON.stringify(existing));
    next.members.find(member => member.memberProperties?.email === account.email).accountId = account._id;
    store.loops.set(existing._id, next);
    try { store.flush(); }
    catch (error) { store.loops.set(existing._id, existing); throw error; }
  }
  return mintSetupToken(store, account._id, null);
}
