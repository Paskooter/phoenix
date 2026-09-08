# A-01 candidate: per-operation attributes and the legacy Settings contract

Task ID: `A-01-operation-attributes-20260907`  
Worktree: `.parity/worktrees/a01-operation-attributes-20260907`  
Branch: `grok/candidate-a01-operation-attributes-20260907`  
Parent: `21b9572`  
Status: **source map candidate, unverified.** No A-01 acceptance criterion is closed. Every runtime scenario remains `not-run`. Dispatch/shape/source mapping is not parity.

This candidate extends `scripts/parity-coverage/a01_operation_map.py` and regenerates `docs/parity/candidates/A-01-operation-map.json`. The JSON is generated; do not hand-edit it.

## What changed

1. **Legacy `Settings_20160801.GetSettings` is independently mapped from `Settings_20171219`, without inventing a model.**
2. **Account, Loop and OOBE rows now carry per-operation attributes** from the pinned API JSON and original `srv-account-ws` controllers.
3. **Phoenix-absent operations are explicit**, including OOBE `GetServiceToken` and `ReconnectRobot`.

## Settings_20160801.GetSettings — recovered contract

A formal `settings-2016-08-01.normal.json` (or any other SDK model with `targetPrefix: Settings_20160801`) was **not recovered**. Searches:

| Search | Result |
| --- | --- |
| `gitea_browse` `jiborobot/srv-jibo-server-client` `apis/` at `155d20a8102960b2aeb89c197bdf04dc1f1fc344` and default `master` | 28 files; only `settings-2017-12-19.normal.json` |
| Gitea code search `settings-2016` in that repo | no matches |
| File history of `apis/settings-2017-12-19.normal.json` | 22 commits; first add `2a4e46beb586d17ffac5f1601855ce96773e06f9` on 2017-12-21 already uses `Settings_20171219` and request members `robotID`/`userID` |
| `gitea_browse` `server/jibo-server-client` `apis/` | 16 files; **no settings API file** |
| Gitea code search `Settings_20160801` in `jiborobot/srv-security-gw` | no matches |
| `jibo_search` `Settings_20160801` / `settings-2016-08-01.normal.json` | no source/API-model hits |
| Pegasus `SettingsClient` at `5c0a7390539663ba749d360de348a428c088505c` | hardcoded `SETTINGS_API_VERSION = '20160801'`; axios POST, not an SDK model |
| Hub `SettingsClient.ts` history | first commit `ec61042c1c` (2018-04-24) already uses `20160801`, after the 2017-12-19 SDK model existed |

What **is** recovered, and is independently mapped from the 20171219 four-operation surface:

### Original hub consumer (`packages/hub/src/utils/SettingsClient.ts`)

- Headers: `x-amz-credentials: JSON.stringify({ id: accountId })`, `x-amz-target: Settings_20160801.GetSettings`
- Body: `{ loopId, transId, skills: string[], getView: false }`
- Empty `skills` short-circuits with no HTTP call
- Missing `accountId`/`loopId` throws; missing `transId` is a warning, field still sent
- Response consumption: array → `Map(skillId → data)`; other members ignored

### Original report consumer (`packages/report-skill/src/SettingsClient.ts`)

- Same headers and target
- Body: `{ loopId, transId, getView: false, skills: 'report-skill' }` — **string, not array**
- Response consumption: array; find `skillId === 'report-skill'` and use that object's `data`

### Later same-name handler (not a 20160801 model)

Pinned `jiborobot/srv-settings-ws@0d37e1fd2f4fca40538fb470194a3c5daf2c9830` `SettingsHandler.GetSettings` uses `parseCredentials`, Joi `loopId` required, `transId`/`skills`/`settings`/`getView` optional, `getView` default `true` when absent, loop-membership check, errors `LOOP_MEMBER_ONLY 403` and `UNKNOWN_DATA_SERVICE 422`, output members `skillId`/`view`/`data`/`errors`. This is 2018 source for the operation **name** `GetSettings`. It is labeled `later-source-not-a-20160801-model` and is not treated as the missing API file.

The previous map row invented a merged `{required:["loopId"], members:{...}}` schema. That invented shape is removed.

## Account / Loop / OOBE attributes

Source pins:

- API models: `jiborobot/srv-jibo-server-client@155d20a8102960b2aeb89c197bdf04dc1f1fc344`
- Controllers: `jiborobot/srv-account-ws@6cea43470825657d6a5722162f28c8f233153ee2`

57 rows now have `attributes`: 28 Account, 23 Loop, 5 OOBE, 1 legacy Settings. Account/Loop attributes were already present as `contract.originalSource`; this candidate adds the canonical `attributes` object plus API JSON shape references (`LoginRequest`/`Account`, `InviteRequest`/`Loop`, `SetupRobotRequest`/`RobotCredentials`, etc.). OOBE original controller mapping is new.

API JSON `errors` arrays are empty for these families. Controller-declared codes are used instead.

OOBE source facts (from `oobe.handler.ts` / `oobe.ctrl.ts` / `token.ctrl.ts`):

| Operation | Auth | Request (API + Joi) | Response shape | Controller errors | Persistence | Phoenix handler |
| --- | --- | --- | --- | --- | --- | --- |
| `GetStatus` | `parseCredentials`; identity unused | `token` required | `StatusContainer` `{complete}` | none; token errors swallowed as `complete:true` | read only | bounded |
| `PrepareRobot` | `parseCredentials`; `credentials.id` is subject | optional `loopId` | `TokenContainer` | none declared | token create/refresh | bounded |
| `SetupRobot` | decorator present; token selects owner | `token`,`id` required | `RobotCredentials` | `TOKEN_NOT_FOUND 404`, `TOKEN_EXPIRED 401`, `ACCOUNT_NOT_FOUND 404`, `OWNER_CAN_MANIPULATE 401`, `LOOP_MUST_BE_SUSPENDED 409` | loop/robot save; token delete | bounded |
| `ReconnectRobot` | decorator present; identity unused | `token` required, optional `id` ignored | `CommandResponse` | `TOKEN_NOT_FOUND 404`, `TOKEN_EXPIRED 401` | token delete | **absent** |
| `GetServiceToken` | `parseCredentials({adminOnly:true})` | empty | `TokenContainer` | none declared | account+token create | **absent** |

## What was verified against original source

- Pegasus hub/report `SettingsClient` request construction at original hashbrown `5c0a7390…`
- SDK `apis/` inventory at `155d20a8…` (no 20160801 settings file)
- First settings API commit `2a4e46beb5` is `Settings_20171219`
- Original OOBE handler/controller/token/error files at `6cea4347…`
- Generator validator: `python3 scripts/parity-coverage/a01_operation_map.py validate` — 169 rows; current=134 historical=35 literal-union=169 substitution=170 observed-client-prefix-union=173 hypothetical-five-pair-union=174
- `npm test` at `372b9ac3c9640eca510ed86602b67bccd0d871b2`: 785 unit tests, **778 pass**, 0 fail, 7 skipped; `parity:check` valid (8/79); smoke gate **43 cases, 0 differences**. Passing unit tests is not A-01 parity.

## What was inferred from source reading

- Controller error lists, ownership rules, persistence and side effects for OOBE (and the existing Account/Loop tables) are source inspection, not runtime traces.
- That `@jibo/server` would dispatch `Settings_20160801.GetSettings` onto the 2018 `GetSettings` mapping is an inference from operation-name mapping; it is **not** proven.

## What remains unknown / not-run

- No 20160801 API model file. Why Pegasus hardcoded `20160801` after `20171219` existed is unexplained.
- Report sending `skills` as a string versus the 2018 TypeScript `skills?: string[]` interface.
- Deployed target alias, gateway auth, and exact Hapi/Boom envelopes.
- All 169 runtime scenarios, including the four source-backed cases per Account/Loop/OOBE row.
- Phoenix robotFace vs original OobeController behavior (GetStatus does not require credentials in Phoenix; source decorator does).

## Commands

```sh
python3 scripts/parity-coverage/a01_operation_map.py build
python3 scripts/parity-coverage/a01_operation_map.py validate
npm test
```

## Next step

Root review of this source map. Functional work stays with A-03/A-04/A-05/A-06. Do not mark A-01 verified from this candidate. A useful follow-up is a source-compatible GetSettings fixture that sends both hub array-skills and report string-skills against the pinned 2018 handler, still labeled as later-source rather than a recovered 20160801 model.
