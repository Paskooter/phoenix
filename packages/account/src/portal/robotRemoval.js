// Owner-scoped removal: only server stores and trusted service peers are used.
import { sendJson } from '@phoenix/common';
import { removalHandlers, robotRemovalTarget } from '../admin/removalRoutes.js';
import { requireUser } from './session.js';

const sameId = (a, b) => a != null && b != null && String(a) === String(b);
const notFound = () => ({ status: 404, error: 'Owned robot not found' });

function ownedTarget(store, { account, body }) {
  const loop = typeof body?.loopId === 'string' ? store.loops.get(body.loopId) : null;
  if (!loop || loop.isDeleted === true || !sameId(loop.owner, account._id)) return notFound();
  const robot = loop.robot ? store.accounts.get(String(loop.robot)) : null;
  if (!robot?.friendlyId) return notFound();
  const target = robotRemovalTarget(store, robot);
  // Imported data can contain more than one loop for a robot. A live household
  // owned by someone else must never be removed through this owner's action.
  if (target.loops.some((item) => item.isDeleted !== true && !sameId(item.owner, account._id))) return notFound();
  return { ...target, label: loop.name || robot.friendlyId, confirmWith: loop.name || robot.friendlyId };
}

// Owners get names and counts, not server paths, credentials or contact details.
function ownerView(result) {
  if (!result?.account) return undefined;
  return {
    kind: result.kind, label: result.label,
    ...(result.confirmWith ? { confirmWith: result.confirmWith } : {}),
    ...(result.removed ? { removed: true } : {}),
    account: {
      robot: { friendlyId: result.account.robot.friendlyId },
      loops: result.account.loops.map(({ name, members }) => ({ name, members })),
      removed: result.account.removed,
      memberships: result.account.memberships,
    },
    services: result.services.map((entry) => ({
      service: entry.service,
      stores: (entry.stores || []).map(({ name, removed }) => ({ name, removed })),
      directories: entry.directories?.length ? [`${entry.directories.length} saved folders`] : [],
      ...(entry.error || entry.skipped ? { unavailable: true } : {}),
    })),
  };
}

export function ownerRobotRemovalRoutes(store, options = {}) {
  const attempts = { preview: new Map(), remove: new Map() };
  const windowMs = 15 * 60_000;
  const allowRequest = (accountId, operation, res) => {
    const now = Date.now();
    const rows = attempts[operation];
    for (const [id, row] of rows) if (now - row.started >= windowMs) rows.delete(id);
    const row = rows.get(accountId) || { started: now, count: 0 };
    rows.set(accountId, row);
    row.count += 1;
    if (row.count <= 10) return true;
    res.setHeader('retry-after', String(Math.ceil((windowMs - (now - row.started)) / 1000)));
    sendJson(res, 429, { error: 'Too many removal requests. Try again in a few minutes.' });
    return false;
  };
  const handlers = removalHandlers(store, {
    ...options,
    resolve: (ctx) => ownedTarget(store, ctx),
    sendJson: (res, status, body) => sendJson(res, status, status === 502
      ? { error: 'Could not remove this Jibo just now. Try again in a few minutes.' } : body),
  });
  const asOwner = (operation) => async (ctx) => {
    const account = requireUser(store, ctx.req, ctx.res);
    if (!account) return undefined;
    const target = ownedTarget(store, { ...ctx, account });
    if (target.error) return sendJson(ctx.res, target.status, { error: target.error });
    if (!allowRequest(account._id, operation, ctx.res)) return undefined;
    return ownerView(await handlers[operation]({ ...ctx, account }));
  };
  return {
    'POST /api/robot/removal/preview': asOwner('preview'),
    'POST /api/robot/removal': asOwner('remove'),
  };
}
