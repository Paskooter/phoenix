# I-03 — Preserve history across restart and verify retention

Track pegasus · P0 · depends on I-01 · phoenix path `packages/history/src/store.js` ·
reference `pegasus:packages/history/src/skilllaunch/schema/SkillLaunchSchema.ts`,
`pegasus:packages/history/src/common/db`, `pegasus:packages/history/src/speech`.

Phoenix head when this work was done: `2c1f5c0` (worktree `.parity/worktrees/w8-i03`, branch `w8/i03`).

## 1. The retention contract, read from the pinned reference (NOT inferred)

Retrieved with the Jibo archive MCP: `gitea_read_file repo=jiboV2/pegasus path=<file>` (default
branch `phoenix`), plus `jibo_read /confluence/display/SER/History+Service+Use+Cases`.

| Element | Pinned value | Source |
|---|---|---|
| Skill-launch expiry mechanism | Mongoose TTL index — `expires: config.skillLaunch.eventExpirationSeconds` on the `timestamp` path | `packages/history/src/skilllaunch/schema/SkillLaunchSchema.ts:12-16` |
| Skill-launch window | `eventExpirationSeconds: 14 * 86400, // 14 days` = 1 209 600 s | `packages/history/src/HistoryServiceConfigProvider.ts:32` |
| Eviction ordering | **By `timestamp` value, in any position.** Mongo's TTL monitor scans the index and removes every document whose timestamp has passed the window; insertion order is irrelevant | MongoDB TTL index semantics (see §5) |
| Row cap | **None.** The collection is `config.skillLaunch.collectionName` = `skilllaunch` (`HistoryServiceConfigProvider.ts:17,31`) and no `max`/`capped`/count limit exists | `SkillLaunchSchema.ts:45` |
| Speech retention | **None — retained indefinitely.** `SpeechHistoryRecordSchema.ts:20-22` declares `timestamp: {type: Date, required: true}` with **no `expires`**, unlike the skill-launch schema | `packages/history/src/speech/schema/SpeechHistoryRecordSchema.ts` |
| What must survive a restart | Everything: both collections live in Mongo (`DBClient`/mongoose connections), so the rows outlive any server process; there is no in-memory-only path in the reference | `packages/history/src/common/db/DBClient.ts`, `.../skilllaunch/db/SkillLaunchCollection.ts`, `.../speech/db/SpeechHistoryRecordsCollection.ts` |
| Identifiers / ordering / payload updates | `_id` minted once at insert and returned as `id`; `getLatest` sorts `{timestamp: -1, _id: -1}`; `saveSkillPayload` is `findOneAndUpdate({sessionID, robotID, skillID}, {$set:{payload, payloadSize}})` | `SkillLaunchCollection.ts` `addSkillLaunch`/`getLatest`/`saveSkillPayload` |

## 2. Defect closed (VERIFIED)

`HistoryStore._pruneExpired` inspected only `skillLaunches[0]` — the **oldest insertion**, which is
not the oldest timestamp. A back-dated launch written after a recent one was therefore never pruned
(AUDIT F08; probe `P12-retention-order` recorded `countAfterPrune: 2`). I-01 independently
re-observed it end to end: `docs/parity/evidence/2026-09-10/i01-history-routes/w7-runtime-probe.json`
→ `RETENTION: POST old timestamp (40 days ago)` followed by
`GET /v1/skill/launch/count?robotID=R-old → {count: 1}`.

Now `packages/history/src/store.js:188`:

```js
const kept = this.skillLaunches.filter((rec) => rec.timestamp >= cutoff);
```

**Why a full per-record scan and not a cheaper head probe:** correctness *is* per-record — any
position may hold an expired row — so the head check cannot be salvaged. Cost is not a concern at
this scale: the prune runs only on access (`addSkillLaunch`, `getLatest`, `getCount`), never on a
timer; it short-circuits on an empty array and skips the array reassignment *and* the disk flush when
nothing was removed; and the reference itself paid a whole-collection sweep for the same rule. A
newly inserted expired row is still stored and then removed by the next prune pass, matching Mongo's
write-then-expire order.

## 3. Durability (VERIFIED, process-level SIGKILL)

`packages/history/src/store.js` is now a durable store when constructed with a file: it loads the
snapshot on construction and rewrites it atomically (private tmp file + `rename`, mode 0600) after
every mutation. The service entrypoint passes `ETCO_history_dataFile`
(`packages/history/src/index.js:27,30-32,55-56`) defaulting to `packages/history/data/store.json` — inside
the compose bind mount (`./packages:/phoenix/packages`), so it survives a container recreate too. A
bare `new HistoryStore()` stays process-local so unit tests never share state.

Evidence:

* `packages/gateway/test/listen.e2e.test.js` hosts a real history service via `startHistory()`; it now
  points `ETCO_history_dataFile` at a per-run temp dir (the same isolation `authenticated-stack.mjs`
  applies to the account store) so repeated runs cannot accumulate launch rows.
* `scripts/parity-robot/stack.mjs` does the same for the diagnostic robot stack
  (`ETCO_history_dataFile: <runDir>/history.json`).
* `packages/history/test/history.durability.test.js` — the same pattern as
  `packages/classic/test/iftttDurability.test.js` (A-17) and `voiceTraining.test.js`: spawn the real
  `packages/history/src/index.js` as a child over `ETCO_history_dataFile`, write over the wire,
  **SIGKILL** (no graceful shutdown), then start a FRESH process over the same file and re-read.
  * `skill-launch and speech records survive a SIGKILL restart with stable ids, ordering and payload semantics` — PASS. Inserts are written in the *reverse* of timestamp order, so a fallback to insertion order would surface the wrong `latest`; a `PUT /v1/skill/launch/payload` issued before the kill is re-read after it (`payloadSize: 2`); a speech id minted before the kill still resolves on `PUT /v1/speech/:id` after it (an unknown id is the 500 error envelope, so a 200 is the durability proof — the reference exposes no speech read route).
* `docs/parity/evidence/2026-09-10/i03-history-retention/i03-runtime-probe.mjs` → `i03-runtime-probe.json`
  (run: `node i03-runtime-probe.mjs i03-runtime-probe.json`): both passes with a real SIGKILL in
  between; the raw store file is dumped before and after so the eviction can be attributed to the
  retention rule rather than to the write path.

## 4. Retention proved at RUNTIME (VERIFIED)

`packages/history/test/history.durability.test.js` →
`a back-dated launch is evicted and does NOT reappear after a SIGKILL restart` — PASS.

1. Fresh row (13 days old) written first; **40-day-old row written second**, so the expired row is
   last in the insertion-ordered array (the exact shape the old head-only prune could never remove).
2. The write is accepted (200) and the raw store file holds **both** rows, the expired one last.
3. SIGKILL, fresh process over the same file: `GET /v1/skill/launch/count?robotID=R-old` →
   `{count: 1}` (the I-01 case, now corrected), the expired intent counts 0, `latest` returns the
   fresh id, and the eviction is written back to disk (1 row left) so a restart cannot resurrect it.

Probe output (from the JSON, verbatim values):

```
PASS1 POST fresh launch (13 days old)                        -> 200
PASS1 POST back-dated launch (40 days old, written SECOND)   -> 200
PASS1 store file: both rows on disk, the expired one last    -> [fresh, expired]
PASS2 GET /v1/skill/launch/count?robotID=R-old               -> {"count":1}   (I-01 saw 1 OF 1; here 1 OF 2)
PASS2 POST count for the expired intent                      -> {"count":0}
PASS2 POST latest                                            -> the fresh id
PASS2 PUT /v1/speech/<pre-kill id>                           -> 200 {"id": "..."}
```

Boundary (unit, `packages/history/test/history.test.js`): a row one minute *inside* the 14-day
window is kept and one one-minute *past* it is evicted; `SKILL_LAUNCH_RETENTION_MS` is asserted equal
to `14 * 86400 * 1000`. The window is exact to within a minute because the store's clock is the real
`now()`, not injectable.

## 5. Falsification (VERIFIED)

Exactly one full line of `packages/history/src/store.js` was replaced (line 188) with the historical
head-only behaviour:

```js
    const kept = this.skillLaunches[0].timestamp < cutoff ? this.skillLaunches.filter((rec) => rec.timestamp >= cutoff) : this.skillLaunches;
```

`node --test packages/history/test/history.test.js packages/history/test/history.durability.test.js`
→ `# tests 17 / # pass 14 / # fail 3`:

* `not ok 2 - a back-dated launch is evicted and does NOT reappear after a SIGKILL restart`
  `AssertionError ... "the 40-day-old row is not counted after the restart" + count: 2 - count: 1`
  (`packages/history/test/history.durability.test.js:200`)
* `not ok 15 - a launch older than the window is pruned even when it is NOT the oldest array element` `expected: 1 actual: 2`
* `not ok 16 - retention boundary: a row inside the window is kept; one past it is evicted` `expected: 1 actual: 2`

Line restored → same command → `# tests 17 / # pass 17 / # fail 0`.

## 6. Status

* **VERIFIED (observed):** the 14-day window and its `14 * 86400` value; per-record, order-independent
  eviction, at runtime and across a SIGKILL restart; skill-launch and speech durability across a
  SIGKILL restart; stable ids, timestamp ordering and payload-update semantics across the restart;
  speech is not subject to retention; the falsification above.
* **INFERRED (no mongod available):** the reference's *timing*. Mongo's TTL monitor runs on a ~60 s
  background sweep, so the reference is eventually consistent while Phoenix is immediate on access.
  The *rule* is pinned source; the sweep interval and its latency are not observable here. Filed as
  divergence candidate I-03a below — the mechanism is deliberately not "fixed" to a sweep interval
  that cannot be observed.
* **UNKNOWN:** whether the deployed reference set `connectAttempts > 0` in production (only the
  configured default of `0` is pinned) — irrelevant to retention/durability behaviour.

## 7. Divergence candidates (not edited into DIVERGENCES.md — reported only)

* **I-03a — expiry timing.** Phoenix expires a launch record on the next access after it passes
  14 days; the reference relies on Mongo's TTL monitor (~60 s sweep) so it expires eventually. The
  *window* is identical; only the latency differs. INFERRED (no mongod here). Not a behaviour change
  a client can rely on in either direction.
* **I-03b — durable snapshot instead of Mongo.** Retained and reported by I-01b's precedent: Phoenix
  snapshots the two collections to one atomically replaced JSON file rather than a sharded Mongo.
  The wire contract is unchanged; the `GET /healthcheck` DB-state override (I-01b) is still absent.
