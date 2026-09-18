# Divergences from the Pegasus reference

Phoenix aims for **behavioral** parity at the wire, not internal fidelity. Every intentional
deviation is recorded here with rationale, so the M9 parity report is just this file finalized.
Each entry: what changed, why, and the parity impact.

## Architectural (decided at bootstrap)

| # | Divergence | Rationale | Parity impact |
|---|---|---|---|
| A1 | Language: modern **JavaScript** (ESM, Node ≥20) instead of TypeScript-compiled-to-node-8 | Project decision; no build step; types via JSDoc + runtime schema validation | none (wire-compatible) |
| A2 | **Zero external deps** for contracts/common/harness (hand-rolled JSON-Schema validator, HTTP runner, diff) | Installable offline, tiny surface, no supply chain | none |
| A3 | **npm workspaces** replace lerna + yarn-1.7 | Reference tooling is dead-era | build-only |
| A4 | Default per-service ports 7010–7014 instead of all-8080-in-container | Allows local side-by-side runs without docker | none (harness collapses port in URLs) |
| A5 | Skill `session` blob compared **round-trip only**, not by contents | node-ID assignment is an internal concern; reference assigns global sequential IDs by registration order | must preserve round-trip opacity |

## Behavioral decisions still open (resolve in the noted milestone)

These are *flagged, not yet decided* — surfaced by the atlas open-questions/risk register.

| # | Question | Milestone | Default leaning |
|---|---|---|---|
| B1 | Weather day-index off-by-one (Open-Meteo `past_days=1` makes `data[0]`=yesterday while report-skill reads `data[0]`=today) — replicate bug-for-bug or fix? | M4 | replicate, then fix behind a flag |
| B2 | NLU intent catalog — match the reference's grammar coverage (198 Dialogflow intents) or the phoenix LLM subset (~14)? | M5 | start from the LLM subset, expand against the corpus |
| B3 | `Credentials.deleteOtherCredentials` uses `if (skillId = 'report-skill')` (assignment bug) — preserve or fix? | M4 | fix (and note the behavior change) |
| B4 | Speech history has no TTL in the reference — add retention or match (none)? | M3 | match (none) for parity; retention is ops-side |
| B5 | MIM prompt-variant randomization seedability for deterministic tests | M7 | add an optional seed (test-only), default unseeded |

## Decided behavioral divergences

| # | Decision | Why | Wire impact |
|---|---|---|---|
| B3✓ | `deleteOtherCredentials` assignment bug **fixed** (`===`) | Bug-for-bug would delete wrong creds | delete-other now correct |
| B6 | **GQA → answer-skill**: knowledge questions (whoIsPerson, requestTellAboutThing, general*Questions) remap to answer-skill instead of chitchat | Reference chitchat GQA deflected to Wolfram (dead service); phoenix answers via Wikipedia/LLM | better answers; chitchat personality questions unaffected |
| B7 | **requestWeather → requestWeatherPR**: weather questions route to report-skill's weather subskill | Chitchat's requestWeather memo was a "go ask the report" deflector; phoenix goes straight there | weather questions get real weather |

| N1 | **Default parser stays the AST engine**, accepting 49 residual differences out of 20,528 captured requests | The compiled-graph runtime is exact (20,528/20,528) but needs the original's graph data provisioned, which is not vendored. Keeping AST means a plain checkout runs correctly with nothing to download. The residuals are explained, not unknown: families F2 (47) and F3 (2) in `docs/parity/candidates/N-08-residual-families-20260907.md` are tie-breaking artifacts of how the original's graphs resolve after optimization, and are not repairable in an AST engine. | 49 of 20,528 parses may select a different rule among overlapping arms. Compiled remains available opt-in via `PHOENIX_NLU_RUNTIME=compiled-fst` for anyone who wants exactness. |

Add a row the moment a deviation is chosen; never let code diverge silently.

| E8-news-images | report news | Reference NewsParse required an AP image per story and cut the feed-header item; the Phoenix data service's RSS→AP shim carries no images, so `image` is optional and only `headline` is required (no header cut). | Faithful against real AP data; shim-compatible. |
| E8b-datetime | report subskills | jibo-data-utils DateTime is ported lean (utc/clone/setTime/isFuture/getRelativeDays/getLocalTime + toString {timeOnly}/{prefixOnAt} with at/tomorrow-at/on-weekday phrasing) instead of the full moment-tz surface. | Covers every call site in the report subskills; full DateTime port only if other skills need it. |

## Phase G — classic services (per-robot auth + OOBE portal)

| # | Decision | Why | Impact |
|---|---|---|---|
| G-sigv4 | Robot Classic-Service requests (AWS SigV4) are **not signature-verified** | The original per-account signing keys are unrecoverable; identity comes from the one-time OOBE token + the hub JWT instead | Anyone who can reach `/` can call the robot-facing OOBE ops — LAN trust (like the hub's `DISABLE_AUTH`); per-account admin (`isAdmin`) + per-robot hub auth are the real gates. For `prepareRobot` we parse the `accessKeyId` out of the Authorization header (unverified) to identify the caller. |
| G-store | Accounts/loops/tokens/sessions persist in a **single JSON file** (atomic tmp+rename) instead of Mongo | Zero-dependency, household-scale; the reference's Mongo/Redis are overkill for a single-owner revival | Not horizontally scalable; fine for one deployment. Path via `ETCO_account_dataFile`. |
| G-hubtoken | Hub tokens are **symmetric** HS256 over a shared `HUB_TOKEN_SECRET` (issued server-side via `/api/token`, optionally validated against the account service via `ETCO_hub_accountUrl`) | Matches the reference `createHubToken` (same secret, 3h expiry) and the robot's own local-signing path; asymmetric keys were out of scope | Anyone with the secret can mint a token for any identity — keep it secret; revocation is via account deactivation (`/api/verify` → `{valid:false}`), not token blocklists. Tokens without `exp` (sim/robot hand-signed creds) stay valid for LAN back-compat. |
| G-admin | The portal admin face is a **per-account flag** (`isAdmin`), not a shared password | The single shared `ADMIN_PASSWORD` gave every operator the same credential, left no per-person trail, and could not be revoked for one person without changing it for everyone. Replaced 2026-09-18. | Grant with `scripts/portal-grant-admin.mjs --email <address>` (and `--revoke`). Every `/api/admin/*` route re-checks the flag, so a signed-out caller gets 401 and a signed-in non-admin 403 — the console renders "sign in" for one and "not an administrator" for the other. The flag is read per request, so revoking takes effect immediately with no stale session. |
| G-qr | The OOBE QR **encoder** is a fresh from-scratch implementation (byte mode, RS/BCH, mask selection), not the robot's original QR library | Phoenix vendors plain data + minimal deps; the original lib isn't reusable server-side | Output verified by decoding it back with jsQR (dev-only oracle); the *payload* format (XOR key + chunk framing) is the exact `config.bt` contract. |


## Phase H — remaining classic services

| # | Decision | Why | Impact |
|---|---|---|---|
| H-frontdoor | One `packages/classic` entrypoint (:9012) dispatches every classic service by X-Amz-Target prefix — in-process for stateless (log/robot/notification/key/push/stubs), proxy for stateful (OOBE/account/settings -> account, Update -> ota) | The robot resolves all server-client services to one host; a single front door matches that without merging every store into one process | The robot's region points at one port. The notification **wss socket** (entrypoint-socket) lives here too, but a robot's `wsendpoint`/`<region>-socket` host is left untouched by point-robot-at-phoenix.sh — pointing a real robot's socket needs that repoint too (follow-up). |
| H-inmemory | notification/key/push and the tier-3 stubs keep in-memory state (not persisted) | Household scale; UGC encryption, push delivery and Commander aren't needed for basic robot revival | State is lost on restart; fine for the conversational+pairing revival. Settings persists (account store); only these auxiliaries are ephemeral. |
| H-stubs | rom/media/person/ifttt/nlp/collision are built to the wire contract (correct output shapes) but their real function needs the dead mobile app / robot hardware | Can't exercise Commander, media upload, push, IFTTT, etc. without the app — but a robot/app calling them must get a valid shape, not a hang | Wire-tested for dispatch + shape; **unverified end-to-end**. person keeps a real in-memory property round-trip. |
| H-backup | `backup` (Backup_20170222) is a **working** service, not a stub: `Backup.New` hands back an upload URL that points back at the entrypoint (no S3 — same self-hosting as OTA packages), a `PUT /backup/blob` stores the blob and answers with an `ETag`, `Backup.List` returns it (default max=1, newest-first) and `GET /backup/blob` serves it back for restore. The original's `loop.robot === accountId` ownership check is dropped (LAN trust, like the rest). This is the **"Backing up robot…" step of the UI wipe/factory-reset flow** — with the old empty-`uploadUrl` stub the robot's `jibo-system-backup.js` upload failed, `systemManager.backup()` returned non-zero, and the gated wipe aborted with "we couldn't wipe your robot." Verified end-to-end against the real client sequence (Loop.List → Backup.New → PUT → Backup.List → GET). | A robot can actually back up before wiping (and restore after). | Storage is **process-lifetime**: an in-memory index + blobs on disk under `ETCO_classic_backupDir` (default `$TMPDIR/phx-backups`). Durable across a robot reboot within one server run (backup→wipe→reboot→restore); not across an entrypoint restart. UGC encryption is the robot's own (`key.loadOrCreateSymmetricKey` is client-side, from `/var/jibo/keys`); the blob is stored opaque. |
| H-loop | `@phoenix/account` (robot face) implements `Loop` ops reachable via the entrypoint's `/^loop/i` proxy. **`List`/`ListLoops`** → the loop(s) for the signing account (robot → its loop; owner → owned loops), `_id`→`id`. **`SuspendLoop {loopId}` / `SuspendRobotLoop {friendlyId}`** → `{result:"Command accepted"}`, marking the loop suspended if found but **never rejecting** (the robot sends its *own* local-KB loopId, which won't match the Phoenix-adopted one). The robot sends the wire `name`, so `Loop.list()`→`ListLoops`. Other Loop ops are not built (clean `UnknownOperationException`). | The wipe/factory-reset has TWO cloud gates: `jibo-system-backup.js` calls `Loop.ListLoops` then `Backup.*`; and **`WipeUtil.run` calls `kb.loop.suspend` → `Loop.SuspendLoop` and aborts the whole wipe ("wipeFail") on any error that isn't `LOOP_NOT_FOUND`**. The shipped `be/settings` swallows *backup* errors but NOT suspend — so `SuspendLoop` is the real wipe gate. Both verified end-to-end against a real robot (Jibo Mark-I, firmware 3.3.0). | v1: one owner / one robot per loop. `SuspendLoop` returns success unconditionally so a robot whose KB loopId predates Phoenix can still complete a wipe. Member-management ops deferred. |
| H-notbuilt | `voicetraining` and `jot` are NOT built | No client API contract (`*.normal.json`) exists in the archive's `apis/` for them | On-robot voice enrollment works without the cloud sync; jot video-message storage is a feature, skippable. |

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
| R2 | The repoint configuration ships **inside the OTA image**, and the published package carries **no `preinstall`/`postinstall` hooks at all**. The server URL is a **build-time input**, taken from this server's configured public URL; the build refuses to run without one unless an explicit leave-as-is opt-out is passed, and the manifest records which case it is. | The archived updater (`PlatformTeam/jibo-ota-updater`) applies a package as `preinstall` → write the filesystem to the device → `postinstall`, and **both hooks run while the robot is still on its old root** — the incoming filesystem is mounted at `/tmp/other` and unmounted before the root switch. A hook therefore cannot edit the image it is installing. Separately, **an error in either hook is fatal**: `apply_common.fail()` writes work state `retry` and reboots, so a hook with a bug becomes a redownload-and-retry loop rather than a failed update. The repoint spans four partitions while an os/services update replaces three: hosts and the CA-trust patch (R1) in `rootfs`, the jetstream hub/entrypoint `override` in `services`, BE 11.0.1 under `/opt` in `skills` — and the region in `/var/jibo/credentials.json`, which is **preserved on purpose** and so cannot carry the URL for a robot that was never repointed. | **The repoint now works for a robot that has never been touched over SSH**, which is the whole point: previously the firmware upgraded and the robot still could not find the server. Costs accepted deliberately: a payload is **deployment-specific**, so changing the public URL means building and publishing a new payload with a new hash rather than editing a robot; and a payload built with no configured URL is a different, documented artefact rather than a silent default. The reference has no equivalent step — a reference robot was provisioned by the factory and cloud, not repointed by its own update — so this is a Phoenix extension, recorded here rather than presented as parity. No hooks means the fatal-retry path cannot be entered from our payload. |



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



## Speech endpointing (Phoenix-original; the reference had none)

| # | Decision | Why | Impact |
|---|---|---|---|
| ASR-1 | The trailing-silence window that ends a turn is **400 ms**, overridable with `PHOENIX_ASR_SILENCE_EOS_MS`. It was 700 ms. | The reference never endpointed locally — Google's recognizer reported `END_OF_SINGLE_UTTERANCE` itself (`GoogleASRSession.ts:106`) — so this window is a Phoenix invention with no source value to be faithful to, and it is the dominant cost of the pause a person feels after they stop talking. Measured 2026-09-17 on real captured turns by replaying them through the real session at several windows (`scripts/parity-asr-encoding/eos-latency.mjs`): a Linear16 robot's pause is **exactly the window** — 0.70 s at 700 ms, 0.40 s at 400 ms, on every capture. An `OGG_OPUS` robot pays it twice, because its audio arrives in ~0.45–0.51 s pages (measured: 22 pages for a 10.90 s turn), so the silence is not even visible until the page carrying it lands; the window still dominates the controllable half. The speaker asked for "maybe a second" and explicitly not five. | Shortens the pause by 300 ms on every turn. **Trade-off, recorded deliberately:** a mid-sentence hesitation longer than the window now ends the turn and cuts the utterance. Because the reference's endpointing was dynamic and external, there is no source behaviour to match here, and the alternative — keeping a pause the speaker has asked to shorten — is worse. `eos-latency.mjs` is the harness to re-derive this value; the empty-endpoint re-listen still recovers a window that recognizes no words at all. |
| ASR-2 | Every completed turn logs `ASR turn` at info: `reason`, `audioMs`, `silenceWaitMs`, `recognizeMs`, `relistens`, `chars`. | The pause has two halves — waiting out the silence, then recognizing the buffer — and a log that prints only a total cannot tell them apart, so a change to either could not be attributed. `recognizeMs` is measured from **the first** EOS, so a re-listen's wasted round trip is included rather than hidden. No transcript text or household data is logged. | One extra info line per turn on the listening path. |



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
| C02a | **`HubErrorCode` does not match the pinned interface.** Verified 2026-09-10 by diffing `packages/contracts/src/constants.js` against `interfaces/src/hub/HubErrorCode.ts@5c0a739`. Reference-only, missing from Phoenix: `SKILL_NOT_FOUND`, `TIMEOUT_TRANSACTION`, `PARSER`, `GENERAL`. Phoenix-only, absent from reference: `TOO_MANY_REDIRECTS`, `NOT_IMPLEMENTED`, `NOT_FOUND`, `INTERNAL`, `AUTH`. | Phoenix's set was invented before the interface was pinned. | **Open, not resolved.** These codes travel **on the wire to the robot** on `ERROR` responses, so a robot matching on `SKILL_NOT_FOUND` sees `NOT_FOUND` instead. The gateway already consumes the Phoenix values, so this needs a coordinated change across gateway and contracts rather than an edit to the enum alone. Flagged by C-02; **not** fixed in that task's scope. |
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
| KEY-2 | `Key.Backup`/`Key.Restore` skip their owner check when the caller cannot be resolved: `accountId = caller \|\| 'anon'` with guards `if (loop && caller && ...)`, so an unauthenticated classic call is stored as 'anon' and ownership is bypassed. | Pinned srv-key-ws has no such branch — accountId is always the gateway credential. | Real weakening inside the documented LAN-trust boundary. A backup row was created this way before a header bug was fixed and had to be deleted and re-created to carry the owner id. |
| KEY-3 | The key relay drops the source signature. JiboKeys' `encryptCommonKey` is sign-then-encrypt ("Encrypts common key with private key of the source; Encrypts result with public key of the target"), but the shipped `Key_20160201.Share` carries a single encrypt-only blob. | Phoenix models the shipped shape, which is correct for the recovered app. | A recipient cannot authenticate WHO shared a key. |
| KEY-4 | The JiboKeys design page describes a device-id API (Keys.Set/Get/Share/GetShared/RequestSharing) while the shipped service the app actually calls is `Key_20160201` with (accountId, loopId, publicKey) request documents. | Phoenix models the shipped shape. | Correct for the recovered app; the design page describes an earlier or parallel design. |

| MEDIA-1 | **Settled by pinned source — do NOT "fix".** `Media_20160725.List` does NOT filter soft-deleted rows while `Get` does. | VERIFIED in `jiborobot/srv-media-ws src/controllers/media.ctrl.js`: list() builds `const condition = { loopId: { $in: loopIds } }` (line 54) with no `isDeleted` predicate, while get() opens with `isDeleted: { $ne: true }` (line 239). `toJSON` (`src/schemes/media.js:27-28`) deletes `url` when `ret.isDeleted`. | A deleted row still appears in List with `isDeleted:true` and **no url**; the Android Gallery's `url IS NOT NULL` cursor drops it client-side. Root initially read this asymmetry as a bug and patched list() to filter — **that was wrong and was reverted**. The behaviour is faithful. |

| I-01c | Bare `/skill/launch/…`, `/speech`, `/speech/:id` aliases are served by Phoenix but 404 on the reference. | Additive convenience. | Additive only; not in DIVERGENCES.md before. |

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
| D-fb | `FacebookConnect`, `FacebookMobileConnect` and `FacebookPrepareLogin` are **not implemented** and are excluded from the A-03 denominator | All three wrap Facebook's 2015-era Graph API using a Jibo-owned application ID and secret. The Graph versions they target are retired, and the Jibo app registration died with the company; a new app ID would not reproduce the original permissions, token formats, or review model. Same class as the existing `[DEAD]` exclusions (Google STT, Bing/Wolfram, Dialogflow, real OAuth refresh). | The **account-side data is retained**: `facebookAccessToken` is stored and preserved by the account model, `facebookConnected` is projected in the `Account` JSON, and Loop member projections strip the token exactly as source does. An imported household carrying a Facebook token still serializes correctly. Only the three operations that must call Facebook are excluded. A-03's implementable set is therefore **25 of 28** `Account_20151111` operations. Full reasoning: [A-03-facebook-dead-determination-20260911.md](docs/parity/candidates/A-03-facebook-dead-determination-20260911.md). |

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

## N03a — conditional semantic actions are silently skipped (open)
`parser.js parseActionBlock` accepts only `key = value` statements and `continue`s on anything else,
so `{% if (this._intent == 'yes') {this._intent = 'delete'} %}` in clock/alarm_timer_change.rule and
clock/alarm_timer_other_set.rule is DROPPED. Observed: 'yes' yields intent 'yes' where the pinned
source maps yes->delete. 10 such conditional statements exist across 5 rules-src files.

## N03b — caller rules leak into `$factory:yes_no` (open)
`requestParser.js:218` merges `Object.assign({}, state.factoryRules, entry.ast.rules)` into ONE flat
namespace, so a caller's local YES/NO override the factory's. Observable: 'replace it', 'delete it',
'trash it' and even 'guess' all yield `yes_no._nl='yes'`, although the pinned yes_no.grm cannot match
any of them. A `$factory:` reference should compile to its own namespace.

## N03c — the factory dependency gate is coarser than the native graph (open)
`requestParser.js:204-209` refuses clock/alarm_timer_ampm wholesale because ONE arm declares
`$factory:time`, even though its `$AM_PM` arm needs no factory. Native FST would still expose that
path. This is why N-03 remains UNVERIFIED: bare 'am'/'pm' is unreachable even though nothing about
it requires the missing time factory.
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

## N06a — inline loop-member escaping removed (intentional behaviour change)
The previous inline detector escaped text-name regexes and guarded missing names; the pinned
`LoopMemberDetector.ts:73,84` does neither, so N-06 removed both and updated the one assertion
that encoded the old behaviour ('who is undefined undefined' now resolves the malformed member).
N-06 itself stays UNVERIFIED: 'speaker/referent interactions' in the acceptance text has no
speaker concept in the pinned source, and the extra expectations are code-derived, not
oracle-matched. The 12 pinned fixtures replay 12/12.

## S01a — cross-shape session reuse is fail-open (open, deployment hazard)
A session minted on one skill shape and offered to another returns HTTP 200 SKILL_ACTION and is
silently reinterpreted instead of rejected. Source-faithful (the original never validates a
session against the host shape), but cutover must drop/re-launch sessions; the cloud cannot
enforce it. S-01 stays UNVERIFIED for its deployment-half acceptance (fleet behaviour on a
shape change is not observable from a worktree).
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

## N07a — N-07 accepted as candidate (open items)
Restored 15-tool LLM catalog + fallback arbitration + external-agent provider seam are merged
and falsified, but three acceptance sub-items stay open: compiled-FST profile unprovisioned,
archived intent/entity catalog only a hashed denominator (the restored catalog names differ,
N-07-D1), and the real external-agent success path has no archived responses (Dialogflow dead).
Also noted: the 715e0dd0 handler DELETES the external-agent attachment that 5c0a739 performs;
Phoenix keeps the 5c0a739 boundary — the union needs ratification (N-07-D2).

## D04a — calendar envelope mirror + unported clients (open items)
The calendar relay envelope mirrors `events` at top level only because certified
credential.test.js:98-103 and oauth.test.js:211-331 assert body.events; the pinned reference
emits exactly two keys. Removing the mirror needs those two certified files edited (root
decision, deferred). Upstream pagination/ordering (Google singleEvents/orderBy/timeMin/timeMax,
Graph orderby/endDateTime) lives in unported API clients. D-04 stays a candidate.
## N03d — the time gate stays coarse deliberately (retained refusal)
Narrowing the whole-rule `$factory:time` refusal so the `$AM_PM` arm executes is arm-for-arm
reproducible for bare am/pm — but it converts the loud refusal into silent no-matches (`noon`,
`morning`, `seven thirty am`) and surfaces `alarm_set_value` `$*`-wrapped arms that are not
provably the reference's. Sound narrowing requires the time factory, whose only source does not
parse (`time.grm:22,40` `?(?:` lexes COLON). The gate is retained and pinned by tests; N-03
stays UNVERIFIED with 18/20 rules replayed 122/122 on three layers (parseRequest, live /v1/parse,
local-turn WS).

## N03e — worktree @phoenix/* symlink hazard (test-integrity note, second sighting)
Worktree `node_modules` symlinks to the main checkout, so `@phoenix/*` package-name imports
exercise the MAIN tree, not the worktree under test. The N-03 agent's broken-gate falsification
left the gateway test green until it switched to relative imports. First sighting was H-06's
@phoenix/gateway draft. LESSON: worktree tests must import relatively; a passing suite that
imports by package name proves the wrong tree.

## A19e/A19f/A19g — Jot error-envelope mismatches (open, deliberately not changed)
A19e: Joi payload failures are 422 raw Boom in source (`server/server src/validate.js:22-25`)
but 400 ValidationException in Phoenix. A19f: JOT_* business errors are raw Boom with a `code`
field and no `x-amzn-errortype` (`@jibo/server dst/boom.js`) but Phoenix uses the shared
`sendAmzError` envelope. A19g: a dotless Jot target throws (500) in source but Phoenix answers
400 UnknownOperationException. All three change the raw bytes of every Jot error and the
package-wide convention, so they were flagged, not unilaterally fixed. A-19 stays a CANDIDATE
on these plus the dead-original-client substitution for criterion 4.
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

