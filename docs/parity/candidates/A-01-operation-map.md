# A-01 operation-level Classic map

Status: working source map integrated after bounded root review; runtime parity remains unverified. Luna Max candidate `b0c41c87175f4e262fcc8ca9db645faa0bb10c2d` supplied the map. Root independently checked all 51 Account/Admin and Loop handler mappings, declarations and direct controller calls with a TypeScript AST against freshly retrieved pinned source. [Review evidence](../evidence/2026-09-06/classic-operation-map/review.json) states the limits of that acceptance.

The complete map is [A-01-operation-map.json](A-01-operation-map.json). From the repository root, validate it with:

```sh
python3 scripts/parity-coverage/a01_operation_map.py validate
```

The validator recomputes the current pair set from `classic-api-inventory.json`, recomputes the historical model union plus legacy Settings from the [root-reviewed historical models](../evidence/2026-09-06/classic-contract-discovery/historical-models.json), checks source pins and task ownership, and requires every runtime scenario and every source-backed Account/Loop scenario to remain explicitly `not-run`.

## Denominator and chronology

| Set | Target-prefix + operation pairs |
| --- | ---: |
| Current SDK inventory | 134 |
| Historical Jot | 24 |
| Historical VoiceTraining | 10 |
| Legacy `Settings_20160801.GetSettings` | 1 |
| Literal model union | **169** |
| Prefix substitution scenario | **170** |
| Directly observed additional client-prefix union | **173** |
| Hypothetical five-pair client-prefix union | **174** |

The unit is target-prefix + operation pairs. The literal model union is 169. A **170 prefix-substitution scenario** replaces the later model's `Jot_20160126` prefix with `Jot_20160512` and does not retain both prefixes; it is not an upper bound. The archived message test directly proves four `Jot_20160512` targets—`CreateMessage`, `ListMessages`, `MarkLoopRead`, and `MarkRead`—at lines 63/219, 89/123/158/178/196, 142, and 107 respectively in the retained review artifact `.parity/reviews/a01-root/source-2.js` (SHA-256 `88c204cf858797c89523fa425075f6ebd3cead9e88f590a82d7ea24855badc65`). Retaining those four pairs gives **173**. `NumberOfUnreadMessagesInLoops` is present in the later model but has no literal alternate-prefix target in that artifact; **174** is retained only as a hypothetical five-pair union pending independent evidence. Canonical rows carry `alternateWireTargets` and mark that fifth pair as model-only inferred.

The deduplicated Jot model counts are `Jot_20160126: 10` and `Jot_20160310: 14`, for 24 Jot pairs. This is separate from the version/profile question about the archived target prefix.

Chronology labels use each model's `metadata.apiVersion`; filename dates remain audit fields. The three mismatches are retained explicitly: Jot `jot-2016-03-10` metadata `2016-04-10`, Jot `jot-2016-05-10` metadata `2016-03-10`, and VoiceTraining `voicetraining-2015-06-17` metadata `2015-10-20`.

## Per-operation attributes (Account, Loop, OOBE)

This candidate adds an `attributes` object on every current Account, Loop and OOBE row, sourced from the pinned API JSON (`account-2015-11-11`, `accountadmin-2015-11-11`, `loop-2016-03-24`, `oobe-2016-10-26`, `oobeadmin-2016-10-26`) and original `jiborobot/srv-account-ws@6cea43470825657d6a5722162f28c8f233153ee2` controllers. Phoenix code is recorded only as `phoenixHandler` presence/absence. The pinned API JSON declares **no error shapes** for these families; declared error codes are controller-sourced.

Each attributes object records: authentication mode, ownership/authorization rule, request schema (API input shape + handler Joi), response schema (API output shape), declared error codes, persistence effects, observable side effects, and whether a Phoenix handler exists.

Phoenix-absent operations are explicit, not blank:

| Family | Phoenix handler present | Phoenix handler absent |
| --- | --- | --- |
| Account (28) | `CreateHubToken` only | the other 27 Account/Admin operations (Classic proxies `/^account/i` with no local `AccountHandler`) |
| Loop (23) | `ListLoops`, `SuspendLoop`, `SuspendRobotLoop` | the other 20 Loop operations |
| OOBE (5) | `SetupRobot`, `PrepareRobot`, `GetStatus` | `GetServiceToken`, `ReconnectRobot` (`UnknownOperationException` 400) |

OOBE original mapping is now the same shape as Account/Loop: `OobeHandler` / `OobeController` at the pinned account-service revision, plus `TokenController` for setup-token create/find/delete. Notable source facts that are **not** Phoenix claims: `GetStatus` swallows `TOKEN_NOT_FOUND`/`TOKEN_EXPIRED` and returns `{complete: true}`; `ReconnectRobot` deletes the token and ignores optional `id`; `GetServiceToken` is `adminOnly` and creates a `service-mode-` account.

## Original Account/Admin and Loop recovery

The current SDK inventory supplied the operation names and schemas. The follow-up now maps every current `Account_20151111` and `Loop_20160324` pair to the source service handler, controller, schema/error files, configuration entrypoint, auth decorator, ownership rule, persistence observation, and side effects from `jiborobot/srv-account-ws@6cea43470825657d6a5722162f28c8f233153ee2`. Account/Admin operations share `AccountHandler`; `ActivateById` and `ResetEmail` carry `adminOnly: true`. Loop operations share `LoopHandler`; `ClearRobot` and `SuspendRobotLoop` carry `adminOnly: true`.

Each affected row separates local Phoenix observations (`source.phoenixStatus`, `contract.phoenixImplementation`) from the source mapping (`source.original`) and source contract (`contract.originalSource`). Four source-backed cases are recorded per row; operations without a required or typed payload use a boundary case and do not claim a guaranteed validation rejection. They are all `not-run`; this is source recovery and does not establish runtime parity. The pinned legacy JavaScript tree `server/account-ws@20c768d098e4e23255bd85322625b2547213674c` is retained as chronology evidence because it predates several operations present in the complete TypeScript tree.

Source-backed gaps remain explicit: the deployed target alias and service revision are not proven, outer gateway authentication and exact framework error framing are not replayed, and Mongo/SNS/Mail/Robot/Binary/Twilio/EchoSign provider behavior is not executed here. Rows with a Phoenix proxy boundary therefore have original controller evidence, but no implementation or parity credit.

This repair adds line-level `sourceEvidence` to the generated Account/Loop rows and validates source-derived negative claims. `ResetKeys` now maps to `AccountController.reset` (the handler calls that symbol), and its unsafe account serialization remains an explicit output witness. The exhaustive handler/controller audit also corrected `ResendActivationCode` to its source call `AccountController.resendActivation`; this is an alias correction, not a new operation. Root followed the schema save hook into `src/index.ts` startup: `AcceptTerms` schedules `AccountUpdated`, and `ClearRobot` schedules `LoopUpdated`. The earlier isolated-controller review missed that wiring. Both hooks use `setImmediate`, continue the save immediately, and log send/serialization failures. Every Account/Loop row now records the conditional startup hook; exact EventSender serialization and external delivery remain unexecuted. `InviteLoopMember` records the handler's lowercased email and trimmed names, `false` defaults for `asLegalGuardian` and `isChild`, owner/suspended/existing-member error order, and `ACCEPTED` versus `INVITED` status rule; the source's array-versus-length active-limit comparison remains an explicit reachability gap. `GetRobot` retains the source null/stale-robot `toJSON` boundary as unknown. Read/token rows use read comparison fixtures instead of a state-changing repeat. All 169 rows and all source-backed cases remain `not-run`.

## What each row contains

Every row records:

- the exact wire target and inventory/model schema, including required input members;
- a pinned Phoenix route/handler observation, retaining `proxy-only`, `stub`, or no-registration facts where applicable;
- the original Account/Admin, Loop or OOBE handler/controller mapping where recovered;
- per-operation `attributes` for Account/Loop/OOBE (auth, ownership, API JSON schema refs, controller errors, persistence, side effects, Phoenix handler presence);
- SDK models and direct tests/source consumers;
- an existing functional task, with registered historical ownership `A-19` for Jot and `A-20` for VoiceTraining;
- auth and identity source, ownership checks, source errors, persistence, side effects, and an operation-specific verification request;
- explicit unknowns so dispatch/shape/source mapping is not counted as runtime parity.

Current functional ownership remains with existing task families: Account A-03/A-02, Loop A-04, OOBE A-05, Settings A-06, Robot A-07, Update A-08, Backup A-09, Notification A-10, Key A-11, Log A-12, Push A-13, Media A-14, Person/Collision A-15, ROM A-16, IFTTT/NLP A-17, remaining OAuth/LPS A-18, and GQA Q-01. A-19 and A-20 are registered functional tasks. No task is closed by this map.

## Pinned source evidence

| Source | Revision | Scope |
| --- | --- | --- |
| `jiborobot/srv-jibo-server-client` | `155d20a8102960b2aeb89c197bdf04dc1f1fc344` | current API files and SDK model consumers |
| Phoenix source snapshot | generated `baseRevision` in the JSON | local handler/source observations; each generated row retains its revision |
| `jiborobot/srv-account-ws` | `6cea43470825657d6a5722162f28c8f233153ee2` | Account/Admin, Loop and OOBE handlers/controllers/schemas/errors/config entrypoint |
| `server/account-ws` | `20c768d098e4e23255bd85322625b2547213674c` | legacy JavaScript chronology comparison; incomplete later operation set |
| `pegasus` | `5c0a7390539663ba749d360de348a428c088505c` | **original** legacy Settings consumers |
| `jiborobot/srv-settings-ws` | `0d37e1fd2f4fca40538fb470194a3c5daf2c9830` | Settings handler/controllers/errors |
| `server/jot-ws` | `9a725d3ed8d991aa840131f5ef98c630df2fdf4e` | current Jot handler/controller/errors |
| `jiborobot/srv-jot-ws-archived` | `4432ac5d017ae1971a447f42e7a4b29da7eb2e58` | historical Jot target-prefix integration test |
| `server/voice-ws` | `a0ec047a86d6811176d0f05a6cce5a660a2cadd8` | current Hapi dispatcher and VoiceTraining handlers |
| `jiborobot/srv-voice-ws-archived` | `0e8dc870beaad8caf1dc9ae415a5d250a580b570` | archived VoiceTraining handler family; path gaps remain |

The frozen discovery record used a restored Pegasus tree for earlier evidence. This follow-up does not label that restored revision as original: all Settings consumer pins generated here use Pegasus `5c0a7390539663ba749d360de348a428c088505c`. In both original consumer files, `SETTINGS_API_VERSION = '20160801'` is declared at report-skill line 12 and hub line 4, and the constructed `x-amz-target` ``Settings_${SETTINGS_API_VERSION}.GetSettings`` appears at report-skill line 176 and hub line 31. The two original files were byte-identical to their restored-revision counterparts in the source comparison (10,959 and 1,596 bytes); the restored revision remains comparison evidence only.

## Remaining source and runtime gaps

Historical Jot and VoiceTraining model schemas are pinned, but their version-specific controllers and deployed target aliases are not all recovered. In particular, the old VoiceTraining names `UploadFile`, `RemoveFile`, `ListFiles`, and `GetFile` do not match the current Hapi handler exports; A-20 retains that gap.

`Settings_20160801.GetSettings` is independently mapped from `Settings_20171219`. Archive searches (SDK `apis/` at the pin and default branch, file history of `settings-2017-12-19.normal.json` first added 2017-12-21 as `Settings_20171219`, `server/jibo-server-client` with no settings file, security-gw code search, and Pegasus consumer history) did **not** recover a formal `settings-2016-08-01` API model. The row records consumer-observed request/response from original hub/report `SettingsClient` (hub sends `skills: string[]`; report sends `skills: 'report-skill'`) plus the later 2018 `SettingsHandler.GetSettings` as a same-name handler, not as a 20160801 model. The previous invented merged schema was removed. All rows remain unverified until root runs the listed scenarios against source-compatible fixtures or the integrated service.

The generator uses the reviewed historical-model artifact directly and requires every operation to belong to a registered task. Broader schema, error, ownership and provider assertions remain provisional unless a separate root review explicitly verifies them. Rebuild the snapshot with `python3 scripts/parity-coverage/a01_operation_map.py build` after updating its source observations; rebuilding alone is not a parity test.
