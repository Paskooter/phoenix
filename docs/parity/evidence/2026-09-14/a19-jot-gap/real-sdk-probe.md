# A-19 first real-SDK Jot journey — 2026-09-14

Status: **first probe — A-19 is not claimed or verified by this file.**

The original robot client now drives Phoenix's classic Jot face over real
SigV4-signed AWS-JSON. This is the first time an original client has exercised
that face at all.

## Setup

- Client: `@jibo/jibo-server-client@3.0.42` fetched from the pvindex archive —
  the newest version that still ships `apis/jot-2016-05-12.min.json`
  (`targetPrefix Jot_20160126`, `signatureVersion v4`). The 3.0.110 client the
  A-05 harness uses ships no Jot model at all.
- Runtime: `node:8.9.4-slim`, the SDK's own era.
- Server: `packages/classic/src/index.js` unmodified, in `phoenix-runtime:local`.
- Credentials: a synthetic probe key/secret. No real credential was used.

The model was registered through the SDK's own loader
(`AWS.apiLoader.services.jot`) and the client built with
`AWS.Service.defineService`, so request construction, target header and SigV4
signing are all the original SDK's, not a hand-rolled envelope.

## Result — four operations, all answered correctly

| step | outcome |
| --- | --- |
| `ListMessages` (before) | `[]` |
| `CreateMessage` | created `{id, loopId, content, sender, tags, parts, isRead, isEncrypted, created}` |
| `ListMessages` (after) | returns exactly the created message |
| `NumberOfUnreadMessagesInLoops` | `{"count":0}` |

The classic service logged each hop, e.g.
`target: Jot_20160126.ListMessages, op: ListMessages, matched: in-process`.

Two details worth recording:

- **The SigV4 credential drove identity.** The created message came back with
  `sender: "AKIAA19PROBEKEY"` — the access key id from the `Authorization`
  header, exactly as `packages/classic/src/awsJson.js:21-26`
  (`accessKeyIdFromAuth`) documents. So the credential is read and used, even
  though the signature itself is not verified.
- **The original model enforced its own contract before the wire.** A first
  attempt sent `parts: [{type, content}]` and the SDK rejected it client-side
  with `MissingRequiredParameter: Missing required key 'path' in params.parts[0]`
  plus an unexpected-parameter error. The accepted shape is
  `content` at the top level and `parts: [{path, type?, meta?}]`, per the
  model's `CreateMessage` input. Phoenix's response echoed `parts: [{path}]`,
  consistent with that model.

## Second pass — membership and impersonation gates, with a seam wired

The first pass ran with no `account` seam, so the two gates were skipped. A
second pass injected a fixture membership source through the entrypoint's
existing option (`createClassicEntrypoint({ jot: { account } })`) — the service
itself was not modified — and re-ran through the same original client.

A first attempt refused **every** request, including the loop's own member. That
was a fault in the fixture, not in Phoenix: `jot.js` `getImpersonatedAccount`
reads `loop.members[]`, keeping only entries whose `status` is `accepted` and
matching the id under `memberId` **or** `accountId`, and the fixture had supplied
`loop.accounts[]` instead. A gate that refuses everyone is not evidence of
correct gating, so the shape was corrected before anything was recorded.

With the correct shape, all eight checks behave as the source requires:

| check | result |
| --- | --- |
| member creates in own loop | created, `sender` = member |
| non-member create | `JOT_MUST_BE_LOOP_MEMBER` 403 |
| non-member list | `JOT_MUST_BE_LOOP_MEMBER` 403 |
| non-robot impersonation | `JOT_ROBOT_CAN_IMPERSONATE` 403 |
| robot impersonates a member | created, `sender` = **impersonated member**, not the robot |
| other account's unread in its own loop | `{"count":0}` — no cross-loop leakage |
| `MarkLoopRead` | `{"result":"Marked all as read"}` |
| unread after mark | `{"count":0}` |

The impersonation row is the informative one: the robot is permitted, and the
substitution actually takes effect in the stored record's `sender`, which is the
behaviour `message.ctrl.js getImpersonatedAccount` specifies.

## What this does and does not establish

Advances:

- **Criterion 2 (authentication)** — a real SigV4-signed request is accepted and
  its credential is used for sender attribution. It does **not** show signature
  *verification*, because Phoenix deliberately does not verify it
  (`awsJson.js:1-11`, "SigV4 — NOT verified; LAN trust like the hub").
- **Criterion 3 (create/list behaviour)** — create-then-list round-trips through
  the original client with a stable id and field set.
- **Criterion 4 (original-client journeys)** — this is one such journey.

Does not establish:

- Any comparison against the original Jot **runtime**. The `jot-ws` service is
  gone, so there is no live counterpart to diff against; the model is the only
  surviving contract.
- Integration with the **real** Account face. The second pass proves the gates
  work correctly *given* a membership source, using a fixture seam. It does not
  prove Phoenix talks to the live Account service, whose client hop
  (`AccountClient.get(loopId)` -> `GET /loop?loopId=`) is still unrecovered.
  Without a seam the gates remain skipped, which is the documented LAN-trust
  divergence at `packages/classic/src/jot.js:93-96`.
- Pagination, media population, per-id `MarkRead`, tags, encryption, durability
  across restart, or TLS. This probe was plain HTTP on a container network.
  `MarkLoopRead` and one cross-loop isolation case are covered above.

## Reproduction

The probe scripts live in the scratch directory
`~/.local/share/phoenix/a19` and are not committed; the client tarball is
fetched from the archive by version. Nothing in the repository was modified to
run this, and no robot was involved.

A-19 stays `todo`.
