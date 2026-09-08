# Household snapshot staging

Status: root accepted for bounded snapshot staging. This utility stages a migration; the
previous real-robot migration used a separate private controller.

`packages/account/src/householdImport.js` and
`scripts/import-household-snapshot.mjs` import captured local KB root/member
snapshots into a new Phoenix account-store file. Source member IDs, account-ID
presence, statuses, enrollment flags, profile fields and root ownership are
validated before any output is written. Guest profiles remain members without
fabricated accounts. Only the already adopted robot supplies signing keys.

The command requires a unique adopted robot and loop. A different household may
replace only a pristine bootstrap owner/robot loop; an existing household may
be re-imported only when its serialized projection stays identical. Shared
account profiles must remain unchanged for preserved loops. New profile-only
human accounts use the original schema's inactive default; existing account
activation flags and robot keys are retained. It rejects conflicting
identities, duplicate store records, unresolved references, unsupported store
collections that the runtime would discard, and profile fields the account
projection cannot represent. All source membership statuses are supported;
there is no household-specific size or status-count default. An optional API
count guard may be supplied by a caller.

The source mapping follows `srv-account-ws` revision
`6cea43470825657d6a5722162f28c8f233153ee2`, `src/controllers/loop.ctrl.ts`, the
member status/type schemas, and the original SDK LoopManager merge. Accepted
account projections intentionally omit `isChild`; local captured profile data
is retained. Account-less and nonaccepted members use `memberProperties`.

Run against private snapshots, directing output to private storage:

```sh
node scripts/import-household-snapshot.mjs \
  --current PRIVATE_ACCOUNT_SNAPSHOT \
  --root PRIVATE_KB_ROOT --users PRIVATE_KB_USERS \
  --output PRIVATE_STAGED_STORE --backup PRIVATE_EXACT_BACKUP
```

`--dry-run` validates without writing. The command never replaces the live
store. Output and backup files are created exclusively with mode0600, fully
written and fsynced. Cleanup checks file identity before removing an output;
a competing writer's replacement is retained. The current input is reread
before staging to detect a changed generation. Review the staged result and
stop the backend before an independently guarded deployment.

Synthetic tests exercise preservation, conflicts, private file modes,
persistence reload, every source membership status and injected write races.
No fixture or default contains captured household data. Root's private staging
comparison checks the serialized wire against the earlier independently
verified migration and checks exact backup bytes and Store save/reload.
Public evidence must omit household statistics, personal profiles and IDs;
private results remain in `.parity/reviews/household-import-root-20260908/`.

This does not import a complete cloud Account database, deploy a store, or
verify every Account/Loop lifecycle operation. Those parent tasks remain open.

Root validation: 11 focused controls and the full bounded-concurrency unit
suite (814 passed, 8 skipped) passed. The [sanitized review](../evidence/2026-09-08/household-staging/review.json)
records source pins, artifact hashes, repairs and scope limits.
