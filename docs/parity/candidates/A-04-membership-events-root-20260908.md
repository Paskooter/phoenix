# A-04 membership lifecycle events

Status: **implemented candidate; pending independent review and integration**.
Based on invitation deployment candidate `ba0e3b417cd7e2c95dd3c4ec5d7cf671499e1b7e`.

The pinned Account controller `6cea43470825657d6a5722162f28c8f233153ee2`
emits separate events after membership state saves. Phoenix previously saved
acceptance, decline, and removal without those events. This candidate adds
`InvitationToLoopAccepted`, `InvitationToLoopDeclined`, and
`MemberRemovedFromLoop` through the configured event sender.

The payloads preserve accepted-member recipients, the extra removed-member
recipient (including duplicates), optional email, and the source first-match
legal-guardian flag when duplicate memberships exist. Delivery rejection is
contained after the successful save; a failed save emits no event. The accepted
response remains unpopulated, while declined and removed responses are populated.
Legacy uppercase statuses normalize as in the existing storage adaptation.

Validation:

- Two focused tests exercise Account and Classic, six event-producing requests,
  durable save ordering, rejected delivery, duplicate membership behavior, and
  failed-save suppression.
- All three serialized event payloads match the original `@jibo/server@4.0.12`
  event constructors under Node 8.9.4.
- Full candidate suite: **873 passed, 7 skipped, 0 failed**.

Private synthetic receipts are under
`.parity/reviews/a04-membership-events-root-20260908/`. No household captures,
real mail, or robot mutations were used. Exact source-controller execution,
generated-client controls, transport acceptance, and integration remain open.
The invitation deployment dependency is also still under review. This result
does not complete A-04 or change the verified checklist percentage.
