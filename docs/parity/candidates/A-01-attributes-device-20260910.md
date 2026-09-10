# A-01 candidate: device-family per-operation attributes

Task ID: `A-01-attributes-device-20260910`  
Worktree: `.parity/worktrees/a01-device-20260910`  
Status: **source map candidate, unverified.** Criterion 2 coverage for nine prefixes only. No A-01 acceptance criterion is closed. Every `runtimeStatus` remains `not-run`. Dispatch/shape/source mapping is not parity.

This candidate adds an `attributes` block to **37 operations** in `docs/parity/candidates/A-01-operation-map.json`. No production code, `.parity/`, hardware, Moth, or remote was touched.

## Scope

| target prefix | count | operations |
|---|---:|---|
| `Key_20160201` | 9 | Backup, CreateRequest, GetRequest, ListBinaryRequests, ListIncomingRequests, Restore, Share, ShareBinary, ShouldCreate |
| `Robot_20160225` | 9 | CalibrateRobot, CreateRobot, CreateRobotBatch, GetCalibrationData, GetFriendlyIds, GetRobot, GetRobotHistory, RemoveRobot, UpdateRobot |
| `Update_20160301` | 8 | CreateUpdate, GetUpdateFrom, ListTargets, ListUniqueFilters, ListUpdates, ListUpdatesFrom, RemoveUpdate, SetTarget |
| `ROM_20171011` | 3 | Create, SetupClient, SetupServer |
| `Backup_20170222` | 2 | List, New |
| `Push_20160729` | 2 | CreateDevice, RemoveDevice |
| `Notification_20150505` | 2 | GetStatus, NewRobotToken |
| `Collision_20161126` | 1 | Match |
| `Lps_20171201` | 1 | NewCredentials |

Other prefixes were left byte-identical. Account / Loop / OOBE / Settings attributes were not rewritten.

## Pins actually read

| Source | Revision | What was read |
| --- | --- | --- |
| `jiborobot/srv-jibo-server-client` | `155d20a8102960b2aeb89c197bdf04dc1f1fc344` | `apis/key-2016-02-01.normal.json`, `robot-2016-02-25.normal.json`, `robotadmin-2016-02-25.normal.json`, `update-2016-03-01.normal.json`, `updateadmin-2016-03-01.normal.json`, `rom-2017-10-11.normal.json`, `backup-2017-02-22.normal.json`, `push-2016-07-29.normal.json`, `notification-2015-05-05.normal.json`, `collision-2016-11-26.normal.json`, `lps-2017-12-01.normal.json` |
| `jiborobot/srv-security-gw` | `43a692fe7670660aaed6ab5979c6c83039eb711c` | `src/controllers/auth.ctrl.ts` (`unauthorizedMethods`, `unsignedMethods`, `unactiveMethods`) |
| `jiborobot/srv-key-ws` | `813c98f0db53ef0ebdeb08cc4727006ed1d473a4` | `src/handlers/key.handler.ts`, `src/controllers/key.ctrl.ts`, `src/errors/key.ts`, `src/schemes/{key,backup,binary}.ts`, `src/index.ts`, `src/routes/binary.route.ts` |
| `jiborobot/srv-robots-ws` | `4c8b1b75f3e0ccb90fab160019637704ba62d36a` | `src/handlers/robot.handler.js`, `src/command.handlers/{robot.create,robot.create.batch,robot.update,robot.delete,robot.calibrate,abstract.cmd.handler}.js`, `src/errors/robot.js`, `src/repositories/{robot.repo,abstract.repository}.js`, `src/controllers/event.ctrl.js`, `src/schemes/event.js`, `config/config.json` |
| `jiborobot/srv-robots-read-ws` | `decbbf7e959af3dabe2384940cb316b0689a18b4` | `src/handlers/robot.handler.js`, `src/query.handlers/{robot.read,robot.calibrate,robot.history,robot.friendly.ids,abstract.robot.handler,abstract.query.handler}.js`, `src/controllers/robot.ctrl.js`, `src/errors/robot.js`, `src/schemes/robot.js` |
| `jiborobot/srv-update-ws` | `14394fec783c6ed75734750319d6c17cbf870571` | `src/handlers/{update,targeted}.handler.ts`, `src/controllers/{update,targeted}.ctrl.ts`, `src/errors/update.ts`, `src/schemes/{update,target}.ts`, `src/index.ts` |
| `jiborobot/srv-rom-ws` | `c639b4253019be60789cff6085ec11ccbe44ace3` | `src/handlers/rom.handler.ts`, `src/controllers/rom.ctrl.ts`, `src/errors/rom.ts`, `src/schemes/certificate.ts`, `src/index.ts` |
| `jiborobot/srv-backup-ws` | `1153de1e343310a3f48f74ea3cbbe01e4bccab65` | `src/handlers/handler.js`, `src/controllers/ctrl.js`, `src/errors/backup.js`, `src/index.js` |
| `jiborobot/srv-push-ws` | `0bde76b64cb49733f9e57a772e69b6ea4b9c9a9d` | `src/handlers/handler.js`, `src/controllers/account.ctrl.js`, `src/errors/account.js`, `src/schemas/account.js` |
| `jiborobot/srv-notification-ws` | `e42bfe01506a8febf3005ac536fda735bba49d0d` | `src/handlers/handler.ts`, `src/controllers/ctrl.ts`, `src/errors/errors.ts`, `src/schemes/{token,notification}.ts` (same pin as accepted A-10) |
| `jiborobot/srv-collision-ws` | `71e98bb6d4eed38fea5b4433386a1d1d8236a370` | `src/handlers/collision.handler.js`, `src/controllers/collision.ctrl.js` |
| `jiborobot/srv-lps-ws` | `e36e378a58cb66cfc577a554863de86360a82bb2` | `src/handlers/handler.ts`, `src/controllers/sts.ctrl.ts`, `src/errors/lps.ts`, `src/index.ts` |

HEAD of each `jiborobot/srv-*-ws` repo is a 2026 pvindex URL-migration commit that only touched `package.json` / `.npmrc`. Attributes pin the **pre-migration parent**, which is the last original Jibo source revision. Handler/controller files were re-read at that parent.

Phoenix files opened for `phoenixHandler.present`: `packages/classic/src/{index,router,key,robot,backup,push,notification,stubs}.js`, `packages/ota/src/service.js`, `scripts/parity-robot/authenticated-stack.mjs`, `scripts/run-compose-stack.sh`.

## Gateway layer (all 37)

None of these targets appear in `unauthorizedMethods`, `unsignedMethods` (empty), or `unactiveMethods` (`Account_20151111.Remove` only) at `auth.ctrl.ts@43a692fe`. A missing `Authorization` is therefore `MISSING_AUTH_HEADER`. A supplied header is verified as AWS4. Inactive accounts are rejected. A handler `@parseCredentials` decorator does **not** override that allow-list.

`Backup_20150617.*Anon` is on the unsigned list; **`Backup_20170222` is not.**

## Ownership facts that matter in this family

Recorded from handlers/controllers, not from Phoenix:

- **Robot-authenticated:** `Backup_20170222.{New,List}` (`loop.robot === credentials.id`), `ROM_20171011.SetupServer` (`credentials.friendlyId`), `Lps_20171201.NewCredentials` (`friendlyId` required or `ROBOT_ONLY 403`). `Key_20160201.Restore` allows owner **or** robot. `Update_20160301` List/Get use `credentials.friendlyId` only as a targeting key, not as an ownership gate.
- **Manufacturing email, not `adminOnly`:** `Robot_20160225.{CreateRobot,CreateRobotBatch,CalibrateRobot,RemoveRobot,GetFriendlyIds}` require `credentials.email === 'manufacturing@jibo.com'` (GetFriendlyIds also allows `isAdmin`). `UpdateRobot` allows manufacturing or owner/robot; `payload.suspended` is manufacturing-only, `payload.remoteEnabled` is owner-editable (`config/config.json`).
- **Admin decorator:** `Update_20160301.{ListUniqueFilters,ListTargets,SetTarget}` use `@parseCredentials({adminOnly:true})`. `CreateUpdate` does **not**; it checks `credentials.isAdmin` in the method. `RemoveUpdate` is creator-`accountId`, not adminOnly.
- **Loop owner:** `Key_20160201.Backup`. `ROM_20171011.{Create,SetupClient}` require owning the loop whose `robotFriendlyId` matches, plus `remoteEnabled` on Create.
- **Notification GetStatus:** source handler has an explicit TODO and does **not** check whether the caller may read `payload.accountId`. Recorded, not repaired. Does not contradict accepted A-10 token/socket behavior.

## Phoenix handlers (opened, not executed)

| Family | present | note |
| --- | --- | --- |
| Key (9) | true | in-process `KeyStore`; no loop-membership checks |
| Robot reads/Update/Remove/GetFriendlyIds | true | compatibility shapes; no manufacturing/owner checks |
| Robot Create/CreateBatch/Calibrate | **false** | `makeRobotHandler` has no cases; unknown-operation 400 |
| Update List/Get | true | `packages/ota/src/service.js`; SigV4 ignored |
| Update Create/Remove/admin target ops | **false** | OTA POST / returns `UnknownOperationException` |
| ROM / Collision | true (stub) | empty certs / "no collision" |
| Backup | true | drops `loop.robot` check; self-hosted blobs |
| Push | true | in-memory registry; `{}` not `Devices`; no APNs/FCM |
| Notification | true | A-10 store/socket; GetStatus still has no caller-vs-subject check |
| Lps | **false** | unregistered prefix → `no classic service for target` |

**OTA launcher gap (deliberate, not fixed):** Classic `/^update/i` proxies to `NET_ota` default `localhost:7015`. `scripts/parity-robot/authenticated-stack.mjs` starts account, classic and gateway and does **not** start `packages/ota`, so `Update_*` proxy to a port with nothing listening in that profile. `scripts/run-compose-stack.sh` can start OTA on 9010 when `OTA` is not `0`.

## Notification / A-10

A-10 already accepted durable Token/Notification documents, 64-byte hex `tokenKey`, one token per account, 300s TTL, pending cap 100, and send-callback deletion. Attributes describe the **pinned source handler/controller** for `NewRobotToken` / `GetStatus` and do not claim extra Phoenix behavior. GetStatus's missing ownership check is in the source TODO; Phoenix also uses `body.accountId` without a caller-vs-subject check. That is recorded, not treated as an A-10 defect to edit.

## Verified / inferred / unknown split

Counts are per-field across 37 rows (authenticationMode, ownershipRule, requestSchema, responseSchema, declaredErrorCodes, persistenceEffects, observableSideEffects, phoenixHandler). A field is **verified** when it quotes a file that was opened at the pinned revision; **inferred** when it follows from that file without a runtime trace (for example "this EventSender call would publish if SNS were up"); **unknown** when the source was not read, not executed, or is an outer envelope.

| | verified | inferred | unknown |
|---|---:|---:|---:|
| authenticationMode (decorator / adminOnly / gateway lists) | 37 | 0 | 0 for the two layers that were read |
| ownershipRule | 37 | 0 | `accountClient.listRobots` second-argument semantics beyond the UpdateRobot call site |
| requestSchema.apiModel | 37 | 0 | 0 |
| requestSchema.handlerValidation | 37 | 0 | ShareBinary/`CreateUpdate` binary-stream Joi beyond the local decorator |
| responseSchema | 37 | 0 | Collision stdout vs `MatchOutput` JSON |
| declaredErrorCodes.controller | 37 | 0 | Joi/gateway/STS/S3 envelopes; CreateRobotBatch swallowed per-item errors |
| persistenceEffects | 0 executed | 37 source-read | Mongo/S3/STS/event-bus durability, restart |
| observableSideEffects | 0 executed | 37 source-read | SNS, APNs/FCM, phonetic binary, STS PUT |
| phoenixHandler.present | 37 files opened | 0 | 0 |
| runtimeStatus | 37 `not-run` | — | — |

**Honest unknown themes (also in the JSON `unknowns` arrays):**

- Deployed gateway alias and exact SigV4/Boom/Joi envelopes were not replayed.
- Inactive-account `ACCOUNT_NOT_ACTIVE` was not executed.
- S3 (Update upload/delete, Backup presign, Key binary public upload), SNS (`KeyNeeded`/`KeyShared`/`KeyTimeout`/`BinaryShared`/`RomConnectionRequested`/`RobotUpdated`), STS assumeRole, and the phonetic_collision binary were not executed.
- `srv-robots-ws` EventBus delivery into `srv-robots-read-ws` is source-structured, not traced.
- CreateRobotBatch does not await per-item `validate`/`handle` and logs errors.
- GetRobotHistory does not await `this.validate`.
- Collision controller returns raw `execFile` stdout; whether that is `MatchOutput` JSON is unknown.
- `@jibo/server` binary-option payload validation for ShareBinary/CreateUpdate was not opened.

## Commands

```sh
python3 scripts/parity-coverage/a01_operation_map.py validate
npm test
```

Validator: `A-01 operation map valid: 169 rows; current=134 historical=35 literal-union=169 substitution=170 observed-client-prefix-union=173 hypothetical-five-pair-union=174`.

`npm test` (this worktree): **994 tests, 987 pass, 0 fail, 7 skip**; parity gate `{"result":"match","cases":43,"differences":0}`. Unchanged from the branch-point baseline. The 7 skips (vs 8 on some main checkouts) is the known `scripts/nlu-compiled-graphs-install.test.mjs` path artifact.

## What this does not do

- Does not mark A-01 verified.
- Does not edit `packages/**`.
- Does not start OTA, Mongo, SNS, S3, STS, or a robot.
- Does not fill attributes for the other 24 prefixes (other workers).
