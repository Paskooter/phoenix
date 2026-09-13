# Phoenix S-07 public Chitchat boundary proof

Status: **PASS / DEFENSIVE_ONLY**. This bounded executable proof shows that the normal Phoenix parser → `IntentRouter` → `SkillClient` seam does not emit the seven malformed direct Chitchat launch shapes. It is supporting defensive evidence for the seven known malformed memo precedence differences; it does not mark the S-07 routing differential as verified.

The proof ran on Node `v22.22.0`. Its worktree base is `1b9b7fdbf72462b65caf538e206625a11ec8b130`; the pinned root-equivalent routing/chitchat scope revision is `99a758c5d5babe33a1a97d4585e44728efa4e158`. The six scope-file SHA-1 values are recorded in `receipt.json` and match the root-equivalent worktree. No production files were changed: this addition contains only the proof scripts and compact evidence.

The bounded plan has nine rows and captures five outbound `LISTEN_LAUNCH` requests. Three parser controls route valid hot-dogs, semispecific cheddar, and flip-coin launches. Parser no-match and empty text produce `{ intent: null, entities: null, rules: [] }` and do not route. The two null or missing NLU controls also do not route. The two semispecific controls with null or missing entities route to generic `KU_DoYouLike` `ScriptedResponse`; neither emits `SemiSpecificResponse`.

Each captured request retains the exact fixed context, skill, ASR, NLU, and memo shape. The dynamic `msgID` and timestamp are validated at capture and normalized to `<uuid-v4>` and `<number>` in the compact receipt. The proof captures requests through `SkillClient`; it does not hand-build a malformed Chitchat request.

The seven guards are pinned by exact ID and order in the verifier:

| Guard | Boundary evidence |
| --- | --- |
| `malformed-result-omitted` | Normal `SkillClient` launches contain `data.result`. |
| `malformed-result-null` | The captured result is an object. |
| `malformed-result-empty` | The result has `nlu`, `asr`, and `memo`. |
| `malformed-nlu-omitted` | Missing NLU produces no `IntentRouter` decision. |
| `malformed-nlu-null` | Null NLU produces no `IntentRouter` decision. |
| `malformed-semi-entities-omitted` | Missing semispecific entities select only generic `ScriptedResponse`. |
| `malformed-semi-entities-null` | Null semispecific entities select only generic `ScriptedResponse`. |

The falsifier runs the verifier against fresh mutated copies. It rejects paired row and guard omission, a forged captured route MIM, a null captured result, a failed malformed guard, and a forged scope-file hash. All five mutations were rejected. The receipt and mutation summary are `receipt.json` and `falsification.json`.

Validation:

```text
node --check scripts/parity-s07-routing-public-boundary/run.mjs
node --check scripts/parity-s07-routing-public-boundary/verify.mjs
node --check scripts/parity-s07-routing-public-boundary/falsify.mjs
node scripts/parity-s07-routing-public-boundary/verify.mjs --receipt docs/parity/evidence/2026-09-13/s07-routing-public-boundary/receipt.json
node scripts/parity-s07-routing-public-boundary/falsify.mjs --receipt docs/parity/evidence/2026-09-13/s07-routing-public-boundary/receipt.json --summary docs/parity/evidence/2026-09-13/s07-routing-public-boundary/falsification.json
```
