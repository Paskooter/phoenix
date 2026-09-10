# A-16 — ROM certificate exchange and remote operation

**Verified 2026-09-10.** Reference (pinned):
`jiborobot/srv-jibo-server-client@155d20a8102960b2aeb89c197bdf04dc1f1fc344/apis/rom-2017-10-11.normal.json`.
Behaviour source (read from the Jibo archive for this task):
`jiborobot/srv-rom-ws` — `src/controllers/rom.ctrl.ts`, `src/handlers/rom.handler.ts`,
`src/schemes/certificate.ts`, `src/errors/rom.ts`, `src/clients/{account,robot}.client.ts`,
`test/rom.ctrl.spec.ts`.

Implemented in `packages/classic/src/rom.js` (the `rom` entry in `src/stubs.js` was three
functions returning empty strings). 19 tests in `packages/classic/test/rom.test.js`.

---

## What the contract actually is

`ROM_20171011` is **Jibo ROM (Remote Operation Mode)** and it is *only* the certificate
exchange. There is no robot-control traffic here: the ROM control session is a WebSocket the
robot itself serves on LAN port 8160, and the operators (`rom-commander`, `rom-bot`,
`rom-sdk-android`) talk to that directly. The cloud's whole job is to hand out the matched
mutual-TLS pair and the robot's address.

| op | caller | input | output shape |
|---|---|---|---|
| `Create` | loop owner | `{friendlyId, aco?}` (`friendlyId` required) | `{created}` (ms timestamp) |
| `SetupServer` | robot | `Payload` `{ipAddress, ipAddresses?}` | `{cert, public, private, fingerprint, created}` |
| `SetupClient` | loop owner | `{friendlyId}` | `{cert, public, private, p12?, fingerprint, payload, created}` |

The exchanged objects (from `rom.ctrl.ts`):

- `Create` deletes any previous `Certificate` for the friendlyId (`findByIdAndRemove`) and
  mints a **fresh pair every call** — `selfsigned.generate([{commonName:'jibo.com'}],
  {algorithm:'sha256', clientCertificate:true, days:1})`. The server cert is a self-signed
  RSA-1024 cert valid **1 day**; the client cert is a separate RSA-1024 key signed by the
  server key, packaged as a PKCS#12 blob (empty passphrase, 3DES). It then emits
  `RomConnectionRequested{aco, certFingerprint: client.fingerprint, friendlyId}`.
- `SetupServer` (robot) records `payload.ipAddress` / `payload.ipAddresses`, sets
  `complete = true`, and returns the **server** bundle plus the **client** fingerprint
  (`ClientFingerprint`) for the robot to pin.
- `SetupClient` (owner) only answers once `complete` is set, and returns the **client**
  bundle (`p12` included) plus the robot `payload`, with the **server** fingerprint
  (`ServerFingerprint`) for the operator to pin.

Guards (`rom.ctrl.ts` + `rom.handler.ts`), reproduced verbatim in `ROM_ERRORS`:

- ownership — a `Loop_2016.ListLoops` where `robotFriendlyId === friendlyId && owner === ownerId`, else `ROBOT_NOT_OWNED` **403**
- master switch — `Robot_20160225.GetRobot`; missing robot → `ROBOT_NOT_FOUND` **404**; `!payload.remoteEnabled` → `REMOTE_MODE_DISABLED` **403**
- `SetupServer` with no robot identity → `ROBOT_MUST_CALL` **403**
- no stored certificate → `CERTIFICATE_NOT_FOUND` **404**; pair exists but not deployed → `CERTIFICATE_NOT_DEPLOYED` **404**
- Joi payloads: `Create`/`SetupClient` require a non-empty string `friendlyId`; `SetupServer` requires `ipAddress` and an array `ipAddresses` → `ValidationException` **400**

## Criterion 1 — Create / SetupClient / SetupServer with validation, ownership, cert lifecycle

`packages/classic/test/rom.test.js` covers the archived spec test (`test/rom.ctrl.spec.ts`)
one-for-one — create / always-create-new / setup-before-deploy / setupServer / setupClient /
master-switch-off — plus ownership, missing robot, missing certificate, the `ROBOT_MUST_CALL`
boundary, "a second create resets the deployed state", and the error catalog. Certificate
lifecycle/expiry is asserted from the material itself: the server certificate is valid
`CERTIFICATE_LIFETIME_DAYS` (1) day, and the SDK-shaped `created` is epoch **milliseconds**.

## Criterion 2 — usable remote-operation sessions with the original client

Driven through the **original generated client** — the pinned `@jibo/jibo-server-client`
(v3.0.117) aws-sdk fork, `clients/rom.js` built from `apis/rom-2017-10-11.min.json`
(`docs/parity/evidence/2026-09-10/a16-rom-certificates/real-client.txt`):

| step | result through the real SDK |
|---|---|
| `ROM.create` | `{created}` parsed from CreateResponse |
| `ROM.setupServer` | ServerResponse — `cert/public/private/fingerprint/created`, **no p12** |
| `ROM.setupClient` | ClientResponse — `p12` present, `payload.ipAddresses[0].netmask` intact |
| `ROM.setupServer`, no robot credentials | typed `ROBOT_MUST_CALL`, **403** |
| `ROM.create`, not the owner | typed `ROBOT_NOT_OWNED`, **403** |
| `ROM.setupClient({})` | client-side `MissingRequiredParameter` (rejected pre-wire) |

**All three operations are SERVED.** Over a live entrypoint (`runtime.txt`) each returns the
source status and envelope, e.g. `ROM_20171011.Create -> 200`, and the failure cases carry
`x-amzn-errortype` + `__type` with the source status.

The ROM **control session itself** (robot port 8160, mDNS discovery, command/event protocol)
is **not** exercised: it runs on dead robot hardware. That half of the criterion is recorded
as unreproducible, not simulated.

## Certificate material — real, not faked

The material is generated by the *same libraries the original used* (`selfsigned`
`^1.10.3` + `node-forge` `^0.7.5`, matching `srv-rom-ws/package.json`). `rom.test.js` decodes
it back with node-forge and asserts: server CN/issuer `jibo.com`, ~1-day validity, the SHA-1
colon-hex fingerprints (20 bytes) recompute from the DER, the client certificate verifies
against the server key, and the PKCS#12 blob decodes with the empty passphrase. No key
material is invented and no trust chain is claimed — see the divergences.

## Falsification

Highest-risk assertion: **`SetupServer` returns the *client* fingerprint and `SetupClient`
returns the *server* fingerprint** (the mutual-pin mapping across two pinned files). Broke the
full line in `rom.js` (`SetupServer`'s `fingerprint: certificate.client.fingerprint,` →
`certificate.server.fingerprint,`), ran `node --test packages/classic/test/rom.test.js`:
**test 5 "setupServer returns the server bundle … and records the payload" FAILED** (18 pass /
1 fail); restored the line, re-ran: **19 pass / 0 fail**. The corruption was a full code line,
not a substring, and no comment in the file quotes it.

## Divergences and unknowns

- **A16a** — `remoteEnabled` is not modelled anywhere in Phoenix (`grep -r remoteEnabled`
  finds only `rom.js`). The master switch reads `Robot_20160225.GetRobot → payload.remoteEnabled`
  faithfully, but nothing sets that flag, so on a real Phoenix stack `Create` returns
  `REMOTE_MODE_DISABLED` **403** until a robot-settings/`UpdateRobot` payload path exists.
  The `rom` clients are injectable (`createClassicEntrypoint({ rom: {...} })`) so the seam is
  testable; the data model is the gap.
- **A16b** — the ROM→account ownership call uses the original internal contract
  (`x-amz-target: Loop_2016.ListLoops` + `x-amz-credentials`). Phoenix's account Loop face
  currently requires a **SigV4** signature, so the credentials-only internal call from this
  in-process service is not verified end-to-end against the live account process.
- **A16c** — the SNS `RomConnectionRequested` delivery (topic `jibo-events-legacy`) is dead;
  the side effect is exposed as an injectable `onConnectionRequested` hook, default no-op.
- **A16d** — identity comes from `x-amz-credentials` (the original `parseCredentials`
  contract); Phoenix has no gateway to populate it, so the handler falls back to the SigV4
  `accessKeyId` as `{id}`. This is a Phoenix adaptation, not source behaviour.
- **UNKNOWN** — the robot's actual operator client (`rom-commander`/`rom-sdk-android`) and the
  8160 session were not run; the "expiration / reconnect" half of ROM is unverified.

## Runtime probe

`probe.mjs` / `runtime.txt` (Phoenix classic, `ROM_20171011.*`) and
`real-client-probe.cjs` / `real-client.txt` (original `@jibo/jibo-server-client` ROM client).
Private key and P12 bodies are redacted to lengths in the recorded output.
