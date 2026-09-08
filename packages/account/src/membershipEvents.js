// srv-account-ws@6cea434 LoopController membership events, after successful save.
import { normalizeInvitationProviders } from './invitationProviders.js';

class MembershipEvent {
  constructor(payload) {
    this.payload = payload || {};
    this.payload.eventKey = this.constructor.name;
    this.validate();
  }
  validate() {
    const required = ['loopId', 'ownerId'];
    if (this.constructor.name !== 'MemberRemovedFromLoop') required.push('accountId');
    for (const key of required) {
      if (typeof this.payload[key] !== 'string' || !this.payload[key]) throw new TypeError(`${key} is required`);
    }
    for (const key of ['accountId', 'email']) {
      if (this.payload[key] !== undefined && (typeof this.payload[key] !== 'string' || !this.payload[key])) throw new TypeError(`${key} must be a nonempty string`);
    }
    if (this.payload.memberIds !== undefined && !Array.isArray(this.payload.memberIds)) throw new TypeError('memberIds must be an array');
    const guardian = this.payload.invitedAsLegalGuardian;
    if (guardian !== undefined && typeof guardian !== 'boolean' && !['true', 'false'].includes(String(guardian).toLowerCase())) throw new TypeError('invitedAsLegalGuardian must be boolean');
  }
}
export class InvitationToLoopAccepted extends MembershipEvent {}
export class InvitationToLoopDeclined extends MembershipEvent {}
export class MemberRemovedFromLoop extends MembershipEvent {}
const classes = { InvitationToLoopAccepted, InvitationToLoopDeclined, MemberRemovedFromLoop };

export function dispatchMembershipEvent(kind, loop, { accountId, invitedAsLegalGuardian, targetMember } = {}, inputProviders) {
  const memberIds = loop.members.filter((member) => String(member.status).toLowerCase() === 'accepted' && member.accountId).map((member) => member.accountId);
  const payload = { loopId: String(loop._id), memberIds, ownerId: String(loop.owner) };
  if (kind === 'MemberRemovedFromLoop') {
    if (targetMember.accountId) {
      memberIds.push(targetMember.accountId); // Source includes the removed recipient, without deduplication.
      payload.accountId = String(targetMember.accountId);
    }
    if (targetMember.memberProperties?.email) payload.email = targetMember.memberProperties.email;
  } else {
    payload.accountId = String(accountId);
    if (kind === 'InvitationToLoopAccepted') payload.invitedAsLegalGuardian = invitedAsLegalGuardian;
  }
  const Event = classes[kind];
  const event = new Event(payload);
  const providers = normalizeInvitationProviders(inputProviders);
  const sender = providers.eventSender;
  const result = typeof sender === 'function' ? sender(event) : sender?.send
    ? sender.send(event) : Promise.reject(Object.assign(new Error('Membership event transport unavailable'), { code: 'EVENT_TRANSPORT_UNAVAILABLE' }));
  Promise.resolve(result).catch((error) => {
    try { providers.onError?.(error, kind); } catch { /* Source logging cannot reject the account response. */ }
  });
  return event;
}
