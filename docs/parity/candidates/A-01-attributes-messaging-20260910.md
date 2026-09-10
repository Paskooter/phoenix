# A-01 candidate: Jot / Person / Media operation attributes

Task ID: `A-01-attributes-messaging-20260910`  
Worktree: `.parity/worktrees/a01-messaging-20260910`  
Status: **source map candidate, unverified.** Criterion 2 is recorded for these 39 rows only. No A-01 criterion is closed. Every runtime scenario remains `not-run`. Dispatch/shape/source mapping is not parity.

This candidate hand-edits `docs/parity/candidates/A-01-operation-map.json` for four prefixes:

| target prefix | operations |
|---|---:|
| `Jot_20160310` | 14 |
| `Jot_20160126` | 10 |
| `Person_20160801` | 10 |
| `Media_20160725` | 5 |

No other row is changed. `packages/**` is untouched.

## Pins actually read

| id | repository | revision | what was read |
|---|---|---|---|
| current SDK | `jiborobot/srv-jibo-server-client` | `155d20a8102960b2aeb89c197bdf04dc1f1fc344` | `apis/` listing (28 files, **no jot-***); `person-2016-08-01.normal.json`; `media-2016-07-25.normal.json`; `mediaadmin-2016-07-25.normal.json` |
| jot historical SDK | `jiborobot/srv-jibo-server-client` | `4c68f963…`, `1b26ad78…`, `39f53698…`, `bfab9a6d…`, `b2da11bc…` | `apis/jot-2016-01-26.normal.json`, both `jot-2016-03-10.normal.json` revisions, `jot-2016-05-10.normal.json`, `jot-2016-05-12.normal.json` |
| jot later handler | `server/jot-ws` | `9a725d3ed8d991aa840131f5ef98c630df2fdf4e` | `src/handlers/message.handler.js`, `src/controllers/message.ctrl.js`, `src/errors/message.js`, `src/schemes/message.js`, `src/index.js`, `src/bus.js` |
| jot archive | `jiborobot/srv-jot-ws-archived` | `4432ac5d017ae1971a447f42e7a4b29da7eb2e58` | `src/handlers/message.handler.js`, `src/controllers/message.ctrl.js`, `src/errors/message.js`, `archive/message.spec.js` |
| jot party-era | `server/jot-ws` | `5247deadf6fefcf96c5f3cdd460c6f93e8541d55` | last party-era `message.handler.js` / `message.ctrl.js` / `message.js` (jot-parts merge, before simplified Jot) |
| jot 2016-01-26 | `server/jot-ws` | `3b7b2f842ff361cf39fc1d8d639f5992039cb689` | `lib/handlers/message.handler.js`, `lib/controllers/message.ctrl.js` |
| jot createBinaryPart | `server/jot-ws` | `5fc8c8345f1124e24d962929ab1561612b0e09e3` | `message.handler.js` / `message.ctrl.js` after simplified Jot added `createBinaryPart` |
| person | `jiborobot/srv-person-ws` | `fc06373f5f1ce88997d0b5f2e4640543e2033b44` | handlers, controllers, errors, schemes, `src/index.js` postSave hooks, account client (pre-URL-migration parent of `edac8d1d`) |
| media | `jiborobot/srv-media-ws` | `62fab24e3927f6d7eb340d43d8b3367959da254e` | handler, controller, errors, schemes, route, `src/index.js`, account client (pre-URL-migration parent of `17ab7f05`) |
| gateway | `jiborobot/srv-security-gw` | `43a692fe7670660aaed6ab5979c6c83039eb711c` | `src/controllers/auth.ctrl.ts` as specified (`43a692fe`) |
| phoenix | local | `f50288b8dfa7f792a1e8b1feb922fbade35256fa` | `packages/classic/src/stubs.js`, `index.js`, `router.js`, `awsJson.js`, `packages/classic/test/stubs.test.js` |

Decorator trap: files were read in source order. `@parseCredentials` / `@validatePayload` / `@validateHeaders` immediately above a method belong to that method. Party-era `markDelivered`/`markSeen` at `5247dead` have `@validatePayload` then `@parseCredentials` (both still belong to those methods).

## Gateway layer (all 39)

`unauthorizedMethods` does not include any Jot/Person/Media target. `unsignedMethods` is empty. `unactiveMethods` is only `Account_20151111.Remove`. A handler decorator does not override that allow-list: every one of these operations requires signed AWS4 at the gateway, and inactive accounts are rejected. Recorded in every `authenticationMode.unknowns` because deployed alias/replay was not run.

## Person_20160801 (10) — verified against current SDK + `srv-person-ws@fc06373f`

Formal API file **is** present at the current SDK pin (`apis/person-2016-08-01.normal.json`). The task note that Person has no client API file is not true of this pin; the recovered file is used.

| Operation | Auth | Ownership | Joi vs API | Controller errors thrown | Persistence / side effects |
|---|---|---|---|---|---|
| Answer | `parseCredentials` | caller’s `credentials.id` | `key`,`answer` required | `ALREADY_ANSWERED 409`, `QUESTION_NOT_FOUND 404`, `ANSWER_OPTION_WRONG 422` | `Answer.create`; no postSave hook |
| List | `parseCredentials` | unanswered questions for caller | `category` required; Joi has no `'app'` enum | `CATEGORY_NOT_FOUND 404` | read `Answer.find` to filter |
| EnableHolidays / DisableHolidays | `parseCredentials` | owner or robot | `ids`,`loopId` | `HOLIDAY_MUST_BE_OWNER_OR_ROBOT 403` | `Holiday.update` `isEnabled`; **Model.update, so `HolidayUpdated` postSave likely does not fire** |
| ListHolidays | `parseCredentials` | owner or robot | `loopId` | `HOLIDAY_MUST_BE_OWNER_OR_ROBOT 403` | `syncHolidays` may `create`/`remove`; create schedules `HolidayUpdated` |
| GetAccountProperties | `parseCredentials` | caller only | API requires `keys`; Joi `keys` is optional `.min(1)` | none; `PROPERTY_NOT_FOUND` unused after 2018-01-04 empty-map change | read |
| GetLoopProperties | `parseCredentials` | loop member | API requires `keys`+`loopId`; Joi requires only `loopId` | `LOOP_MEMBER_ONLY 403` | read |
| SetAccountProperty | `parseCredentials` | caller only | `key` + `value` object | none | save → `AccountPropertyUpdated` |
| SetLoopProperty | `parseCredentials` | loop member | `loopId`,`key`,`value` object | `LOOP_MEMBER_ONLY 403` | save → `LoopPropertyUpdated` |
| ListAccountPropertyKeys | `parseCredentials` | caller only | empty payload | none | **controller returns `string[]`; API shape is `{keys: string[]}`** |

Phoenix: `packages/classic/src/stubs.js` `defineStubs().person` is present (`stub-ephemeral`). In-memory property maps, no membership/owner checks, holidays return `{result:'Command accepted'}` with no persistence. Phoenix `ListAccountPropertyKeys` returns `{keys:[…]}` (API shape), not the source array.

`HOLIDAY_NOT_FOUND` and `PROPERTY_NOT_FOUND` are exported and unused in the controllers that were read. `ACCOUNT_SERVICE_UNAVAILABLE 503` is thrown from `AccountClient.getBase`.

## Media_20160725 (5) — verified against current SDK + `srv-media-ws@62fab24e`

| Operation | Auth | Ownership | Validation | Errors thrown | Persistence / side effects |
|---|---|---|---|---|---|
| Create | `parseCredentials` | accepted loop member | **headers** `x-loop-id` required; binary body; `x-type` enum | `MEDIA_MUST_BE_MEMBER 403`, `MEDIA_ALREADY_EXISTS 409`, `REFERENCE_FOR_THUMB 422`, `REFERENCE_NOT_FOUND 404` | `BinaryController.createPublic` + `Media.create` (or thumbs.push+save); `MediaCreated` on non-thumb |
| Get | `parseCredentials` | filter to caller’s loops; throw if any path is outside | `paths` required | `MEDIA_MUST_BE_MEMBER 403` | read; missing paths omitted (not `MEDIA_NOT_FOUND`) |
| List | `parseCredentials` | member of every `loopIds` entry | `loopIds` required; optional `before`/`after`; **handler also accepts `limit` (not in API JSON), default 50 cap 200** | `MEDIA_MUST_BE_MEMBER 403` | read + thumb expand |
| Remove | `parseCredentials` | uploader **or** loop owner; unowned paths omitted | `paths` required | **none thrown**; `MEDIA_ONLY_OWNER_CAN_REMOVE` is exported and unused | soft `isDeleted=true`; async S3 delete; `MediaDeleted` |
| RemoveAllMediaFromLoop | `parseCredentials({adminOnly:true})` | admin decorator; no membership check | `loopId` | none in controller | awaited S3 delete then `Media.remove` (hard); **no `MediaDeleted` event** |

Phoenix stub is present for Create/Get/List/Remove but reads JSON body, not headers/binary, and has no S3. `RemoveAllMediaFromLoop` is **absent** from `defineStubs().media.ops`; prefix `/^media/i` still matches, so the stub returns `ValidationException` unknown operation. Recorded as `present: false`, `absent-operation-handler`.

Internal `POST /getMedia` (`src/routes/media.route.js`) is not the AWS-JSON Get operation (`ignoreOwnership: true`).

## Jot — two prefixes, several recovered eras, prefixAmbiguity left open

Current SDK pin has **no** Jot client API file (`gitea_browse apis/` at `155d20a8`, 28 files). Historical models were read at older `srv-jibo-server-client` revisions. `requestSchema.apiModel.note` says so, following the Settings unrecovered-file pattern.

`denominator.prefixAmbiguity` is **not resolved**. The 2016-05-12 model declares `Jot_20160126` while `archive/message.spec.js` uses literal `Jot_20160512` for CreateMessage, ListMessages, MarkLoopRead, MarkRead. `NumberOfUnreadMessagesInLoops` remains model-only inferred. Recorded in `unknowns` on the 2016-05-12 operations.

Phoenix: no `/^jot/i` classic route and stubs.js documents jot as not built. Unmatched prefix → `UnknownOperationException 400`. `phoenixHandler.present: false`, `absent-no-classic-service`.

### Later loop-era handler (maps five `Jot_20160126` / 2016-05-12 operations)

Pinned `server/jot-ws@9a725d3` mapping: `createMessage`, `listMessages`, `markRead`, `markLoopRead`, `numberOfUnreadMessagesInLoops`. Archived pin is the same five, plus `isEncrypted` on create and `impersonateAs` on list.

| Operation | Ownership actually in the controller | Errors actually thrown | Notes |
|---|---|---|---|
| CreateMessage (2016-05-12 shape) | accepted member; only `loop.robot` may `impersonateAs` | `JOT_MUST_BE_LOOP_MEMBER 403`, `JOT_ROBOT_CAN_IMPERSONATE 403`, `JOT_CONTENT_OR_PARTS_REQUIRED 422` | `JotMessageCreated` then `populateParts` via Media |
| ListMessages | accepted member | `JOT_MUST_BE_LOOP_MEMBER 403` | current pin list Joi has no `impersonateAs`; archive does |
| MarkLoopRead | accepted member; robot impersonation | same 403s | `$addToSet read` for the whole loop |
| MarkRead | **no membership check**; `impersonateAs \|\| accountId` | none of the JOT_* 403s | archived source has `TODO: check accountId can impersonate` |
| NumberOfUnreadMessagesInLoops | **no membership check** | none | current pin returns `{count}`; archive returns `{count,accountId,loopIds}` |

Same-name `CreateMessage` also exists in `jot-2016-01-26.normal.json` with `payload`/`recipients`. That is a different contract, recovered at `3b7b2f84` / `5247dead`. Both are recorded on the one `Jot_20160126.CreateMessage` row.

### Party-era handler (maps six operations that appear on both Jot prefixes)

Last party-era mapping at `5247dead` (and PascalCase mapping at `3b7b2f84`): CreateMessage, RemoveMessage, ListIncomingMessages, ListSentMessages, MarkDelivered, MarkSeen.

Auth at `3b7b2f84` is a **custom** `x-amz-credentials` JSON `{_id}` parser, not `@jibo/server parseCredentials`. Auth at `5247dead` is `@parseCredentials({})`. Errors are `Boom.conflict` / `Error('Message not found')` / `401 Must be authenticated`. Typed `JOT_*` codes do not exist until 2016-08-11.

These six operations on `Jot_20160310` and the matching `Jot_20160126` rows cite that party-era source. The later loop-era pin does **not** map them.

### Wire names with no recovered handler mapping

Searched: current jot-ws pin, archived jot-ws, party-era `5247dead`, `3b7b2f84` lib handler, `5fc8c834` (createBinaryPart), `be/jot` (skill), archive-wide `jibo_search` for CreatePart / ListInbox / ListIncomingMessages / MarkAllSeen.

| Wire name | API evidence | Handler evidence |
|---|---|---|
| CreatePart | all three Jot_20160310 models; path is header `x-path`, streaming body | **no `createPart` mapping**. Nearby `createBinaryPart` at `5fc8c834` uses a generated uuid and hardcoded accountId `jot`. Recorded as a candidate, not as this wire name |
| GetMessages | all three Jot_20160310 models | controller `get` is an internal delete helper, not a mapping |
| UpdateMessage | all three | no mapping |
| MarkAllDelivered | initial 2016-03-10 file only | no mapping |
| MarkAllSeen | all three | no mapping |
| ListInbox | 2016-05-10 file only | no mapping (`listIncomingMessages` is a different name) |
| ListSent | 2016-05-10 file only | no mapping |
| ListMessages (`Jot_20160310`) | latest 2016-03-10 file, `partyId`/`skip`/`fromId` | later loop-era `ListMessages` is a different `loopId` contract |

Those rows have honest `unknown-matching-era-handler` auth, empty controller error lists, and persistence/side-effects marked unknown. Later loop-era `JOT_*` codes are **not** copied onto them.

## Verified / inferred / unknown split

**Verified (read in pinned source, not executed):**

- Gateway allow-lists at `43a692fe`.
- Current SDK Person and Media API JSON, including Media Create header/binary contract and mediaadmin `RemoveAllMediaFromLoop`.
- Historical Jot API JSON at the five recovered SDK revisions, including the dual `Jot_20160126` CreateMessage shapes and the three-file `Jot_20160310` union.
- Person/Media handler Joi, controller throws, mongoose save vs update, and Person postSave hooks in `src/index.js`.
- Later jot-ws five-operation mapping, membership/impersonation, and the MarkRead / NumberOfUnread membership holes.
- Party-era six-operation mapping and custom `x-amz-credentials` auth at `3b7b2f84`.
- Phoenix stub presence/absence, including Media `RemoveAllMediaFromLoop` unknown-op and Jot unmatched prefix.
- `python3 scripts/parity-coverage/a01_operation_map.py validate` — 169 rows; literal-union 169.

**Inferred from source reading (not runtime):**

- Person Enable/Disable `Holiday.update` probably does not fire `HolidayUpdated` postSave.
- Media thumb-via-reference create does not send `MediaCreated`.
- Media Remove S3 failure is swallowed; RemoveAllMediaFromLoop S3 failure fails the request.
- `createBinaryPart` is a same-era binary upload, not proven to be wire `CreatePart`.
- `@jibo/server` camelCase mapping of `x-amz-target` operation names.

**Unknown / not-run:**

- All 39 runtime scenarios.
- Deployed gateway alias, exact Boom/Joi envelopes, Mongo/SNS/S3/Kafka delivery.
- Matching-era handlers for CreatePart, GetMessages, UpdateMessage, MarkAllDelivered, MarkAllSeen, ListInbox, ListSent, and Jot_20160310.ListMessages.
- Whether a deployed 2016-03-10 process used the party-era payload/recipients Joi or the parts-required API JSON (they disagree).
- ListAccountPropertyKeys array vs `{keys}` wire envelope.
- Get*Properties behavior when API-required `keys` is omitted (Joi optional).
- Jot `Jot_20160126` vs `Jot_20160512` prefix identity (root’s open question).
- Phoenix stub vs source ownership/header/binary behavior (explicitly not treated as source).

## Commands

```sh
python3 scripts/parity-coverage/a01_operation_map.py validate
npm test
```

Validator: `A-01 operation map valid: 169 rows; current=134 historical=35 literal-union=169 substitution=170 observed-client-prefix-union=173 hypothetical-five-pair-union=174`.

`npm test` (second run): **994 tests, 987 pass, 0 fail, 7 skip**; parity tracker valid; smoke gate `{"result":"match","cases":43,"differences":0}`. First run failed one unrelated timing test (`RobotReadClient keeps one header deadline across redirects` in `packages/account/test/loopCreationTransport.test.js`, expected `['POST','POST']` got `[]`). That file is untouched; a focused re-run of the file passed 4/4, and the full suite then matched baseline. 7 skips is the known worktree path artifact in `scripts/nlu-compiled-graphs-install.test.mjs`.

Do not mark A-01 verified from this candidate. Root reviews and integrates.
