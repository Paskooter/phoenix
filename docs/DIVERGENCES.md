# Deliberate differences from the original cloud

Phoenix aims for **behavioral** parity at the wire, not internal fidelity. Every intentional
deviation — and every known behavioral difference that has been kept — is recorded here with what
changed, why, and what it affects. Entries carry the engineering record's own identifiers
(`B3`, `G-store`, `N03a`, …) so they can be matched with the task ledger and the code comments
that cite them.

This is a register of decisions, not a list of defects. If you need to know whether Phoenix will
behave like the original in some specific case, look here first.

## Architectural (decided at bootstrap)

| # | Divergence | Rationale | Parity impact |
|---|---|---|---|
| A1 | Language: modern **JavaScript** (ESM, Node ≥20) instead of TypeScript-compiled-to-node-8 | Project decision; no build step; types via JSDoc + runtime schema validation | none (wire-compatible) |
| A2 | **Zero external deps** for contracts/common/harness (hand-rolled JSON-Schema validator, HTTP runner, diff) | Installable offline, tiny surface, no supply chain | none |
| A3 | **npm workspaces** replace lerna + yarn-1.7 | Reference tooling is dead-era | build-only |
| A4 | Default per-service ports 7010–7014 instead of all-8080-in-container | Allows local side-by-side runs without docker | none (harness collapses port in URLs) |
| A5 | Skill `session` blob compared **round-trip only**, not by contents | node-ID assignment is an internal concern; reference assigns global sequential IDs by registration order | must preserve round-trip opacity |

## Reconciled bootstrap questions

These questions came from the atlas risk register. Their current decisions are
recorded below; accepted evidence and remaining qualifications are in
[VERIFICATION-GAPS.md](parity/VERIFICATION-GAPS.md).

| # | Question | Milestone | Default leaning |
|---|---|---|---|
| B1 | Weather/date semantics | D-05 | Source-shaped behavior is accepted; historical provider window and apparent-temperature qualifications remain recorded. |
| B2 | NLU grammar coverage | N-01/N-02/N-08 | Default AST and approved compiled profiles are explicit; the compiled HTTP corpus is exact and the default has the accepted 49-row residual set. |
| B3 | Credential assignment bug | D-02 | Corrected deliberately with `===`, documented and regression-pinned as D-02a. |
| B4 | History retention | I-03 | Durable retention is accepted; synchronous pruning differs from Mongo TTL eventual consistency. |
| B5 | MIM variant selection | S-04 | Weighted source selection is verified at pinned points/boundaries; physical timing remains R-04 scope. |

## Decided behavioral divergences

| # | Decision | Why | Wire impact |
|---|---|---|---|
| B3✓ | `deleteOtherCredentials` assignment bug **fixed** (`===`) | Bug-for-bug would delete wrong creds | delete-other now correct |
| B6 | **GQA → answer-skill**: knowledge questions (whoIsPerson, requestTellAboutThing, general*Questions) remap to answer-skill instead of chitchat | Reference chitchat GQA deflected to Wolfram (dead service); phoenix answers via Wikipedia/LLM | better answers; chitchat personality questions unaffected |
| B7 | **requestWeather → requestWeatherPR**: weather questions route to report-skill's weather subskill | Chitchat's requestWeather memo was a "go ask the report" deflector; phoenix goes straight there | weather questions get real weather |

| N1 | **Default parser stays the AST engine**, accepting 49 residual differences out of 20,528 captured requests | The compiled-graph runtime is exact (20,528/20,528) but needs the original's graph data provisioned, which is not vendored. Keeping AST means a plain checkout runs correctly with nothing to download. The residuals are explained, not unknown: families F2 (47) and F3 (2) in `docs/parity/candidates/N-08-residual-families-20260907.md` are tie-breaking artifacts of how the original's graphs resolve after optimization, and are not repairable in an AST engine. | 49 of 20,528 parses may select a different rule among overlapping arms. Compiled remains available opt-in via `PHOENIX_NLU_RUNTIME=compiled-fst` for anyone who wants exactness. |

Add a row the moment a deviation is chosen; nothing in the code diverges silently.

| E8-news-images | report news | Reference NewsParse required an AP image per story and cut the feed-header item; the Phoenix data service's RSS→AP shim carries no images, so `image` is optional and only `headline` is required (no header cut). | Faithful against real AP data; shim-compatible. |
| E8b-datetime | report subskills | jibo-data-utils DateTime is ported lean (utc/clone/setTime/isFuture/getRelativeDays/getLocalTime + toString {timeOnly}/{prefixOnAt} with at/tomorrow-at/on-weekday phrasing) instead of the full moment-tz surface. | Covers every call site in the report subskills; full DateTime port only if other skills need it. |
| Q-hardening-provider-secrets | GQA provider URLs returned to the skill or stored as attribution drop credential-like query parameters (`appid`, `key`, `subscription-key`, `api_key`, tokens, signatures), userinfo and fragments; Mongo reads sanitize legacy rows; Bing/Wolfram `Unexpected exception:` messages redact the API key and embedded URLs. Bing/Wolfram reject malformed or nonfinite latitude/longitude before any HTTP call. | The recovered srv-gqa-ws copied provider URLs and exception text verbatim, which can carry the deployment's API key into robot responses and attribution history; it also forwarded unvalidated coordinates. Staged September hardening re-port. | URLs without credentials are unchanged. A malformed coordinate is a provider error instead of an upstream request. DuckDuckGo results are covered by the store-level redaction. |
| Q-hardening-errors | GQA answer and attribution 500 responses keep the source `{version: "5.2.15", message}` envelope, but `message` is the fixed `Internal server error` (or a fixed authorization message) and `stacktrace` is omitted. Internal logs carry only a sanitized, length-bounded name/code/message with credential-shaped text redacted. GQA request validation also rejects malformed or nonfinite `runtime.location` coordinates. | srv-gqa-ws returned `str(error)` and the Python stack to the caller, exposing provider, storage and credential details. Staged September hardening re-port. | Status codes and media types are unchanged; clients that displayed the error text now see the fixed message. |
| Q-hardening-attribution-auth | `/retrieveAtt` and `/wipeID` require an explicit identity boundary: an injected `attributionAuth.verifyCaller` (for example `createGqaSigV4CallerVerifier`, which verifies SigV4 over the raw body) or the opt-in `PHOENIX_GQA_ATTRIBUTION_TRUSTED_INTERNAL` mode that accepts the legacy `x-amz-credentials` header only from allowlisted socket peers (loopback by default). Without either they answer 503. Retrieval searches only the caller's own loops; wipe requires the caller to own the loop or be an admin, and rejects non-string IDs. See `packages/skills/GQA-ATTRIBUTION.md`. | Source trusted a caller-supplied `x-amz-credentials` header and `/wipeID` deleted any loop's history without an account check. The skills HTTP service receives no verified gateway identity. Staged September hardening re-port. | Unauthenticated callers get 401/403/503 instead of data. Classic `GQA_20160930.ListAttribution` uses its in-process store and is unaffected. |
| S-hardening-redirect-headers | When a report-skill Lasso or Settings request is redirected to a different origin, Lasso forwards only standard representation/cache headers (no Jibo trace, authorization, cookie or custom identity headers) and Settings drops `x-amz-credentials` and the `x-phoenix-internal-token` peer secret, for that hop and any later one. Same-origin redirects are unchanged. | The source axios/follow-redirects stack re-sent the full header snapshot to any redirect target, so a misconfigured or hostile peer could collect account identity or an internal secret. Staged September hardening re-port. | Only cross-origin redirects change. The September commute/weather coordinate pre-checks were not ported: main pins source presence-only completeness (s11 settings) and the source `toFixed` TypeError. |

## Phase G — classic services (per-robot auth + OOBE portal)

| # | Decision | Why | Impact |
|---|---|---|---|
| G-sigv4 | Public Classic and OTA entrypoints verify AWS SigV4 against the Account-store credential snapshot | Phoenix has no separate security-gateway process, so the entrypoint performs the gateway's essential verification itself, including the exact received body, active-account lookup, fixed public Host, and a bounded replay cache. | Unsigned, forged, stale, and replayed requests are rejected before Classic/OOBE/OTA handlers. In-process compatibility fixtures may deliberately omit the boundary; they are not a deployable public mode. |
| G-store | Accounts/loops/tokens/sessions persist in a **single JSON file** (atomic tmp+rename) instead of Mongo | Zero-dependency, household-scale; the reference's Mongo/Redis are overkill for a single-owner revival | Not horizontally scalable; fine for one deployment. Path via `ETCO_account_dataFile`. |
| G-hubtoken | Hub tokens are **symmetric** HS256 over a shared `HUB_TOKEN_SECRET` (issued server-side via `/api/token`, optionally validated against the account service via `ETCO_hub_accountUrl`) | Matches the reference `createHubToken` (same secret, 3h expiry) and the robot's own local-signing path; asymmetric keys were out of scope | Anyone with the secret can mint a token for any identity — keep it secret; revocation is via account deactivation (`/api/verify` → `{valid:false}`), not token blocklists. Tokens without `exp` (sim/robot hand-signed creds) stay valid for LAN back-compat. |
| G-admin | The portal admin face is a **per-account flag** (`isAdmin`), not a shared password | The single shared `ADMIN_PASSWORD` gave every operator the same credential, left no per-person trail, and could not be revoked for one person without changing it for everyone. Replaced 2026-09-18. | Grant with `scripts/portal-grant-admin.mjs --email <address>` (and `--revoke`). Every `/api/admin/*` route re-checks the flag, so a signed-out caller gets 401 and a signed-in non-admin 403 — the console renders "sign in" for one and "not an administrator" for the other. The flag is read per request, so revoking takes effect immediately with no stale session. |
| G-qr | The OOBE QR **encoder** is a fresh from-scratch implementation (byte mode, RS/BCH, mask selection), not the robot's original QR library | Phoenix vendors plain data + minimal deps; the original lib isn't reusable server-side | Output verified by decoding it back with jsQR (dev-only oracle); the *payload* format (XOR key + chunk framing) is the exact `config.bt` contract. |
| G-claim | `Loop_20160324.CreateLoop` refuses to claim a robot that is still attached to a live loop owned by a **different** account (`ROBOT_ALREADY_CLAIMED`, 409). Source **allows** the takeover: pinned `jiborobot/srv-account-ws@master` `src/controllers/loop.ctrl.ts:116-158` validates only `name`/`robotId` and then calls `removeRobotFromLoops(robotAccount._id)` unconditionally, so any signed-in account could detach another household's robot by its public friendlyId (displayed on the robot, used in normal setup) and lock out the real owner. **Legacy parity, deliberately broken 2026-10-09.** | The friendlyId is not a secret, so the source's unconditional relocation is a real-world takeover of the owner's own robots; the same gap was already closed for `SetupRobot` (`ROBOT_ALREADY_CLAIMED` in `robotFace.js`) and CreateLoop was missed. | Same-owner re-setup/relocation and fresh unowned-robot claims keep the source behavior (a robot freed by loop soft-deletion remains claimable); the refusal predicate is exactly `removeRobotFromLoops`'s detach query (robot relation AND member, non-deleted) so nothing broader is blocked, and it fires before any mutation (no victim-loop suspension, no robot-account reactivation). `setupRobot`'s QR re-pair, `linkAdoptedRobotToOwner`/claim codes and the admin `transferExisting` flow do not go through this boundary. Pinned by `packages/account/test/loopCreateClaimGuard.test.js` (fails on ff8f592). |


## Phase H — remaining classic services

| # | Decision | Why | Impact |
|---|---|---|---|
| H-frontdoor | One Classic entrypoint dispatches by X-Amz-Target and exposes the notification socket; separate Account and OTA services receive authenticated proxy calls. | Matches the robot's global REST/socket resolution without combining every store. | The supported helper rewrites region clients, notification socket suffix and hub routing. Production SigV4 identity is verified; native notification delivery is corroborated. |
| H-inmemory | **Superseded:** Classic notification/key/push and functional auxiliary stores now have durable local state. | Accepted restart and failure controls replaced the initial in-memory implementation. | JSON files/local outboxes replace the original databases/brokers; external SNS/Kafka and provider limitations retain separate entries. |
| H-stubs | **Superseded:** ROM, Media, Person, IFTTT, NLP and Collision have functional accepted handlers; Jot and VoiceTraining are implemented too. | Source, runtime and available-client evidence closes the original dispatch/shape stubs. | Physical mobile/Commander/voice-enrollment, live provider and original phonetic/NLP engine behavior retain explicit qualifications. |
| H-backup | `backup` (Backup_20170222) is a **working** service, not a stub: `Backup.New` hands back an upload URL that points back at the entrypoint (no S3 — same self-hosting as OTA packages), a `PUT /backup/blob` stores the blob and answers with an `ETag`, `Backup.List` returns it (default max=1, newest-first) and `GET /backup/blob` serves it back for restore. Phoenix enforces the source `loop.robot === accountId` ownership check at the verified Classic boundary; an explicit loopback-only compatibility opt-in is available for private fixtures, never for the public listener. Supplied `max` values follow the source `Joi.number().integer().min(1).max(1000)` contract and invalid values return 422. This is the **"Backing up robot…" step of the UI wipe/factory-reset flow** — with the old empty-`uploadUrl` stub the robot's `jibo-system-backup.js` upload failed, `systemManager.backup()` returned non-zero, and the gated wipe aborted with "we couldn't wipe your robot." Verified end-to-end against the real client sequence (Loop.List → Backup.New → PUT → Backup.List → GET). | A robot can actually back up before wiping (and restore after), while a public caller cannot list or create backups for another robot's loop. | The blob/index files under `ETCO_classic_backupDir` are the source of truth and are re-indexed after a process restart; leave the directory on durable private storage rather than the `/tmp` default. Phoenix replaces S3 presigned URLs with method/loop/key-bound HMAC URLs, preserving possession-based restore authorization. UGC encryption is the robot's own (`key.loadOrCreateSymmetricKey` is client-side, from `/var/jibo/keys`); the blob is stored opaque. |
| H-loop | All 23 Loop operations now have accepted runtime/client/lifecycle evidence. SuspendLoop remains the native wipe gate. | Later A-04 acceptance supersedes the initial v1 List/Suspend-only implementation. | Membership, invitations, adoption and durable lifecycle are implemented; the initial member-management-deferred claim is historical. |
| H-notbuilt | **Superseded:** VoiceTraining and loop-era Jot are built and verified. | Archived versioned models and source were recovered and assigned A-19/A-20. | Available SDK/upload/list/durability behavior is accepted; physical voice enrollment and removed party-era operations retain their documented scope. |

## Robot deployment client

| # | Decision | Why | Impact |
|---|---|---|---|
| R1 | Patch every installed `@jibo/jibo-server-client` Node HTTP transport to accept an explicit CA bundle | Moth's Node 6 clients do not use the native system trust store. The user authorized a source fork and installation through the repoint script. | TLS verification stays enabled. The optional package-local `lib/http/phoenix-ca.pem` (or explicit `JIBO_EXTRA_CA_CERTS` path) supplies the trust bundle. Explicit `ca` replaces Node's built-in roots; deployment uses the robot's system roots plus Phoenix's CA. With neither configured, upstream behavior remains. Hardware evidence using this patch is evidence from a modified reference client. |

The fork retains the archived source history and Apache-2.0 license:
[Gitea](https://pvindex.org/gitea/jibo/phoenix-jibo-server-client) and
[GitHub](https://github.com/Paskooter/phoenix-jibo-server-client).
The change is limited to certificate loading in the Node transport; it does not
change API requests, signing, response interpretation, BE behavior, or native
Notification transport. Explicit caller-supplied HTTP agents/options retain
upstream precedence. The installer records original and patched file hashes and
supports guarded restoration.

## OTA payload: the repoint is baked into the image (R-07)

| # | Decision | Why | Impact |
|---|---|---|---|
| R2 | Phoenix configuration is baked into native OS/services payloads; OS/services packages carry no preinstall/postinstall hooks. Public endpoint/trust is a build input and skills update independently. | Hooks run on the old root and a hook error triggers retry/reboot. Baking avoids that dependency; /var remains preserved. | Owner-certified working OTA, 2026-10-03. The supported helper supplies the first connection from the retired cloud; after OTA no additional manual repoint is needed. Different endpoints require different payloads/hashes. A/B fallback, corrupt/interrupted recovery and wrong-endpoint controls remain R-10; no hooks avoids hook failures rather than every possible retry. |



## Loop event and projection behavior

Both rows below are **pre-existing Phoenix behavior** (they predate the
2026-09-09 candidate waves). They were surfaced as measured observations by the
A-04 gate 1 state-sequence work and are recorded here by root so they are
deliberate decisions rather than undocumented drift. Under the standing policy
— only substantive client-visible behavior counts — neither changes what a
reference client observes, but both are real differences from source and are
qualified as such.

| # | Decision | Why | Impact |
|---|---|---|---|
| L1 | A Loop save whose `robot` relation is absent produces **no** `LoopUpdated` outbox row. Source `Loop` post-save emits the event regardless; `notification-ws` `LoopUpdatedHandler` then skips it because `accountId = evt.payload.robot` has no target. | Phoenix's durable outbox is the routing step and the delivery step at once (`loopUpdatedOutbox.record` returns `null` for an unroutable loop). Persisting a row that can never be addressed would leave a permanently undrainable entry. | **Robot-visible behavior is identical**: no notification is delivered either way. The difference is bus-visible — a *different* consumer of `LoopUpdated` would see the event from source and not from Phoenix. The prior root's A-04 pending review already noted "Other services may consume those events." Revisit if any non-notification consumer is implemented. |
| L2 | Phoenix Loop mutation JSON omits `isDeleted`; source `toJSON` includes `isDeleted: true` on a soft-deleted loop. | Phoenix serializes the wire model rather than the Mongoose document. | The generated `loop-2016-03-24` API model has **no** `isDeleted` member, so a generated reference client drops the field during response parsing and cannot observe it. Following `ListLoops` / `GetRobot` reads agree with source schema `pre("find")` middleware (deleted loops absent, `404 LOOP_NOT_FOUND`). **Measured 2026-09-11** (root gate 1 replay, `.parity/reviews/root-gate1-replay-20260911/comparison-root.json`): the source `ClearRobot` and `RemoveLoop` **response bodies** carry `isDeleted: true`, and the Phoenix bodies do not, on both the Account and Classic faces — 4 wire-level occurrences. This upgrades L2 from "inferred from the API model" to a directly observed body difference. It remains non-substantive **only** because the generated client drops the unmodeled field; any consumer parsing raw JSON would see it. |

## Console account email and invitations (2026-10-04)

At the owner's request, all eight account email templates now describe Phoenix's
browser console. The archived app/store copy, retired hosted images and
`support@jibo.com` references are replaced with current console instructions.
Subjects identify the action; HTML escapes substituted values, and plain text
substitutes names, email addresses and links instead of sending raw placeholders.
This deliberately supersedes the source-template and literal-text expectations
in the dated A-04 invitation evidence without changing SMTP framing or the
mail-before-event dispatch order.

New invitations use `/invite?email=...&loopId=...` (with `signup=1` for a new
recipient) instead of the archived `/create` and `/home` destinations. Both old
paths remain supported. The console fills the invited email, preserves the
review destination through signup/verification, and requires explicit acceptance.
Legacy invitation codes do not authorize joining or activate a console account.
Unlinked live invitations are attached only to an active human account whose
current mailbox is verified. Removed, declined, deleted, suspended and
already-linked memberships are left alone. This fixes the portal signup gap;
the robot Account wire creation flow remains separate.

## Account identity and recovery behavior (A-03)
Both rows are **source-faithful Phoenix behavior**, verified by root against
pinned source `jiborobot/srv-account-ws@6cea434`
`src/controllers/account.ctrl.ts` (read 2026-09-09 through the Jibo archive
MCP, `gitea_read_file`). They were reported by the wave-3 A-03 candidates as
open questions; root read the source and classifies them here.

| # | Decision | Why | Impact |
|---|---|---|---|
| A1 | `PasswordResetByCode` on a **soft-deleted** account (`isDeleted: true`) that still holds a `passwordResetCode` succeeds, sets `isActive: true`, clears the code, and leaves `isDeleted: true`. Phoenix matches. | Source `passwordReset(code, password)` queries `Account.findOne({ passwordResetCode: code })` **directly** — it does not route through `findById`/`findByEmail`, which are the two functions that raise `ACCOUNT_IS_DELETED`. So the deleted-account guard is structurally absent on this path, not merely omitted. Reaching it requires a code issued before deletion, because `sendPasswordReset` *does* go through `findByEmail` and rejects deleted accounts. | **Security-relevant but faithful.** The window is narrow: a reset code must already exist on the row at deletion time, and deletion does not clear `passwordResetCode`. The result is a row that is simultaneously `isActive: true` and `isDeleted: true`. Because `find` middleware and `findById` still treat it as deleted, the revived credential does not yield account access through normal reads — the practical effect is a stale password write plus an inconsistent flag pair, not a usable account takeover. Retained as source-faithful; **not** guarded, because guarding it would be a deliberate behavior change from source. Revisit if Phoenix ever adds a path that reads accounts without the deleted check. |
| A2 | Source `confirmEmailReset` compares `request._id === emailReset._id` on Mongoose ObjectIds, so the *intended* row is marked `CANCELED` rather than `USED`. Phoenix compares string ids by value and marks the intended row `USED`, others `CANCELED`. **Phoenix deliberately differs.** | `_id` values are `mongoose.Types.ObjectId` instances, and `===` on two distinct object wrappers is reference equality. The loop re-fetches every request for the account with `EmailReset.find(...)`, so the element representing the same document is a **separate object instance** from `emailReset`. The strict comparison is therefore false for every row including the intended one. Source needed `.equals()` or `String(...)`. This is a **source bug**, not a contract. | Client-visible only in the terminal status of a consumed email-reset row. The email change itself completes identically in both (the `account.email` write and `reset()` happen *before* the loop). Source leaves no row in `USED`; Phoenix leaves exactly one. Phoenix's behavior is what the code plainly intends, and the A-03 candidate followed source everywhere else. Recorded as an intentional divergence rather than "fixed silently" — anything replaying source status transitions byte-for-byte will see this one field differ. |
| A3 | A member account whose `photoUrl` is `null` has the field **omitted** from Phoenix's Loop member projection; source `loadMembers` copies `photoUrl` through unconditionally, so the wire carries `photoUrl: null`. **Repaired 2026-09-10** (`deae53f`). | `packages/account/src/model.js` `copyAcceptedAccount` guarded every field with `!= null`, which is correct for the adjacent optional fields and wrong for this one. Source `loop.ctrl.ts` `loadMembers` builds its `accountCopy` with a bare `photoUrl: account.photoUrl`, no conditional. Verified against pinned `jiborobot/srv-account-ws@6cea434`. | **Client-visible, unlike L2.** The pinned `loop-2016-03-24` API model declares `photoUrl` on the `MemberAccount` shape, so a generated reference client parses the field and a consumer can distinguish "no photo" (`null`) from "field absent". Latent until `Account.RemovePhoto` landed in wave 4, which sets `photoUrl = null` on a live account that may be a loop member. Reported by the photos candidate, confirmed by root against source rather than accepted on the candidate's word, and fixed with a falsification-checked regression test driving the public `populateLoop`. |
| A4 | `Account_20151111.Search` is a signed but **unscoped** directory: any authenticated caller can regex-match every non-deleted account by first name, last name or email. Phoenix matches. | Pinned `account.handler.ts` `Search` carries **no** `@parseCredentials` decorator and the controller's `search(query)` runs `Account.find({$or: [{lastName}, {firstName}, {email}], isDeleted: {$ne: true}})` with no caller, loop or ownership predicate. The gateway does not list the target in `unauthorizedMethods`, so a signature is still required — but any valid signature suffices. | **Privacy-relevant and source-faithful.** The result set is the safe projection (source never calls `toJSON({unsafe: true})` on this path, so no password hash, activation code or access keys leak), but names and email addresses of unrelated accounts are exposed to any signed caller. Retained as-is: adding a scope predicate would be a deliberate behavior change from source. Worth flagging to anyone re-deploying this surface on a shared network — it is a design weakness of the original service, not of Phoenix. |
| A5 | `Remove` on a loop member deletes the member **subdocument** from the loop's `members` array; `RemoveLoopMember` instead marks `status: 'removed'`. Phoenix matches both. | Source routes account deletion through `loop.ctrl.ts` `clearAssociated`/`clearMember`, which splices the member out, while the membership lifecycle operation performs a status transition. Two different code paths with two different shapes, both reproduced. | Client-visible in `ListLoopMembers`: a removed-by-account-deletion member disappears entirely, while a removed-by-membership-operation member remains with a terminal status. Measured by the candidate: after a self-remove, the host loop's member row is **absent from the array** rather than marked. Not a defect — the asymmetry is in source. |
| A6 | A robot account can pass the emailless-dependent guard on `Remove`, because robot accounts are created without an email. | The guard distinguishes "dependent" (removable by the loop owner) from "independent" (must remove itself) by testing whether the account has an email. Robot accounts have `friendlyId` set and `email` null, so they satisfy the dependent branch. | Reachable only by a caller who already owns the loop the robot belongs to, and the source guard is written exactly this way. Recorded because a byte-for-byte replay will show a loop owner able to delete a robot account through the dependent path; classify as source-faithful, not repaired. |
| A7 | Passing your **own** `id` to `Remove` when your account has an email fails with `OWNER_CAN_REMOVE`; self-deletion requires **omitting** `id` entirely. Phoenix matches. | Source treats a supplied `id` as "remove this dependent of mine" and an absent `id` as "remove me". An emailed account is independent, so naming yourself takes the dependent branch and is rejected. | A usability wart in the original API, faithfully reproduced. Callers that helpfully pass their own id get a confusing error. Retained. |

| A8 | An unknown or malformed `x-amz-target` returns `400 UnknownOperationException` in Phoenix. Source returns **404** (`Boom.notFound("Method X not found.")`) for an unknown method, and **500** for a malformed one. | Pinned `jiborobot/srv-server@master src/server.ts`: `registerApiHandlers`'s `onRequest` extension calls `lowerMethodName(request)` — `target.split(".")[1]`, then lowercase the first character — and replies `Boom.notFound` when `this.mapping[methodName]` misses. A target with no dot, or with an empty second segment, makes `methodName[0]` throw a `TypeError` inside `onRequest`, which Hapi converts to a 500. Phoenix normalizes all four cases to the AWS-JSON `UnknownOperationException` 400 envelope. | The **method-name rule itself matches exactly**: Phoenix's `accountMethodName` is `String(target).split('.')[1]` with the first character lowercased, so `Account_20151111.Get.Extra` resolves to `get` on both (trailing segments ignored) and `ACCOUNT_20151111.GET` resolves to `gET` on both, i.e. unknown. What differs is the **status code** for a miss (400 vs 404/500), which any client sees. The *coded* errors are a different matter and are **not** divergent — see A11. Phoenix's 400 is the AWS-JSON convention every other unimplemented target already uses, and the original 404/500 pair leaks framework internals. Retained deliberately; recorded so a byte-for-byte replay expects it. |
| A9 | Phoenix rejects a well-formed operation carried under the **wrong service prefix** (e.g. `WrongPrefix.Get`) with `400 UnknownOperationException`. Source **dispatches it**. | The source framework's `mapping` is keyed by the lowercased *method name only* — `get`, `createLoop`, `setupRobot` — and `lowerMethodName` never consults the prefix. Any prefix therefore reaches any handler registered on that service. Phoenix gates the Account identity table behind `/^account/i.test(prefix)` in `robotFace.js`, so a mismatched prefix falls through to the unknown-target response. | **Phoenix is deliberately stricter, and the practical gap is narrow.** In the original deployment each service registered only its own handlers, so a wrong prefix could only reach a method that service already exposed — cross-service dispatch was prevented by topology, not by the framework. Phoenix serves several faces from one process, where the same laxness would let `Loop_20160324.Get` reach the Account handler. The stricter check preserves the *deployed* behavior while removing a hazard the single-process design would otherwise introduce. `CreateHubToken` carries an explicit prefix guard for the same reason. |

| A10 | A captured signature can be **replayed** until its 15-minute window expires. Phoenix matches source exactly. | Pinned `auth.ctrl.ts` `parse()` (L127-130) rejects only on `Math.abs(parsedDate - now) > 15 * 60 * 1000`. There is no nonce store, no seen-signature cache and no single-use marker anywhere in the gateway, so the same `Authorization` header verifies repeatedly while the timestamp stays inside the window. Measured 2026-09-10: the identical signed request returns 200 on both attempts. | **Source-faithful and deliberately not repaired.** Replay is bounded only by the skew window, in both directions (`Math.abs` means a 16-minute *future* timestamp is rejected the same as a 16-minute past one). Adding nonce tracking would be a security improvement and a real behavior change, so it stays out. Practical exposure: an attacker who captures a signed request on the wire can repeat it for up to 15 minutes; TLS is what prevents that capture, which is why the R1 TLS work matters. Anyone re-deploying on an untrusted network should know this is the original design, not a Phoenix weakness. |

| A11 | Coded error responses are **not** divergent despite different raw JSON. Source emits a Hapi/Boom payload `{statusCode, error, message, code}`; Phoenix emits AWS-JSON `{"__type": CODE, "message": ...}` plus an `x-amzn-errortype` header. A generated client cannot tell them apart. | The original client is the pinned `aws-sdk` in the reference tree. `lib/protocol/json.js` `extractError()` resolves the code as: header `x-amzn-errortype` first as a default, then **overridden** by `body.__type || body.code` — so `if (e.__type \|\| e.code) error.code = (e.__type \|\| e.code).split('#').pop();`. The body beats the header, and `__type` and `code` are treated identically. `error.message` comes from `e.message \|\| e.Message`. | **Verified executably, not just read** (2026-09-10): the real pinned `extractError()` was run over both envelopes for four codes — `WRONG_PASSWORD`, `ACCOUNT_NOT_FOUND`, `MISSING_AUTH_HEADER`, `CLOCK_SKEW_TOO_LONG` — and every pair yielded an identical `error.code` and `error.message`. Falsification checked: a deliberately mismatched `__type` is detected. The 422 Joi path is identical on both sides already, since `Boom.badData` carries neither key and both fall back to the header. **This corrects an earlier root reading** that called the shapes divergent — at the SDK boundary they are not. The raw JSON differs (source adds `statusCode`/`error` keys), which matters only to a consumer parsing raw JSON instead of using the generated client. |

## Hub listen path (CONTEXT preprocessing)

| # | Decision | Why | Impact |
|---|---|---|---|
| L3 | A CONTEXT whose `data` is a non-array object and carries **no `runtime`** (absent or `null`) is **accepted**. Pinned `MessagePreProcessor.ts:33` reads `message.data.runtime.loop` unguarded, so source throws `TypeError: Cannot read property 'loop' of undefined`. **Repaired 2026-09-17.** | A real robot opens a turn while idle — between skills, after a skill crash, during OOBE, or with **no behaviour engine running at all**, which is the permanent state of a robot that has no renderer. Jetstream still wakes on "Hey Jibo" and sends a CONTEXT whose `data` holds only `general`; the behaviour engine is what supplies `runtime`. Measured on both robots: 7 rejected turns in one test session, on Aero (`192.168.1.15`) and Moth (`192.168.1.217`) alike, each killing the whole listen transaction with a TypeError that names nothing client-visible. An absent runtime simply means there are no loop-member names to trim. | **Client-visible only as a repair.** At the source, the turn dies; in Phoenix it proceeds to a normal no-match/`LISTEN` result. `runtime` is passed through exactly as received — nothing is invented — and the identity cross-check against the socket JWT is unchanged, so this cannot admit a mismatched account or robot. The boundary is **shape-based, not fixture-based**: `data` must be a non-array object. A **non-object `data`** (`[]`, `[7]`, `{data:{forEach:null}}`) keeps the source `TypeError` verbatim, and a `runtime` that is present but malformed still raises the exact source errors (`loop.users.forEach is not a function`, `Cannot read property 'firstName' of null`, `user.firstName.trim is not a function`). Pinned by 5 of 187 identity fixtures diverging deliberately (`runtime-missing`, `runtime-null`, `root-runtime-0`, plus the two root cases) with the source failure still asserted as the expected value; the H-10 differential test derives the boundary from the fixture *shape* so adding a same-shape case cannot silently widen it. Falsification: restoring the unguarded read fails 3 named tests. |



## Gateway request and resource hardening

The staged September hardening re-port retains the newer router, failover,
local-home routing, endpointing and telemetry implementations. These changes are
intentional robustness differences, not claims of exact original-service parity.

| # | Decision | Why | Impact |
|---|---|---|---|
| H-hardening-google | Legacy Google mock sessions settle on stop/abort and unexpected transport end, detach owned listeners, and emit EOS at most once. The mock TCP seam bounds individual audio frames (64 KiB), total audio (4 MiB), pending/outbound audio (512 KiB), and inbound lines/buffers (256/512 KiB); config precedes early audio. | Cancellation must release transport ownership; an unresponsive mock peer must not retain unbounded audio or leave `start()` pending. | Excess input rejects the mock session; unexpected end returns its last incremental or an empty ASR envelope. This affects the legacy line-delimited mock seam, not the newer paid Google recognizer/router. |

| H-hardening-peers | Settings/history fetches have a 10 s wall-clock deadline; parser/skill fetches have an 11 s transport deadline behind the existing 10 s phase budget. Each accepts a parent cancellation signal. | Peer requests must not outlive a cancelled transaction or hang indefinitely. | A stalled peer now aborts. Existing request payloads, internal Settings authentication and error envelopes are unchanged. |

| H-hardening-config | Gateway NET peers preserve explicit HTTP/HTTPS schemes; `HUB_TOKEN_SECRET` is a fallback to `ETCO_server_hubTokenSecret`. Registry entries reject malformed nonempty base URLs, and settings rules require an own `value` (false, null and zero remain valid). | Avoid unusable double-prefixed URLs and reject incomplete registrations before startup. | These input-validation repairs intentionally differ from the source's discarded URL regex and permissive missing-value handling. Newer Home Assistant registry/configuration remains intact. |

| H-hardening-anonymous | Explicit `disableAuth` connections use stable non-credentialed `anonymous-account`/`anonymous-robot` identities, including nullish-auth preprocessing. | The original disables upgrade auth but then dereferences missing auth on CONTEXT, making the configured mode unusable. | Nullish auth now accepts the ordinary anonymous CONTEXT path; authenticated identity mismatch checks and the newer missing-runtime divergence remain. No access key or verified robot identity is created, so local-home/control authorization is not granted. The frozen identity differential bounds the new divergence by input shape to three cases. |

| H-hardening-lifecycle | Listen/proactive close, rejection and expiry cancel shared peer work and settle once; late continuations cannot emit frames or launch history. Pre-session audio is capped at 1 MiB, ignores empty frames, and is released at phase/terminal boundaries. Timeout races clear timers on both success and rejection. | A disconnected/expired turn cannot usefully continue; the source leaves the internal listen transaction running after its outer timeout. | Disconnect now resolves only after cancellation; expiry stops work instead of allowing a late skill response. Listen failure bookkeeping retains its two speech-history writes, but transaction timeout does not create fresh history. Empty live ASR completion supplies an empty envelope; max-speech finalization owns its annotated result. Successful turns, router/failover, verified local-home gates and content-free telemetry stay intact. |

| H-hardening-proactive-error | A proactive cloud skill error retains its `code` in the final ERROR data. | Listen and proactive callers need the same actionable peer error. | Adds the supplied code (absent/undefined remains absent on JSON serialization); success frames are unchanged. |

| H-hardening-parakeet | Batch responses are limited to 64 KiB; errors contain at most 1 KiB of UTF-8 diagnostic text without split code points. Abort/decoder failure destroys in-flight POST work, including composed failover transports. A wake tail suppresses only one initial burst of at most 200 ms; later short speech is recognized. Empty candidates wait for new speech. | Limit recognizer-controlled memory and keep short commands from being discarded; dead turns cannot leave a held batch POST running. | These are staged robustness differences. The newer streaming API, confidence reporting, adaptive 900 ms/env-derived silence gate, decoder draining, router and Google fallback remain. Existing relisten storage replaces the September candidate/deferred-PCM rewrite; response hardening belongs in the extracted transport, not a second HTTP implementation. |

## NLU and tooling hardening

Area 2 of the staged September re-port (packages/nlu and tooling). As for the
gateway, the newer Laya fallback, decision layer, LLM external agent and
generated intent catalog are retained; each row is an intentional robustness
difference, not a claim of exact original-service parity.

| # | Decision | Why | Impact |
|---|---|---|---|
| N-hardening-loop | LoopMemberDetector matches member names literally (regex-escaped), skips loop members whose `id`/`firstName`/`lastName` is not a non-empty string, and returns a result with a non-object `entities` map unchanged. Supersedes the unescaped/`undefined`-pattern fidelity recorded in N06a. | Loop member names are household-entered data. The pinned detector (`LoopMemberDetector.ts:73,84`) compiled them as patterns, so `A.J.` matched `AXJY` and a nested quantifier could stall the parser; a nameless member matched the literal text `undefined undefined`; a malformed member or null entities threw a TypeError (lines 5-7, 32-35). | Well-formed loops resolve exactly as before (source fixtures and the N-06 gateway speaker/referent tests unchanged). Malformed members no longer resolve or fail the parse; the request is still answered (no 400 is introduced). |
| N-hardening-external | A failed external (Dialogflow-shaped) agent records `error: 'External agent unavailable'` instead of the underlying error message; a null agent entry, an array result, or a pending (Promise) resolver result is a failed agent; a pending result abandoned on a synchronous path has its rejection observed. | `DialogflowClient.ts:68-75` copies `error.message` into the response, and agent resolvers/providers are untrusted: their messages can carry provider internals or credentials. A null agent made the archived record dereference `agent.rules` and fail the whole parse. | The external envelope keeps its archived structure (`rules`, `intent: ''`, `entities: {}`, `error`); only the `error` text differs. The disabled-client boundary error, the 5c0a739/715e0dd0 attachment revisions and the live LLM agent lane are unchanged. |
| N-hardening-fst-directories | `PHOENIX_NLU_RUNTIME=compiled-fst` no longer accepts `PHOENIX_NLU_COMPILED_FST_DIRECTORIES`: selection fails with an explicit "unprovenanced directory graphs" error (and the listener does not start). Only the approved home, the approved snapshot manifest and the closed binary pins remain. `compiledFstAcquisition.js` stays as an offline inspection helper and is no longer imported by the runtime. | The original production `default.json` globbed `fstDirectories` (RulesRegistry), but a Phoenix directory profile loads mutable graphs with no versioned binding to source, artifact or compiler provenance, so it can neither support a parity claim nor be told apart from an approved profile at runtime. | Opt-in only: the default AST profile and all approved compiled profiles are unchanged. Graphs outside the closed 98-rule inventory can no longer be served until a provenance manifest exists for them. Historical evidence for the 2026-09-07 directory candidate is kept as history. |

## Speech endpointing (Phoenix-original; the reference had none)

| # | Decision | Why | Impact |
|---|---|---|---|
| ASR-1 | The trailing-silence window that ends a turn is **900 ms**, overridable with `PHOENIX_ASR_SILENCE_EOS_MS`. Starting speech uses a 1.8× room-noise margin; continuing an established utterance uses 1.3×, both with a minimum RMS of 400 and a 30 ms burst debounce. After SOS, the room-floor estimate may fall but cannot rise. | The reference uses Google's external `END_OF_SINGLE_UTTERANCE` (`GoogleASRSession.ts:106`), so local endpointing is a Phoenix decision. The September 17 reduction from 700 to 400 ms improved response speed but cut natural mid-sentence pauses. On October 2, Moth's live turns still ended with `reason: silence` and `silenceWaitMs: 400`. Regression tests reproduce both prefix-only recognition after a 600 ms pause and loss of a quieter continuous continuation when that continuation is learned as noise. | Allows 600 ms pauses and softer speech without discarding the rest of the utterance. Adds 500 ms of silence wait compared with the 400 ms setting; OGG page buffering and recognition time remain additional costs. Sustained room noise changes during a turn can keep listening open longer; the 30 s audio cap still bounds it. Tests cover PCM, real OGG/FLAC decoding, WebSocket streaming, and isolated room-noise spikes. |
| ASR-2 | Every completed turn logs `ASR turn` at info: `reason`, `audioMs`, `silenceWaitMs`, `recognizeMs`, `relistens`, `chars`, `noiseFloorRms`, `speechGateRms`, `speechMs`. | Separates endpoint waiting from recognition time and exposes the effective energy gate for diagnosing premature endings. No transcript text or audio is logged. | One info line per recognized turn on the listening path. |



## Credential store (D-02)

| # | Decision | Why | Impact |
|---|---|---|---|
| D-02a | `deleteOtherCredentials` guards on `skillId === 'report-skill'` in Phoenix. Pinned `Credentials.ts:143` reads `if (newCredential.skillId = 'report-skill')` — a **single `=`**, i.e. an assignment, which is always truthy and also overwrites `skillId`. Phoenix uses a comparison. | Verified 2026-09-10 against `.parity/reference/5c0a739…/packages/lasso/src/credential/Credentials.ts:143`. This is a **source bug**, not a contract. | **Phoenix deliberately differs, and is reported rather than silently labelled parity.** Under source, cross-provider deletion fires for *every* credential save whose `serviceAccountName` is `workCalendar`/`personalCalendar`, regardless of the saving skill. Phoenix deletes only for `report-skill`. Pinned by regression fixture `D2 REGRESSION FIXTURE: a NON-report-skill save does NOT trigger cross-provider deletion` in `packages/data/test/credential-durable.test.js`, so a future "fix" that restores source behaviour will fail the suite instead of passing quietly. The D-02 acceptance criterion explicitly warns against calling changed deletion behaviour parity. |

## Notification and history services (A-10, I-01)

| # | Decision | Why | Impact |
|---|---|---|---|
| A10a | Socket upgrade with an unknown token returns **401** in Phoenix; source replies **404** `TOKEN_NOT_FOUND`. | Pinned `errors.ts` gives `TOKEN_NOT_FOUND` a 404 statusCode, and `socket-server.ts` closes with `err.statusCode`. Phoenix uses the generic unauthorized 401. | No consumer-visible behaviour change — the original client retries identically in both cases. Pinned by a focused test. Recorded so a byte-for-byte replay expects the different code. |
| A10b | Duplicate same-token connection: source overwrites `connectionCache` and lets the old socket's close kill the replacement (**source bug**); Phoenix deterministically closes the previous socket first. | Source has a race between new-connection registration and old-socket close. | Phoenix reaches the same one-active-socket-per-token steady state deterministically. Retained as the sane behaviour; recorded as a divergence rather than described as a match. |
| A10c | `deliver()` on a non-open cached socket: source calls `close(tokenId)`; Phoenix returns false and waits for the ws close event. | Different mechanisms, identical row-retention semantics. | No data-loss difference. |
| I-01a | Launch-record `timestamp` is numeric ms on the wire; Pegasus sends an ISO-8601 string. | Phoenix hub `TimeSince` computes `Date.now() - timestamp`, which works with ms and NaNs on ISO — the same as the reference hub. | Deliberate tradeoff to keep `timeSince` alive, needing an integration decision. Flagged by the I-01 worker, who owns history but not the gateway. |
| I-01b | **REPAIRED 2026-09-18.** `GET /healthcheck` on History now returns the source body `{status, skillLaunchDB, speechHistoryDB}` with a real status code: 200 when the store is usable, **500** with `status: 'error'` and `DISCONNECTED` when it is not. Previously every service returned the base-service `ok` text with 200. | Verified against pinned `packages/history/src/HistoryService.ts` `getHealthcheckResponse` (and the `DBClientState` enum in `packages/history/src/common/db/DBClient.ts`): History is the one service that overrides the shared response, sets `status: 'error'` whenever a store is not `CONNECTED`, and returns 500 for it. R-03 clause 3 requires failures to be observable without falsely healthy service state, and the observability lane measured exactly that defect: a store operation returning 500 while `/healthcheck` still answered 200 `ok`. `createService` could not express a status code at all, which is why this needed a change outside the worker's owned files. | **Client-visible only on the ops surface.** The body keeps exactly the source's three members — no extra diagnostic field — because the body is what a consumer parses; the failure *reason* is logged instead. `HistoryStore.probe()` answers the equivalent question for a JSON-file store (readable *and* writable right now) by performing the writes a flush needs, so it fails on a corrupt snapshot, a read-only directory or a full disk rather than remembering that startup succeeded, and it leaves no residue. Recovery is unlatched: a successful write heals the snapshot and the endpoint returns to 200 without a restart. The other seven services keep their plain `ok`, which the lane now asserts directly (`overrides == ['history']`). Falsification: forcing `probe()` to report CONNECTED unconditionally fails two named tests. |

## Wire contracts and classic services (C-02, A-12, A-13, A-18)

| # | Decision | Why | Impact |
|---|---|---|---|
| C02a | **Repaired:** all nine pinned HubErrorCode values are present in `packages/contracts/src/constants.js`, including SKILL_NOT_FOUND, TIMEOUT_TRANSACTION, PARSER and GENERAL. | The prior missing-code finding predates the H-02 repair; PARSER error frames now match accepted source/runtime evidence. | Additional Phoenix-only codes are explicitly labeled for extra subsystem paths. The original blanket missing-enum claim is superseded; retain those extensions as a scoped difference. |
| C02b | `ResponseType` omits `ASR` and `COMMAND`, both present in the reference `hub/MessageType.ts`. | Same origin as C02a. | Open. Any reference emitter using those types would not round-trip. |
| C02c | Manifest-rule schemas (`ContextRule`, `IHRule`, `IHQuery`, `queryRules`) do not set `additionalProperties: false`, though the reference `SkillConfigValidator.checkUnexpectedProperties` rejects unknown keys. | Deliberate leniency so valid optional fields are never rejected. | Phoenix is **more permissive** than source here. Accepts everything source accepts, plus some source would reject. |
| A12a | Log `uploadUrl` / blob URLs point at the Phoenix entrypoint's local sink instead of S3 presigned URLs. | S3 and its credentials are dead; same self-hosted pattern already used by Backup. | Clients follow the returned URL, so the handshake shape is preserved. |
| A12b | `SetLevel` accepts and logs but performs no SNS `RobotVerbosityChanged` fan-out. | Phoenix has no SNS. | A robot will not learn of a verbosity change out-of-band. |
| A12c | `NewKinesisCredentials` returns a shape-complete but **expired** `StsCredentials`. | AWS STS is dead. Returning the correct shape keeps clients on their normal parse path rather than an error branch. | No real Kinesis stream exists to write to. |
| A12d | `log.js` emits Boom `badData` **422** for validation, while `robot.js` and `backup.js` still emit **400**. | Source Hapi services emit 422; log now follows source faithfully. | The older 400 convention in the two neighbouring files is **out of A-12's scope and still divergent** — a real inconsistency to close later, recorded here so it is not lost. |
| A12e | Phoenix returns `code = "ValidationException"` (422) and `"NotFoundException"` (404) where the source's Boom payload carried no `code`, so the original client fell back to the HTTP reason phrase (`"Unprocessable Entity"` / `"Not Found"`). | Phoenix codifies these; the source did not. | **Client-visible.** The pinned client's `extractError` (`lib/protocol/json.js:63-64`) resolves `e.__type \|\| e.code \|\| e.error`, so `err.code` genuinely differs. Root confirmed the precedence directly in the pinned SDK. Whether robot firmware branches on `err.code` for a 422/404 cannot be observed without firmware. |
| A12f | `SetLevel` rejects `namespaces` entries that omit `namespace` or `level` (422) where the source's `VerbosityLevel` Joi shape has no required members and returned 200; conversely Phoenix accepts `friendlyIds: [""]` (200) where source `Joi.string()` rejected it (422). | Phoenix's schema is stricter in one direction and looser in the other. | **Client-reachable, admin tooling only.** Not reachable from the robot path. |
| A13a | Push delivery runs through an in-process fixture provider. | The original push provider and its credentials are dead, and no mobile client exists. | The "available real client" half of A-13 criterion 2 is **recorded as unknown, not simulated**. |
| A18d | ~~`oauthClients.js` empty-string validation dropped the Joi wrapper.~~ **FIXED.** | Phoenix emitted `child "clientId" is not allowed to be empty` where pinned joi 13.1.2 emits `child "clientId" fails because ["clientId" is not allowed to be empty]`. Root ran the pinned joi from `.parity/reference` directly and confirmed the wrapper applies to the empty-string case exactly as it does to required/type failures. Both helpers corrected; the test that asserted the unwrapped form had encoded the defect and was updated. Falsified: reverting the source fix fails the test. | Resolved — no longer a divergence. |
| A12e | ~~422/404 error codes differed~~ **FIXED.** | Phoenix now emits the source's raw Boom payload with no `__type`/`code`, so the pinned client's `extractError` falls back to the HTTP reason phrase (`Unprocessable Entity`/`Not Found`). | **Scoped to the Log surface deliberately.** The envelope came from the shared `sendAmzError()` in `packages/classic/src/awsJson.js`, used by router/stubs/robot/push/key/backup/notification too; changing it globally would have rewritten every classic service's wire contract. A local `sendLogError()` handles only `boomBadData`/`boomNotFound`. Codified Log errors (429/403/401/500) still use the shared path because those already matched. |
| A12f | ~~`SetLevel` validation diverged~~ **FIXED.** | `VerbosityLevel` has no required members upstream, so `[{}]`, `[{namespace:'x'}]`, `[{level:'info'}]` are valid (200); `friendlyIds:['']` is rejected (422). Both directions corrected against pinned Joi. | Resolved. |
| A12g | Log blob retrievability was process-lifetime only: `GET /log/blob` 404'd after restart because the index was in-memory. **FIXED.** | Index is rebuilt from the on-disk object files on startup, so retrieval survives a restart. On-disk layout unchanged. | Resolved. |
| D-01a | Cache substrate: reference is Redis (shared, persistent, server-side TTL); Phoenix is an in-process `Map`. | No Redis in the restored environment. | Single-process request/response contract matches exactly; multi-instance sharing, restart persistence and Redis eviction are **not reproduced and cannot be closed by inference** — the reference capture used a fake Redis that never expired. |
| D-02b | Scope-overlap uniqueness: reference's Mongo multikey unique index rejects two same-slot credentials sharing a scope value; Phoenix's sorted-scope-set key lets them coexist, and a `find()` on a shared scope multi-matches and returns `credentialExists:false` for a stored scope. | Different storage substrate. | INFERRED reference (no Mongo available) / VERIFIED Phoenix runtime. No original fixture covers it. |
| D-02c | Single (non-repeated) `scopes` query param: reference 400s `Scopes should be an array`; Phoenix treats it as a one-element array and returns 200. | Express `qs` default gives a string on the reference. | Only the single-param form differs; the repeated-param wire form agrees. |
| A-10a | Unknown/rotated token at the socket: Phoenix rejects the HTTP upgrade with **401**; the source completes the handshake then closes with WebSocket code **404**. | Phoenix returns the HTTP-level rejection directly. | The pinned consumer sees `open->close` on the source but `websocket-error->close` on Phoenix. Recovery converges (both reconnect after 10s), but an earlier report called this "cosmetic" — that was **wrong**. |
| A-10b | A repointed robot still dials the dead `wsendpoint`: `scripts/robot-repoint-server-client.sh:10` leaves the socket entries alone. | Deliberate in that script; related to H-frontdoor. | **This is the concrete item blocking a closed A-10** — it needs a root/hardware decision, not just code. |
| KEY-1 | **Server-side loop-key minting removed — must not return.** An opt-in `mintOnRequest` made Phoenix mint and persist plaintext 32-byte loop keys. Deleted (the code, not just the flag) with a guard test that fails if reintroduced. | Official design doc `/confluence/display/JN/User+Generated+Content+Key`: "A stated design goal is that Jibo the company and its servers do not possess or store the user generated content key" and "The Jibo servers do not store this key." | It also BROKE adoption: the provisioning branch wrote encryptedKey+keyHash into requests, and a holder's listIncomingRequests filters out requests already carrying encryptedKey, so the robot's jibo-sts skipped them and never shared. It also handed the app the wrong key. |
| KEY-2 | ~~`Key.Backup`/`Key.Restore` could skip their owner check when Classic had no resolved caller.~~ **FIXED.** | The public Classic boundary always supplies a verified caller; the key routes reject a missing or foreign identity before reading or writing key material. | Resolved for production. The legacy no-boundary fixture mode is not an Internet-facing deployment. |
| KEY-3 | The key relay drops the source signature. JiboKeys' `encryptCommonKey` is sign-then-encrypt ("Encrypts common key with private key of the source; Encrypts result with public key of the target"), but the shipped `Key_20160201.Share` carries a single encrypt-only blob. | Phoenix models the shipped shape, which is correct for the recovered app. | A recipient cannot authenticate WHO shared a key. |
| KEY-4 | The JiboKeys design page describes a device-id API (Keys.Set/Get/Share/GetShared/RequestSharing) while the shipped service the app actually calls is `Key_20160201` with (accountId, loopId, publicKey) request documents. | Phoenix models the shipped shape. | Correct for the recovered app; the design page describes an earlier or parallel design. |

| MEDIA-1 | **Settled by pinned source — do NOT "fix".** `Media_20160725.List` does NOT filter soft-deleted rows while `Get` does. | VERIFIED in `jiborobot/srv-media-ws src/controllers/media.ctrl.js`: list() builds `const condition = { loopId: { $in: loopIds } }` (line 54) with no `isDeleted` predicate, while get() opens with `isDeleted: { $ne: true }` (line 239). `toJSON` (`src/schemes/media.js:27-28`) deletes `url` when `ret.isDeleted`. | A deleted row still appears in List with `isDeleted:true` and **no url**; the Android Gallery's `url IS NOT NULL` cursor drops it client-side. Root initially read this asymmetry as a bug and patched list() to filter — **that was wrong and was reverted**. The behaviour is faithful. |

| I-01c | Bare `/skill/launch/…`, `/speech`, `/speech/:id` aliases are served by Phoenix but 404 on the reference. | Additive convenience. | Additive only; not in DIVERGENCES.md before. |

| D-hardening-deadline | Data-service upstream calls (Open-Meteo, RSS, TomTom, calendar events, OAuth token exchange/refresh) run under a 10 s deadline and an AbortSignal that also fires when the robot's request disconnects; a timed-out relay answers 502 `Error getting <name> data: TimeoutError: ...`. | The source Lasso used axios without a timeout, so a stalled provider held the request open indefinitely. Staged September hardening re-port. | A stalled provider now fails after 10 s instead of hanging. Successful responses, cache envelopes, upstream-status error bodies and main's deferred HEAD prefetch are unchanged. |

| D-hardening-calendar-cache | Calendar cache keys include `endDate` and encode the `(skillId, accountId, calendar)` tuple (`google_calendar:<encoded tuple>:<encoded endDate>`). Every credential mutation — save/replacement, deletion, token refresh, deactivation — evicts every cached date range of the affected slot, and a Microsoft `InvalidAuthenticationToken` error *code* (not only message text) deactivates the credential. Concurrent `saveCredential` calls are serialized. | Source `createRedisKey` (`<service>_calendar:<skill>:<account>:<calendar>`) omitted `endDate`, so two windows served each other's events, and colon-joined ids could collide; source invalidated only on a new credential. Staged September hardening re-port. | Cache keys are not byte-compatible with the source format (Phoenix's cache is in-process, D-01a, so nothing shares it). A different `endDate` is a cache miss rather than a stale hit. |

## Corrections to earlier findings (recorded so they are not re-litigated)

- **I-01 candidate divergence #3 was FALSE.** It claimed body-parser left `req.body` undefined for empty/text-plain PUT. Re-running the pinned express 4.16.2 + body-parser 1.18.2 showed `req.body` is always `{}` on those routes, so Phoenix matches. Disproved with a reference HTTP oracle.
- **A-10's earlier "cosmetic code difference" characterisation was wrong** — see A-10a.
- **D-02's candidate report claimed durable state was satisfied while the deployed service was actually in-memory.** A corrupt-the-flush falsification exposed it; the flush now persists and was verified across a real SIGKILL + respawn.

| A18e | The A-01 map's `Lps_20171201.NewCredentials` row notes "absent from unauthorizedMethods (unsigned call allowed)". The pinned gateway does the opposite: absence means `MISSING_AUTH_HEADER`. | Documentation gloss only; the row's operative conclusion ("AWS4 signature is required") is correct, and the OauthClients rows in the same map state it correctly. | No behavioural impact. Fix the note so it cannot mislead a later task. |
| A18a | OAuthClients admin identity is the **verified access-key account's** `isAdmin` flag rather than a caller-supplied `x-amz-credentials` header. | The header is an internal source-service convention; honouring it on a public face would make admin a caller-controlled switch. | Same deliberate strictness already applied to `CreateHubToken` and `SuspendRobotLoop`. |
| A18b | LPS `bucketPath` uses a **0-based** month (`getMonth()` with no `+1`). | Verified against pinned `srv-lps-ws@e36e378a` `sts.ctrl.ts:26`, which reads `month=${date.getMonth()}`. | A **faithful source quirk**, deliberately reproduced. January writes `month=0`. |
| A18c | `Remove` with a missing id returns an empty 200. | Source `findByIdAndRemove` returns null and does not throw, but the wire body was never captured. | Retained as an explicit **unknown**, not claimed as parity. |

## Dead external dependencies (Account family)

| # | Decision | Why | Impact |
|---|---|---|---|
| D-fb | `FacebookConnect`, `FacebookMobileConnect` and `FacebookPrepareLogin` are **not implemented** and are excluded from the A-03 denominator | All three wrap Facebook's 2015-era Graph API using a Jibo-owned application ID and secret. The Graph versions they target are retired, and the Jibo app registration died with the company; a new app ID would not reproduce the original permissions, token formats, or review model. Same class as the existing `[DEAD]` exclusions (Google STT, Bing/Wolfram, Dialogflow, real OAuth refresh). | The **account-side data is retained**: `facebookAccessToken` is stored and preserved by the account model, `facebookConnected` is projected in the `Account` JSON, and Loop member projections strip the token exactly as source does. An imported household carrying a Facebook token still serializes correctly. Only the three operations that must call Facebook are excluded. A-03's implementable set is therefore **25 of 28** `Account_20151111` operations. Full reasoning: [A-03-facebook-dead-determination-20260911.md](parity/candidates/A-03-facebook-dead-determination-20260911.md). |

| A19a | **RESOLVED 2026-09-11: Jot target-prefix is not significant.** The `@jibo/server` dispatcher reads only the operation segment (`lowerMethodName = target.split('.')[1]`, byte-identical in `@jibo/server@2.1.3 dst/server.js:64-68` and `@jibo/server@3.1.1 dst/server.js:70-73`); the prefix is never compared, so `Jot_20160126` (model metadata) and `Jot_20160512` (archived runtime test) — and any other prefix — reach the same five handlers. Four prefixes x five operations return 200 against the live entrypoint. |
| A19b | **Jot party-era operations unimplemented — corrected and evidenced 2026-09-16.** They answer **404** (`Method <lowerFirst op> not found.`), not 400: `@jibo/server` resolves the handler in the POST `/` onRequest extension before credentials or payload validation, so an unregistered operation is a raw Boom 404. The claim that no implementation was recovered is also **false for five of them**. Searching all 229 commits of `jiborobot/srv-jot-ws-archived`: `CreatePart`, `UpdateMessage`, `GetMessages`, `ListInbox`, `ListSent`, `MarkAllDelivered` and `MarkAllSeen` have **zero occurrences** and were never built; but `RemoveMessage`, `ListIncomingMessages`, `ListSentMessages`, `MarkDelivered` and `MarkSeen` have a real handler and controller at `594abf5:lib/handlers/message.handler.js`. Those five are not ported because Jibo itself removed them: master HEAD dispatches `this.mapping` with only the five loop-era operations, the alpha `this.handlers` block having been replaced by the 2016-05-09 loop rewrite. Their schema is incompatible with the surviving one (`payload`/`recipients[]`/`delivered`/`seen` versus `content`/`loopId`/`read[]`), so implementing them would invent semantics rather than recover them. See `docs/parity/evidence/2026-09-16/a19-party-era/`. |
| A19c | **Two Jot membership gaps reproduced deliberately.** `markRead` has no membership check (TODO at `srv-jot-ws-archived message.ctrl.js:134`) and `numberOfUnreadMessagesInLoops` is a raw count with no membership check, so a caller can count unread in a loop it cannot list. Faithful to source; not closed. |
| A19d | **Jot Kafka fan-out not reconstructed.** `JotMessageCreated` is emitted with the exact `server/message-bus` payload but lands in a durable local event ledger, not a broker round-trip. |
| H01a | **Skill-list no-ID aliases are Phoenix extensions.** `GET /skills`, `GET /v1/skills` and `GET /skills/` return 200 with a reduced `{id,intents}` projection; the pinned reference 404s them. Same class as I-01c. |
| H09a | **`POST /v1/<id>/main` exists only in Phoenix** (the reference registers only `/v1/main`). Kept intentionally — it is the alias the gateway registry addresses. |
| N02a | **Repeated-rule tag composition diverges.** `digits.grm`/`year.grm` do not execute faithfully: `parseSeq` hoists a repetition's trailing tags to the group and `mergeObj` makes the repeated private field last-wins, so per-repetition `{_nl+=...}` cannot compose ('one two three' -> 33 not 123; 'nineteen eighty four' -> 4444 not 1984). Affects `*X{k+=X.f}` / `+X{k+=X.f}` generally. |
| N02b | **`':'` is a token in the AST lexer but a word character in `compiler.l`**, so factory sources using `?:` / `H:MM` forms cannot be read (`time.grm`, `timer.grm` do not parse). |
| N09 | **Phoenix does not reproduce an original grammar crash.** `clock/launch.rule:457` writes `LastName = ths._parsed` for `this._parsed`. Running the original `jibo-nlu` 2.8.3 `parse` binary over the pinned `launch.fst` shows this is not cosmetic: any utterance reaching that LAST_NAME arm aborts the request with `Rule Syntax Error / Uncaught ReferenceError: ths is not defined`, and the binary abandons the whole batch rather than that one sentence. "when is bob smith birthday" and "what is bob smith birthday" — a `whenIsBirthday` phrasing the Dialogflow agent itself lists as training data — are among them. Phoenix vendors the rule byte-identically and reproduces the *effect* (the assignment silently does not happen, so `LastName` is absent) but not the crash: it returns `whenIsBirthday{GivenName:'bob'}`. | An original defect, not a Phoenix one. Reproducing it would mean failing a parse the robot can answer. Recorded rather than emulated, per the standing instruction to make features work rather than match a dead reference bug-for-bug. | A parse the original refused now succeeds, with `LastName` unset exactly as the original intended but failed to do. Detected by `scripts/parity-nlu-oracle/sweep.mjs`, which reports these sentences instead of silently dropping them. |
| N02c | **Two of 15 factory sources unrecoverable.** `city_state.grm` and `last_name.grm` are byte-truncated by the archive portal, so their semantics are not claimed. |
| N01a | **2 of 98 named public rules refuse loudly in the AST profile.** `clock/alarm_set_value` and `clock/alarm_timer_ampm` throw `Unsupported NLU factory dependencies ...: time`. Root cause: `resources/factory-sources/time.grm` uses the native literal-colon form `?:`, which the word-token AST matcher cannot consume (`matcher.js:222` compares a lit node to a whole whitespace-delimited token; the native FST is byte-based). They fail LOUDLY, not silently — the loader still imports and hash-verifies all 98. The accepted compiled profile covers both. |
| I03a | **History retention prunes only the head of the array.** `_pruneExpired` inspects `skillLaunches[0]` only, and the array is in insertion order, so a back-dated launch that is not the first element is never pruned — a 40-day-old launch still answers `{count: 1}`. The reference delegates expiry to a Mongo TTL index. Found by the I-01 pass; owned by I-03. |
| I03b | **Retention sweep timing.** Phoenix prunes synchronously on read; the reference relies on Mongo's TTL monitor, which runs roughly every 60s and is therefore eventually-consistent. INFERRED — no mongod in this environment. |
| H07a | **Google ASR mock transport is not gRPC.** The `ETCO_server_gspeechMockAddress/Port` seam is implemented as line-delimited JSON over TCP rather than the pinned gRPC `SpeechClient(servicePath, port, insecure)`. The `ASROutput` frame shapes are preserved; the transport is not byte-identical. |
| H07c | **ASR confidence is synthetic.** `parakeetSession.js:449` reports `confidence: 1.0` for any non-empty transcript and `0.0` otherwise. Measured against the live deployment 2026-09-15, this is not a shortcut but the best the data allows: `POST /transcribe` returns `{transcript:{score: 396.396, text: "...", frame_confidence: null, token_confidence: null, word_confidence: null}}` — an unbounded likelihood score and three null confidence fields. There is no 0–1 confidence to pass through, and mapping `score` onto one would be an invention. The original reported Google's real per-alternative value (`GoogleASRSession.ts:125`) and **ranked interim results by it** (`:129`, `asrResult.confidence >= this.lastASRResult.confidence`), so the field carried real signal there. | Surfaced by the R-01 side-effect comparison, which found it on transactions that PASS every suite assertion: `test_audio.raw` returns `confidence: 0.9339536428451538` from the original and `1` from Phoenix. A pass count cannot see it. | The robot receives a constant in `LISTEN.data.asr.confidence`. Anything keyed on it has lost the signal rather than received a different value. Ranking is unaffected in practice because a batch recognizer returns one result, so there is nothing to rank. Closing it needs confidence output enabled in the Parakeet deployment (server-side configuration), not a code change here. |
| H07b | **Parakeet applies `earlyEOS` post-hoc.** The pinned `ParakeetASRSession.ts` builds `fastEOSRegex` and then never uses it. Phoenix completes the stated intent and annotates `FAST_EOS` in `finalize()`, so the batch path does not silently drop the annotation. **No longer intent-derived — observed 2026-09-15.** Substituting Phoenix's gateway into the original `integration-tests-int` stack, `Listen transaction > Early EOS and ASR hints` fails with `expected 4 to equal 3`: a batch recognizer cannot truncate the utterance at the trigger word, so "live long and prosper" is transcribed whole, parses to `referenceLiveLongProsper`, and routes to a skill — a 4th message the original never sends. The original's own log line in the same run is `GoogleASRSession Incremental transcription contains a FastEOS trigger word/phrase. Stopping ASR and returning.` This is the one behavioural difference in that lane; see `docs/parity/evidence/2026-09-15/r01-hub-substitution/`. |
| D05a | **`GET /v1/dark_sky` with no lat/lon returns 200.** `Number(null) === 0` passes `Number.isFinite`, so Phoenix answers `latitude:0, longitude:0` and caches `dark_sky:0;0`. The original's `LatLon.make_from_strings` throws `RangeError('Invalid latitude undefined')` → 400. Observed at runtime; owned by D-05. |
| D07a | **Map coordinates are only range-checked by `Number.isFinite`.** `{lat:800}` / `{lon:654}` pass validation and reach the provider; the original rejects them with `Invalid latitude 800`. INFERRED from the pinned `GoogleMaps.test.ts`; owned by D-07. |
| D02d | **A legacy credential snapshot may violate the new scope-overlap invariant.** `_load()` does not enforce it, so a file written by an older Phoenix could still multi-match on `find()`. New writes cannot create that state. |

## D05b — historical timestamps outside the Open-Meteo window (open)
`requestedDayIndex()` falls back to the window's base day when `secondsSinceEpoch` lies outside
Open-Meteo's `past_days=1` window, while the cache key still carries the requested date — so
`dark_sky:1;2;2018-01-19` returns today's payload. The original time-machined to the requested day.
Closing it needs an Open-Meteo archive query. The report skill's real historical request (now-24h) is
inside the window and is correct.

## D06a — news poller start() was not concurrency-safe (FIXED)
`createNewsPoller.start()` awaited the initial poll BEFORE assigning `timer`, so the `if (timer)`
guard could not stop a second concurrent call: both polled all 11 categories (22 provider fetches).
This surfaced as a flaky `D06/11` failing `22 !== 11` only under full-suite load — the agent's own
report claimed exit 0 because its second run happened to pass. Root reproduced it directly (three
concurrent `start()` calls -> 22 fetches), fixed it by memoising the in-flight start promise, and
re-verified: 3 concurrent starts -> 11 fetches, later sequential start still a no-op.
LESSON: an `if (guard)` set only AFTER an await does not guard anything.

## D06b — replacement news feed spoke short titles (FIXED 2026-10-02)

The original report speaks `apcm:ExtendedHeadLine`, a sentence-length story brief.
AP also supplied a short title and a longer summary; the summary was used for
content filtering. The RSS adapter copied the short RSS title into both `<title>`
and `apcm:ExtendedHeadLine`, leaving the fuller description only in `<summary>`.
Consequently, the robot read the terse title even though the provider supplied
more context.

The adapter now maps the cleaned provider description to `apcm:ExtendedHeadLine`
and retains the original title and summary fields. A missing description still
leaves `<summary>` absent, preserving the source parser's missing-data behavior.
The source MIMs, 0.75-second lead-in, pitch, story counts, images, and content
filters are unchanged.

Evidence: the pinned Pegasus `5c0a739` [NewsParse.ts](https://pvindex.org/gitea/jiboV2/pegasus/src/commit/5c0a7390539663ba749d360de348a428c088505c/packages/report-skill/src/subskills/news/NewsParse.ts)
selects `ExtendedHeadLine` at line 136. Its archived `APNewsTestData.ts` payload,
normalized in `scripts/parity-s10-source-diff/ap-fixtures.json`, contains ten
stories averaging 23.3 words in that field (11–37), versus 71.2 in the full
summary (40–91). A ten-story sample from the configured BBC general feed on
2026-10-02 averaged 11.7 words per title and 18.6 per description. These are
sample measurements, not duration guarantees. Jibo's [AP content tuning ticket](https://pvindex.org/jira.jibo.com/browse/JIBO-2714.html)
also records the move toward one-sentence extended headlines.

Regression coverage follows RSS through the AP adapter, NewsParse, NewsMimLogic,
and the rendered robot speech sequence, including the original pauses and image
association. RSS/Atom field mapping, absent summaries, and refreshed cached
speech are covered by the data tests. This is a replacement-provider mapping;
the real AP consumer contract remains unchanged.

## D06c — shared generated news briefings (opt-in, 2026-10-02)

`PHOENIX_NEWS_BRIEFINGS_ENABLED=true` enables a separate, versioned
`/v1/news_briefings` path. World News API supplies article text; a scheduled Lasso
worker summarizes it with the pinned OpenRouter model
`deepseek/deepseek-v4.1-flash`. All eleven categories refresh every twelve hours.
Each has up to five prepared stories, shared across people and robots. The
provider adapter is separate from generation and storage so it can be replaced.
Every category now uses the same US national edition: both US publishers and a
US location entity are required. The legacy international category uses domestic
selection too. Changing editions drops worldwide snapshots but retains daily
spend and reusable article drafts. Each validated story becomes readable during
the refresh, with candidates interleaved across categories to reduce cold-start
waiting. An unavailable category is skipped, so worldwide RSS cannot reappear
during warm-up. The legacy `/v1/ap_news` contract remains the default when the
feature is disabled.

Opinion pieces, editorials, op-eds and commentary are excluded using explicit
title/URL/provider labels before generation and title/URL labels on cached reads.
The versioned generation prompt also asks the model to reject unlabeled opinion
or advocacy instead of extracting its claims into apparent straight reporting.
It requires impartial language and attributed claims, rejects loaded framing and
unsupported inferences, and forbids invented counterarguments or artificial
balance. These are model instructions, not a claim of guaranteed neutrality or
independent fact checking of the source.

Each story has three sentences targeting 50–60 words (validated at 48–62), with
publisher attribution, source paragraph references, and no model-supplied markup.
The renderer produces only Jibo's `style set="neutral|enthusiastic"` and
`break size="0.35"` tags. Separate MIMs retain the native news animations, avoid
the original AP-only introduction and nested pitch, and disable automatic voice
styling. This targets 20–30 seconds; actual timing still needs a robot listening
test. Validation checks structure, evidence IDs, length and markup, not factual
entailment. The model is instructed to preserve source uncertainty and skip
articles lacking sufficient information.

The original adult/banned keyword sets apply to the full source text before
prompt truncation, as well as generated speech. Adult classification survives
summarization. Stories do not require image metadata: the new view shows the
title, publisher and category. Selection retains the original category/story
counts and suppresses duplicate selected story URLs across categories.

Atomic private snapshots and daily spending reservations live under
`PHOENIX_DATA_DIR/news/briefings.json`, outside releases. HTTP reads never fetch
providers or call models. The worker caps World News requests at forty points
per UTC day and model spending at $0.15 per UTC day by default; OpenRouter calls
also enforce token-price ceilings. One validation repair is allowed. Failures
retain last good stories until their original publication/generation age reaches
thirty-six hours. Changed source revisions invalidate older summaries. Corrupt
storage stops paid refreshes instead of silently resetting the spend ledger.

Coverage: `packages/data/test/news-briefings.test.js`,
`packages/skills/test/newsBriefings.test.js`, and
`packages/account/test/adminNewsConfig.test.js`. Operational setup is in the
[runbook](RUNBOOK.md#shared-news-briefings).

## D07b — no traffic model (CLOSED 2026-09-15, OpenRouteService replaced by TomTom)
OpenRouteService has no traffic model at all, so `duration_in_traffic` always equalled `duration`,
`extraMins` was always 0, and the report skill's commute quality could never select Poor or
Terrible. The feature was dead by construction, not by configuration.

ORS has been removed. `packages/data/src/maps.js` now uses TomTom Routing, which returns a real
live-traffic breakdown on a free, no-card tier:

    liveTrafficIncidentsTravelTimeInSeconds -> Google duration_in_traffic
    noTrafficTravelTimeInSeconds            -> Google duration

`computeTravelTimeFor=all` is REQUIRED. Without it TomTom silently omits the breakdown and answers
with free-flow times only, which is indistinguishable from "no traffic right now" — the same silent
failure mode that let the ORS gap go unnoticed. Verified live: a Boston route returned 913 s
free-flow against 936 s with traffic, values ORS could not have produced.

## D07c — maps feature gaps (open, retained)
`mode=transit` is answered with TomTom's `bus` travel mode, which is not real transit routing.
`overview_polyline` and `bounds` are no longer populated: TomTom returns route geometry as point
arrays rather than an encoded polyline, and CommuteParse reads neither field. `legs[].steps`,
`arrival_time`/`departure_time`, `warnings`, `fare` and `geocoded_waypoints` are still not produced.
These are provider gaps, not port defects.

## A05f — oobeRestartSIGKILL is flaky (RESOLVED 2026-09-17)
`packages/account/test/oobeRestartSIGKILL.test.js` "SIGKILL mid-write leaves a complete snapshot
with the issued robot credentials" failed roughly one run in three. Observed 2026-09-15 on an
otherwise untouched tree, so it was not caused by the Jot fan-out work landed the same day.

Quantified 2026-09-15 while checking whether an unrelated change had caused it: **3 failures in 8
consecutive runs on a clean HEAD**, the test file run alone. Small samples on either side of a
change are worthless here — 3-run samples gave 3/3 pass on the clean tree and 1/3 on the changed
tree, which would have supported exactly the wrong conclusion in both directions. Anyone
attributing a failure of this test to their own change needs a run count in the dozens, or the
flake fixed first.

A flaky test in a parity suite is worse than a missing one: it trains readers to re-run until green,
which is exactly how a real regression gets waved through. It should be made deterministic or
quarantined with its reason recorded, not left to chance.

**Root cause and fix.** The flake was not scheduling jitter — the test asserted something the
mechanism cannot provide. It required that **no `.tmp` file survive the kill**, but `Store.flush`
writes `openSync(tmp,'wx')` … `renameSync(tmp, file)` and cleans the temp file in a `finally`. A
`SIGKILL` cannot run a `finally`, so when the signal lands between the open and the rename an
abandoned temp file remains **by construction** — and the child loops on `flush()` precisely so the
kill lands mid-write. Re-measured at the demanded run count, same machine: **8 failures in 25 runs
with the original assertion, 0 in 25 with it corrected.** The corrected test asserts what the
atomic-write mechanism actually guarantees and what the A-05 criterion actually needs: the committed
snapshot stays complete JSON with its issued robot credentials, the access key still resolves to the
robot after the crash, a missing store still loads as empty, and any abandoned temp file is
**private** (`0600`) so a torn write can never be read as truth. The credential and atomicity
assertions — the ones the criterion rests on — passed in every one of the 51 runs.

## N03a — conditional semantic actions (FIXED; see N05b)
The initial action-skipping defect was repaired by the conditional action evaluator.
N-03/N-05 final acceptance supersedes the open candidate finding.

## N03b — factory namespace leak (FIXED; see N05a)
Each factory now binds its own rule namespace. N-03/N-05 final acceptance
supersedes the initial caller YES/NO override defect.

## N03c — clock time dependency gate (CLOSED by N-03 time acceptance)
The recovered source time grammar and action evaluator now cover the supported
clock time/AM-PM paths. All 20 public clock/settings/menu rules have accepted
fixtures; the old bare-AM/PM refusal is superseded. Other unsupported factory
dependencies remain explicit in the current rule inventory.

## H08a — failure-path speech record is saved twice (matches reference, kept)
A rejected LISTEN turn writes the speech-history row TWICE: `reject()` saves after
`onTransactionError`, then `stop()->done()->resolve()->onTransactionSuccess` saves the same
still-id-less record again. The agent confirmed this ordering on the pinned original under
node 8.9.4 (tooManyRedirects/parserFailure: two speechSave events, both recordId=<undefined>),
so it is reproduced, not invented. Falsification: deleting listenTransaction.js:600 fails the
named double-save test 2-vs-1.

## H08b — skillTimeout late skill-error record (open)
The reference's inner 10 s SkillRequestMaker budget can win on a hung skill and record a late
`{skill:{error:{code:'TIMEOUT',...}}}` that Phoenix's record never gains (outer budget only).
H-04 timeout-layering surfacing through H-08. Excluded from the strict differential.

## N06a — inline loop-member escaping removed (intentional behavior change)
N-06 follows the pinned detector's unescaped/missing-name behavior. Its final
acceptance additionally verifies separate speaker/referent handling through the
gateway; the old whole-task-unverified statement is superseded by N06b.

## S01a — cross-shape session reuse (source-faithful; cutover policy accepted)
Source and Phoenix do not validate a session against the host shape. S-01 is
verified with the tested deploy-time cutover gate described in S01b: resume or
drop/relaunch based on shape. Physical robot cutover remains a specific follow-up
in VERIFICATION-GAPS.md HW-07, rather than a whole-task blocker.

## H06a — proactive selection collection order (open, kept)
The source collects skill configs with Promise.all so `results` order is completion order
(ProactiveTransactionHandler.ts:202-239); the port iterates sequentially in config order.
Unobservable in a single outcome because the pick is uniform. Not changed.

## N05a — factory namespace isolation (FIXED)
Phoenix merged each `$factory:NAME` into the requesting rule's namespace, so a public rule
declaring its own YES/NO (15 vendored rules do) silently replaced the factory's and literal
'yes'/'no' no-matched. `compileRuleTree()` now binds each graph's refs to its own rule map
(matcher.js:129-138) and each factory top is pre-compiled against its own rules
(requestParser.js:86-92,232-235). This also resolves N-03/D2 (N03b) for the yes_no factory.

## N05b — conditional {% if %} semantic actions (FIXED)
`parseActionBlock` skipped whole-block control flow, so 5 rules leaked the raw factory intent.
The parser now emits `cond` tags (parser.js:243-252) evaluated in `applyTags`
(matcher.js:183-189): alarm_timer_change yes->delete/no->keep, right_word yes->agreement,
alarm_timer_other_set yes->replace, greetings proactive questions yes->good/no->bad. This also
resolves N-03/D1 (N03a). Conditional coverage: 10 statements across 5 rules-src files.

## N07a — fallback candidate limitations (superseded by N07b)
The final N-07 acceptance provisions both parser profiles, re-derives the
archived catalog and explicitly ratifies attach/omit behavior. Its initial
three candidate hold items are closed; retired vendor and profile limitations
retain their own documented boundaries.

## D04a — initial calendar candidate gaps (superseded by the closed record below)
The extra top-level events mirror was removed and upstream query/pagination
behavior ported. D-04 has final accepted evidence; live credentials remain a
separate provider qualification.

## N03d — historical coarse time refusal (superseded)
The refusal protected the pre-time-factory candidate. The recovered time
grammar/action evaluator and exhaustive native time controls now close N-03;
its current acceptance covers 20/20 public rules. Retain preflight refusals for
other factory dependencies still identified as unsupported in the inventory.

## N03e — worktree @phoenix/* symlink hazard (test-integrity note, second sighting)
Worktree `node_modules` symlinks to the main checkout, so `@phoenix/*` package-name imports
exercise the MAIN tree, not the worktree under test. The N-03 agent's broken-gate falsification
left the gateway test green until it switched to relative imports. First sighting was H-06's
@phoenix/gateway draft. LESSON: worktree tests must import relatively; a passing suite that
imports by package name proves the wrong tree.

## A19e/A19f/A19g — Jot error-envelope differences (accepted scope)
Joi/business-error envelopes and dotless-target handling retain the recorded
raw-byte differences. The final A-19 acceptance explicitly permits these
qualified differences and exercises the real era SDK over TLS. A-19 is verified;
its former candidate/original-client blocker is superseded.

## D04a — calendar envelope mirror + unported clients (CLOSED w14/d04)
Top-level `events` mirror REMOVED: the envelope is now exactly
`{relayData, lassoDataFromRedis}` (+ `lassoInsertedIntoRedisAt` on a hit), matching
`AbstractRelayRequestHandler.ts:112-131` and both pinned deep-equal bodies. The two certified
files (credential.test.js, oauth.test.js) now read `body.relayData.events`; their findings are
preserved. Upstream pagination/ordering ported with the pinned wire query recorded. Residual:
report-side endDate UTC rendering belongs to `packages/skills/src/report/calendar.js`, outside
D-04 scope. The pre-existing port collision (credential-durable PORT+5=7805 vs
calendar-lasso-integration PORT=7805) is still open; calendar-relay.test.js now retries the
next port on EADDRINUSE.

## N06b — speaker/referent settled (CLOSED w14/n06)
`perception.speaker` and `dialog.referent` are independent RuntimeContext fields; the hub copies
the detector's `loopMemberReferent` entity into `dialog.referent` (SkillRequestHelper.ts:93-102)
while the speaker feeds only history personIDs (TransactionHelper.ts:13-16). Proven over a real
gateway CLIENT_ASR turn. `SPEAKER_ID` ignoring is faithful (deprecated in source).

## S01b — cutover gate (CLOSED w14/s01, deploy procedure)
The cloud cannot enforce session cutover (no registry, no shape validation, session arrives
from the robot in CONTEXT). Release procedure: run `scripts/parity-s01/cutover-gate.mjs` —
exit 0 resumes, exit 2 drops-or-relaunches. Standalone report-skill nodeID 31 vs cohosted 35
observed; cross-shape reuse is silently reinterpreted (HTTP 200), never refused.

## N07b — external-agent revision ratified (CLOSED w14/n07, root judgement kept)
`EXTERNAL_ATTACHMENT_REVISION {attach, omit}` defaults to `attach` (5c0a739); `omit`
(715e0dd0) is selectable per request. The omission is an incomplete restoration — its own
`ParserService.ts:54,121-123` still wires `DialogflowClient`. Per-profile matrix 18/18 under
both AST and provisioned compiled-FST with zero row differences; archived catalog re-derived
(99 intents / 89 entities). N-07-D1 (LLM names vs Dialogflow names) stays open but measurable.
