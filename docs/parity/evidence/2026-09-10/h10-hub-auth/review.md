# H-10 — hub authentication and context identity checks

Task: `H-10` (pegasus, P0) — "Match hub authentication and context identity checks".
Worktree `/home/shell/work/phoenix/.parity/worktrees/w3-h10` (branch `w3/h10`), base `39c1cd8`.
Pinned source: pegasus `5c0a7390539663ba749d360de348a428c088505c`, read from the frozen
reference tree at `.parity/reference/5c0a7390539663ba749d360de348a428c088505c`.

Scope of THIS work: the gateway/hub authentication surface and the CONTEXT identity
preprocessing/validation surface, verified at runtime. Acceptance item 4 (the *native*
signed `CreateHubToken` → `Bearer` upgrade with on-robot expiry + single 401 refetch/retry)
is a hardware/robot-lifecycle item and is **not** closed here — see UNKNOWN.

---

## 1. The contract, re-derived from pinned source

### 1a. Upgrade-time authentication — `BaseService`

`packages/utils/src/service/BaseService.ts:58-78` `checkAuthentication(headers)`:

| condition | line | result |
|---|---|---|
| no `authorization` header | 59-61 | `{ error: 'Authorization is required' }` |
| `split(' ').length !== 2` or scheme `!== 'Bearer'` (case-sensitive, exactly one space) | 63-65 | `{ error: 'Only bearer scheme is supported' }` |
| `!process.env.ETCO_server_hubTokenSecret` (empty string also falsy) | 67-69 | `{ error: 'No JWT secret set' }` |
| `jsonwebtoken.verify(token, secret)` throws | 70-77 | `{ error: e.name ? e.name + ': ' + e.message : e.message }` |
| otherwise | 71-72 | `{ auth: <payload> }` |

`BaseService.ts:170-192` `verifyClient`: when `!disableAuth` the auth check runs **first**
(`401`), and only then is `socketHandlers.has(info.req.url)` consulted (`404`). The URL is
matched exactly, so a query string is a different key. `callback(false, status, body)` makes
`ws` write the body verbatim; the robot client maps `401 → UNAUTHORIZED` and `404 →
INVALID_URL` (`packages/utils/src/socket/Socket.ts:24-34`).

Registered socket paths — `packages/hub/src/HubService.ts:58-73`: exactly
`/listen`, `/v1/listen`, `/proactive`, `/v1/proactive`.

HTTP surface — `HubService.ts:75-80` registers `/skills` and `/v1/skills` **without**
`authenticationRequired`, and `BaseService.ts:123-126` registers `/healthcheck` free of auth.
So the hub HTTP surface is unauthenticated by design.

### 1b. CONTEXT identity — `MessagePreProcessor` / `MessageValidator`

`packages/hub/src/utils/MessagePreProcessor.ts:13-17` only acts when
`data.json && data.json.type === CONTEXT`.
`:19-40`: defaults `{accountID: socket.auth.id, robotID: socket.auth.friendlyId, lang:'en',
release:'1.8.0', remoteAddress: socket.remoteAddress}`, merged under `Object.assign({}, defaults,
general)`; trims truthy `loop.users[].{firstName,lastName,phoneticName}`; then
`MessageValidator.validateGeneralData(general, socket.auth)`.

`packages/hub/src/utils/MessageValidator.ts:10-26`: missing/falsy `accountID`/`robotID`/`release`
throw; `accountID !== auth.id` and `robotID !== auth.friendlyId` throw the two mismatch errors.
`:28-36` `validateContextMessage` re-checks `accountID`/`robotID` only.

Call sites with error framing:
- `packages/hub/src/listen/ListenHandler.ts:36-44,46-71` — preprocess inside the message
  handler; a throw rejects the transaction and the catch writes
  `{type:ERROR, msgID, ts, final:true, data:{code: (e instanceof HubError) ? e.code : undefined,
  message}, timings:{total}}`.
- `packages/hub/src/proactive/ProactiveSocketRequestHandler.ts:61-66` — same preprocess, error
  via `ResponseWrapper.error`.

A plain `Error` has no `code`, so the exported frame has **no** `code` key (JSON drops
`undefined`). `disableAuth` leaves `socket.auth` unset, so a CONTEXT then throws at
`socket.auth.id` instead of inventing an anonymous identity.

---

## 2. Changes made

| file | change |
|---|---|
| `packages/gateway/test/hubAuth.differential.test.js` | **new** — replays the committed review fixtures against the live implementation and asserts deep-equality with the pinned-source goldens (1965 auth cases + 187 identity cases). Real WS upgrades for the `upgrades` section. |
| `packages/gateway/test/hubAuth.runtime.test.js` | **new** — 9 runtime tests: CONTEXT identity accept + reject over a live socket (listen and proactive), default-fill accept, empty-secret upgrade, non-HMAC algorithm rejection, disableAuth path ordering, and the unauthenticated HTTP surface. |

No production source was changed. The two differential fixtures
(`packages/gateway/test/fixtures/h10-*-differential.json`) existed but **no test consumed
them** — that was the gap: the 1965/187 differential was a one-time review run, not a
regression guard. Both fixtures plus the committed goldens are now exercised by `npm test`.

---

## 3. Runtime evidence (VERIFIED — observed)

Raw transcripts committed next to this file:
`runtime-context-probe.txt`, `runtime-upgrade-http-probe.txt`.

- `REJECT account` → `[{type:ERROR, final:true, data:{message:"data.general.accountID is not
  equal to socket accountID"}, timings:{total:3}}]` — **no `code` key**.
- `REJECT robot` → same envelope with `data.general.robotID is not equal to socket robotID`.
- `PROACTIVE bad` → same envelope on `/proactive`.
- `ACCEPT turn` → `SOS, EOS, LISTEN(final, match:null)`; no ERROR.
- `NO-SECRET upgrade` → `401 Unauthorized`, body `No JWT secret set`.
- `RS256 upgrade` → `401`, body `JsonWebTokenError: invalid algorithm`.
- `NONE-empty-sig upgrade` (secret configured) → `401`, body `JsonWebTokenError: jwt signature
  is required`.
- `HEALTHCHECK` → `200 ok`; `GET /skills/robot-A` → `200 {"skills":[...]}`;
  `GET /v1/skills/settings/robot-A` → `200` — all **without** credentials.

---

## 4. Differential evidence (VERIFIED — observed)

The committed goldens were independently reproduced from the pinned source, not trusted:

1. Ran the source probes inside the pinned `node:8.9.4-slim` image with the frozen reference
   tree mounted at `/ref`:
   - `h10-source-probe.cjs` on `docs/parity/reviews/h10-root/generated-fixtures.json`
   - `h10-identity-source-probe.cjs` on `docs/parity/reviews/h10-identity-root/fixtures.json`
2. Result **equals the committed goldens exactly** (`source.json.gz`, `source.json`), i.e.
   `.h10tmp` regeneration `== ` committed artefact for all 1965 + 187 cases. Canonical
   `json.dumps(sort_keys=True)` SHA-256:
   - auth `25df14bfafbd2b2be6d78b788977d24aed1df7606d78aa75a9056ba647da9e1e`
   - identity `4679dacb53b0f444ee4e6032c63d44b555212cc44a52cec973d4fa306c4cd6e2`

   Re-generations are stored as `source-regen-auth.json.gz` / `source-regen-identity.json.gz`.
   The source probe records `preProcessorSha256 da27c1e5…` / `validatorSha256 8b2c5a1a…`
   matching the committed golden's `source` block, so the reference tree at this revision is
   the one the golden came from.
3. Replayed the same fixtures against the current implementation and compared section by
   section: **0 differences** across 1965 auth cases (`direct` 1947, `auth` 10, `upgrades` 8)
   and 187 identity cases. This is now asserted by the committed test, so it will fail loudly
   on any future drift.

Representative pinned-source outcomes that the test pins (from the golden):
- `none-valid` (alg `none`, empty signature, secret configured) → `jwt signature is required`.
- `none-signed` (alg `none`, non-empty signature) → `invalid algorithm`.
- `array-header` (`[]`) → `invalid algorithm`; `bad-header` (`{bad`) → `invalid token`.
- `null-valid` (signed `null` payload) → `TypeError: Cannot read property 'nbf' of null`.
- `bad-payload-*` → Node 8 JSON diagnostics, e.g. `Unexpected token b in JSON at position 1`.
- `noncanonical-signature` (last base64 char changed) → `invalid signature`.
- `non-jwt-string` (header without `typ:JWT`, primitive payload) → succeeds, payload stays the
  raw string `"robot"`.
- `no-secret` auth case → `{error:'No JWT secret set'}`.

---

## 5. Falsification (performed)

Two corruptions, each anchored on a **full code line** (verified with `grep -n` before
trusting the result), each restored afterwards.

**F1 — highest-risk assertion: upgrade auth rejection.**
Broke `packages/gateway/src/index.js:45` (the bearer-scheme gate):
`  if (parts.length !== 2 || parts[0] !== 'Bearer') return { error: 'Only bearer scheme is supported' };`
→ `  if (false) return { error: 'Only bearer scheme is supported' };`
`grep -n` confirmed line 45 now reads `if (false) return …`.
Result: `hubAuth.differential.test.js` **failed** (`not ok 1`, first differing case
`auth/basic`; the wrong-scheme matrix and the `upgrades/wrong-scheme` 401 body are covered by
the same assertion). Log: `falsify-auth-differential.log`. Restored with `git checkout`; the
5-file hub-auth subset then passed 28/28.

**F2 — context identity rejection.**
Broke `packages/gateway/src/preprocessor.js:49` (the accountID cross-check):
`  if (general.accountID !== readLegacyProperty(auth, 'id')) throw new Error('data.general.accountID is not equal to socket accountID');`
→ `  if (false) throw new Error('data.general.accountID is not equal to socket accountID');`
`grep -n` confirmed line 49.
Result (differential + runtime together): **3 failed** —
`identity differential` at `case/conflicting-account`,
`listen: a CONTEXT whose accountID differs from the socket JWT is rejected`,
`proactive: a mismatched CONTEXT is rejected with the same envelope`.
The neighbouring `robotID`-mismatch test and `defaults`/accept cases still passed, which shows
the corruption was narrow and the assertions specific. Log: `falsify-identity-runtime.log`.
Restored; green.

---

## 6. Divergence candidates / observations (for root; not edited into DIVERGENCES.md)

1. **Account verification is a Phoenix ADDITION, not source behaviour.** Default is off
   (`accountUrl` unset ⇒ shared-secret-only, i.e. source behaviour). When enabled,
   `verifyAgainstAccount` (`packages/gateway/src/index.js:61-76`) adds a per-robot
   account-liveness + `friendlyId` cross-check that `BaseService` never performed. This
   *strengthens* auth; it is not a missing check. Flagged because a reviewer comparing token
   acceptance should know the extra 401 source is unreachable.
2. **CONTEXT-less "global turn" extension skips identity validation.** `_beginGlobalTurn`
   (`packages/gateway/src/listenTransaction.js:167-185`) synthesises a context when a
   `CLIENT_ASR`/`CLIENT_NLU` arrives with no preceding `LISTEN`/`CONTEXT`, using
   `anonymous-account`/`anonymous-robot` when `auth` is null, and does **not** run
   `preprocessContext`. It is a documented sim/robot-compat extension (no CONTEXT message
   exists to validate), and the socket is still authenticated, so it does not weaken the auth
   contract — but it is the one place Phoenix can proceed with a synthetic identity. Reported,
   not changed.
3. **Non-divergence checked:** the source frames `code` as
   `(error instanceof HubError) ? error.code : undefined`, Phoenix as `err.code`
   (`listenTransaction.js:445-449` + `index.js:153-156`). Within the gateway listen/proactive
   path the only errors carrying a `.code` are `HubError` instances (no `.code` is assigned
   anywhere else under `packages/gateway/src`; ASR failures are wrapped at
   `listenTransaction.js:246`), so the two forms are observationally identical here. INFERRED,
   not a divergence on this surface.

---

## 7. Claim ledger

**VERIFIED (observed)**
- The 4 registry socket paths accept, everything else 404s; query strings 404 (differential
  `upgrades/*`, runtime tests).
- Missing / non-Bearer / lowercase / double-space / malformed / bad-signature / expired /
  not-yet-active / `none` / wrong-algorithm credentials are each rejected at the upgrade with
  the exact status, reason, headers and body the pinned source produced (1965-case differential;
  runtime probes).
- Empty configured secret ⇒ `401 No JWT secret set`; 401 is returned before the 404 path check.
- CONTEXT accountID and robotID mismatch are rejected over a live socket on both `/listen` and
  `/proactive`, with `data:{message}` and no `code`; matching CONTEXT is accepted and the turn
  completes; missing `general` is filled from the JWT.
- The hub HTTP `/healthcheck` and `/skills|/v1/skills` routes are reachable without credentials.
- The committed goldens reproduce exactly from the pinned source (SHA-256 above).

**INFERRED (reasoned from source)**
- `code`-field gating (`instanceof HubError` vs `err.code`) is observationally equivalent on
  this surface (§6.3).
- The account-verify extension is off by default and therefore source-compatible out of the box
  (`config.js:68`, and the differential runs with `accountUrl:''`).

**UNKNOWN**
- Acceptance item 4: the *native* robot sequence — real signed `Account_20151111.CreateHubToken`
  → `Bearer` upgrade → token expiry → the native single 401 refetch/retry — is not exercised
  here. It needs the robot/hardware path.
- Persistent authenticated deployment, microphone/wake-word/physical-ring acceptance: not
  touched.
- Parent's cross-check: whether `H-10` as a whole can be flipped to verified (this slice is a
  code-level contract, not the hardware lifecycle).

---

## 8. Test run

Command: `npm test` (worktree `w3-h10`, one run, no concurrent suite).

```
# tests 1206
# suites 7
# pass 1199
# fail 0
# cancelled 0
# skipped 7
# todo 0
```

`npm test` exit 0. `parity:check`: `Checklist: 16/79 verified (20.3%)`, structure valid.
My two new files contribute 11 tests (2 differential + 9 runtime); all pass, including under
`node --test --test-concurrency=1 packages/gateway/test/*.test.js` (112/112).

Parity gate JSON:

```json
{"result": "match", "cases": 43, "differences": 0, "invariants": 0, "coverageGaps": 0}
```

The 7 skips are the reference-path artifact (7 in worktrees vs 8 on main).
