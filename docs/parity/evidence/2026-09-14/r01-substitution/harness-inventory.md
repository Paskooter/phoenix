# R-01 harness and surface inventory — 2026-09-14

Status: **inventory only — R-01 is not claimed or verified by this file.**

Two things had to be pinned down before more substitution lanes could be built:
what the recorded R-01 blocker actually refers to, and what already exists to
compare two stacks with.

## What "Phoenix-specific skill paths" means

The ledger's R-01 finding reads:

> Existing compose smoke checks use Phoenix-specific skill paths and cannot
> prove individual service substitution.

That is accurate, and it is now concrete. `scripts/verify-compose-contract.mjs`
exercises surfaces no original client or test ever touches:

1. **`GET /v1/skills` with no robot ID.** The original hub registers only
   `/:robotId` and `/settings/:robotId` under both `/skills` and `/v1/skills`
   (`SkillListGetHttpRequestsHandler.ts:24,27`; `HubService.ts:75-80`). Phoenix's
   own gateway labels the bare aliases a deployment extension in-line
   (`packages/gateway/src/index.js:96-98`). The original equivalent is
   `GET /v1/skills/<robotId>`, which is exactly what this repo's
   `scripts/parity-compare/suite.json` already drives.
2. **Four of the ten healthchecked ports have no original counterpart.**
   `answer-skill:9009` is an external non-monorepo host in the original
   (`skills-local.json:4-6`), `color-skill:9008` is a Phoenix demo skill, and
   `example-skill:9013` / `template-skill:9014` are original *packages* that the
   original compose never runs as services — the original suite binds `example`
   in-process instead (`integration-tests-int/src/utils/integration.ts:55`).

Only six ports (`9000, 9003, 9004, 9005, 9006, 9007`) correspond to original
compose services.

This is why the compose lane cannot carry R-01 on its own, and why the
in-process `integration-tests-int` lane is the right primary vehicle: it uses
only original surfaces, driven by original clients.

## The comparison machinery already exists

`packages/harness/` is described in its own manifest as *"Old-vs-new comparison
harness: drive identical input into the Pegasus reference stack and Phoenix,
normalize both message streams, and diff them."* It provides:

- `src/parityCompare.js` — `diffValues()` (full JSON diff including field
  presence, types and array order), `validateTrace()` (clock, timings, frames,
  sessions, side-effect attribution invariants) and `compareTraces()`.
- `src/productionCompare.js` — the JCP/ESML/analytics-aware production lane.
- `src/normalize.js` — key-sorting only, no field dropping.
- Bounded equivalence rules: generated UUIDs allowed only at listed pointer
  paths, fixture hosts allowed in URL/host fields, wall-clock durations bounded,
  ETags re-derived from raw bytes.

R-01's "complete HTTP/WS/JCP/speech/history/data side-effect comparison" should
be built on this rather than on something new.

## Hub substitution — designed, not yet built

Phoenix's gateway does run against the original contract: started with
`ETCO_hub_disableAuth=false` and the suite's own `my-hard-kept-secret`, with its
parser peer pointed at the Phoenix parser, it answers `/healthcheck` 200 and
serves both `/listen` and `/v1/listen`, matching the original hub's two WS paths.

The obstacle is configuration lifetime, not contract. The original
`startHub(config)` allocates the example skill's port at test time and hands
`hubSkills` — with that dynamic URL — straight to `HubService`. Phoenix's
gateway reads its skill list from `ETCO_hub_skillsConfig` at boot, so a faithful
hub substitution has to start the gateway **per test run**, after the port is
allocated, with a generated skills config carrying that URL. That is a larger
seam than the parser's one-line `baseURL` override and has not been built.

## Not yet done

Hub and skill substitution, the all-Phoenix run, per-case side-effect capture
through `packages/harness`, and adversarial controls over the comparison itself.
R-01 remains `todo`.
