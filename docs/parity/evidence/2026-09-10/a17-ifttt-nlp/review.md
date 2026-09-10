# A-17 verification candidate — IFTTT and Classic NLP behavior

**Date:** 2026-09-10
**Worktree:** `.parity/worktrees/w3-a17` (branch `w3/a17`), base `62f9c2697580f40c5c796554849fef2624f936d3`
**Task:** `A-17` "Implement IFTTT and Classic NLP behavior" (classic, P1, was `implementation: stub`)
**Result:** candidate — 9/9 operations served at runtime; contract + tests green; NLP tag **content**
is UNREPRODUCIBLE and IFTTT **delivery** is impossible. Both are made explicit, not faked.

---

## 1. Scope split (what this task does and does not claim)

Two different things were kept apart, per the task brief:

* **(a) the wire surface** — target prefixes, operation set, request/response members, status codes,
  error codes and controller semantics. This is fully implemented and probed at runtime.
* **(b) the dead third-party integrations** — IFTTT delivery and the spaCy NLP backend. These cannot
  work. They are implemented as **explicit injectable seams whose default answer is UNAVAILABLE**,
  never as fabricated success or plausibly-shaped fake data.

---

## 2. Pinned source read (archive MCP via `.parity/tools/jibo-mcp-client.py` → `https://pvindex.org/mcp`)

| Source (pin) | File | What it establishes |
|---|---|---|
| `jiborobot/srv-jibo-server-client@155d20a8102960b2aeb89c197bdf04dc1f1fc344` | `apis/ifttt-2017-02-07.normal.json` | 7 ops; targetPrefix `IFTTT_20170207`; every input/output shape |
| same | `apis/nlp-2016-10-31.normal.json` | 2 ops; targetPrefix `NLP_20161031`; `QuestionRequest.Input`, `PartOfSpeech{word,pos}`, `NamedEntity{start,end,label,text}` |
| `jiborobot/srv-ifttt-ws` (master as read) | `src/handlers/ifttt.handler.ts` | op→method mapping; `@validatePayload` Joi (which fields are required) |
| same | `src/controllers/ifttt.ctrl.ts` | the real contract: robot gate, identity match, limit rules, cascade delete, filters |
| same | `src/schemes/{action,identity,media,trigger}.ts` | `toJSON` id/`created` transforms; field types |
| same | `src/errors/ifttt.ts` | the six Boom codes + messages + statuses (verbatim) |
| same | `src/clients/{ifttt,account}.client.ts` | `realtime.ifttt.com/v1/notifications` + `IFTTT-Channel-Key`; `AccountClient` loop list |
| `jiborobot/srv-nlp-ws` | `nlp.py` | Flask `POST /POS`, `POST /NER`; `{"Input": …}`; response builders |
| same | `jibospacy.py` | `spacy.load('en')`; `clean_input`; `WH_WORDS` |
| same | `requirements.txt` | `spacy==1.2.0`, `Flask==0.11.1` (Python 2) |

**Pin check (VERIFIED):** `git cat-file -t 155d20a8…` = `commit` in the local checkout, and
`git diff 155d20a8 HEAD -- apis/ifttt-2017-02-07.normal.json apis/nlp-2016-10-31.normal.json` is
**empty**, so the two API models read here are byte-identical to the pinned revision.

> Note: the MCP returns file bodies with a one-line `# <repo>:<path>` header prepended, so
> **source line ≈ cited line − 1** for the quoted excerpts below.

---

## 3. What was implemented

### IFTTT — `packages/classic/src/ifttt.js` (new)

Full controller semantics ported from `ifttt.ctrl.ts`:

* `Trigger` (robot-only, `text` required): `listLoops(ownerId,true)` must be exactly one loop whose
  `robot === ownerId`, else `ROBOT_MUST_CALL 403`; identities matched by the phonetic filter and the
  4-hour `updated` window; a Trigger row per matching identity; then `notify()`. No match →
  `APPLET_NOT_FOUND 404` when a fresh `USER_FILTER` identity exists for the loop, else `USER_NOT_FOUND 404`.
* `ListTriggers` / `ListMedia` (owner; handler Joi **requires** `identity`): upsert `USER_FILTER`
  and the request identity; `limit` default 50 when `undefined | >50 | <0`, `0 → []`; newest-first.
  A repeat id under a different filter → `IDENTITY_TRIGGER_CHANGED 409`.
* `Action` (owner; `fields` required): one Action per loop whose `owner === ownerId`; members
  `{id, loopId, fields, created}`.
* `ListActions` (robot-only; limit rules above).
* `DeleteIdentity` (owner; `identity` required): `IDENTITY_NOT_FOUND 404`,
  `IDENTITY_ONLY_ACCESSIBLE_BY_OWNER 403` on a loop-set miss, then cascade `Trigger.remove` +
  key `removeBinaries` for decrypted media + `Media.remove` + identity remove.
* `UserInfo`: `{id: ownerId, name: email}` + `USER_FILTER` upsert.

**Dead provider seams (defaults are explicit, never fake):**

* `notify` → `unavailableIftttNotify` records `{delivered:false, reason, endpoint}` and logs a warn.
  The pinned endpoint (`https://realtime.ifttt.com/v1/notifications` with an `IFTTT-Channel-Key`)
  was retired with the Jibo channel; there is nothing to call.
* `key` → `unavailableKeyClient` records the attempt and performs nothing (the key service is dead).
* `loops` → `singleHouseholdLoops` answers the LAN-trust single-household case so a real client gets
  shapes and statuses instead of errors. Replaceable for tests/multi-loop deployments.
* `email` → injectable; Classic auth carries no email, so `UserInfo.name` defaults to `''`.

### NLP — `packages/classic/src/nlp.js` (new)

* `cleanInput` — the source transform (`jibospacy.py`): drop `?`, then for each of
  `WH_WORDS = ['what','when','who','where','how','which']` in order re-slice from the last present
  WH word, trim. Reproduced exactly and applied before the provider.
* `PartOfSpeech` / `NamedEntityRecognition`: `QuestionRequest.Input` **required**; responses are the
  pinned shapes with rows reduced to exactly `{word,pos}` / `{start,end,text,label}`.
* Provider seam: default `unavailableNlpProvider` returns `null` (no tags) → the handler serves the
  documented empty shape and warns; `createHttpNlpProvider` / `ETCO_nlp_upstream` can point at a
  recovered Flask service (`POST {base}/POS`, `POST {base}/NER` with `{"Input": …}`).

### Wiring / migration

* `packages/classic/src/index.js` — registers `makeIftttHandler` (`/^ifttt/i`) and `makeNlpHandler`
  (`/^nlp/i`) **before** `stubRegistrations()`, exposes `iftttStore`, and re-exports the new symbols.
* `packages/classic/src/stubs.js` — the `ifttt` and `nlp` stub blocks are removed (now real services).
* `packages/classic/test/stubs.test.js` — the old placeholder assertions
  (`IFTTT.Trigger {} → Command accepted`, `NLP.PartOfSpeech {text:'hi'} → []`) were exactly the
  behaviour this task replaces; they now cover `collision` only.
* `CLASSIC-SERVICES.md` — the `ifttt` and `nlp` rows updated from stub to the real handlers.

---

## 4. Runtime probe — every operation is SERVED (VERIFIED, observed)

`node docs/parity/evidence/2026-09-10/a17-ifttt-nlp/probe.mjs` starts the real entrypoint and sends
all 9 requests over the wire (`POST /`, `application/x-amz-json-1.1`, `X-Amz-Target`). Output saved
to `probe.out`:

```
200 IFTTT_20170207.UserInfo -> id,name
200 IFTTT_20170207.Trigger -> result
200 IFTTT_20170207.ListTriggers -> list(0)
200 IFTTT_20170207.ListMedia -> list(0)
200 IFTTT_20170207.Action -> list(1)
200 IFTTT_20170207.ListActions -> list(1)
200 IFTTT_20170207.DeleteIdentity -> result
200 NLP_20161031.PartOfSpeech -> partsOfSpeech
200 NLP_20161031.NamedEntityRecognition -> namedEntities
dead IFTTT notify ledger: [{"identities":["idf-1"],"outcome":{"delivered":false,"reason":"IFTTT realtime notifications endpoint (realtime.ifttt.com/v1/notifications) is dead","endpoint":"https://realtime.ifttt.com/v1/notifications"}}]
action rows: [{"loopId":"loop-acct-1","fields":{"url":"https://example.test/a.jpg"}}]
```

All seven IFTTT operations and both NLP operations dispatch in-process and return the pinned members
(no `matched: NONE`), and the dead IFTTT notify is recorded as `delivered:false` rather than faked.

Error/status paths observed (focused tests, §5): `ValidationException 400` (missing required
member), `ROBOT_MUST_CALL 403`, `APPLET_NOT_FOUND 404`, `USER_NOT_FOUND 404`,
`IDENTITY_NOT_FOUND 404`, `IDENTITY_ONLY_ACCESSIBLE_BY_OWNER 403`, `IDENTITY_TRIGGER_CHANGED 409`.

---

## 5. Focused tests

* `packages/classic/test/ifttt.test.js` — 14 tests: UserInfo, Trigger Joi, robot gate, Trigger row
  creation + dead-notify ledger, APPLET/USER_NOT_FOUND, ListTriggers limit rules + 409, Action
  members + owner-loop filter, ListActions robot gate, ListMedia + 409, decrypted media rows,
  DeleteIdentity cascade + both gates + key adapter, unknown op, default-adapter dead-notify.
* `packages/classic/test/nlp.test.js` — 8 tests: POS members, NER members, `clean_input` application
  (asserted through the provider calls), missing `Input`, provider-seam consultation, default
  dead-provider empty shape, unknown op, HTTP provider request shape.

Classic package: **150 tests / 150 pass / 0 fail**.

---

## 6. Falsification (REQUIRED) — performed

**Highest-risk assertion:** the robot-only gate (`Trigger`/`ListActions` must refuse a caller whose
single loop is not their robot). If this were wrong, a non-robot client could create triggers.

**Corruption anchored on a full code line** (`packages/classic/src/ifttt.js`, `robotLoop`):

```diff
-    if (list.length !== 1 || String(list[0].robot) !== String(accountId)) return { error: IFTTT_ERRORS.ROBOT_MUST_CALL };
+    if (list.length !== 1) return { error: IFTTT_ERRORS.ROBOT_MUST_CALL };
```

**Observed failure** (`node --test packages/classic/test/ifttt.test.js`):

```
not ok 3 - Trigger is robot-only (ROBOT_MUST_CALL 403)      expected: 403
not ok 9 - ListActions is robot-only and lists the robot loop actions   expected: 403
# tests 14 / pass 12 / fail 2
```

Both robot-gate tests failed as designed (the call proceeded instead of returning `403`).
**Restored** the exact line; re-ran → `26 pass / 0 fail` across the three touched test files
(and 150/150 for the classic package). Falsification confirms the gate is actually exercised.

---

## 7. What cannot work, and why (honest limits)

* **IFTTT delivery cannot work.** `IftttClient.notify` targets
  `https://realtime.ifttt.com/v1/notifications` with `IFTTT-Channel-Key: config.server.iftttKey`.
  IFTTT retired that realtime channel and the Jibo channel key is gone. There is no replacement
  endpoint and no surviving provider. Phoenix keeps the documented wire behaviour and records the
  attempt as `delivered:false`; it does **not** report a fabricated delivery.
* **NLP tag content cannot be reproduced.** The tags come from `spacy.load('en')` inside a Python-2
  Flask app pinned to `spacy==1.2.0` (`jibospacy.py`, `requirements.txt`). That runtime and the
  hosted service are gone, and this environment has no spaCy. Emitting tags from a modern tagger
  would be invented output for a dead provider, so Phoenix serves the correct shape with an empty
  array and an explicit warn, and offers an `ETCO_nlp_upstream` seam for a recovered service.
* **`metaphone`/`stemmer` are absent** from Phoenix, so the original
  `metaphone(stemmer(text))` phonetic index cannot be reproduced byte-for-byte; a documented local
  key is used. It is an opaque internal identity key, so the observable matching contract holds.

---

## 8. Verified / Inferred / Unknown

**VERIFIED (observed at runtime or read from the pin):**
1. All 9 operations are served in-process with the pinned statuses/members (probe §4).
2. The two API models are byte-identical to pin `155d20a8…` (empty `git diff`).
3. The six IFTTT error codes/messages/statuses match `src/errors/ifttt.ts` verbatim.
4. Controller semantics (robot gate, limit rules, identity filters, cascade delete) match
   `ifttt.ctrl.ts`; `clean_input` matches `jibospacy.py`.
5. `npm test` green, classic 150/150, new tests 26/26, parity gate `match`.
6. Falsification (§6) executed and reverted.

**INFERRED (reasoned from source, not executed):**
1. The dead endpoints are actually unreachable for the original too (IFTTT channel retired; spaCy
   1.2.0 service offline) — from the client/requirements source, not a live request.
2. The single-household default loop stands in for the dead Account/loop list on a LAN-trust deploy.
3. `limit` semantics and newest-first ordering per `Trigger.find(...).sort({created:-1})`.

**UNKNOWN:**
1. The exact `@jibo/server` `@validatePayload` rejection status/envelope (Boom.badData 422 vs the
   `ValidationException 400` Phoenix uses, following the media/key precedent); the deployed gateway
   envelope was not replayed.
2. How the gateway mapped `NLP_20161031.*` x-amz-target onto Flask `/POS`/`/NER` (an A-01 unknown);
   Phoenix serves the SDK target directly.
3. Whether an IFTTT `notify` failure aborted the original request; Phoenix returns `CommandResponse`
   regardless, matching the controller's `return COMMAND_RESULT`.
4. Byte-level Mongo ObjectId string formats and the ordering within equal `created` timestamps.
5. The original deployed `config.server.iftttKey` and IFTTT channel state.

---

## 9. Divergence candidates (for root — `DIVERGENCES.md` was not edited)

1. **IFTTT delivery is impossible** — the realtime notify endpoint is dead. Phoenix records an
   explicit unavailable outcome; no applet is actually triggered. Add to the tier-3 divergence row.
2. **NLP POS/NER content is unavailable** — needs `spacy==1.2.0`/Python-2; Phoenix serves the
   documented empty shape by default and exposes a provider seam. Empty arrays are the honest
   result of a dead backend, not a completion placeholder.
3. **Phonetic index differs** — `metaphone`/`stemmer` absent; local key substituted (opaque).
4. **Validation status envelope** — source `@validatePayload` likely 422; Phoenix returns
   `ValidationException 400` (media/key convention). UNKNOWN which the deployed gateway sent.
5. **Account/loop list + KeyClient are dead Classic services** — replaced by injectable fixture
   adapters with a single-household default; real multi-loop/robot semantics are unexercised.
6. **`UserInfo.name`** — source returns `credentials.email`; Classic auth exposes none, so `''`
   unless an email adapter is injected.
7. **NLP missing `Input`** — source raised `KeyError` (Flask 500 HTML); Phoenix returns a declared
   `ValidationException 400`.

---

## 10. Final `npm test` (one full run)

```
# tests 1274
# suites 7
# pass 1267
# fail 0
# cancelled 0
# skipped 7
# todo 0
# duration_ms 40016.571617
```

parity:check — `Checklist: 16/79 verified (20.3%)`; `classic: 6/20 verified`; tracker valid.

parity:gate JSON:

```json
{"result": "match", "cases": 43, "differences": 0, "invariants": 0, "coverageGaps": 0}
```

The change adds 22 tests (14 IFTTT + 8 NLP); `cancelled: 0` confirms no parallel-run artefact.

---

## 11. Files

New: `packages/classic/src/ifttt.js`, `packages/classic/src/nlp.js`,
`packages/classic/test/ifttt.test.js`, `packages/classic/test/nlp.test.js`,
`docs/parity/evidence/2026-09-10/a17-ifttt-nlp/{probe.mjs,probe.out,review.md}`.
Modified: `packages/classic/src/index.js`, `packages/classic/src/stubs.js`,
`packages/classic/test/stubs.test.js`, `CLASSIC-SERVICES.md`.

**Recommendation:** mark A-17 a candidate for review. The wire surface and semantics are source-backed
and runtime-verified; the dead-provider seams are explicit. Acceptance criterion 2 (POS/NER output)
is met at the **contract** level and cannot be met at the **content** level — recorded honestly above.
