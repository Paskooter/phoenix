# A-04 reconnect candidate — `OOBE_20161026.ReconnectRobot`

Status: **candidate, unverified**. One adopted-operation slice: the missing
`OOBE_20161026.ReconnectRobot`. Does not close A-04 (root acceptance required).

## Source contract

Pinned source: `jiborobot/srv-account-ws@6cea434` — read in full:

- `src/handlers/oobe.handler.ts` — `ReconnectRobot` carries
  `@parseCredentials({})` then
  `@validatePayload({ id: Joi.string(), token: Joi.string().required() })`.
  `id` is **optional**; the robot identity comes from
  `request.auth.credentials.id`, not the payload. The decorator order means
  credentials are resolved before payload validation.
- `src/controllers/oobe.ctrl.ts` — `reconnectRobot({ token, robotAccountId })`:
  1. `tokenCtrl.findById(token)` (missing -> `TOKEN_NOT_FOUND`, expired ->
     `TOKEN_EXPIRED`, both without deleting);
  2. `loopCtrl.findByRobotAccountId(robotAccountId)` (`Loop.findOne({ robot })`);
  3. `!robotLoop` -> `LOOP_NOT_FOUND`;
  4. `robotLoop.isSuspended` -> `LOOP_SUSPENDED`;
  5. membership check: some member with `accountId` whose
     `m.accountId.toString() === tokenObj.accountId.toString()` and
     `m.status === MemberStatus.ACCEPTED`; else `MEMBER_CAN_REQUEST`;
  6. `tokenCtrl.deleteToken(token)` (one-time);
  7. return `COMMAND_RESULT`.
- `COMMAND_RESULT` is defined at the top of `oobe.ctrl.ts` as
  `{ result: "Command accepted" }`; the same shape is returned by the pinned
  `loop.ctrl.ts` (`update`, `suspendLoop`, `setLegalGuardian`, …).
- `MemberStatus.ACCEPTED` (`src/schemes/member.status.ts`) is the lowercase
  string `"accepted"`.
- Errors (`src/errors/loop.ts`, `src/errors/account.ts`, `src/errors/token.ts`):
  - `LOOP_NOT_FOUND` 404 "Loop does not exist"
  - `LOOP_SUSPENDED` 403 "Loop is suspended and cannot be modified"
  - `MEMBER_CAN_REQUEST` 401 "You can only request members that are in your loops"
  - `TOKEN_NOT_FOUND` 404 / `TOKEN_EXPIRED` 401

## Candidate behavior

`packages/account/src/robotFace.js` now:

- registers `reconnectrobot` in the `ops` table (keyed lowercased, like
  `setuprobot`), so `OOBE_20161026.ReconnectRobot` is served on the robot face;
- adds the missing `LOOP_SUSPENDED` entry to the local `Errors` table with the
  source message and `statusCode: 403` (`LOOP_NOT_FOUND` and
  `MEMBER_CAN_REQUEST` already existed with source-matching codes/statuses);
- resolves the caller from the stored account matching
  `Authorization: ... Credential=<accessKeyId>/...` (`accountForClassicRequest`,
  the same LAN-trust boundary the other OOBE compatibility handlers use —
  matching `prepareRobot` / `createhubtoken` precedent), and rejects a missing
  caller with `CREDENTIALS_REQUIRED`, mirroring `@parseCredentials` running
  before validation;
- validates `token` is a non-empty string (400 `ValidationException`, the
  existing local OOBE convention);
- then follows the source controller order exactly: token lookup
  (`TOKEN_NOT_FOUND`/`TOKEN_EXPIRED`, never deleting on expiry) -> the robot's
  loop via `activeLoopForRobot` (`LOOP_NOT_FOUND` 404) -> `isSuspended`
  (`LOOP_SUSPENDED` 403) -> ACCEPTED-membership check (`MEMBER_CAN_REQUEST`
  401) -> `deleteToken` (one-time) -> `{ result: "Command accepted" }`.

The robot-loop lookup reuses the existing Phoenix `activeLoopForRobot` (the
first non-deleted loop with `loop.robot === robotId`), the same helper
`loopSuspend` uses for `findByRobotAccountId`-style lookups; no
`model.js` change was needed. The membership test compares `accountId` strings
and accepts any member whose status lowercases to `accepted`
(`isAcceptedStatus`), matching Phoenix's case-insensitive stored statuses while
preserving the source's literal `=== ACCEPTED` semantics for the pinned store.

The face remains the explicit legacy Classic/LAN compatibility boundary: like
the other OOBE operations it does not verify the SigV4 signature; payload
validation follows the existing local 400 `ValidationException` envelope rather
than the source gateway's Hapi 422 framing (same convention as `setupRobot`).

## Evidence and commands

Worktree:
`/home/shell/work/phoenix/.parity/worktrees/ds-reconnect-20260910`, branch
`ds/candidate-a04-reconnect-20260910`.

The candidate test drives real HTTP requests (`fetch` to the service's listening
port) against the full `createAccountService` — every case is a served request,
not a unit call on the handler.

| Control | Result |
| --- | --- |
| `node --test packages/account/test/reconnectRobot.test.js` | exit 0; 10 tests passed |
| falsification: membership guard removed | 3 tests fail (MEMBER_CAN_REQUEST, invited-not-accepted, case-variant pending) |
| falsification: suspension guard removed | 1 test fails (LOOP_SUSPENDED) |
| guards restored, focused suite rerun | exit 0; 10 tests passed |
| `npm test` (unit + parity:check + parity:gate) | 1017 tests, 1010 pass, 0 fail, 7 skipped; parity gate `{"result":"match","cases":43,"differences":0}` |

Baseline before this change (same worktree): 1007 tests, 1000 pass, 0 fail,
7 skipped. The delta is exactly the 10 new `reconnectRobot` tests; nothing else
moved. (The wave brief quotes "999 pass / 8 skipped" for the baseline; the
observed baseline here is 1000/7 — same total, copied store-state variation.
Flagging rather than papering over.)

Falsification report: with the membership guard removed the three membership
cases returned success instead of 401 and failed; with the suspension guard
removed the suspended-loop case returned success instead of 403 and failed.
Both guards were restored and the suite re-passed.

## Verified / inferred / unknown split

**Verified (read the file and drove it):**
- `oobe.handler.ts`, `oobe.ctrl.ts` controller order and `COMMAND_RESULT`
  string; `member.status.ts`, `errors/{loop,account,token}.ts`
  code/message/statusCode values (via the archive MCP at the pinned ref);
- the served-handler behavior above, via the 10 HTTP tests, including one-time
  deletion and TOKEN_NOT_FOUND on replay.
- Baseline and post-change `npm test` numbers and the parity gate output above.

**Inferred (not independently verified against a running original):**
- The `CREDENTIALS_REQUIRED` gate for a missing/unknown caller: the source
  `parseCredentials` gate sits at the gateway, which is not exercised for the
  OOBE compatibility LAN path; `CREDENTIALS_REQUIRED` is the established
  Phoenix OOBE convention. A valid robot caller is always present in the
  source flow.
- The accountId comparison `m.accountId === token.accountId`: Phoenix stores
  both as strings; refs are never ObjectIds here.
- 400 `ValidationException` for a bad/absent `token` payload, matching the
  local OOBE convention rather than the source Hapi 422 envelope.

**Unknown:**
- The original gateway's exact `parseCredentials` failure envelope for a robot
  with absent/invalid credentials (the source service was not run; no live
  service, robot, or original Mongo stack was touched).
- Any behavior difference between `activeLoopForRobot` (first non-deleted loop
  by `loop.robot`) and the source `Loop.findOne({ robot })` for loops removed
  with `isDeleted` set but robot not yet cleared — not reachable through the
  current Phoenix mutation paths (`_remove` clears `robot`), and the deleted-loop
  filtering in `SetupRobot` remains open to a separate A-04 slice as the review
  noted.

`git diff --stat` (plus the new test file): `packages/account/src/robotFace.js`
(+41/-1) and `packages/account/test/reconnectRobot.test.js` (new, 10 tests).
No `model.js` change was required.