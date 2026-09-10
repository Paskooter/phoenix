# A-07 — Robot records, provisioning and calibration/history behaviour

**Date:** 2026-09-10
**Worktree:** `.parity/worktrees/w3-a07` (branch `w3/a07`)
**Base revision at verification:** `930fb1404bb5711e8466f6ed20d86839e07f8f2a` (plus the working-tree changes below)
**Result:** implemented and certified from pinned source; recommend `verified`.

Every claim is labelled **VERIFIED** (observed at runtime or read verbatim from pinned
source), **INFERRED** (reasoned from source), or **UNKNOWN** (not established).

## 1. How the pinned source was obtained

The Jibo archive MCP is reachable at `https://pvindex.org/mcp` (Streamable-HTTP JSON-RPC;
`tools/list` → `gitea_read_file` / `jibo_search` / `jibo_browse`). Every controller file was
read **at an explicit revision**, which is itself evidence that the revision exists and
contains that file. Raw copies are retained under
`docs/parity/evidence/2026-09-10/a07-robot-records/pinned/` (the saved files carry a
`# repo:path@ref` header, so raw line numbers are `saved − 2`; all line citations below are
**raw**).

| Repo | Revision | Files read |
|---|---|---|
| `jiborobot/srv-robots-ws` | `4c8b1b75f3e0ccb90fab160019637704ba62d36a` | `src/handlers/robot.handler.js`, `src/command.handlers/robot.{create,create.batch,update,delete,calibrate}.js`, `src/command.handlers/abstract.cmd.handler.js`, `src/repositories/{robot,abstract}.repository.js`, `src/aggregates/{robot,abstract.aggregate}.js`, `src/controllers/event.ctrl.js`, `src/schemes/event.js`, `src/clients/account.client.js`, `src/errors/robot.js`, `src/event.bus.js`, `config/config.json` |
| `jiborobot/srv-robots-read-ws` | `decbbf7e959af3dabe2384940cb316b0689a18b4` | `src/handlers/robot.handler.js`, `src/query.handlers/robot.{read,history,calibrate,friendly.ids}.js`, `src/query.handlers/{abstract.robot,abstract.query}.handler.js`, `src/controllers/robot.ctrl.js`, `src/clients/account.client.js`, `src/errors/robot.js`, `src/schemes/robot.js` |
| `jiborobot/srv-serial-names` | `master` | `src/main.js`, `data/{colors,tech,food,fabrics}.json`, `lib/crypto/md5.js` |
| `jiborobot/srv-jibo-server-client` | read at `155d20a8102960b2aeb89c197bdf04dc1f1fc344` and locally at `a07785a5` | `apis/robot-2016-02-25.normal.json`, `apis/robotadmin-2016-02-25.normal.json` |

**VERIFIED:** the two API models are **semantically identical** between the A-01-pinned
revision `155d20a8…` and the local mirror `a07785a5…`: `json.loads` equality is `True` for both
files. They are not byte-identical — `robotadmin` differs only in whitespace, and `robot`
differs in **member ordering** (`CalibrationPayload` and `CalibrationResponse` swap position) as
well as whitespace. JSON objects are unordered, so operation names, shapes and members are
unchanged; only cosmetic byte layout differs. Both declare `"targetPrefix":"Robot_20160225"`.

**VERIFIED (source), a correction worth recording:** `robot-2016-02-25.normal.json` and
`robotadmin-2016-02-25.normal.json` declare **the same** `targetPrefix` (`Robot_20160225`).
Robot and RobotAdmin operations therefore arrive under one wire prefix and are distinguished
**by operation name only** (the `endpointPrefix` `robot` vs `robotadmin` is a client-side
endpoint choice, not a header). The Phoenix router's `/^robot/i` prefix match therefore
serves both files, which is correct.

## 2. The full surface (9 operations, verbatim shapes)

All operations are `POST /` `X-Amz-Target: Robot_20160225.<Op>`, `protocol: json` 1.1.

| Operation | Source handler | Input shape (required members) | Output shape | Command/gate |
|---|---|---|---|---|
| `GetRobot` | readws `robot.handler.js:60` | `IdRequest{id}` (+ optional `serialNumber`) | `Robot` | mfg-or-admin-or-owner |
| `GetRobotHistory` | readws `robot.handler.js:45` | `IdRequest{id}` (+ `serialNumber`) | `Events` (list) | mfg-or-admin-or-owner |
| `GetCalibrationData` | readws `robot.handler.js:75` | `IdRequest{id}` (+ `serialNumber`) | `CalibrationResponse` | mfg-or-admin-or-owner |
| `GetFriendlyIds` | readws `robot.handler.js:89` | `FriendlyIdsRequest{count}` | `IdPairs` (list of `{id}`) | mfg-or-admin |
| `CreateRobot` | ws `robot.handler.js:66` | `CreateRequest{id, payload}` | `CommandResponse` | manufacturing-only |
| `CreateRobotBatch` | ws `robot.handler.js:82` | `CreateRequests` (**array body**) | `CommandResponse` | manufacturing-only |
| `UpdateRobot` | ws `robot.handler.js:49` | `UpdateRequest{id, payload}` | `CommandResponse` | manufacturing-or-owner |
| `RemoveRobot` | ws `robot.handler.js:33` | `IdRequest{id}` | `CommandResponse` | manufacturing-only |
| `CalibrateRobot` | ws `robot.handler.js:96` | `CalibrateRequest{id, calibrationPayload}` | `CommandResponse` | manufacturing-only |

**VERIFIED:** the read side never 500s for these ops; every command op returns
`{ result: 'Command accepted' }` (ws `robot.handler.js:9`).

### Response-shape rules (each implemented and tested)

- **VERIFIED:** `GetRobot` strips `calibrationPayload` and `events` from the stored record and
  defaults `payload` to `{}` (readws `robot.read.js:13-15`); the returned `id` is the **stored**
  (converted) id (`.read.js:11`).
- **VERIFIED:** `GetRobotHistory` maps `Robot.events` to the **list** `[{id, name, created, payload}]`
  (readws `robot.history.js:10`). The output shape `Events` is a `list`, so the wire body is a
  JSON array — **not** an `{events:[…]}` wrapper. `lib/json/parser.js translateList` confirms the
  aws-sdk fork parses a top-level array here.
- **VERIFIED:** `GetCalibrationData` returns `{id, calibrationPayload}` (readws
  `robot.calibrate.js:10`). Before the robot is ever calibrated, `calibrationPayload` is
  `undefined` and is dropped by `JSON.stringify`, so the body is `{id}`.
- **VERIFIED:** `GetFriendlyIds` returns `newIds.map(id => ({ id }))` (readws
  `robot.friendly.ids.js:25`) — a list of `IdPair{id}`; the model declares **only** `id`, so a
  `friendlyId` member is wrong (and would be stripped by the generated client).
- **VERIFIED:** ids with exactly four hyphen-separated parts are Pascal-cased per part before
  storage/lookup; other ids are untouched (ws `event.ctrl.js:4-17`, readws `robot.ctrl.js`).
- **VERIFIED:** `created`/`updated` are epoch-millisecond numbers; `updated` is restamped by
  both update and calibrate (ws `aggregates/robot.js`).

### Error envelopes with exact status codes

Command side (ws `errors/robot.js`): `ENTITY_ALREADY_EXISTS` 409, `ENTITY_NOT_FOUND` 404,
`ENTITY_DELETED` 410, `MANUFACTURING_ONLY` 403, `MANUFACTURING_OR_OWNER_ONLY` 403,
`ROBOT_OR_OWNER_ONLY` 403.
Read side (readws `errors/robot.js`): `MANUFACTURING_ONLY` 403, `MANUFACTURING_OR_OWNER_ONLY` 403,
`SERIAL_NUMBER_NOT_SET` 422, `SERIAL_NUMBER_NOT_MATCH` 422, `ROBOT_NOT_FOUND` 404,
`ROBOT_NAMES_NOT_GENERATED` 409.

**VERIFIED:** each is emitted as `__type` + `x-amzn-errortype` = the code with the source's
`statusCode` (Phoenix `sendAmzError`), which is exactly what the fork's
`lib/protocol/json.js extractError` reads back. Precedence implemented as source orders it:

- `UpdateRobot`: `listRobots` runs first (`robot.update.js:18`); then
  `MANUFACTURING_ONLY` for a `suspended` payload (`:19`); then `ROBOT_OR_OWNER_ONLY` (`:23`);
  **then** `getAggregate` → 404/410 (`:25`).
- Reads: permission → `getById` 404 → `serialNumber` 422 (readws `abstract.robot.handler.js:12-19`).

## 3. Both auth layers

- **Gateway layer (VERIFIED from the A-01 allow-list extraction,
  `evidence/2026-09-10/a01-operation-attributes/gateway-allow-lists.json`):** **no**
  `Robot_20160225.*` target appears in `unauthorizedMethods`, `unsignedMethods` or
  `unactiveMethods`. Every Robot target is therefore authenticated upstream: an unsigned call
  is rejected with `MISSING_AUTH_HEADER` before any handler runs. A-07 must not treat any Robot
  op as anonymous.
- **Handler layer (VERIFIED):** the `@parseCredentials({})` decorator on every Robot handler
  method populates `request.auth.credentials`; the handlers then apply their own gate
  (`isManufacturing` ws `robot.handler.js:25`; `isManufacturingOrAdmin`/`hasRobot` readws
  `robot.handler.js:28,33`). **VERIFIED:** `isManufacturing` is an explicit
  `credentials.email === 'manufacturing@jibo.com'` comparison, **not** an `adminOnly` decorator,
  and the command gate does **not** accept `isAdmin` (only `GetFriendlyIds` does, via
  `isManufacturingOrAdmin`).
- Phoenix runs no gateway and does not verify SigV4, so identity arrives on the same
  `x-amz-credentials` seam `log.js`/`backup.js` already use. `credentialsFrom(req) === null`
  means "no identity forwarded" — the LAN-trusted path.

## 4. Implementation

- `packages/classic/src/robot.js` — rewritten: event-sourced durable `RobotStore`
  (append-only log mirrored to JSON on disk), id conversion, both error tables, all nine
  operations, the manufacturing/admin/owner gates, `serialNumber` validation, and the
  source's `created/updated`/id/merge semantics.
- `packages/classic/src/serialNames.js` + `packages/classic/src/serialNames.json` — a port of
  `srv-serial-names` `randomlyGenerateCombos` with the four pinned word pools vendored verbatim
  (colors 218, tech 238, food 169, fabrics 71). **VERIFIED:** `GetFriendlyIds` ids are four
  PascalCase hyphen parts ≤ 25 chars drawn from that vocabulary, e.g.
  `Chicory-Plus-Zest-Cloth`.
- `packages/classic/src/index.js` — wires one durable `RobotStore` into the `/^robot/i` route
  (new `robotStore` option, env `ETCO_classic_robotDir`), replacing the stateless stub.
- `packages/classic/test/robotRecords.test.js` — 19 new tests: id conversion, aggregate
  projection, error envelopes, permission matrix, read shapes, friendly-id vocabulary, batch
  semantics, runtime serving and restart durability.
- `packages/classic/test/entrypoint.test.js` — the two robot stub tests corrected to the
  source-shaped record and the manufacturing gate.

**INFERRED (documented collapse):** `srv-robots-ws` (commands → Redis `EventBus`) and
`srv-robots-read-ws` (events → Mongo `Robot` projection) are two services in the original; the
robot reaches both through the one Classic entrypoint. Phoenix has no Redis/Mongo, so one
handler appends and projects the same durable event log. Observable records, shapes, gates and
error envelopes are preserved; the cross-service pub/sub hop is not (the source's
`RobotEntityUpdated`/`RobotUpdated` SNS sends are also not replayed — no SNS in Phoenix).

## 5. Runtime serving (every operation)

**VERIFIED:** `robotRecords.test.js` test 19 starts the real Classic entrypoint and sends all
nine operations over HTTP with a manufacturing `x-amz-credentials` header. Eight return `200`
and `RemoveRobot` returns `200`, then the deleted robot's `GetRobot` returns `404`. No operation
falls through to the unknown-operation `ValidationException`, so all nine are served.

## 6. Durability proven by a real restart

**VERIFIED:** test 19 creates, updates and calibrates a robot, **closes the listening server**,
asserts the on-disk log (`robots.json` → three events for `Ab-Cd-Ef-Gh`), then constructs a
**new** `createClassicEntrypoint` over a fresh `RobotStore` on the same directory and re-reads:

- `GetRobot` → `200`, `payload = {serialNumber:'SN-1', timeZone:'UTC'}`, `id = Ab-Cd-Ef-Gh`
- `GetCalibrationData` → `{id, calibrationPayload:{yaw:9}}`
- `GetRobotHistory` → `[RobotCreated, RobotUpdated, RobotCalibrated]`
- a batch-created robot is also re-read; `RemoveRobot` on the restarted process still serves.

## 7. Permission matrix (fixture identities)

**VERIFIED** by tests 6-10 with injected `x-amz-credentials` and an injected ownership
resolver:

| Caller | Create/Remove/Calibrate | GetFriendlyIds | GetRobot/History/Calibration | UpdateRobot |
|---|---|---|---|---|
| manufacturing email | allowed | allowed | allowed | allowed (incl. `suspended`) |
| `isAdmin` only | `MANUFACTURING_ONLY` 403 | allowed | allowed | allowed |
| owner (owns the id) | `MANUFACTURING_ONLY` 403 | `MANUFACTURING_ONLY` 403 | allowed | allowed unless `suspended` |
| non-owner identity | `MANUFACTURING_ONLY` 403 | `MANUFACTURING_ONLY` 403 | `MANUFACTURING_OR_OWNER_ONLY` 403 | `ROBOT_OR_OWNER_ONLY` 403 |
| no identity | `MANUFACTURING_ONLY` 403 | `MANUFACTURING_ONLY` 403 | allowed (LAN-trust boot read) | `suspended` → 403; otherwise LAN-trust |

Missing/duplicate/deleted record behaviour: `CreateRobot` duplicate → 409; command op on an
unknown id → 404 `ENTITY_NOT_FOUND`; on a deleted id → 410 `ENTITY_DELETED`; read of a deleted
robot → 404 `ROBOT_NOT_FOUND`; `serialNumber` absent → 422 `SERIAL_NUMBER_NOT_SET`; mismatch →
422 `SERIAL_NUMBER_NOT_MATCH`.

## 8. Falsification (required)

Two probes, each anchored on a **full code line** (never a substring, so no comment can satisfy
the anchor). Both were applied, observed, and reverted; the suite is green after each revert.

**Probe 1 — durability (highest-risk assertion).** Replaced the persist line
`    writeFileSync(this.file, JSON.stringify({ events: this.events }));`
with `    void this.file;` inside `RobotStore.#persist`.
**Observed:** `not ok 19 - every robot/robotadmin operation is served over HTTP and state
survives a process restart`, failing with
`ENOENT: no such file or directory, open '/tmp/a07-robot-…/runtime/robots.json'` at the on-disk
assertion (`robotRecords.test.js:370`); 18 pass / 1 fail. Restored → 19/19 pass.

**Probe 2 — permission gate.** Replaced
`    const isManufacturing = !!credentials && credentials.email === MANUFACTURING_EMAIL;`
with `    const isManufacturing = true;`.
**Observed:** five failures — tests 6 (manufacturing-only command ops), 7 (GetFriendlyIds gate),
8 (reads enforce mfg-or-owner), 9 (UpdateRobot owner/suspended), 10 (anonymous writes gated);
14 pass / 5 fail. Restored → 19/19 pass.

## 9. Final suite

Run once, at the end, from the worktree root:

```
$ npm test
# tests 1238
# suites 7
# pass 1231
# fail 0
# cancelled 0
# skipped 7
# todo 0
# duration_ms 24728.084324
> parity:check  Tracker structure, dependencies, evidence links and generated checklist are valid.
> parity:gate
{"result": "match", "cases": 43, "differences": 0, "invariants": 0, "coverageGaps": 0}
```

`cancelled 0` — no parallel-run contamination.

## 10. Honest unknowns / divergence candidates (NOT edited into DIVERGENCES.md)

1. **Anonymous boot read.** The source 404s `GetRobot`/`GetCalibrationData` for a robot with no
   stored record. Phoenix returns a valid empty record when **no identity is forwarded** (the
   robot's unverified SigV4 boot path), preserving the deliberate CLASSIC-SERVICES behaviour
   that the robot falls back to local `/var` calibration. With any identity present, the
   source's `ROBOT_NOT_FOUND` 404 applies. This is a candidate divergence (source-faithful for
   identified callers; lenient only for the identity-less LAN path).
2. **Ownership resolver.** The source's `hasRobot`/`UpdateRobot` ownership check is
   `AccountClient.listRobots(ownerId)` → `GET <account>/robots?ownerId=`. Phoenix's account
   service exposes no such internal route, so `accountOwnedRobots` returns `null` (unresolved)
   and the check is not enforced — the same "unresolved ⇒ allow" convention `backup.js` uses.
   **UNKNOWN:** whether a real owner/robot reaches these paths; enforcement is proven only with
   an injected resolver. Wiring a `/robots?ownerId=` route is A-04's surface.
3. **`GetRobotHistory` serial validation.** The source does not `await this.validate` in
   `robot.history.js:8`, so a serial mismatch races the read. Phoenix returns history without
   gating on `serialNumber` — the source's effective behaviour, made deterministic.
4. **`CreateRobotBatch` awaiting.** The source does not await per-item `validate`/`handle` and
   swallows per-item errors. Phoenix performs the same per-item create-and-ignore synchronously
   so persistence is deterministic; the response is identical (`Command accepted`).
5. **No pub/sub, no Mongo, no SNS.** The command→read projection and `RobotUpdated`/`RobotEntityUpdated`
   SNS sends are collapsed/absent (section 4).
6. **Framework envelope.** Source validation/Joi and Boom error bodies come from `@jibo/server`;
   Phoenix uses the AWS-JSON `__type`+`x-amzn-errortype` envelope (`ValidationException` 400 for
   Joi failures). The exact original framework envelope was not runtime-replayed (also flagged by
   A-01). **UNKNOWN.**
7. **`UpdateRobot` ownership comparison.** The source compares the **raw** request `objectId`
   against the account robot list while `getAggregate` converts the id; a 4-part lowercase id
   could therefore differ between the ownership check and the aggregate lookup. Phoenix follows
   the same raw-vs-converted split.

## 11. Reproduce

```bash
node --test packages/classic/test/robotRecords.test.js packages/classic/test/entrypoint.test.js
python3 - <<'PY'
# re-fetch the pinned controllers (same helper the session used)
PY
npm test
```
