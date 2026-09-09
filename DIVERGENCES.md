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
| G-sigv4 | Robot Classic-Service requests (AWS SigV4) are **not signature-verified** | The original per-account signing keys are unrecoverable; identity comes from the one-time OOBE token + the hub JWT instead | Anyone who can reach `/` can call the robot-facing OOBE ops — LAN trust (like the hub's `DISABLE_AUTH`); `ADMIN_PASSWORD` + per-robot hub auth are the real gates. For `prepareRobot` we parse the `accessKeyId` out of the Authorization header (unverified) to identify the caller. |
| G-store | Accounts/loops/tokens/sessions persist in a **single JSON file** (atomic tmp+rename) instead of Mongo | Zero-dependency, household-scale; the reference's Mongo/Redis are overkill for a single-owner revival | Not horizontally scalable; fine for one deployment. Path via `ETCO_account_dataFile`. |
| G-hubtoken | Hub tokens are **symmetric** HS256 over a shared `HUB_TOKEN_SECRET` (issued server-side via `/api/token`, optionally validated against the account service via `ETCO_hub_accountUrl`) | Matches the reference `createHubToken` (same secret, 3h expiry) and the robot's own local-signing path; asymmetric keys were out of scope | Anyone with the secret can mint a token for any identity — keep it secret; revocation is via account deactivation (`/api/verify` → `{valid:false}`), not token blocklists. Tokens without `exp` (sim/robot hand-signed creds) stay valid for LAN back-compat. |
| G-admin | The portal admin face is a **single shared password** (`ADMIN_PASSWORD`), not per-admin accounts | Minimal plumbing for a single-owner revival; unset = admin face disabled | One operator; no admin audit trail. |
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

## Dead external dependencies (Account family)

| # | Decision | Why | Impact |
|---|---|---|---|
| D-fb | `FacebookConnect`, `FacebookMobileConnect` and `FacebookPrepareLogin` are **not implemented** and are excluded from the A-03 denominator | All three wrap Facebook's 2015-era Graph API using a Jibo-owned application ID and secret. The Graph versions they target are retired, and the Jibo app registration died with the company; a new app ID would not reproduce the original permissions, token formats, or review model. Same class as the existing `[DEAD]` exclusions (Google STT, Bing/Wolfram, Dialogflow, real OAuth refresh). | The **account-side data is retained**: `facebookAccessToken` is stored and preserved by the account model, `facebookConnected` is projected in the `Account` JSON, and Loop member projections strip the token exactly as source does. An imported household carrying a Facebook token still serializes correctly. Only the three operations that must call Facebook are excluded. A-03's implementable set is therefore **25 of 28** `Account_20151111` operations. Full reasoning: [A-03-facebook-dead-determination-20260911.md](docs/parity/candidates/A-03-facebook-dead-determination-20260911.md). |
