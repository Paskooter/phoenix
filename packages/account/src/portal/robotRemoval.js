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
  if (!result) return result;
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
  const handlers = removalHandlers(store, {
    ...options,
    resolve: (ctx) => ownedTarget(store, ctx),
    sendJson: (res, status, body) => sendJson(res, status, status === 502
      ? { error: 'Could not remove this Jibo just now. Try again in a few minutes.' } : body),
  });
  const asOwner = (handler) => async (ctx) => {
    const account = requireUser(store, ctx.req, ctx.res);
    if (!account) return undefined;
    return ownerView(await handler({ ...ctx, account }));
  };
  return {
    'POST /api/robot/removal/preview': asOwner(handlers.preview),
    'POST /api/robot/removal': asOwner(handlers.remove),
  };
}
