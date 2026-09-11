# H-08 — speech and launch-history side effects

Pinned reference: Pegasus `5c0a7390539663ba749d360de348a428c088505c`
(`packages/hub/src/listen/ListenTransactionHandler.ts`, `packages/hub/src/utils/TransactionHandler.ts`,
`packages/hub/src/utils/TransactionHelper.ts`, `packages/history-client/src/**`),
executed under the archived `node:8.9.4-slim`
(`sha256:8233daae003ba0ecba4e6d70cab8525c30a3f085935afc624a275892ebe23f7c`).

## MCP sources (jibo archive, `gitea://jiboV2/pegasus@5c0a7390…`)

* `packages/hub/src/listen/ListenTransactionHandler.ts@5c0a7390…` —
  `if (this.components.hubSettings.recordSpeechHistory) { this.speechHistoryRecord = new SpeechHistoryRecord({ robotID: this.ws.auth.friendlyId, ... audioFileURL: null }); }` (L75-86);
  `onTransactionSuccess(){ … this.saveSpeechHistoryRecord(); }` (L99-101);
  `onTransactionError(err: Error){ … this.speechHistoryRecord.update({ error: err }); this.saveSpeechHistoryRecord(); }` (L105-108);
  `this.updateSpeechHistoryRecord({ asr: Object.assign({}, this.asrData) }); // Avoid logging normalized ASR` (L467);
  `this.updateSpeechHistoryRecord({ match: match });` (L678).
* `packages/history-client/src/speech/SpeechHistoryClient.ts@5c0a7390…` —
  `async save(record, jiboHeaders)` → `await this.updateRecord(record.id, record.data, jiboHeaders)` / `record.id = await this.createRecord(record.data, jiboHeaders)` (L21-46);
  `err.message = \`Failed to save speech history record: ${err.message}\`;` (L32);
  `const response = await this.put<{id: string}>(\`/speech/${id}\`, data, …)` (L53).
* `packages/hub/src/utils/TransactionHelper.ts@5c0a7390…` —
  `return context.perception && context.perception.speaker ? [ context.perception.speaker ] : ["UNKNOWN"];` (L15).
* `packages/hub/src/skill/SkillRequestMaker.ts@5c0a7390…` —
  `const code = error.code || error.message.toLowerCase().startsWith('timeout') ? SkillRequestError.TIMEOUT : SkillRequestError.SKILL_NOT_FOUND;` (L76-77),
  the operator-precedence quirk behind the `skill.error.code` divergence below.

## Method

Two receipts are produced and diffed cell by cell:

* `source-speech-history.cjs` — runs the **pinned original** `ListenHandler` /
  `ListenTransactionHandler` on the archived Node 8 runtime with recording mocks for
  `history.skillLaunch.writeSkillLaunch` and `history.speechHistory.save`, a prototype probe on
  `SpeechHistoryRecord.update()`, a control-flow probe on `resolve`/`reject`/
  `onTransactionSuccess`/`onTransactionError`, and a stub ASR session so the server-ASR path
  executes. → `source-speech-history.json`
* `phoenix-speech-history.mjs` — drives the **real Phoenix gateway** (`createGateway`) over a
  real `ws` socket per case, pointed at a **real HTTP history service**, and records the same
  three surfaces (update sequence, ordered side effects with the exact request headers, frames).
  → `phoenix-speech-history.json`
* `python3 compare.py` normalizes the random peer port and prints a structural diff.

```
docker run --rm --network none -v "$PWD:/review" \
  -v /home/shell/work/phoenix/.parity/reference/5c0a7390539663ba749d360de348a428c088505c:/runtime:ro \
  node:8.9.4-slim node /review/source-speech-history.cjs /runtime /review/source-speech-history.json
node phoenix-speech-history.mjs phoenix-speech-history.json
python3 compare.py     # -> DIFFS (0)
```

## Verified contract (observed on both runtimes)

Speech record base (constructor, `ListenTransactionHandler.ts:73-82`):
`{robotID: auth.friendlyId, accountID: auth.id, transID: ws.jibo.transID, timestamp: Date.now(), audioFileURL: null}`.

`update()` calls, in order, per path (`:261`, `:283`, `:323`, `:465`, `:598`, `:619`, `:632`, `:676`):

| Path | Updates, in order | Saves |
| --- | --- | --- |
| CLIENT_NLU launch | `{asr,nlu}` → `{match}` → `{skill}` | 1 (create) |
| continued session (LISTEN_UPDATE) | `{asr,nlu}` → `{match:launch:false}` → `{skill}` | 1 |
| redirect | `{asr,nlu}` → `{match}` → `{skill:source}` → `{redirect}` → `{skill:destination}` | 1 |
| too-many-redirects (reject) | … → `{redirect}` → `{skill}` → `{error}` | **2** |
| skill non-2xx (resolved) | `{asr,nlu}` → `{match}` → `{skill:error}` | 1 |
| redirect destination non-2xx | `{asr,nlu}` → `{match}` → `{skill:source}` → `{redirect}` → `{skill:error}` | 1 |
| on-robot match | `{asr,nlu}` → `{match:onRobot}` | 1 |
| server ASR launch | `{asr}` (raw, pre-normalize) → `{nlu}` → `{match}` → `{skill}` | 1 |
| server ASR GARBAGE | `{asr}` (raw) → `{match:null}` | 1 |
| no match | `{asr,nlu}` → `{match:null}` | 1 |
| parser failure (reject) | `{asr}` → `{error:{code:'PARSER'}}` | **2** |
| recordSpeechHistory off | — | 0 |

Other observed facts:

* `{match}` is recorded even when the match is `null` (`:676`).
* ASR is cloned **before** `normalizeString` mutates the live `asrData` (`:465`), so the record
  holds `"  Hello   World "`, not `"Hello World"`.
* A rejected transaction saves the speech record **twice**: `reject()` runs `onTransactionError`
  (record `{error}`, save #1) and then `stop() → done() → resolve() → onTransactionSuccess`
  (save #2). Both are creates because the record still has no id, so the store receives two rows
  (control-flow probe: `tooManyRedirects`/`parserFailure` show `reject`, `onTransactionError`,
  `speechSave`, `done`, `resolve`, `onTransactionSuccess`, `speechSave`).
* `error` is the thrown value after JSON serialization: a plain `Error` → `{}`, a `HubError` →
  `{code}` (`message` is non-enumerable).
* Launch-history writes are gated by `recordLaunchHistory`; speech by `recordSpeechHistory`; the
  two flags are independent. `personIDs` is `[speaker]` or `['UNKNOWN']` when no speaker was
  identified (`TransactionHelper.getPersonIDs`).
* Every outbound history call carries `x-jibo-transid`/`x-jibo-robotid`/`x-jibo-logging-config`
  with the `JiboHeaders` defaults `unknown`/`unknown`/`{}` (`utils/service/JiboHeaders.ts:26-37`).

## Divergences found and fixed

### 1. Speech-history recording was entirely absent from the hub

`HistoryClient` had only `writeSkillLaunch` and the two IHQuery reads; nothing created, updated or
saved a speech record, and `HubConfigProvider`'s `recordSpeechHistory` was read into config but
never used. Implemented in `packages/gateway/src/historyClient.js`
(`SpeechHistoryRecord`, `createSpeechRecord`, `updateSpeechRecord`, `saveSpeechRecord`) and
`packages/gateway/src/listenTransaction.js` (record construction, all eight `update` sites, and the
save on `resolve`/`reject`).

### 2. Failure-path double save

`reject()` now reproduces the reference's `onTransactionError` + `onTransactionSuccess` pair, so a
failed turn writes the speech record twice. Observable only at the history store (two rows).

### 3. `skill.error.code` for a request-path failure must be `TIMEOUT`

`SkillRequestMaker.ts:74-76` computes
`error.code || error.message.toLowerCase().startsWith('timeout') ? TIMEOUT : SKILL_NOT_FOUND`, and
the thrown envelope always carries a truthy `code`, so **every** request-path failure is `TIMEOUT`
(the source recorded `skill.error.code === 'TIMEOUT'` for a 500). Phoenix returned
`SKILL_NOT_FOUND`. This value is invisible on every hub output frame (H-04 noted it) but is stored
verbatim in the speech record's `skill` field, so it becomes observable for the first time here.
`packages/gateway/src/skillClient.js` now returns `TIMEOUT` for the request path; the
"skill does not exist" / "is a robot skill" early returns keep `SKILL_NOT_FOUND`, matching the
reference's early returns.

## Already correct (not gaps)

* Unknown-speaker launches already write `personIDs: ['UNKNOWN']` (`listenTransaction.js:_record`,
  pinned by commit `1f98603`); the H-08 finding text predates that fix. No change needed.
* Outbound history headers already match `JiboHeaders.toHeader()` (all three headers, defaults
  materialized at the transaction boundary). No change needed.

## Not verified / open

* **Excluded case `skillTimeout`.** The reference has an inner 10 s skill budget
  (`SkillRequestMaker`) *and* an outer 10 s timeout; H-04 documented the race. On a hung skill the
  inner timer can win and record a late `{skill:{error:{code:'TIMEOUT',message:'Timeout of 10000ms
  while waiting for "source" response'}}}`. Phoenix has only the outer budget, so its record never
  gains that field. This is the H-04 timeout-layering question surfacing through H-08; not changed
  here.
* `disableAuth` + `recordSpeechHistory` together: the reference null-derefs `ws.auth` in the
  transaction constructor; Phoenix writes `robotID/accountID: undefined`. Unreachable in deployment
  (`recordSpeechHistory` defaults false and the robot authenticates). INFERRED.
* The fire-and-forget failure message is log-only: Phoenix logs `Failed to save speech history
  record: history /v1/speech 500`; the reference's axios text is `Request failed with status code
  500`. Wording only; the swallow-and-log contract is identical.
* No mongod in this environment, so the store is the in-memory/durable-file implementation, not
  Mongo. The wire contract is what is compared.
* The archive's `phoenix` branch (a **later** revision than the pin) adds a
  `recordSpeechLogBucket` sink alongside `recordSpeechHistory`; the pinned `5c0a739053…`
  revision has only `recordSpeechHistory`, so the bucket is out of scope here.

## Falsification

Broke one full line in `packages/gateway/src/listenTransaction.js` — removed the second
`this._saveSpeech();` inside `reject()` (line 598, the `stop() → done() → resolve() →
onTransactionSuccess` save):

```
    this._updateSpeech({ error: err });
    this._saveSpeech();
-   this._saveSpeech();
```

`node --test --test-name-pattern="saves the speech record twice"
packages/gateway/test/listenTransaction.speechHistory.test.js` →
`not ok 1 - a rejected turn records the HubError and saves the speech record twice`
(`expected: 2, actual: 1`). Restored → 11/11 pass.

## Commands

```
node --test packages/gateway/test/listenTransaction.speechHistory.test.js
node --test packages/gateway/test/historyClient.speech.test.js
node --test packages/gateway/test/listen.speechHistory.integration.test.js
npm test
```
