// JotMessageCreated -> push notification fan-out.
//
// WHY THIS EXISTS
// `jot.js` produces a complete `JotMessageCreated` event and hands it to an
// `onEvent` sink, but nothing consumed it: the original fan-out went over Kafka,
// and the bus is gone. That was recorded as an unrecoverable gap. It is not.
//
// RECOVERED SOURCE (read from the Jibo archive at pvindex.org/gitea, and
// re-read directly by root rather than taken on a worker's word):
//   server/push-ws/src/event.handlers/jot.message.created.handler.js
//   server/push-ws/src/event.handlers/jot.base.event.handler.js
//   server/message-bus/src/events/jotEvents.js   (the event schema)
// The archive also carries the Confluence page "Push notifications detailed
// description" (MOB), which documents the iOS/Android payload contract and the
// notification `type` values.
//
// `push-ws` was the ONE consumer of this event. The investigation checked
// notification-ws (REST-only), entrypoint-socket-ws (robot socket delivery) and
// jibo-websocket (the `ws` npm package) and found no other subscriber, so
// reproducing this handler reproduces the whole observable side effect.
//
// THE SOURCE ALGORITHM, verbatim in behaviour:
//   1. members  = accountClient.getLoopMembers(senderId, loopId)
//   2. sender   = accountClient.getAccountById(senderId)
//   3. devices  = accountController.listDevices(memberIds)
//      loops    = accountClient.listAssociatedLoops(memberIds)
//   4. settings = JotSettingsController.getJotSettingsForAccounts(memberIds)
//   5. per member WITH devices: isSilent(member, event, notificationMode)
//   6. badge    = jotClient.getNumberOfUnreadMessagesInLoops(memberId, loopIds)
//   7. notify each device
//
// isSilent (source static method, reproduced exactly):
//   - the sender never gets a non-silent push, even under 'always'
//   - 'always'                      -> non-silent for everyone else
//   - 'tagged', or no setting at all -> non-silent IFF the member id appears in
//     event.payload.tags. The source comment is explicit that an undefined
//     pushNotificationsMode defaults to tagged.
//   - anything else                 -> silent
//
// SEAMS. The account service hop and the mobile push providers are dead, so both
// are injected. With no `account` seam wired the consumer cannot resolve loop
// membership and does nothing rather than inventing recipients — the same
// posture jot.js takes for its membership gates.

/** server/push-ws jot.message.created.handler.js:16-27 — reproduced exactly. */
export function isSilentForMember({ member, event, notificationMode }) {
  const payload = (event && event.payload) || {};
  const isSender = member.memberId === payload.senderId;
  let isSilent = true;
  if (notificationMode === 'always' && !isSender) {
    isSilent = false;
  } else if (!notificationMode || notificationMode === 'tagged') {
    const tags = payload.tags;
    // The source uses `==` here, so a numeric id and its string form match.
    // eslint-disable-next-line eqeqeq
    if (Array.isArray(tags) && tags.findIndex((tag) => tag == member.memberId) >= 0) {
      isSilent = false;
    }
  }
  return isSilent;
}

/** The notification object push-ws hands to MobileController.send. */
export function buildJotNotification({ event, sender, badge, isSilent }) {
  const payload = (event && event.payload) || {};
  return {
    isSilent,
    locKey: 'new.message.from.member',
    locArgs: [`${(sender && sender.firstName) || ''} ${(sender && sender.lastName) || ''}`],
    body: payload.content,
    badge,
    data: {
      messageId: payload.messageId,
      senderId: payload.senderId,
      loopId: payload.loopId,
      type: isSilent ? 'jot-created-silent' : 'jot-created-tagged',
    },
  };
}

/**
 * Build the consumer. Returns an `onEvent` sink for `makeJotHandler`.
 *
 * @param {object} deps
 * @param {{get:Function}} [deps.account]   loop membership + account lookup seam
 * @param {object}  deps.registry           DeviceRegistry (listDevices)
 * @param {object}  deps.store              JotStore (countUnread)
 * @param {object}  [deps.push]             PushProvider (send)
 * @param {Function} [deps.jotSettings]     accountId -> 'always'|'tagged'|undefined
 * @param {object}  [deps.logger]
 */
export function createJotMessageCreatedConsumer({
  account, registry, store, push, jotSettings, logger,
} = {}) {
  const log = logger || { info: () => {}, warn: () => {} };

  return async function onJotEvent(event) {
    // The producer hands over a JotMessageCreated INSTANCE, whose identity lives
    // in `payload.eventKey` (message-bus BaseEvent stamps it from the
    // constructor name). Instances carry no `.name` of their own, so matching on
    // that silently ignored every real event. `event.name` is still accepted for
    // plain object literals.
    const eventKey = event && ((event.payload && event.payload.eventKey) || event.name);
    if (eventKey !== 'JotMessageCreated') return { delivered: 0, reason: 'not-a-jot-created-event' };
    if (!account || typeof account.get !== 'function') {
      // No membership source: the same LAN-trust posture jot.js documents.
      return { delivered: 0, reason: 'no-account-seam' };
    }
    const payload = event.payload || {};

    const loop = await account.get(payload.loopId);
    if (!loop) return { delivered: 0, reason: 'loop-not-found' };

    const members = (Array.isArray(loop.members) ? loop.members : [])
      .filter((member) => member && String(member.status || '').toLowerCase() === 'accepted')
      .map((member) => ({ memberId: member.memberId ?? member.accountId }))
      .filter((member) => member.memberId !== undefined && member.memberId !== null);

    const sender = (typeof account.getAccountById === 'function'
      ? await account.getAccountById(payload.senderId)
      : (loop.members || []).find((member) => (member.memberId ?? member.accountId) === payload.senderId)) || {};

    const memberIds = members.map((member) => member.memberId);
    const devicesByAccount = registry && typeof registry.listDevices === 'function'
      ? registry.listDevices(memberIds) : {};

    const settings = typeof jotSettings === 'function' ? await jotSettings(memberIds) : {};

    const notifications = [];
    let delivered = 0;
    for (const member of members) {
      const devices = devicesByAccount[member.memberId];
      if (!devices || !devices.length) continue; // source: `continue` on no devices

      const isSilent = isSilentForMember({
        member, event, notificationMode: settings ? settings[member.memberId] : undefined,
      });

      // Source reads each member's associated loops; the recovered store keeps
      // one loop per message, so the badge is counted over that loop.
      const loopIds = [payload.loopId];
      const badge = store && typeof store.countUnread === 'function'
        ? store.countUnread({ accountId: member.memberId, loopIds })
        : 0;

      const notification = buildJotNotification({ event, sender, badge, isSilent });
      notifications.push({ memberId: member.memberId, notification });

      for (const device of devices) {
        if (push && typeof push.send === 'function') {
          try {
            await push.send({ device, notification });
            delivered += 1;
          } catch (error) {
            log.warn('jot push failed', { error: error && error.message });
          }
        }
      }
    }
    log.info('JotMessageCreated fan-out', { members: members.length, delivered });
    return { delivered, notifications };
  };
}
