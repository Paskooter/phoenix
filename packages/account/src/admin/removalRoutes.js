// Administrator removal of a robot or a loop, across every service that holds its data.
//
//   GET  /api/admin/loops              every loop, with its owner and robot
//   POST /api/admin/removal/preview    { robot: <friendlyId> } or { loopId }: what would be removed
//   POST /api/admin/removal            the same, plus confirm: <friendlyId or loopId>
//
// The same preview and removal are also served at /internal/admin/removal[/preview] for an
// operator with a shell on the server: they take the internal peer token from the instance
// environment file instead of an administrator session, e.g.
//   curl -s -X POST localhost:9011/internal/admin/removal/preview \
//     -H "x-phoenix-internal-token: $ETCO_account_internalPeerToken" -H 'content-type: application/json' \
//     -d '{"robot":"aero-root-okra-knit"}'
//
// Removing a robot removes its robot account, every loop it belongs to, and everything
// Classic and History hold for them: robot events, keys, backups, media, messages,
// notification tokens, skill launches. The loop owner's own account is kept. Removing a
// loop removes only that loop and its data; its robot account stays.
//
// This is the reproducible version of what was done by hand before a robot was reflashed
// and set up from scratch: afterwards the server has never heard of it, so QR setup
// creates it again. Every service first saves a backup copy under removal-backups/.

import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { net, purgeBackupDir, purgeCollections, purgeNeedles, requireInternalPeer } from '@phoenix/common';
import { classicBaseUrl } from '../portal/classicClient.js';

// Account-store collections that can reference a robot or loop. `accounts` and `loops`
// are handled explicitly; `settings` only by the robot's own entry, so an owner's
// report settings are never caught by a stray mention.
export const SIDE_COLLECTIONS = ['tokens', 'sessions', 'notificationOutbox', 'webPushSubscriptions',
  'emailResets', 'phoneVerifications', 'oauthClients', 'homeAssistantInstallations', 'homeAssistantCodes'];

/** The other services that keep a robot's, a loop's or a person's records. Classic must answer. */
export const defaultPeers = () => [
  { name: 'classic', base: classicBaseUrl(), required: true },
  { name: 'history', base: net('history', { required: false }), required: false },
];

/** Where removal and deletion backups go: beside the data, like every other service's. */
export const defaultBackupRoot = (store) => (process.env.PHOENIX_DATA_DIR
  ? join(process.env.PHOENIX_DATA_DIR, 'removal-backups')
  : join(dirname(store.file), 'removal-backups'));

function resolveTarget(store, body) {
  if (typeof body?.robot === 'string' && body.robot.trim()) {
    const wanted = body.robot.trim().toLowerCase();
    const robot = [...store.accounts.values()]
      .find((account) => account.friendlyId && String(account.friendlyId).toLowerCase() === wanted);
    if (!robot) return { status: 404, error: `No robot named ${body.robot.trim()}` };
    const loops = [...store.loops.values()].filter((loop) => String(loop.robot) === String(robot._id));
    return {
      kind: 'robot', label: robot.friendlyId, robot, loops,
      ids: [robot._id, robot.accessKeyId, robot.friendlyId, ...loops.map((loop) => loop._id)].filter(Boolean).map(String),
    };
  }
  if (typeof body?.loopId === 'string' && body.loopId.trim()) {
    const loop = store.loops.get(body.loopId.trim());
    if (!loop) return { status: 404, error: `No loop with id ${body.loopId.trim()}` };
    return { kind: 'loop', label: String(loop._id), robot: null, loops: [loop], ids: [String(loop._id)] };
  }
  return { status: 400, error: 'Name a robot (its friendly id) or a loop id' };
}

function loopView(store, loop) {
  const owner = loop.owner ? store.accounts.get(String(loop.owner)) : null;
  const robot = loop.robot ? store.accounts.get(String(loop.robot)) : null;
  return {
    id: String(loop._id),
    name: loop.name || null,
    ownerEmail: owner?.email || null,
    robotFriendlyId: robot?.friendlyId || null,
    members: (loop.members || []).length,
    isDeleted: loop.isDeleted === true,
    created: loop.created || null,
  };
}

/** What the account store holds for a target; `apply` also removes it. */
function accountStorePlan(store, target, { apply = false } = {}) {
  const needles = purgeNeedles(target.ids);
  const loopIds = new Set(target.loops.map((loop) => String(loop._id)));
  const robotId = target.robot ? String(target.robot._id) : null;
  const collections = {};
  for (const name of SIDE_COLLECTIONS) if (store[name]) collections[name] = store[name];
  const removed = purgeCollections(collections, needles, { dryRun: !apply });
  if (robotId && store.settings?.has(robotId)) {
    removed.settings = 1;
    if (apply) store.settings.delete(robotId);
  }
  // The robot's membership in any loop that is not itself being removed.
  let memberships = 0;
  if (robotId) {
    for (const loop of store.loops.values()) {
      if (loopIds.has(String(loop._id))) continue;
      const before = (loop.members || []).length;
      const kept = (loop.members || []).filter((member) => String(member?.accountId) !== robotId);
      memberships += before - kept.length;
      if (apply && kept.length !== before) loop.members = kept;
    }
  }
  if (apply) {
    for (const id of loopIds) store.loops.delete(id);
    if (robotId) store.accounts.delete(robotId);
    store.flush();
  }
  return {
    robot: target.robot ? { id: robotId, friendlyId: target.robot.friendlyId } : null,
    loops: target.loops.map((loop) => loopView(store, loop)),
    removed,
    memberships,
  };
}

async function callPeer(fetchImpl, base, body) {
  const response = await fetchImpl(`${base.replace(/\/$/, '')}/internal/admin/purge`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-phoenix-internal-token': process.env.ETCO_account_internalPeerToken || '',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

/**
 * Send one purge request to each peer in turn. A required peer that fails throws,
 * naming it, so the caller can stop before changing the account store; an optional
 * one is reported instead.
 */
export async function purgePeers(peers, fetchImpl, body) {
  const results = [];
  for (const peer of peers) {
    if (!peer.base) {
      results.push({ service: peer.name, skipped: 'address not configured' });
      continue;
    }
    try {
      results.push({ service: peer.name, ...await callPeer(fetchImpl, peer.base, body) });
    } catch (error) {
      if (peer.required) throw Object.assign(new Error(`${peer.name}: ${error.message}`), { peer: peer.name });
      results.push({ service: peer.name, error: error.message });
    }
  }
  return results;
}

export function adminRemovalRoutes(store, {
  requireAdmin,
  sendJson,
  fetch: fetchImpl = globalThis.fetch,
  peers = defaultPeers,
  backupRoot = () => defaultBackupRoot(store),
} = {}) {
  const askPeers = (target, dryRun) => purgePeers(peers(), fetchImpl, { ids: target.ids, dryRun });

  const preview = async ({ res, body }) => {
    const target = resolveTarget(store, body);
    if (target.error) return sendJson(res, target.status, { error: target.error });
    let services;
    try { services = await askPeers(target, true); }
    catch (error) { return sendJson(res, 502, { error: `Could not preview the removal (${error.message})` }); }
    return { kind: target.kind, label: target.label, confirmWith: target.label,
      account: accountStorePlan(store, target), services };
  };

  const remove = async ({ res, body }) => {
    const target = resolveTarget(store, body);
    if (target.error) return sendJson(res, target.status, { error: target.error });
    if (typeof body?.confirm !== 'string' || body.confirm.trim().toLowerCase() !== target.label.toLowerCase()) {
      return sendJson(res, 400, { error: `Type ${target.label} to confirm the removal` });
    }
    const backupDir = purgeBackupDir(backupRoot(), 'removal', 'account');
    mkdirSync(backupDir, { recursive: true, mode: 0o700 });
    copyFileSync(store.file, join(backupDir, 'store.json'));
    let services;
    try {
      services = await askPeers(target, false);
    } catch (error) {
      // Classic failed before the account store was touched; nothing here changed.
      return sendJson(res, 502, { error: `Removal stopped; the account store was not changed (${error.message})` });
    }
    const account = accountStorePlan(store, target, { apply: true });
    return { kind: target.kind, label: target.label, removed: true, account: { ...account, backupDir }, services };
  };

  const asAdmin = (handler) => (ctx) => (requireAdmin(store, ctx.req, ctx.res) ? handler(ctx) : undefined);
  const asPeer = (handler) => (ctx) => (requireInternalPeer(ctx.req, ctx.res) ? handler(ctx) : undefined);

  return {
    'POST /api/admin/removal/preview': asAdmin(preview),
    'POST /api/admin/removal': asAdmin(remove),
    'POST /internal/admin/removal/preview': asPeer(preview),
    'POST /internal/admin/removal': asPeer(remove),

    'GET /api/admin/loops': ({ req, res }) => {
      if (!requireAdmin(store, req, res)) return undefined;
      return { loops: [...store.loops.values()].map((loop) => loopView(store, loop)) };
    },
  };
}
