# A-17 (w6) — IFTTT / Classic NLP candidate, re-derived and hardened

**Worktree:** `.parity/worktrees/w6-a17` (branch `w6/a17`), base `8bca4a8`.
**Prior candidate:** `.parity/worktrees/w3-a17` (commit `60229b0`, already an ancestor of `main`).
This pass re-read the pinned source through the archive MCP, fixed two source-fidelity gaps the
prior candidate left, and added real process-restart durability evidence.

## 1. Pinned source (read this pass, archive MCP `https://pvindex.org/mcp`)

| Source | File | Establishes |
|---|---|---|
| `jiborobot/srv-jibo-server-client` | `apis/ifttt-2017-02-07.normal.json` | 7 ops; `targetPrefix IFTTT_20170207`; `TriggerRequest.text` required; `Action{id,loopId,fields,created}`; `MediaTrigger{id,identity,encryptedUrl,decryptedUrl,created}`; `UserInfoResponse{id,name}` |
| same | `apis/nlp-2016-10-31.normal.json` | 2 ops; `targetPrefix NLP_20161031`; `QuestionRequest.Input` required; `PartOfSpeech{word,pos}`; `NamedEntity{start,end,label,text}` |
| `jiborobot/srv-ifttt-ws` | `src/controllers/ifttt.ctrl.ts` | the controller semantics (robot gate, phonetic filter + 4h/4d windows, limit rules, cascade delete) |
| same | `src/handlers/ifttt.handler.ts` | op→method mapping; `@validatePayload` Joi (which fields are required) |
| same | `src/errors/ifttt.ts` | six Boom codes/messages/statuses (verbatim) |
| same | `src/schemes/identity.ts` | `Identity` is a **Mongo** schema `{_id,filter,loopIds,updated}` → the state is durable |
| same | `src/clients/{ifttt,account}.client.ts` | `realtime.ifttt.com/v1/notifications` + `IFTTT-Channel-Key`; `AccountClient` loop list |
| same | `test/ifttt.ctrl.spec.ts` | original behavioral examples: `light`/`lights` share a phonetic key, `listTriggers` limit 0/1, "list no media" → `[]` |
| `jiborobot/srv-nlp-ws` | `nlp.py` | Flask `POST /POS`, `POST /NER`; `{"Input": ...}`; response builders |
| same | `jibospacy.py` | `spacy.load('en')`; `clean_input`; `WH_WORDS` |
| same | `README.md` → `https://pvindex.org/docs/latest/Jibo/NLP.html` | the SDK doc: `partsOfSpeech`/`namedEntities` member lists |

## 2. Two gaps fixed this pass

1. **NER possessive strip** (`nlp.py:83-86`): the NER endpoint emits `ent.text`, and when that
   text `endswith("'s")` it drops the two characters (`entity_text = ent.text[:-2]`). The prior
   handler passed the provider's `text` straight through. Now applied in `nlp.js` before emit.
2. **Durable IFTTT state** (Mongo in `src/schemes/*.ts`): the prior store was process-lifetime
   in-memory only. `IftttStore` now keeps the same four document boundaries (Identity / Trigger /
   Action / Media) in one atomically replaced JSON file (`ETCO_classic_iftttFile`, default
   `$TMPDIR/phoenix-ifttt.json`), matching `notificationStore` / `key` / `person` / `jot` / `media`.

## 3. Runtime evidence

`probe.out` — all 7 IFTTT_20170207 ops + both NLP_20161031 ops answer 200 over the wire on the
real entrypoint; an unknown IFTTT op is `ValidationException 400`; `stubRegistrations()` is `[]`.

`packages/classic/test/iftttDurability.test.js` — starts the real entrypoint as a CHILD process
over `ETCO_classic_iftttFile`, writes Identity/Trigger/Action through the wire, **SIGKILLs** it
(no graceful shutdown), starts a FRESH process over the same file and reads the state back; a
second case proves the `DeleteIdentity` cascade does not resurrect rows after the kill.

## 4. Divergence candidates (for root — `DIVERGENCES.md` was not edited)

- Phonetic index: source uses `metaphone(stemmer(text||""))` (the `metaphone`/`stemmer` npm deps
  are absent from `node_modules`), so `light`/`lights` do NOT share a key in Phoenix the way
  `test/ifttt.ctrl.spec.ts` shows. `localPhoneticKey` is an opaque stand-in — DIVERGENCE.
- IFTTT delivery and the spaCy 1.2.0 tag content are dead third parties; both are explicit
  UNAVAILABLE seams, never fabricated.
- Missing NLP `Input`: source raised `KeyError` (Flask 500); Phoenix returns `ValidationException 400`.
- Account loop list + `KeyClient` are dead Classic services; default adapters answer the LAN
  single-household case.
