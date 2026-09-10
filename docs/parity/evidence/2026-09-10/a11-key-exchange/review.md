# A-11 — key exchange, backup and binary-key operations

**Task:** A-11 (P0, classic, implementation: partial before this work).
**Worktree:** `/home/shell/work/phoenix/.parity/worktrees/w3-a11` (branch `w3/a11`).
**Date:** 2026-09-10.

## 0. Pinned source (authoritative — the source wins over any candidate report)

Read through the Jibo archive MCP (`gitea_read_file`, `gitea_browse`); SHAs resolved from
`GET /gitea/api/v1/repos/<repo>/branches/<default>` at read time.

| artifact | revision |
|---|---|
| `jiborobot/srv-key-ws` (service implementation) | `c69f09845118d129d25d21392a1207e6480da6a3` (master) |
| `jiborobot/srv-jibo-server-client` (generated client + `apis/key-2016-02-01.normal.json`) | `155d20a8102960b2aeb89c197bdf04dc1f1fc344` (master) |

Files read: `src/controllers/key.ctrl.ts`, `src/handlers/key.handler.ts`, `src/errors/key.ts`,
`src/routes/binary.route.ts`, `src/clients/account.client.ts`, `src/schemes/{key,backup,binary}.ts`,
`src/index.ts`, `config/config.json`, `index.js`, `package.json`,
`test/{key.handler,key.ctrl,binary.share}.spec.ts`, `lib/protocol/json.js`
(client error/data protocol), and `apis/key-2016-02-01.normal.json`.

The A-11 `reference` field names only the SDK model. The **implementation** lives in
`srv-key-ws`, which the finding's "controller comparison" requires — where the two disagree the
implementation is the behaviour and the model is the wire shape. Both are used below.

There was **no pre-existing A-11 candidate report** in `docs/parity/candidates/`; the row's
`finding` ("The nine operation names are present but state is ephemeral; binary and ownership
semantics need controller comparison") was the only prior claim, and it was checked directly.

---

## 1. Full surface enumerated from pinned source

Nine AWS-JSON operations (`src/handlers/key.handler.ts:13-21` mapping, targetPrefix
`Key_20160201` at `apis/key-2016-02-01.normal.json:8`) **plus** two plain Hapi routes
(`src/routes/binary.route.ts`).

| # | operation | handler validation | success output shape | pinned error codes (status) |
|---|---|---|---|---|
| 1 | `CreateRequest` | `loopId`, `publicKey` required (`key.handler.ts:49-56`) | `Request` | 403 `KEY_NOT_PART_OF_LOOP` |
| 2 | `GetRequest` | `id` required (`:60-64`) | `Request` | 404 `KEY_NOT_FOUND`; 403 `KEY_NOT_PART_OF_LOOP` |
| 3 | `Share` | `encryptedKey`, `id` required, `keyHash` optional (`:23-30`) | `Request` | 404 `KEY_NOT_FOUND`; 409 `KEY_HASH_DOESNT_MATCH`; 403 `KEY_NOT_PART_OF_LOOP` |
| 4 | `ListIncomingRequests` | `loopId` required (`:74-79`) | `Requests` | 403 `KEY_NOT_PART_OF_LOOP` |
| 5 | `ShouldCreate` | `loopId` required (`:81-86`) | `ShouldCreateResponse` | 403 `KEY_NOT_PART_OF_LOOP` |
| 6 | `Backup` | `loopId`, `encryptedKey` required, `passwordHash` optional (`:89-96`) | `Backup` | 403 `ONLY_OWNER_CAN_BACKUP_RESTORE` |
| 7 | `Restore` | `loopId` required, `passwordHash` optional (`:99-104`) | `Backup` | 403 `ONLY_OWNER_OR_ROBOT_CAN_RESTORE`; 404 `BACKUP_NOT_FOUND`; 409 `BACKUP_PASSWORD_WRONG` |
| 8 | `ListBinaryRequests` | `loopId` required (`:107-112`) | `BinaryRequests` | 403 `KEY_NOT_PART_OF_LOOP` |
| 9 | `ShareBinary` | header `x-id` required (`:124-127`), payload **is** the binary stream (`:129-134`) | `BinaryRequest` | 404 `BINARY_NOT_FOUND`; 403 `BINARY_NOT_PART_OF_LOOP` |
| R1 | `POST /binaryRequest` | `accountId`, `encryptedUrl`, `loopId` required (`binary.route.ts:11-15`) | `BinaryRequest` JSON | Boom 403 `KEY_NOT_PART_OF_LOOP` |
| R2 | `POST /deleteBinaries` | `encryptedUrls` string array required (`:38-42`) | `{result:"Command accepted"}` | — |

Error catalogue, exact (`src/errors/key.ts`, one constant per line):
`KEY_NOT_FOUND`→404 (:3), `KEY_NOT_PART_OF_LOOP`→403 (:8), `ONLY_OWNER_CAN_BACKUP_RESTORE`→403
(:13), `ONLY_OWNER_OR_ROBOT_CAN_RESTORE`→403 (:18), `BACKUP_NOT_FOUND`→404 (:23),
`BACKUP_PASSWORD_WRONG`→409 (:28), `BINARY_NOT_FOUND`→404 (:33), `BINARY_NOT_PART_OF_LOOP`→403
(:38), `KEY_HASH_DOESNT_MATCH`→409 (:43).

Semantics taken from the controller:

* `CreateRequest` (`key.ctrl.ts:124`) — `getSiblingIds({loopId, accountId})` first (403 if the
  caller is not in the loop, `:105-123`), then `findOne({accountId, loopId, publicKey})`; the
  same triple **reuses** one document. It also fires `KeyNeeded` to siblings and arms a
  `KeyTimeout` after `config/config.json:12 keyShareTimeout` = 60000 ms.
* `GetRequest` (`:169`) — the owner reads directly; anybody else must be a loop sibling.
* `Share` (`:44`) — 404 when the request is gone; `checkShaingSameKey` (`:72`) refuses a
  `keyHash` that differs from any other key document already carrying one in that loop; the
  sharer must be a **sibling** of the requesting account (`getSiblingIds`, `:105`).
* `ListIncomingRequests` (`:187`) — `Key.find({accountId: {$in: siblings}, created: {$gt: now-7d},
  encryptedKey: {$exists: false}, loopId})`. Unsatisfied requests **created by other members**,
  7-day window.
* `ShouldCreate` (`:211`) — `ListLoops`; `< 1` loop → 403; then `shouldCreate` is false iff any
  key document in the loop carries `encryptedKey`.
* `Backup` (`:232`) — `checkOwnership` (`:197`): `loops.length !== 1 || loop.owner !== caller`
  → 403. The document is keyed by **loopId alone** (`schemes/backup.ts:9` `index:{unique:true}`),
  an existing one is updated in place; `passwordHash` is stored **on** the document.
* `Restore` (`:254`) — `checkOwnerOrRobot` (`:204`); 404 when absent; **only a supplied**
  `passwordHash` is compared, a mismatch is 409.
* `ListBinaryRequests` (`:368`) — `getMemberIds` (note: throws `KEY_NOT_PART_OF_LOOP`, not
  `BINARY_NOT_PART_OF_LOOP`), then undecrypted binaries of members, 7-day window.
* `ShareBinary` (`:324`) — `id` from the `x-id` **header**; 404 `BINARY_NOT_FOUND`; the sharer
  must be in the requesting account's loop (403 `BINARY_NOT_PART_OF_LOOP`); uploads the stream
  and sets `decryptedUrl`.

Auth (two layers, both checked): `Key_20160201.*` appears in **none** of
`srv-security-gw src/controllers/auth.ctrl.ts` `unauthorizedMethods` / `unsignedMethods` /
`unactiveMethods` — so all nine require a verified SigV4 signature (gateway layer), while every
handler only carries `@parseCredentials({})` / `@validateHeaders` (parsing layer).

### Observable-field note (avoids the "undeclared field" trap)

The generated client parses through the declared output shapes
(`apis/key-2016-02-01.normal.json`). Declared members only:

* `Request` = `id, accountId, loopId, publicKey, encryptedKey?` (no `created`, no `keyHash`)
* `Backup` = `loopId, accountId, encryptedKey`
* `BinaryRequest` = `id, accountId, loopId, encryptedUrl, decryptedUrl?`

`created`, `keyHash` and `passwordHash` are persisted by the source (they exist on the Mongo
schemas) but are **not** in any output shape, so no real client can observe them. They are
therefore **not** reported as defects and the implementation keeps them internal only.

---

## 2. What the pre-change Phoenix did (re-derived, not trusted)

`packages/classic/src/key.js` before this task: an in-memory `KeyStore` (three `Map`s), no
persistence, no membership/ownership checks, no validation, and three error codes that
**contradict the pinned catalogue**:

* `GetRequest`/`Share` not-found → `KEY_REQUEST_NOT_FOUND` (pinned: `KEY_NOT_FOUND`);
* `Restore` not-found → `KEY_BACKUP_NOT_FOUND` (pinned: `BACKUP_NOT_FOUND`);
* wrong `passwordHash` on `Restore` → 404 (pinned: 409 `BACKUP_PASSWORD_WRONG`);
* `Backup` keyed by `` `${loopId}:${passwordHash}` `` (pinned: loopId alone, unique);
* `ListIncomingRequests` returned the caller's own request and had no 7-day window;
* `ShareBinary` read `id` from the **JSON body** (pinned: `x-id` header + raw payload) and
  returned hard-coded empty strings;
* `ListBinaryRequests` always returned `[]`; no `POST /binaryRequest`, no `POST /deleteBinaries`;
* the two pre-existing tests (`packages/classic/test/keyPush.test.js`) asserted the wrong codes,
  i.e. they encoded the defect.

The row's finding "state is ephemeral" is **VERIFIED** for the pre-change tree. The source kept
Key/Backup/Binary in MongoDB (`connectMongo`, `src/index.ts:27`), so its state outlived the
process; the Phoenix store did not.

---

## 3. Changes made

`packages/classic/src/key.js` — rebuilt against the pinned controller:

1. **Durable store.** `KeyStore` is now file-backed (one atomically-renamed JSON file,
   `ETCO_classic_keyFile`, default `$TMPDIR/phoenix-key.json`) with `keys` / `backups` /
   `binaries` collections, loaded on construction — the local counterpart of the three Mongo
   collections. Mutations roll back the in-memory maps if the flush fails.
2. **Exact error catalogue.** `KEY_ERRORS` is the pinned `errors/key.ts` verbatim (codes,
   messages and statuses). Envelope unchanged from the A-02 house style
   (`{__type, message}` + `x-amzn-errortype`), which the pinned client resolves identically
   (`lib/protocol/json.js:62-71` reads `x-amzn-errortype` then `__type || code || error`).
3. **`Backup` is one document per loop.** Upsert by `loopId`; `passwordHash` stored on the
   document; `Restore` compares **only a supplied** hash → 409 `BACKUP_PASSWORD_WRONG`.
4. **Ownership / membership seam.** `makeKeyHandler(store, { membership })` and a default
   `accountMembership()` that calls the internal Account peer routes `GET /loopMembers` and
   `GET /loop` with a 3 s timeout. An **unresolvable** lookup keeps the documented LAN-trust
   path (same policy as the Backup service), so a down Account service cannot fail a legitimate
   robot call. `shouldCreate`/`Backup`/`Restore` use `loop.owner`/`loop.robot`; the loop-scoped
   read/write ops use the member list.
5. **`ListIncomingRequests`** — siblings only (excludes the caller) and the source 7-day window;
   same window for `ListBinaryRequests`.
6. **Binary flow.** `POST /binaryRequest` (pinned `binary.route.ts`) creates a `Binary` document;
   `ListBinaryRequests` lists it (undecrypted, 7-day window, members only); `ShareBinary` takes
   the id from the **`x-id` header**, consumes the **raw request body** as the decrypted stream
   and returns a `decryptedUrl`; `GET /key/binary` serves the stored bytes back;
   `POST /deleteBinaries` removes documents and their bytes.
7. **Validation** for every declared `required` member, surfaced as the source
   `validatePayload`/`validateHeaders` refusal (Boom.badData 422
   `{statusCode, error:"Unprocessable Entity", message}`) — see INFERRED #2.
8. **Output views** emit exactly the declared shape members; `encryptedKey` is omitted while a
   request is unsatisfied (the source never writes the field before `Share`).

`packages/classic/src/router.js` — `dispatch.rawBody` now also matches
`Key_*\.ShareBinary`, so a blob payload reaches the handler unparsed (the pinned client sets no
JSON content-type for a non-structure payload, `lib/protocol/json.js:36-45`).

`packages/classic/src/index.js` — the entrypoint builds one `KeyStore`, injects
`keyStore` / `keyMembership` / `keyBinaryDir`, and registers `keyRoutes`.

`packages/account/src/keyPeerRoutes.js` (new) + one registration line in
`packages/account/src/index.js` — the internal `GET /loopMembers?loopId=` peer route, the
counterpart of the source `AccountClient.listMembers` (`srv-key-ws src/clients/account.client.ts`),
next to the existing `GET /loop` seam.

Tests: `packages/classic/test/keyExchange.test.js` (new, 13 tests);
`packages/classic/test/keyPush.test.js` corrected (the old codes encoded the defect).

---

## 4. Runtime evidence — every operation SERVED

Started the real entrypoint and sent real HTTP requests (test 1 asserts this for all nine; the
other tests exercise each op in a realistic sequence). Observed on the wire:

| operation | request | observed |
|---|---|---|
| `CreateRequest` | `{loopId, publicKey}` + SigV4 identity | 200 `{id:24hex, accountId, loopId, publicKey}` |
| `GetRequest` | `{id}` | 200 `{..., encryptedKey}` |
| `Share` | `{id, encryptedKey, keyHash}` | 200 `{..., encryptedKey, keyHash?}` |
| `ListIncomingRequests` | `{loopId}` | 200 `[Request]` (siblings only) |
| `ShouldCreate` | `{loopId}` | 200 `{shouldCreate}` |
| `Backup` | `{loopId, encryptedKey, passwordHash?}` | 200 `{loopId, accountId, encryptedKey}` |
| `Restore` | `{loopId, passwordHash?}` | 200 `{loopId, accountId, encryptedKey}` |
| `ListBinaryRequests` | `{loopId}` | 200 `[BinaryRequest]` |
| `ShareBinary` | `x-id` header + binary body | 200 `{id, accountId, loopId, encryptedUrl, decryptedUrl}` |
| `POST /binaryRequest` | `{accountId, encryptedUrl, loopId}` | 200 `BinaryRequest` |
| `POST /deleteBinaries` | `{encryptedUrls:[…]}` | 200 `{result:"Command accepted"}` |

**VERIFIED** — nine of nine ops dispatched in-process (not 404, not 400) and each behaviour
observed from a real response body; the earlier static-scan trap (1 of 23 served) does not apply
here because dispatch was confirmed by request.

### Encrypted key sharing round trip (test-owned key material)

`packages/classic/test/keyExchange.test.js` "real RSA/AES round trip": the test generates a
2048-bit RSA pair, sends the **public** PEM through `CreateRequest`, encrypts a random 32-byte
symmetric key with `RSA_PKCS1_OAEP_PADDING` to that public key, `Share`s the base64 ciphertext
with `keyHash = sha1(aes)`, `GetRequest`s it back and decrypts with the private key.
Observed: `decrypted` deep-equals the original AES key, and `shouldCreate` flips
`true → false`. **VERIFIED** (consumer encryption/decryption round trip through the service).

### Durability — proven by an actual restart

Test "durable: requests, backups and binaries survive a SIGKILL restart" starts the real
entrypoint as a child process, writes a key request + a `Share` + a `Backup` + a
`POST /binaryRequest` + a `ShareBinary` of real bytes, `SIGKILL`s it (nothing flushed on the way
out), starts a **new process on a new port** against the same `ETCO_classic_keyFile`, and
re-reads: `GetRequest` 200 with `encryptedKey` intact, `Restore` 200 with the backed-up blob,
`ListBinaryRequests` no longer pending (it was satisfied), `ShouldCreate` false, and the binary
uploaded by the killed process is served back **byte-identical** by the new process.
**VERIFIED** — restart, not an assertion from a write call.

### Ownership against a real Account service

Test "membership: end-to-end against a real Account service" runs `createAccountService` with a
loop whose members are `owner-1` and `robot-1`, points `NET_account` at it, and drives the
**default** membership seam (no injection). Observed: member `CreateRequest` 200;
non-member `CreateRequest` 403 `KEY_NOT_PART_OF_LOOP`; the sibling robot sees the owner's pending
request and the non-member does not; `Backup` 200 for the owner and 403
`ONLY_OWNER_CAN_BACKUP_RESTORE` for the robot; `Restore` 200 for the robot and 403
`ONLY_OWNER_OR_ROBOT_CAN_RESTORE` for a stranger; `x-amz-credentials` and the SigV4 access key
are both accepted identity sources. **VERIFIED**.

### Error envelopes

Every code in §1 is asserted over the wire with its exact status, `x-amzn-errortype` header and
the pinned client's precedence (`__type`). Validation refusals are 422 `Unprocessable Entity`
with the Joi wording. **VERIFIED** (as reproduced behaviour; see INFERRED #2 for the source's
envelope identity).

---

## 5. Falsification (required)

### 5.1 Primary — durability (highest-risk assertion)

The headline claim is "the store survives a real restart". Corruption anchored on a **full code
line** in `packages/classic/src/key.js`:

```
      this.persistence.rename(temporary, this.file);
```

replaced with

```
      this.persistence.unlink(temporary); // FALSIFICATION: never publish the temp file
```

so every mutation still updates the in-memory maps but nothing ever lands at `this.file`.
Proved the code line changed before trusting the result:

```
$ grep -n 'FALSIFICATION' packages/classic/src/key.js
171:      this.persistence.unlink(temporary); // FALSIFICATION: never publish the temp file
$ grep -n 'rename(temporary' packages/classic/src/key.js
(no rename line left)
```

Result — exactly the two durability tests fail, all 11 others stay green:

```
not ok 11 - durable: requests, backups and binaries survive a SIGKILL restart
   error: |-
     the request written before the kill is still there

     404 !== 200
not ok 13 - KeyStore reloads every collection from the same file
# tests 13
# pass 11
# fail 2
```

The restart probe returning **404 for a request written before the kill** is the exact defect the
finding described; the test catches it. (The corruption was applied twice — once against the
first version of the suite and once against the **final** test file — with the identical result:
tests 11 and 13 fail, 11 others green.)

Restored from a byte copy of the pre-corruption file; `grep rename(temporary` shows the line back
and the falsification marker count is 0; the suite is green again (§6).

### 5.2 Secondary — error catalogue

Full code line in `packages/classic/src/key.js`

```
    code: 'BACKUP_PASSWORD_WRONG', message: 'Backup password is wrong', statusCode: 409,
```

changed `statusCode: 409` → `404`. `grep` confirmed the single changed line, and the tests that
own the 409 semantics failed — `Restore compares only a SUPPLIED passwordHash
(BACKUP_PASSWORD_WRONG 409)`, `Backup is one document PER LOOP` and the H.4
`wrong hash -> 409` test (`# fail 3`). Restored; green.

Falsification **performed: yes**; corruption was line-anchored (not substring-anchored), and the
pre-corruption file was restored byte-for-byte in both cases.

---

## 6. Test + gate (final)

`npm test` (full, single run, from the worktree):

```
# tests 1232
# suites 7
# pass 1225
# fail 0
# cancelled 0
# skipped 7
# todo 0
# duration_ms 24028.042495
...
Checklist: 16/79 verified (20.3%)
classic: 6/20 verified; 0 in progress; 0 blocked
Tracker structure, dependencies, evidence links and generated checklist are valid.
> phoenix@0.0.0 parity:gate
Strict production smoke gate (43 cases; full corpus remains separately tracked).
{"result": "match", "cases": 43, "differences": 0, "invariants": 0, "coverageGaps": 0}
EXIT=0
```

* 13 of the 1225 passing tests are new (`keyExchange.test.js`); `keyPush.test.js` keeps 4 tests
  (assertions corrected). Skip count 7, not 8 — the documented reference-path artifact of running
  from a worktree, not a change in behaviour.
* The two "durable" assertions in 5.1 are what the falsification broke; the gate JSON above is
  from an unmoved tree.
* New code paths all execute in the suite (no skipped tests cover the key service).

---

## 7. Claims

### VERIFIED (observed in this worktree)

1. All nine `Key_20160201` operations (and `POST /binaryRequest`, `POST /deleteBinaries`,
   `GET /key/binary`) are dispatched by the real entrypoint and answer real requests — §4.
2. Request state transitions: create → pending → shared → satisfied, and `shouldCreate`
   true→false, observed over the wire; a repeated `(accountId, loopId, publicKey)` reuses one
   document.
3. Key material round-trips: the exact AES key encrypted to the requester's test-owned RSA
   public key is returned and decrypts with the test-owned private key.
4. The nine pinned error codes and statuses are emitted exactly, with the pinned client's
   `err.code` precedence (`lib/protocol/json.js:62-71`).
5. `Backup` is one document per loop; a re-backup replaces it; the previous password hash then
   becomes 409 `BACKUP_PASSWORD_WRONG`; an omitted hash restores.
6. Ownership: owner-only `Backup`, owner-or-robot `Restore`, member-only key/binary reads,
   sibling-only `Share` — verified both with injected membership and end-to-end through a real
   Account service.
7. Durability across a real `SIGKILL` restart for keys, backups and binaries; and the store
   reloading all three collections from one file.
8. The 7-day list windows and the self-exclusion of the caller's own request.
9. The binary flow end-to-end, including `x-id` header handling, a raw (non-JSON) payload, and
   byte-identical retrieval of the shared binary.
10. Pre-change defects existed and were real: `KEY_REQUEST_NOT_FOUND` / `KEY_BACKUP_NOT_FOUND`,
    404-for-wrong-password, and the loop+hash backup key all contradict the pinned catalogue.

### INFERRED (reasoned from source, not directly observed)

1. The gateway layer (`srv-security-gw` `unauthorizedMethods`/`unsignedMethods`/`unactiveMethods`)
   requires a verified signature for every `Key_*` target, so no Key operation is anonymous. The
   gateway lists were read directly; what is inferred is that the deployed robot always signs
   (it does — SigV4 is the client's only auth mode).
2. Key-op validation failures are HTTP **422** Boom.badData: the `@validatePayload` /
   `@validateHeaders` decorators are the same `@jibo/server` ones whose 422 behaviour is already
   pinned for Push and Backup in this repo. Not separately observed from `srv-key-ws` itself.
3. Success responses keep the `{__type, message}` + `x-amzn-errortype` envelope used by the rest
   of the classic/account family; the source's Hapi Boom payload would instead carry
   `{statusCode, error, message, code}`. Client-visible `err.code` and `err.message` are the same
   either way (`lib/protocol/json.js:53-71`), but the header's presence is a format difference,
   not a code difference.
4. `GET /loopMembers` returns every member carrying an accountId (the source calls
   `ListLoopMembers` with an empty payload, which selects every member status, and the controller
   itself filters only on `member.accountId && member.loopId === loopId`).
5. The `Key_*\.ShareBinary` raw-body bypass reproduces the pinned client, which sets no JSON
   content-type for a non-structure payload (`lib/protocol/json.js:36-45`).

### UNKNOWN (honest gaps)

1. The caller of `POST /binaryRequest` / `POST /deleteBinaries` in the live deployment. No
   generated client model declares `CreateBinaryRequest`/`DeleteBinaries`, the mobile app is dead
   and no surviving robot-side caller was found; the routes are built to the pinned contract only.
2. The consumers of the `KeyNeeded` / `KeyShared` / `KeyTimeout` / `BinaryNeeded` / `BinaryShared`
   SNS events. Phoenix has no SNS and the robot-side consumers were not traced; **no events are
   emitted**. Whether any live client depends on them is unverified.
3. Whether `srv-key-ws`'s own host/path published the two plain routes to the robot the same way
   the classic entrypoint does. Phoenix serves them at the entrypoint root; the source registered
   them on its own Hapi server (`src/index.ts:16-21`).
4. The exact `@jibo/server` Boom serialization on the wire (see INFERRED #3).

---

## 8. Divergence candidates (for DIVERGENCES.md — not edited here)

1. **No SNS events for the key flow.** KeyNeeded/KeyShared/KeyTimeout/BinaryNeeded/BinaryShared
   are not emitted; the source published them on every create/share, including the armed
   `KeyTimeout` after `config.json keyShareTimeout` (60 s).
2. **Self-hosted decrypted-binary URL.** The source uploaded the decrypted binary to S3 and
   returned the public S3 URL; Phoenix writes it under `ETCO_classic_keyBinaryDir` and returns
   `<host>/key/binary?accountId=&id=` (same class as the Backup/OTA self-hosting divergence).
   Access control is possession of the URL.
3. **Binary/key state file instead of MongoDB.** One atomic JSON file
   (`ETCO_classic_keyFile`) replaces the `Key`/`Backup`/`Binary` Mongo collections; single-writer,
   whole-file rewrite.
4. **Identity from `x-amz-credentials` or the SigV4 access key.** The source used
   `request.auth.credentials.id` produced by the gateway; Phoenix's classic face runs no gateway
   in-process and falls back to the SigV4 Credential user (LAN trust, as elsewhere in classic).
5. **`GET /loopMembers` peer route.** An additive internal Account route standing in for the
   source's `Loop_2016.ListLoopMembers` call.
6. **Binary routes are not in any SDK model.** They exist only as plain Hapi routes in the source;
   Phoenix serves them from the classic entrypoint.

## 9. Recommendation

`recommend_verified: true`. Acceptance 1 (nine operations + transitions + encrypted sharing +
backup/restore + binary exchange, with pinned fixtures) and acceptance 2 (ownership, key material,
expiry/errors, restart behaviour, consumer round trip) are each backed by observed runtime
evidence, the two pre-change error codes were corrected against the source, the durability claim
is falsifiable and was falsified, and the unknowns are listed rather than papered over. The
remaining gap (`POST /binaryRequest` caller, SNS events) does not block any client that speaks the
pinned SDK model.
