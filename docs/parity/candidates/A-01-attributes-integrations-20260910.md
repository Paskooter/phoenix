# A-01 candidate: operation attributes for IFTTT, Log, OauthClients, Settings 20171219, GQA, NLP, VoiceTraining

Task ID: `A-01-attributes-integrations-20260910`  
Worktree: `.parity/worktrees/a01-integrations-20260910`  
Status: **source map candidate, unverified.** Criterion 2 for these 36 rows is filled in; A-01 is not closed. Every runtime scenario remains `not-run`. Dispatch/shape/source mapping is not parity.

This candidate edits only `docs/parity/candidates/A-01-operation-map.json` (the 36 assigned rows) plus this write-up. Production code is unchanged.

## Scope

36 operations across 9 prefixes, previously without `attributes`:

| target prefix | count | operations |
|---|---:|---|
| `IFTTT_20170207` | 7 | Action, DeleteIdentity, ListActions, ListMedia, ListTriggers, Trigger, UserInfo |
| `Log_20150309` | 7 | NewKinesisCredentials, PutAsrBinary, PutBinary, PutBinaryAsync, PutEvents, PutEventsAsync, SetLevel |
| `OauthClients_20171108` | 4 | Create, ListClients, Remove, Update |
| `Settings_20171219` | 4 | DeleteSettings, GetDataForSettings, GetSettings, UpdateSettings |
| `GQA_20160930` | 2 | ListAttribution, Question |
| `NLP_20161031` | 2 | NamedEntityRecognition, PartOfSpeech |
| `VoiceTraining_20151103` | 4 | GetFile, ListFiles, RemoveFile, UploadFile |
| `VoiceTraining_20160103` | 4 | GetFile, ListFiles, RemoveFile, UploadFile |
| `VoiceTraining_20151020` | 2 | ListVoiceTrainings, UploadVoiceTraining |

`Settings_20160801.GetSettings` was not touched. The 20171219 four-operation surface is mapped independently.

## Pins actually read

| Pin | Revision | What was opened |
|---|---|---|
| `jiborobot/srv-jibo-server-client` | `155d20a8102960b2aeb89c197bdf04dc1f1fc344` | current API JSON for IFTTT, Log, LogAdmin, OauthClients, Settings 20171219, GQA, NLP |
| historical VoiceTraining models | `0e4c44d8…` / `29ef3c25…` / `4c68f963…` | `voicetraining-2015-06-17.normal.json`, `…-2015-11-03…`, `…-2016-01-03…` |
| `jiborobot/srv-security-gw` | `43a692fe7670660aaed6ab5979c6c83039eb711c` | `src/controllers/auth.ctrl.ts` (`unauthorizedMethods`, `unsignedMethods`, `unactiveMethods`) |
| `jiborobot/srv-ifttt-ws` | `c277dbf1d3952f801b3b6c7198434833f064a23a` (default master as read) | `ifttt.handler.ts`, `ifttt.ctrl.ts`, errors, schemes |
| `jiborobot/srv-log-ws` | `d72f82d423fa47b1e2e7a30a312d4b5f9d012e38` | `log.handler.ts`, `log.ctrl.ts`, `kinesis.ctrl.ts`, errors |
| `jiborobot/srv-oauth-clients-ws` | `3e546cb78eb160dcd3eaf25173420a35c56f68b5` | `client.handler.ts`, `client.ctrl.ts`, errors, scheme |
| `jiborobot/srv-settings-ws` | `0d37e1fd2f4fca40538fb470194a3c5daf2c9830` | `settings.handler.ts`, `settings.ctrl.ts`, `get.ctrl.ts`, `account.ts` client, errors |
| `jiborobot/srv-gqa-ws` | `ebe1a7d38f511570060c1fbf61bec89d58419b26` | `gqa.py` (partial; Flask routes), `attribute.py`, `account.py`, `tests/unit/test_general.py` |
| `jiborobot/srv-nlp-ws` | `787bc1a54eece2d036963baef14be9d95bc0309a` | `nlp.py`, `jibospacy.py`, README |
| `server/voice-ws` | `a0ec047a86d6811176d0f05a6cce5a660a2cadd8` | `server.js`, `lib/handlers/{index,base,upload-voice-sample,list-voice-trainings}.handler.js` |
| `jiborobot/srv-voice-ws-archived` | `0e8dc870beaad8caf1dc9ae415a5d250a580b570` | `lib/handlers/index.js` (same two exports) |
| Phoenix | opened locally | `packages/classic/src/{index,router,stubs,log}.js`, `packages/account/src/settingsFace.js`, `packages/skills/src/gqaAccountAttribution.js` |

Decorators were read as preceding their methods. No grepped snippet was trusted for method ownership.

None of these 36 targets appear in gateway `unauthorizedMethods`, `unsignedMethods` (empty at this pin) or `unactiveMethods`. Unsigned calls are therefore rejected with `MISSING_AUTH_HEADER` before any handler decorator runs. That layer is recorded on every `authenticationMode.unknowns` array; the decorator does not override it. Deployed gateway revision/alias was not replayed.

## Family notes

### IFTTT_20170207

`IftttHandler` uses `@parseCredentials({})` on every method. Robot-only operations (`Trigger`, `ListActions`) throw `ROBOT_MUST_CALL 403` unless `listLoops(ownerId, true)` returns exactly one loop whose `robot === ownerId`. Owner operations (`Action`, `ListTriggers`, `ListMedia`, `DeleteIdentity`, `UserInfo`) key off `credentials.id`.

API vs Joi mismatches, recorded not repaired: `Action.fields` and `ListTriggers`/`ListMedia.identity` are required by the handler and optional in the API JSON.

Phoenix: stub in `packages/classic/src/stubs.js` (empty lists / `Command accepted`). Present, not source-backed.

### Log_20150309

Six robot operations plus admin `SetLevel` (`parseCredentials({ adminOnly: true })`, `logadmin-2015-03-09.normal.json`, same target prefix). `NewKinesisCredentials` is robot-only (`ROBOT_ONLY 403` if `friendlyId` is missing) and calls STS. Binary/async paths probability-sample then return 24h S3 signed URLs or stream through `@jibo/binary`. `PutEvents` writes Winston → `S3StreamLogger`. `SetLevel` only publishes `RobotVerbosityChanged`.

Phoenix `logHandler` implements the six non-admin ops as a local sink with no Kinesis/S3; `SetLevel` is unimplemented (`ValidationException`).

Kinesis and the original S3 bucket are dead providers; live signed-URL and STS behavior is unknown.

### OauthClients_20171108

All four methods are `adminOnly`. Mongo `OauthClient` documents, unique `clientId`. `Create` → `CLIENT_ALREADY_EXISTS 409`; `Update` → `CLIENT_NOT_FOUND 404`; `Remove` uses `findByIdAndRemove` and does **not** throw on a missing id (wire body unknown). Phoenix has no registration.

### Settings_20171219

Independently mapped from `Settings_20160801.GetSettings`. Handler Joi requires `loopId`; `transId` is optional despite API `requiredInput`. Membership is `Account.checkUserBelongsToLoop` → `LOOP_MEMBER_ONLY 403`. Get path: Hub configs (or payload `settings`) then Person/Lasso/loop nodes; unknown data service → `UNKNOWN_DATA_SERVICE 422`. `getView` defaults to **true** when not a boolean. At this pin, `GetDataForSettings` shares GetSettings' `validatePayload` (`loopId`+`transId` only); missing `settings` therefore falls through to Hub configs. That is the source decorator, not the API JSON and not Phoenix's extra `settings` array check.

Phoenix: `packages/account/src/settingsFace.js` via classic `/^settings/i` proxy. Lasso is a dead external provider.

### GQA_20160930

The recovered service is Flask, not `@jibo/server`. Tests at this pin post `application/json` to:

- `POST /structQA` for the QuestionRequest shape (`Input`, `Intent`, geo, `x-amz-credentials`)
- `POST /retrieveAtt` for attribution (`Service`/`before`/`after`; test body `ID` is the literal `"useless"` — loop_id comes from `account.get_loop_id(credentials.id)`)

Q-01 accepted work is the Hub skill `POST /answer_skill/v1/main` plus `/retrieveAtt` HTTP framing. That is **not** treated as `GQA_20160930.Question`. Phoenix Classic has no GQA registration.

Q-01 HTTP framing established that Flask 0.12 does not parse `application/x-amz-json-1.1`. Whether the gateway rewrites content-type onto `/structQA` is unknown. Live Bing/Wolfram were not contacted. Whether `/structQA` itself calls `attribute.insert_db` was not line-read (Hub-skill attribution insert is a different route).

### NLP_20161031

Cloud spaCy Flask app: `POST /NER` and `POST /POS`, JSON `Input`, optional `x-amz-credentials.friendlyId` for stderr logs only. No ownership check. This is **not** the N-08 on-robot NLU engine; N-08 findings are not applied here.

How the gateway maps `NLP_20161031.*` x-amz-target onto `/POS`/`/NER` was not found in this repo. Phoenix stub returns empty arrays.

### VoiceTraining_* (three prefixes)

Pinned current Hapi dispatcher (`server.js`) looks up `handlers[method] || handlers[method+'Handler']`. Exports at both `server/voice-ws@a0ec047a` and `srv-voice-ws-archived@0e8dc870` are only `UploadVoiceTrainingHandler` and `ListVoiceTrainingsHandler`.

- `VoiceTraining_20151020.ListVoiceTrainings` / `UploadVoiceTraining` match those exports (filename label `2015-06-17` vs metadata `2015-10-20` already on the model row).
- `VoiceTraining_20151103` and `VoiceTraining_20160103` SDK names `UploadFile` / `RemoveFile` / `ListFiles` / `GetFile` do **not** match. The mismatch is recorded in `unknowns`. No alias is invented. Current dispatcher 404s an unknown method.

Google STT / historical sample processing is unrecovered; current handlers only talk to Backup at `/voiceTraining/`. Phoenix has no VoiceTraining registration.

## Verified / inferred / unknown

**Verified (read, not executed):** API JSON shapes and empty error arrays; IFTTT/Log/Oauth/Settings TypeScript decorators, Joi, controller Boom codes, Mongo/S3/STS/event writes as written; gateway allow-lists at `43a692fe`; Voice current exports and dispatcher lookup; GQA `/structQA` and `/retrieveAtt` from unit tests plus `attribute.search_db` (90-day floor, 50 cap); NLP `/NER`/`/POS` and `clean_input`; Phoenix files named in `phoenixHandler.path`; `runtimeStatus: not-run`.

**Inferred from source reading, not runtime:** unsigned gateway rejection for these targets; `@jibo/server` camelCase mapping keys accepting PascalCase x-amz-target; GetDataForSettings missing-`settings` fallthrough to Hub; Voice 20151020 name match vs later SDK 404; ListAttribution `ID` unused; GQA Question vs Hub skill as distinct surfaces.

**Unknown / not-run:** all 36 runtime scenarios; deployed aliases; exact Hapi/Boom/Flask envelopes; STS/S3/IFTTT-notify/Lasso/Bing/Wolfram/Wikipedia live behavior; AWS-JSON content-type rewrite onto Flask GQA/NLP; NLP x-amz-target→path map; Oauth `Remove` missing-id body; `/structQA` attribution insert; historical VoiceTraining aliases and Google STT; restart/transaction behavior.

A row with those unknowns is intentional. Nothing here was invented to look complete.

## Commands

```sh
python3 scripts/parity-coverage/a01_operation_map.py validate
# A-01 operation map valid: 169 rows; current=134 historical=35
# literal-union=169 substitution=170 observed-client-prefix-union=173
# hypothetical-five-pair-union=174

npm test
# tests 994 / pass 987 / fail 0 / skipped 7
# parity:check valid (9/79)
# parity:gate {"result":"match","cases":43,"differences":0}
```

Unit-test and gate counts did not move from this worktree's baseline. The change is data-only.

## Next step

Root review of this source map. Functional work stays with A-17 (IFTTT/NLP), A-20 (VoiceTraining), Q-01 (GQA), A-06 (Settings). Do not mark A-01 verified from this candidate.
