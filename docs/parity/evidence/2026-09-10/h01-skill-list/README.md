# H-01 — robot-specific skill-list endpoints

**Task:** H-01 "Restore the robot-specific skill-list endpoints" (track pegasus, P0).
**Date:** 2026-09-10. **Worktree:** `w5/h01` off `main@194b81a`.
**Verdict:** all four endpoints are served and match the pinned original byte-for-byte.
No production-code change was required; the deliverable is runtime verification plus the
focused regression tests that lock the contract.

## Reference contract (pinned source)

Pinned runtime checkout: **`pegasus@5c0a7390539663ba749d360de348a428c088505c`**
(`.parity/reference/5c0a7390539663ba749d360de348a428c088505c`).

| Evidence | Where |
|---|---|
| The one `SkillListGetHttpRequestsHandler` is mounted at **both** `/skills` and `/v1/skills` | `packages/hub/src/HubService.ts:75-80` |
| `addGetHandler('/:robotId', …, false)` → `{ skills: skillConfigs }` | `packages/hub/src/skill-list/SkillListGetHttpRequestsHandler.ts:24-26, 31-44` |
| `addGetHandler('/settings/:robotId', …, true)` → `{ skills: skillConfigsWithSettings }` | same file, lines 27-29 |
| `skillConfigsWithSettings = skillConfigs.filter(it => !!it.settings)` | same file, lines 17-20 |
| `:robotId` is read for logging only — it never filters the response | same file, lines 32-40 |
| `SkillConfig` = full manifest + derived `URL` (not a reduced projection) | `packages/interfaces/src/skill/config.ts` |

So exactly four robot-specific URLs exist:

```
GET /skills/:robotId              200 { skills: SkillConfig[] }
GET /v1/skills/:robotId           200 { skills: SkillConfig[] }
GET /skills/settings/:robotId     200 { skills: SkillConfig[] with truthy .settings }
GET /v1/skills/settings/:robotId  200 { skills: SkillConfig[] with truthy .settings }
```

No auth middleware is registered on the mount; a bad/missing credential is ignored.
`robotId` values that match no skill are not an error — the handler ignores the parameter.

Documentation (secondary, agrees with the source):
<https://pvindex.org/gitea/jiboV2/pegasus/src/commit/d682547a31511cd164db0913b6104eb1786455a2/docs/atlas/packages/hub.md>
§3 "Public interface": *"HTTP GET `/skills/:robotId`, `/v1/skills/:robotId` → `{ skills:
SkillConfig[] }`; GET `/skills/settings/:robotId` → only configs that have `settings`. No auth
middleware is registered for these (the `authenticationRequired` flag is never set)."*

### Difference from the generic skill list

The reference has **no** generic (no-`robotId`) skill-list endpoint: `GET /skills`,
`GET /v1/skills` and `GET /skills/` are 404 `URL not found` in the original. Phoenix serves
them as a documented deployment extension and returns a **reduced** projection
(`{ id, intents }` per skill, `packages/gateway/src/index.js:94-96`) — deliberately not the
full configurations the robot-specific URLs return. See "Divergence candidate" below.

## Runtime verification

### 1. Byte-level differential against the pinned original

```bash
node scripts/parity-h01/differential.mjs
# fixtures=4 urls=11 comparisons=44 differences=12
```

The script boots the compiled original `HubService` and Phoenix `createGateway` in one
process with **identical** skill registries — the real original registries are read through
`HubConfigProvider.getSkillConfigs('skills-local.json')` — and compares HTTP status,
content-type and raw body.

Four registries × 11 URLs = 44 comparisons. Per-registry results
(`runtime-differential.json`):

| registry | skills | with `settings` | identical / 11 |
|---|---:|---:|---:|
| full original registry | 21 | 1 | 8 |
| no settings-bearing skill | 20 | 0 | 8 |
| settings-bearing skill only | 1 | 1 | 8 |
| empty registry | 0 | 0 | 8 |

All **16** target comparisons (4 URLs × 4 registries) are byte-identical, including unknown
robot IDs. The 4×3 = 12 differences are the Phoenix-only no-ID aliases described above.
Example bodies (sha256 over the raw response):

- `/skills/robot-A` and `/v1/skills/robot-A`: 733 975 bytes, 21 skills, identical hash.
- `/skills/settings/robot-A` and `/v1/skills/settings/robot-A`: 7 718 bytes, 1 skill (`report-skill`), identical hash.
- empty registry: all four URLs return `{"skills":[]}` (13 bytes) in both.

A separate run (`loadConfig({rootPath: <pinned hub>})`, i.e. Phoenix's own registry loader
against the unmodified reference registries) produced the same 4/4 byte-identical bodies —
so neither the routes nor the registry loader "omit paths or metadata" any more.

### 2. The gateway process actually serving requests

`runtime-cli-probe.txt` records `ETCO_hub_disableAuth=true ETCO_server_port=8139 node
packages/gateway/src/index.js` (the shipped `npm run start:gateway` entry point) answering
all four URLs plus the unknown-robot cases with HTTP 200 and the expected skill counts.

### 3. Focused tests

`packages/gateway/test/skillList.runtime.test.js` — 6 tests over a real listening socket:

1. `/skills/:robotId` and `/v1/skills/:robotId` serve the full reference-shaped configurations
2. the settings-filtered URLs return exactly the configurations that carry settings
3. an unknown robot ID returns the same configurations as a known one (the id is not a filter)
4. an empty registry returns `{"skills":[]}` on all four URLs, settings variants included
5. a registry with no settings-bearing skill yields `{"skills":[]}` from the settings variants only
6. the generic no-ID alias is the reduced `id`+`intents` projection, unlike the robot-specific list

### Falsification

`falsification-mutation-fail.txt`: mutating **`packages/gateway/src/index.js:83`**

```
-  const settingsSkills = config.skills.filter(skill => !!skill.settings);
+  const settingsSkills = config.skills;
```

makes the focused run go **6 tests / 4 pass / 2 fail**, with exactly:

- `not ok 2 - H-01: the settings-filtered URLs return exactly the configurations that carry settings`
- `not ok 5 - H-01: a registry with no settings-bearing skill yields {"skills":[]} from the settings variants only`

Restoring the line returns 6/6 pass.

## Divergence candidate (not recorded in DIVERGENCES.md)

The no-ID aliases `GET /skills`, `GET /v1/skills`, `GET /skills/` return **200** in Phoenix
where the pinned reference returns **404 `URL not found: /skills`**, and they return a reduced
`{ id, intents }` projection rather than the full `SkillConfig[]` the robot-specific URLs
return. They are labelled "Phoenix's no-ID discovery aliases are deployment extensions" in
`packages/gateway/src/index.js:94`, which matches the existing recorded alias divergence
`I-01c` in `DIVERGENCES.md:166`, but this specific alias is not yet listed there.
`docs/parity/tasks.json` and `DIVERGENCES.md` were not edited (task constraint).

## Limits

- Comparisons are static-config HTTP only. Robot identity in the reference is never consulted
  for these routes (the source ignores `:robotId`), and no robot was contacted.
- The original is the `compile.cjs` TypeScript-transpile artifact, not a historical Gulp
  production build (same boundary as V-01/V-02).
- HEAD/OPTIONS/POST, query strings, percent-encoding and trailing-slash routing for these
  routes were already compared by C-03's 161/161 registry differential and are not re-derived
  here.
