# H-10 CONTEXT identity candidate

Status: **bounded implementation candidate; awaiting root review**. This
report does not mark the identity portion of H-10 verified.

Owner: Luna Max. Worktree: `codex/candidate-hub-identity-20260906`. Base:
`3233429`. Scope is limited to `packages/gateway/src/preprocessor.js`, its
focused identity test, a source-only differential probe and fixture, and this
report. JWT verification, signing, account/classic services, dependencies,
robots, and the root/lead worktrees are unchanged.

## Source basis

The frozen `MessagePreProcessor.preProcessContextMessage` always takes
`accountID` from `socket.auth.id` and `robotID` from `socket.auth.friendlyId`.
It supplies `lang: 'en'`, `release: '1.8.0'`, and `remoteAddress`, then merges
the incoming `general` object over those defaults. It directly reads
`message.data.runtime.loop`; if `loop.users` is truthy it calls its
`.forEach`, trimming each user's `firstName`, `lastName`, and `phoneticName`
when those values are truthy. It always calls
`MessageValidator.validateGeneralData` afterward.

`MessageValidator.validateGeneralData` checks missing account, robot, and
release fields before comparing account and robot IDs with the socket auth.
`validateContextMessage` performs only its separate general/account/robot
presence checks. The original `ClientSession.writeContext` wraps the supplied
context in a CONTEXT envelope; the CLI's synthetic `getGeneralData` leaves
account and robot IDs undefined, so the hub preprocessor remains the source of
the authenticated defaults.

Pinned source hashes:

| source | SHA-256 |
| --- | --- |
| `packages/hub/src/utils/MessagePreProcessor.ts` | `c04ae6a4e4e8989420dcb1135dbd43adc1cdc08b68b4a4d197e1e5ce522cffbc` |
| `packages/hub/src/utils/MessageValidator.ts` | `5503b7d2f773a5daf6eecc0fdd2b09fcba5d12a91ffd48b666f91f2d592e723d` |
| `packages/hub-client/src/session/ClientSession.ts` | `c3c8dbb28217eb4791ae15b3b936fc9bf71f36f42f7cf514fdf1b2dc5a0477c9` |
| compiled `MessagePreProcessor.js` | `da27c1e530172808a229f01700de287474f46ddd4a3c8c8b20e5605a6bc21cbf` |
| compiled `MessageValidator.js` | `8b2c5a1ad04f38423aaf7a72a37e776912165ec07c3b4138be85dc20d4921087` |

## Candidate behavior

`preprocessContext` now follows those operations and ordering. It no longer
creates `anonymous-account` or `anonymous-robot` values when authentication is
disabled. The original service leaves `socket.auth` unset in that mode, so a
CONTEXT reaches the same `Cannot read property 'id' of null/undefined`
failure. The candidate also preserves the source's Node 8 property and
`.trim` error wording on the host runtime, while retaining the original
mutation order for loop members.

The existing minimal `validateContextMessage` checks remain source-shaped,
including its account-before-robot error order. No upgrade authentication or
JWT code was changed in this candidate.

## Node 8 differential

[`h10-identity-differential.json`](../../../packages/gateway/test/fixtures/h10-identity-differential.json)
drives 18 synthetic cases through the compiled original preprocessor inside
the pinned `node:8.9.4-slim` image and through the candidate test path. Cases
cover authenticated defaults and overrides, loop-name trimming, conflicting
and explicitly missing account/robot/release fields, missing/null runtime and
data, malformed user lists, non-string names, null/undefined/empty auth, and
a non-CONTEXT no-op. The normalized comparison has zero differences.

Complete outputs and the fixture hash are retained in
[`H-10-identity-source-differential-20260906.json`](H-10-identity-source-differential-20260906.json).
The fixture SHA-256 is
`6fe7382c40e25a328cd92acd6b82988fecfd43c29ae501fec436ca7b4d98d770`.

Reproduce the source side with:

```text
docker run --rm --network none \
  --mount type=bind,source=$REFERENCE,target=/ref,readonly \
  --mount type=bind,source=$WORKTREE,target=/phoenix,readonly \
  --mount type=bind,source=/tmp,target=/out \
  node@sha256:8233daae003ba0ecba4e6d70cab8525c30a3f085935afc624a275892ebe23f7c \
  node /phoenix/packages/gateway/tools/h10-identity-source-probe.cjs \
  /phoenix/packages/gateway/test/fixtures/h10-identity-differential.json /out/h10-identity-source.json
```

The probe imports only the pinned compiled utility modules and uses synthetic
auth/message objects. It does not start a hub, NLU service, robot, or live
socket.

## Focused validation

```text
node --test packages/gateway/test/preprocessor.identity.test.js
# 6 passed, 0 failed, 0 skipped

node --test packages/gateway/test/*.test.js
# 63 passed, 0 failed, 0 skipped
```

The focused test covers defaults, overrides, authenticated identity mismatch,
missing fields, malformed runtime/data/user shapes, disabled-auth behavior,
and the minimal context validator. The source differential is evidence for
the pinned original Node 8 path; root must perform integrated acceptance.

## Remaining scope and limits

This candidate covers CONTEXT preprocessing and the two source validator
checks only. It does not change the WebSocket auth upgrade, token claims,
client token issuance, context construction in the SDK, or downstream
transaction error envelopes. The observed disabled-auth behavior is the
source's preprocessor failure when a CONTEXT is sent without `socket.auth`;
this candidate preserves that behavior and does not claim anonymous CONTEXT
support. Root should decide separately whether any product-facing disabled
auth mode needs a source-divergent compatibility policy.

## Root review — 2026-09-06

Accepted and integrated for the bounded scope in the [root review](../reviews/h10-identity-root/review.json). Fresh integrated comparisons agree and main passes 402 unit tests. The parent product task remains open for its remaining acceptance criteria. Earlier candidate statuses above are historical.
