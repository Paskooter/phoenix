# A-15 — Person data and Collision behavior

Worktree `.parity/worktrees/w4-a15` (branch `w4/a15`). Person_20160801 and Collision_20161126
graduated from the tier-3 stub (`packages/classic/src/stubs.js`) to real, source-faithful handlers
registered ahead of the stub seam.

## Pins read (via the Jibo archive MCP)

| what | repo | path |
|---|---|---|
| Person client API | `jiborobot/srv-jibo-server-client` | `apis/person-2016-08-01.normal.json` |
| Collision client API | `jiborobot/srv-jibo-server-client` | `apis/collision-2016-11-26.normal.json` |
| Person service | `jiborobot/srv-person-ws` | `src/handlers/{person,property}.handler.js`, `src/controllers/{person,property}.ctrl.js`, `src/errors/person.js`, `src/schemes/{answer,holiday,accountProperty,loopProperty}.js`, `src/clients/account.client.js`, `src/index.js`, `config/config.json` |
| Collision service | `jiborobot/srv-collision-ws` | `src/handlers/collision.handler.js`, `src/controllers/collision.ctrl.js` |
| Collision algorithm | `alexander-rysenko/phonetic_collision` (== `amir/phonetic_collision`) | `README.txt`, `test.cfg`, `src/jibo_phonetic_collision_service.cc`, `src/phonetic_collision.{h,cc}` |
| Gateway allow-list | `jiborobot/srv-security-gw` | `src/controllers/auth.ctrl.ts`, `src/errors/account.ts` |

Person service pin revision `fc06373f5f1ce88997d0b5f2e4640543e2033b44` is the one A-01 recorded
(`docs/parity/candidates/A-01-attributes-messaging-20260910.md`); the MCP read the default branch.
Gateway pin `43a692fe7670660aaed6ab5979c6c83039eb711c` (A-01).

## Two auth layers

* **Gateway** (`43a692fe` `auth.ctrl.ts`): `unauthorizedMethods` lists 19 Account/Loop/Backup/OOBE
  targets and **no Person or Collision target**; `unsignedMethods` is empty; `unactiveMethods` is
  only `Account_20151111.Remove`. Every Person op and `Collision_20161126.Match` therefore needs a
  signed `Authorization: AWS4…` header; a missing header is `MISSING_AUTH_HEADER 401`
  (`errors/account.ts`). **VERIFIED** — both handlers answer 401 for an unsigned call
  (live-probe `unsigned`; `person.test.js` / `collision.test.js` MISSING_AUTH_HEADER cases).
* **Handler decorators** (`@parseCredentials({})`): the source reads
  `request.auth.credentials.id`. On the trusted internal hop Phoenix derives it from the SigV4
  `Credential=<accessKeyId>/…` (media precedent) **and** from Account Settings'
  `x-amz-credentials: {"id":…}` header (the way `packages/account` actually calls Person —
  `src/settingsProviders.js:316`). **VERIFIED** — live-probe `identity` writes and reads an
  account property through `x-amz-credentials` with no Authorization header.

## Person contract implemented

Every one of the 10 operations is served and shape-checked against the pinned model (live-probe
`live-probe.json` projects each response through the declared output shape — the field-stripping
the generated client applies):

| op | behaviour kept from source | errors |
|---|---|---|
| List | questions of a category, minus the caller's answered keys | `CATEGORY_NOT_FOUND 404` |
| Answer | `ALREADY_ANSWERED` checked before validation; option check when the question declares options | `ALREADY_ANSWERED 409`, `QUESTION_NOT_FOUND 404`, `ANSWER_OPTION_WRONG 422` |
| Enable/DisableHolidays | owner-or-robot; flips `isEnabled` on matching ids in the loop | `HOLIDAY_MUST_BE_OWNER_OR_ROBOT 403` |
| ListHolidays | this+next year upcoming holidays, `syncHolidays` create/remove, sha256 `eventId` = `sha256((name\|memberId)+date)` | `HOLIDAY_MUST_BE_OWNER_OR_ROBOT 403` |
| ListAccountPropertyKeys | answers `{keys:[…]}` (declared shape) | — |
| Set/GetAccountProperty(ies) | caller-only key/value maps | — |
| Set/GetLoopProperty(ies) | loop-member gate | `LOOP_MEMBER_ONLY 403` |

The questions + all 53 holidays are the pinned `config/config.json`, generated verbatim into
`packages/classic/src/personCatalog.js` (2 questions in category `app`; `Halloween` public etc.).

Persistence is one atomically-replaced JSON file (`PersonStore`, same discipline as `MediaStore`),
written synchronously on every mutation. **VERIFIED by restart at two levels:**

* in-process — `person.test.js` "state survives a real restart (new entrypoint, same store file)"
  closes the first entrypoint, opens a second with a brand-new `PersonStore` over the same file,
  and reads back the property, the consumed question and the enabled holiday (the enabled
  `Halloween` row keeps its id).
* **process-level** — `restart-process.mjs` spawns the real entrypoint as a child `node` process,
  writes account property + answer + enabled holiday over the AWS-JSON wire, **SIGKILLs it** (no
  graceful shutdown), starts a *fresh process* over the same file and re-reads. All 5 values
  survived: `PASS: 5/5 values survived a real process restart (SIGKILL -> new process)`.

## Falsification (re-run for A-15)

One full source line was inverted in `packages/classic/src/person.js`, the person suite re-run, the
line restored and the suite re-confirmed green.

* Line broken (`git diff` before/after, restored verbatim):
  `    if (this.store.findAnswer(accountId, key)) fail('ALREADY_ANSWERED');`
  was changed to
  `    if (!this.store.findAnswer(accountId, key)) fail('ALREADY_ANSWERED');`
* Failing test (exact name, from `node --test packages/classic/test/person.test.js`):
  **"person answer stores an option, drops it from list, and refuses a second answer"** — plus the
  two knock-on cases "person answer validates the option (422) and the question (404)" and
  "person state survives a real restart (new entrypoint, same store file)"; counts that run:
  `# tests 14 # pass 11 # fail 3`.
* Restored: `git diff packages/classic/src/person.js` empty; person+collision suites
  `# tests 28 # pass 28 # fail 0`.

## Collision contract implemented

`Collision_20161126.Match` → `{success, collision, closest_pair, distance}`, ported line for line
from `phonetic_collision.cc` + `jibo_phonetic_collision_service.cc`:
Levenshtein over `-`-split phoneme tokens, minimum across target×input pairs with the first strict
minimum winning, and `min_distance` forced to `0` when either winning phoneme sequence has ≤ 3
tokens. The pinned README example is reproduced exactly:
`-i emir,alex -t amir` → `{success:true, collision:true, closest_pair:"emir", distance:1}`
(**VERIFIED**, `collision.test.js` + live-probe). Threshold default `1`, nbest default `2` from
`test.cfg`. Joi validation (`name` string allow `''`; `existingNames` array of non-empty strings) →
400; a failing service seam → **409** (the source `Boom.wrap(_, 409)`).

## Evidence standard

**VERIFIED (observed at runtime or read in pinned source):**
- 10 Person ops + Collision Match served at 2xx with the declared visible shapes
  (`docs/parity/evidence/2026-09-10/a15-person-collision/live-probe.json`, "SERVED 11 operations").
- The pinned README collision example, the ≤3-token boundary, the min_distance override.
- Durable state across a real process/entrypoint restart.
- Missing-auth 401 for both services; `x-amz-credentials` identity.
- Gateway allow-lists at `43a692fe` (no Person/Collision target in `unauthorizedMethods`;
  `unsignedMethods` empty) — re-read `jiborobot/srv-security-gw:src/controllers/auth.ctrl.ts`
  for A-15: `Person`/`Collision` appear **0 times** in the file, and a missing `authorization`
  throws `Errors.MISSING_AUTH_HEADER`.

**INFERRED (source reading, not executed):**
- `Get*Properties` with `keys` omitted (Joi optional) reads every property for the owner; mongoose
  `$in: undefined` was not run, so the source's exact behaviour is unproven.
- The account hop failure maps to `ACCOUNT_SERVICE_UNAVAILABLE 503` (source `AccountClient.getBase`
  throws it; the wreck-level failure type was not observed).
- The membership/ownership gates are skipped when no account seam is injected (Media precedent);
  the deployed launcher injects the real client.
- `expanded_input_words` repeats a word once per *returned* pronunciation (the source repeats it
  `nbest` times unconditionally).

**UNKNOWN / not reproduced:**
- The exact phoneme sequences the original 14 MB Phonetisaurus g2p model produced. The default
  phonemizer is a documented grapheme approximation; `phonemize` is an injectable seam. Other
  names' distances are not claimed to equal the model's.
- The wire `__type` the deployed hapi/Boom serializer emitted for the collision 409, and for
  Person's typed errors (Phoenix emits `err.code`).
- The bare-array vs `{keys}` wire envelope of `ListAccountPropertyKeys` (A-01 leaves it open;
  Phoenix answers the declared shape).
- The exact eth `Holiday.update` postSave vs `save` event semantics (no SNS in Phoenix).

## Divergence candidates (for DIVERGENCES.md — not edited here)

1. Person identity is read from `x-amz-credentials`/SigV4 accessKeyId without signature
   verification (LAN trust), whereas the gateway verifies AWS4 signature + account activity.
2. Mongoose/Mongo replaced by a single JSON file; `_id`/ObjectId values are opaque uuid strings.
3. Membership/ownership gates are skipped when no account client is injected (documented LAN-trust
   skip, same as Media's dropped membership gate).
4. Collision g2p is a grapheme approximation, not the pinned Phonetisaurus model.
5. Collision 409 error code `COLLISION_SERVICE_FAILED` is Phoenix-chosen (source used an
   untyped `Boom.wrap`).
6. `ListAccountPropertyKeys` answers `{keys}` (declared shape) rather than the source's bare array.

## Commands

```sh
node --test packages/classic/test/*.test.js   # 224 tests, 224 pass, 0 fail
node docs/parity/evidence/2026-09-10/a15-person-collision/probe.mjs            # SERVED 11 operations; all 2xx = true
node docs/parity/evidence/2026-09-10/a15-person-collision/restart-process.mjs  # PASS: 5/5 values survived a real process restart
npm test                                       # 1409 tests, 1402 pass, 0 fail, 0 cancelled, 7 skipped; gate {"result":"match","cases":43,...}
```
