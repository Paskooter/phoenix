# A-05 — OOBE reconnect, service tokens and administrative behavior (criteria 1 & 2)

Wave 13 / branch `w13/a05`, base `11e0d9e`. Runtime evidence captured 2026-09-11T03:13Z by
`runtime-probe.mjs` in this directory (output: `probe.json`); unit evidence in
`packages/account/test/{oobeTargetContract,oobeRestartSIGKILL,oobeQrFraming}.test.js`.

## Contract sources (Jibo archive MCP, read 2026-09-11)

| Source | What it pins |
|---|---|
| `gitea_read_file jiborobot/srv-jibo-server-client apis/oobe-2016-10-26.normal.json` | `metadata.targetPrefix = "OOBE_20161026"`, `protocol: "json"`, `jsonVersion: "1.1"`; operations `PrepareRobot` (`PrepareRobotRequest {loopId?}` → `TokenContainer`), `GetStatus` (`TokenContainer` → `StatusContainer {complete}`), `SetupRobot` (`SetupRobotRequest {token,id} required` → `RobotCredentials {accessKeyId,secretAccessKey,serviceMode?}`), `ReconnectRobot` (`ReconnectRobotRequest {token required, id?}` → `CommandResponse {result}`) |
| `gitea_read_file jiborobot/srv-jibo-server-client apis/oobeadmin-2016-10-26.normal.json` | same `targetPrefix "OOBE_20161026"`; `GetServiceToken` (no input) → `TokenContainer {token required, expires long}` |
| `gitea_read_file jiborobot/srv-account-ws src/handlers/oobe.handler.ts@master` | `mapping = {getServiceToken,getStatus,prepareRobot,reconnectRobot,setupRobot}`; `@parseCredentials({})` + `@validatePayload` on the four normal ops; `GetServiceToken` is `@parseCredentials({ adminOnly: true })` with **no** `@validatePayload` |
| `gitea_read_file jiborobot/srv-account-ws src/controllers/token.ctrl.ts@master` | `create()` reuses a live token for the same `(accountId, loopId)` and returns `{token, expires}`; `findById` → `TOKEN_NOT_FOUND` / `TOKEN_EXPIRED` (no delete on expiry); `deleteToken` deletes |
| `gitea_read_file skills/oobe-config src/behaviors/oobe/config.bt` | QR frame `"<codeId>/<totalCodes>\n<chunk>"`, chunk stored at `codeId-1`, concatenated in order, XOR key `Wow, you cracked our secret code. Impressive. Maybe you should check out jibo.com/jobs.`, `barcodeData.pop()` = token, positional `_ssid,_password,_staticIP,_netmask,_gateway,_dns1,_dns2` |
| `docs/parity/evidence/2026-09-10/a02-auth-boundary/gateway-allow-lists.json` | `unauthorizedMethods = ["OOBE_20161026.GetStatus","OOBE_20161026.SetupRobot"]` — only these two accept an absent Authorization |

**Prefix question closed.** `OOBE-PORTAL-HANDOFF.md` §10 and the old `robotFace.js` header both
said the OOBE prefix "isn't in the archived API defs". It now is: both OOBE API models declare
`targetPrefix = OOBE_20161026`, and the admin model shares it (only `endpointPrefix` differs,
`oobe` vs `oobeadmin`, which never appears in `X-Amz-Target`). The stale header comment was
corrected in `packages/account/src/robotFace.js`.

## Criterion 1 — every normal/admin target, and the setup/expired/used-token/reconnect/replacement/suspended flows

VERIFIED (runtime, `probe.json.targets`):

| Target | Observed |
|---|---|
| `OOBE_20161026.PrepareRobot` | 200 `{token,expires}` |
| `OOBE_20161026.GetStatus` (live token) | 200 `{complete:false}` |
| `OOBE_20161026.SetupRobot` (redeem) | 200 `{accessKeyId,secretAccessKey}` |
| `OOBE_20161026.GetStatus` (after redeem) | 200 `{complete:true}` |
| `OOBE_20161026.ReconnectRobot` | 200 `{result:"Command accepted"}` |
| `OOBE_20161026.ReconnectRobot` (unknown token) | 404 `TOKEN_NOT_FOUND` |
| `OOBE_20161026.SetupRobot` (used-token replay) | 404 `TOKEN_NOT_FOUND` |
| `OOBE_20161026.GetServiceToken` (non-admin) | 401 `AUTHORIZED_UNDER_ADMIN` |
| `OOBE_20161026.GetServiceToken` (admin) | 200 `{token,expires}` |
| `OOBE_20161026.Frobnicate` (unknown op) | 400 `UnknownOperationException` |
| `OOBE.PrepareRobot` (bare prefix used by `scripts/portal-smoke.mjs`) | 200 `{token,expires}` |

All five archived operations reach a real handler; none is an unknown target. The operation table
is `packages/account/src/robotFace.js:112-116` (dispatch at `:232-247`); the handlers are
`setupRobot` `:284`, `prepareRobot` `:386`, `getStatus` `:398`, `getServiceToken` `:428`,
`reconnectRobot` `:457`.

Expired-token, suspended-loop, robot-replacement and soft-deleted gates were already pinned by
`oobeSetupRevival.test.js` (replacement `:88`, detach `:145`, LOOP_MUST_BE_SUSPENDED `:175`,
same-robot re-issue `:193`, deleted-loop `:206`, deleted-account `:225`, ROBOT_DISABLED `:298`,
full sequence `:364`) and `reconnectRobot.test.js` (happy/one-time `:47`, unknown `:65`,
expired `:77`, no-loop `:90`, suspended `:104`, non-member `:119`). Those remain green; this wave
adds the missing *target-matrix* certification — that the archived operation NAMES themselves
dispatch, not only that the handlers behave.

## Criterion 2 — SDK request/response + QR framing vs the original consumers

VERIFIED (runtime + `oobeTargetContract.test.js`):

- **Envelope.** Every success is `200` with `Content-Type: application/x-amz-json-1.1`
  (`packages/account/src/loopHttp.js:4,6`); every controller failure is `{__type, message}` with
  the matching `x-amzn-errortype` header and the source status code
  (`loopHttp.js:17`; `robotFace.js:54-89` error table). `@validatePayload` refusals keep Hapi's
  422 `{statusCode,error,message}` **without** `x-amzn-errortype` (`loopHttp.js:29`).
- **Shapes.** Output keys match the archived models exactly: `TokenContainer` = `{token,expires}`
  (`prepareRobot` `:391-392`, `getServiceToken` `:441-442`), `StatusContainer` = `{complete}`
  (`getStatus` `:400`), `RobotCredentials` = `{accessKeyId,secretAccessKey}` (20/40 alnum,
  `serviceMode` present only for a `service-mode-owner-*` account, `setupRobot` `:374-380`),
  `CommandResponse` = `{result:"Command accepted"}` (`reconnectRobot` `:479`).
- **Admin behavior.** `GetServiceToken` mints a fresh `service-mode-owner-<uuid>@jibo.com`
  account and a `loopId:null` token each call, and returns the `TokenContainer` (not the raw token
  document) — the A-05 gap that this wave keeps closed (`robotFace.js:426-443`;
  `getServiceToken.test.js:59-202`).
- **Token semantics.** `prepareRobot`/`getServiceToken` body is ignored (no `@validatePayload`),
  one-time consumption on `setupRobot`/`reconnectRobot`, expiry reports without deleting
  (`model.js:362-396`, matching `token.ctrl.ts@master`).
- **QR framing.** Frame regex, 1-based `codeId`, first-newline header split, XOR key, token-last
  ordering, and the static-field order `ip,netmask,gateway,dns1,dns2` are pinned against
  `config.bt` in `oobeQrFraming.test.js`. `qrPayload.js:7,12-18,21-32,38-48,54-65`.
- **Credential preservation across a SIGKILL restart.** VERIFIED: a real child process provisioned
  a loop + robot, was SIGKILLed mid-write (exit `signal:"SIGKILL"`, `code:null`), and the reopened
  store still carried the exact `accessKeyId`/`secretAccessKey`, with the loop pointing at the
  robot and the access key resolving post-crash (`probe.json.persistence.preserved` all `true`;
  `oobeRestartSIGKILL.test.js`). The durable file is written with an atomic tmp+rename
  (`store.js:37-58`), so no orderly shutdown hook is required.

## INFERRED

- The deployed robot's installed `@jibo/jibo-server-client` sends the archived `targetPrefix`
  `OOBE_20161026`; the archive mirror's API model is the same package the robot shipped. Not
  observed against a physical robot in this wave (criterion 3).
- The master-branch `reconnectRobot` body is what production ran; the project's pinned A-04
  snapshot (`6cea434`) has the earlier trivial body (see divergence below).

## UNKNOWN / not closed in this wave

- Criterion 3 hardware/firmware evidence — see `criterion3-handoff.md`.
- Whether the auth gateway in front of the OOBE face enforced a *verified* identity for
  `PrepareRobot` / `ReconnectRobot` / `GetServiceToken` on the real deployment (divergence below).

## Divergence candidates (not fixed here; reported, not silently changed)

1. **`reconnectRobot` body follows the master/default branch, not the pinned `6cea434`.**
   `srv-account-ws@6cea434 src/controllers/oobe.ctrl.ts` (snapshot:
   `.parity/reviews/a04-oobe-unbound-review-20260908/oobe.ctrl.ts`, sha256
   `705ce9256771c7de199c94836a3549d2d8fe838ccc40d1dabda24bd922a9cbe9`):
   ```ts
   public async reconnectRobot({ token }) {
     log.info("Received reconnectRobot payload", { token });
     await this.tokenCtrl.deleteToken(token);
     return COMMAND_RESULT;
   }
   ```
   The master branch adds the loop/suspension/membership checks that phoenix implements
   (`robotFace.js:457-480`). Under the pinned reference, a reconnect with no loop, a suspended
   loop, or a non-member token would succeed; phoenix refuses them (404/403/401). Eight existing
   tests assert the master behavior. The test header citation was corrected to say so explicitly.
2. **OOBE auth is LAN trust for `PrepareRobot` / `ReconnectRobot` / `GetServiceToken`.**
   The source gateway requires a verified identity for these three (only `GetStatus` and
   `SetupRobot` are in `unauthorizedMethods`). Phoenix parses the access key out of the
   `Authorization` header without verifying the SigV4 signature (`robotFace.js:704-707`
   `accountForClassicRequest`). Documented as a deliberate compatibility split; not changed because
   the gateway boundary is owned by A-01/A-02/A-03 and tightening it would change live robot
   behavior outside A-05's acceptance criteria.
3. **QR `dns1`/`dns2` defaulting lives in the robot, not the encoder.** `config.bt` substitutes
   `8.8.8.8`/`8.8.4.4` for falsy `dns1`/`dns2`; `buildPlaintext` emits empty strings
   (`qrPayload.js:24-25`). Pinned by `oobeQrFraming.test.js` so the empty-string wire form is
   intentional. No phoenix change: inventing values would diverge from the portal user's input.
