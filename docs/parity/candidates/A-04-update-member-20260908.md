# A-04 candidate: `UpdateLoopMember`

Task: `A-04` bounded UpdateLoopMember implementation
Worktree: `.parity/worktrees/a04-update-member-20260908`
Branch: `codex/candidate-a04-update-member-20260908`
Base: `d7934a6d1fb6ef92187bf6a2c54034aca4b3d295`
Status: **implementation candidate, unverified; root review required.**

This candidate adds the `Loop_20160324.UpdateLoopMember` AWS-JSON operation to
the account service. It keeps the prior membership and profile operations
unchanged and uses synthetic tests only. It does not close A-04 or claim full
Loop API parity.

## Source and client contract

The controller and handler were read from
`jiborobot/srv-account-ws@6cea43470825657d6a5722162f28c8f233153ee2`:

- `src/controllers/loop.ctrl.ts`, `updateMember`, lines 324–390
- `src/handlers/loop.handler.ts`, mapping and `UpdateMember`, lines 12–36 and 104–127
- `src/errors/loop.ts`, the five UpdateMember-specific errors
- `src/schemes/loop.ts`, member fields and JSON projection
- `src/schemes/member.status.ts`, lower-case statuses

The locally pinned source-file hashes are recorded in the private review
manifest `.parity/reviews/a04-member-profile-review-20260908/manifest.json`:

| Source file | SHA-256 |
| --- | --- |
| `loop.ctrl.ts` | `8eab9312ba611b1dc5735599521bf73f1dbd2ede49f8da53ad3b4b543d729024` |
| `loop.handler.ts` | `abb558d7f7b873b80d765d6fde344d56876e408ce6bdf928be7a57b37605826d` |
| `loop.ts` | `66148531c2308d76a281cc5e82bac2d70e0adf7de7e14d7997dbca83654649f3` |
| `account.ts` | `1d69c02223ec3df088bbfa10c1ff1c8b29a4f003f9229fa89f3c531ee1f3b2c5` |
| `base.loop.ctrl.ts` | `b85870f98589aa5c932d5b14942cae803cba355b7f8c15aacea2925192b1f3d9` |

The archived generated Loop API model
`jiborobot/srv-jibo-server-client` (`apis/loop-2016-03-24.normal.json`) maps
the SDK operation `UpdateMember` to wire name `UpdateLoopMember`, requires
`loopId` and `id`, allows `email`, `firstName`, `lastName`, `gender`,
`birthday`, `isChild`, and `phoneNumber`, and declares a `Loop` output. Its
local `be-12.0.0` copy is SHA-256
`1f3731c87e5f5173361ba7f817cc843818693133ef3310640b03c7bf38be3e5e`.
The source handler schema does not validate or read `isChild`; it is an
allow-unknown API-model field and is intentionally ignored.

## Implemented behavior

- Finds the member before checking authorization, so an unknown member returns
  `MEMBER_NOT_FOUND` before an ownership error.
- A child uses `CAN_BE_ACCESSED_BY_LEGAL_GUARDIAN`; the guardian member must
  have the requesting account id. Other members allow the loop owner or robot
  and return `CAN_BE_ACCESSED_BY_OWNER_OR_ROBOT` otherwise.
- Editable members are invited members, child members, or accepted members
  without a stored member email. Other states return
  `ONLY_INVITED_OR_CHILD_EDITABLE`.
- Applies source `||` assignments for first name, last name, gender, birthday,
  and phone number. The handler trims names, lowercases email, allows a null
  birthday, and preserves unknown properties like the source decorator.
- A member email can be assigned once. An active matching member returns
  `MEMBER_EMAIL_EXISTS`; a matching removed or declined member is removed from
  the draft before the new invitation is assigned. Existing account lookup is
  the source-equivalent `Account.findOne({ email })` seam, including its lack
  of an `isDeleted` predicate.
- New email assignment sets `isChild` false, changes status to invited, stores a
  new invitation code, and persists through the existing LoopUpdated outbox.
- The source method has no suspended-loop guard; the candidate preserves that
  behavior.
- The source derives child authorization from service `isCoppaEnabled`
  configuration. Phoenix has no corresponding service-config seam, so this
  candidate uses the stored `memberProperties.isChild` branch; COPPA-off
  authorization remains unverified.
- All changes occur on a detached loop draft and pass a pre-mutation snapshot
  into the existing save/outbox rollback path. An injected outbox failure leaves
  the shared map object, persisted bytes, and outbox unchanged.

## Provider and persistence limits

The source sends invitation mail and an `InvitedToJoinLoop` event before the
loop save. Phoenix has no configured mail/EventSender seam on this face, so the
candidate does not claim to send either side effect and does not create a fake
delivery result. The successful local state change still records the existing
LoopUpdated row. Mongo query/index behavior, real mail/event delivery, original
Node 8 UpdateMember execution, public SigV4 verification, and generated-client
round trips remain unverified.

## Controls

`packages/account/test/loopMemberUpdate.test.js` uses invented accounts,
member ids, addresses, and loop records. It covers:

- populated property updates and source name/email transformations;
- account attachment and removed-member replacement on email assignment;
- duplicate-email and one-time-email errors with no partial state;
- guardian, owner/robot, member-first error ordering, editable-state, and
  no-suspended-guard behavior;
- required/optional field validation, unknown fields, top-level JSON values;
- failed outbox persistence with in-memory, on-disk, and reload checks.

Dependencies were installed in the candidate worktree with
`npm ci --ignore-scripts --offline`; `@phoenix/common`, `@phoenix/contracts`,
and `@phoenix/account` resolve to this worktree's `packages/*` paths.

Focused command result: `node --test packages/account/test/loopMemberUpdate.test.js`
→ **6 passed, 0 failed**. Existing Loop membership/profile/persistence controls:
`node --test packages/account/test/loopMembership.test.js packages/account/test/loopMemberProfile.test.js packages/account/test/loopMembershipPersistence.test.js`
→ **20 passed, 0 failed**. The full unit command `npm run test:unit` completed
with **833 passed, 0 failed, 7 skipped** (840 tests total). No main, robot,
live store, private household data, shared cache, or remote was changed.

## Follow-up: Joi conversion and public authentication

This follow-up is a separate unverified repair on the candidate branch. It is
based on the exact `srv-account-ws@6cea43470825657d6a5722162f28c8f233153ee2`
controller and handler source, rather than the earlier b525 source-methods
fixture. The exact source files used by the Node 8 control are:

| Layer | SHA-256 |
| --- | --- |
| `source-6cea/loop.ctrl.ts` | `8eab9312ba611b1dc5735599521bf73f1dbd2ede49f8da53ad3b4b543d729024` |
| `source-6cea/loop.handler.ts` | `abb558d7f7b873b80d765d6fde344d56876e408ce6bdf928be7a57b37605826d` |
| transpiled `controllers/loop.ctrl.js` | `c7025c7ca9596ab24adb1f81b8a7ac3fd47c2b33b79428565f7e399dbd9f574f` |
| transpiled `handlers/loop.handler.js` | `4f56d5053b3136c9130b9a4f5db1765b769d1500dab6ac504348d867aa3e0e15` |
| transpiled `index.js` | `d825d1af6e5d347941207ca4f8d65128d9ebba124ca9d0597a55311f973a82c5` |

The source layers were transpiled with the pinned TypeScript 2.5.3 compiler
and executed in `node:8.9.4-slim` without network access. Model, event, and mail
files in that runner are named controlled seams; this evidence does not claim
a complete source-repository build. The source control ran 31 synthetic cases
with exit status 0. Its private receipt records 12 successful cases, 19
source validation/error cases, and three separate COPPA-off controls.

The exact source handler declares `birthday: Joi.number().allow(null)` and the
Jibo validation decorator passes the original request object to the controller
after validation. Pinned Joi 10.5.2 accepts numeric strings such as `42`,
trimmed numeric strings, zero, exponent, and hexadecimal forms, but rejects
empty or whitespace-only strings, nonnumeric strings, booleans, and nonfinite
values. The follow-up preserves that distinction: it validates the source
domain without replacing the request value, then casts the assigned birthday
at the plain-store persistence boundary to match Mongoose's Number cast. A
real HTTP test covers the accepted numeric string and whitespace-only 422.

The public `UpdateLoopMember` Account route now verifies the AWS SigV4
Authorization credential before running the handler validation. Resolution is
by the signed access-key id, excludes deleted accounts, and stores the verified
account on the request; the legacy `x-amz-credentials` and `Credential=`
fragments cannot replace it. The Classic proxy opts only this target into
loose JSON parsing so null, arrays, numbers, and strings reach the Account
boundary and receive the source-style 422 object error. It forwards the
captured raw entity, so a body changed after signing fails signature
verification.

New synthetic signed controls in
`packages/account/test/loopMemberPublicAuth.test.js` cover missing, unknown,
wrong-secret, forged-identity, primitive-body, Classic-forwarding, and
tampered-body cases. The focused command

    node --test packages/account/test/loopMemberUpdate.test.js packages/account/test/loopMemberPublicAuth.test.js

completed with **12 passed, 0 failed**. After the follow-up edits,
`npm run test:unit` completed with **839 passed, 0 failed, 7 skipped** (846
tests total). The exact 6cea source/candidate output comparison and Joi
control are retained privately under
`.parity/reviews/a04-update-member-auth-repair-20260908/`; its 31-case
comparison has 28 equal statuses, with the three expected COPPA-off rows
remaining as a separate configuration seam.

This follow-up does not claim the full original public security gateway, a
Mongo/Mongoose deployment, mail delivery, event-bus delivery, or COPPA-off
configuration. Root's separate COPPA seam can be integrated independently.
No household or other private data is present in this candidate or its tests.
