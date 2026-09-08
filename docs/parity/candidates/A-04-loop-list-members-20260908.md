# A-04 candidate: ListLoopMembers filters, visibility, and population

Status: **candidate; unverified pending root review.** This is a bounded
`ListLoopMembers` repair and does not close A-04.

## Source contract

The source pin is
`jiborobot/srv-account-ws@6cea43470825657d6a5722162f28c8f233153ee2`.
The relevant files are the exact `loop.ctrl.ts`, `loop.handler.ts`, and
`loop.ts` snapshots retained under
`.parity/reviews/a04-member-profile-review-20260908/source-6cea`:

| File | SHA-256 |
| --- | --- |
| `src/controllers/loop.ctrl.ts` | `8eab9312ba611b1dc5735599521bf73f1dbd2ede49f8da53ad3b4b543d729024` |
| `src/handlers/loop.handler.ts` | `abb558d7f7b873b80d765d6fde344d56876e408ce6bdf928be7a57b37605826d` |
| `src/schemes/loop.ts` | `66148531c2308d76a281cc5e82bac2d70e0adf7de7e14d7997dbca83654649f3` |

`LoopController.listMembers` expands an absent or empty `statusList` to all
four member statuses and an absent or empty `typeList` to incoming and
outgoing. It first calls `list({ ownerId, friendlyId })`, then filters the
flattened populated members. `list` selects owner or accepted/invited-member
visibility, applies an optional loop id before robot inference, and for a
robot request keeps only that robot's non-suspended loops. The source account
projection creates keys in the order `birthday`, `email`,
`facebookAccessToken`, `firstName`, `gender`, `lastName`, `phoneNumber`, and
`photoUrl`. The token is undefined for a human request and is assigned as the
raw value for a robot request, including an explicit `null`.

## Candidate changes

- `packages/account/src/loopMembership.js` now builds the source account
  projection with the `facebookAccessToken` slot in its source position. A
  human response therefore omits an undefined token during JSON serialization,
  while a robot response preserves a null token.
- `packages/account/src/robotFace.js` preserves parsed primitive bodies for
  `ListMembers` and `ListLoopMembers` through the shared dispatch. This lets
  the handler return the source Joi 422 for top-level `null`, arrays, numbers,
  and strings instead of coercing them to `{}` and returning 200.
- `packages/account/test/loopMembership.test.js` covers robot/human
  projection, null-token and key-order behavior, status/type validation,
  primitive bodies, and unknown-field acceptance.

No source status/type values, owner/member visibility rules, or robot filtering
were widened. Existing storage normalization of legacy uppercase statuses is a
Phoenix storage adaptation and remains qualified separately from source Mongo
equality.

## Evidence

The exact transpiled source handler was executed under Node `v8.9.4` in the
machine-pinned image
`node@sha256:8233daae003ba0ecba4e6d70cab8525c30a3f085935afc624a275892ebe23f7c`.
The 14-row source handler control has the same 200/422 outcomes and validation
messages as the candidate, and invalid rows make zero controller calls:

- source: `.parity/reviews/a04-list-members-20260908/handler-validation/source-handler-validation.json`
- candidate: `.parity/reviews/a04-list-members-20260908/handler-validation/final/candidate-http-validation.json`
- candidate exit: `.parity/reviews/a04-list-members-20260908/handler-validation/final/exit` (`0`)

The source control includes empty/default filters, accepted and incoming
filters, combined/order-preserving filters, invalid status/type values,
non-array values, top-level primitives, and an unknown field. The source
projection-order witness is
`.parity/reviews/a04-list-members-20260908/source-order/stdout.json`.
It confirms the explicit robot `null` and human undefined token distinction.

The source controller filter control and the candidate companion each have six
filter rows. All six result sequences agree after comparing the source member
status/type projection; both population modes also agree on member account
keys and values. The raw source fixture intentionally bypasses Mongoose, so
its `_id`, schema defaults, and full document serialization are not claimed
as an exact database comparison.

The generated `@jibo/jibo-server-client` `3.0.110` control ran against a
temporary candidate Account listener. The client ran in the same pinned Node
8.9.4 image, with the candidate server on an ephemeral host port and no live
service. Final receipt: `.parity/reviews/a04-list-members-20260908/client-control-run8`.
It contains 11 ordered calls: owner all/accepted/incoming, guest, robot,
outsider, invalid status/type, top-level null, unknown field, and empty
filters. All calls settled without timeout; successful rows returned 5, 3, 1,
5, 5, 0, 5, and 5 members respectively, and the three invalid rows returned
422. The SDK's decoded object key order is its generated parser behavior; raw
candidate JSON is the projection-order check.

Focused validation in the candidate worktree:

```text
timeout 180s node --test \
  packages/account/test/loopMembership.test.js \
  packages/account/test/loopMembershipPersistence.test.js \
  packages/account/test/loopListValidation.test.js \
  packages/account/test/loopGatewayAuth.test.js \
  packages/account/test/robotFace.test.js \
  packages/account/test/loopHouseholdBootstrap.test.js
# exit 0; 28 tests passed
```

The worktree has its own installed workspace links; `@phoenix/*` imports
resolve within this candidate. No main branch, robot, live service, shared
parity reference, or private household fixture was changed.

## Limits

The source controls use named Account/Mongo and controller seams where a full
original service would require its database. They establish the source
handler, filter, visibility, and projection rules but do not claim complete
Mongoose query ordering, Hapi framing, or live robot acceptance. Public
SigV4 authentication is inherited from the separately reviewed Loop gateway
boundary. Event, mail, and other Loop operations remain outside this slice.
