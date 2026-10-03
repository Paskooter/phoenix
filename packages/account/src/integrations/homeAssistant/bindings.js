// Authorization is always derived from live Account/Loop records. Bindings
// contain robot account IDs, never identities supplied in robot context.
export function liveBinding(store, ownerId, binding) {
  const owner = store.accounts.get(ownerId);
  const robot = store.accounts.get(binding.accountId);
  const loop = store.loops.get(binding.loopId);
  return !!(owner && !owner.friendlyId && owner.isActive !== false && !owner.isDeleted
    && robot?.friendlyId && robot.isActive !== false && !robot.isDeleted
    && loop && !loop.isDeleted && !loop.isSuspended && String(loop.owner) === String(ownerId)
    && String(loop.robot) === String(robot._id));
}

// Run synchronously on every store write, including ownership transfer and
// account deletion. Even a later transfer back cannot resurrect credentials.
export function reconcileHomeAssistantBindings(store, now = Date.now()) {
  for (const row of store.homeAssistantInstallations?.values() || []) {
    if (!row.revokedAt && !row.bindings.every((binding) => liveBinding(store, row.ownerId, binding))) {
      row.revokedAt = now;
      row.reason = 'ownership_changed';
    }
  }
  for (const [id, row] of store.homeAssistantCodes?.entries() || []) {
    if (row.expiresAt <= now || !row.bindings.every((binding) => liveBinding(store, row.ownerId, binding))) {
      store.homeAssistantCodes.delete(id);
    }
  }
}
