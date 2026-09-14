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
- Loop membership or robot impersonation. No `account` seam was wired, so the
  two membership gates were skipped — the documented LAN-trust divergence at
  `packages/classic/src/jot.js:93-96`. A real membership comparison needs that
  seam wired to an Account face.
- Pagination, media population, `MarkRead`/`MarkLoopRead`, tags, encryption,
  cross-loop isolation, durability across restart, or TLS. This probe was plain
  HTTP on a container network.

## Reproduction

The probe scripts live in the scratch directory
`~/.local/share/phoenix/a19` and are not committed; the client tarball is
fetched from the archive by version. Nothing in the repository was modified to
run this, and no robot was involved.

A-19 stays `todo`.
