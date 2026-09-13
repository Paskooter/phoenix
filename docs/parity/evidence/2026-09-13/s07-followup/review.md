# S-07 Chitchat follow-up boundary

Status: **bounded evidence only; S-07 remains open.** The pinned Chitchat graph has no skill-owned continuation prompt. The compact host-dispatch check passes for four representative launch paths and their synthetic retained-session `LISTEN_UPDATE`; no production change is indicated by this result.

## Source conclusion

The source is the local Pegasus ref `5c0a7390539663ba749d360de348a428c088505c` at `/home/shell/work/phoenix/.parity/reference/5c0a7390539663ba749d360de348a428c088505c`, executed in `node@sha256:8233daae003ba0ecba4e6d70cab8525c30a3f085935afc624a275892ebe23f7c` (`v8.9.4`). No web source was used.

`packages/chitchat-skill/src/Chitchat.ts:56-85` creates one `ANFactory` subgraph with `final: true` and sends every `ProcessQuery` transition, including scripted, emotion, semispecific, and `ErrorResponse`, to it. The source `ANFactory.ts:12-31` contains one announcement node; `ANNode.ts:19-38` renders the action, returns the configured final flag, and exits only through `Success`. `Slimmer.ts:37-54,196-200` emits `listen` only for `question` or `optional-response` MIM types. Therefore an announcement-only Chitchat inventory cannot ask a skill-owned follow-up.

The source `ProcessQueryNode.ts:31-110` resolves the memo, semispecific category, or `CC_Fallback`, records query/emotion analytics, and returns a transition. The generic source `GraphSkill.ts:70-84,100-133` dispatches `LISTEN_LAUNCH` to `GraphManager.start` and `LISTEN_UPDATE` to `GraphManager.exitNode`; a node with no next action returns terminal `SKILL_ACTION` with `action: null`, `final: true`, and `fireAndForget: true`. Phoenix mirrors these boundaries in `packages/skills/src/chitchatSkill.js:151-185`, `graph/mims/factories.js:64-79,264-277`, `graph/mims/slimmer.js:105-110,171-183`, and `graph/graphSkill.js:108-145`.

## Complete MIM inventory

The inventory script parses every source and candidate Chitchat `.mim` file before comparing runtime receipts.

| side | files | prompts | type counts | tree digest | MIM ID digest |
| --- | ---: | ---: | --- | --- | --- |
| pinned source | 4,424 | 11,883 | 4,369 scripted / 54 emotion / 1 core; 4,424 announcement | `928b8c1a714a54ea0df46af02cef989ce0a4706c4d486bc6d849a9bd3bd25190` | `81a89fe41266295232e4bfdd0abd287b3d4a5efd1c1fcfff373a4a3251c5eb9b` |
| candidate | 4,424 | 11,883 | 4,369 scripted / 54 emotion / 1 core; 4,424 announcement | same | same |

Both sides have zero malformed files, `allAnnouncement: true`, and `sameTree: true`. This is the complete Chitchat MIM inventory for the pinned source and candidate resource trees; it is not a claim about the broader S-07 manifest.

## Four-row host boundary

The matrix deliberately has exactly four IDs: `scripted-announcement`, `emotion-query-announcement`, `semispecific-announcement`, and `fallback-deflection`. Each launch receipt is checked for `SKILL_ACTION`, `final: true`, a JCP 2.0 SLIM with one PLAY/ESML/MIM record, `listen: false`, `display: false`, no listen/display effect, retained session/trace/transition data, and the expected transition, MIM, and analytics query type. Each retained-session update is checked independently for `SKILL_ACTION`, `final: true`, `fireAndForget: true`, `action: null`, empty MIM/effect lists, terminal `Success`/`Done` transitions, and empty update analytics.

| ID | source transition | expected launch MIM | query analytics |
| --- | --- | --- | --- |
| scripted-announcement | `ScriptedResponse` | `RI_JBO_LikesPenguins` | `scripted_response` |
| emotion-query-announcement | `EmotionQuery` | `OI_JBO_IsHappy` | `emotion_query` |
| semispecific-announcement | `SemiSpecificResponse` | `RI_JBO_Likes_SS_Cheese` | none |
| fallback-deflection | `ErrorResponse` | `CC_Fallback` | `scripted_response`, success `false` |

The source and candidate receipts each contain all four rows with separate launch/update error fields. The fail-closed comparator reports `rows: 4`, `differences: 0`, and `errors: 0`; it also verifies the pinned source revision/runtime/image, candidate revision/runtime, exact inventory digests, runner byte hashes, complete response fields, and descriptor expectations. The six falsifiers reject paired row omission, launch action omission, update trace omission, launch effects omission, ESML mutation, and paired MIM/transition corruption.

These updates exercise the generic host exit path after an announcement has completed. They do not establish a source skill-owned follow-up request, because the source graph has already returned a final announcement and contains no question/optional-response MIM. They also do not prove every conditional prompt branch, the full S-07 manifest, or hardware behavior. No production repair is justified by this boundary result.

Receipts and commands are kept beside this review: `matrix-spec.json`, `inventory.json`, `source-runtime.json`, `candidate-runtime.json`, `differential-receipt.json`, and `falsification.log`. The focused regression test reads these receipts and preserves the four-row/terminal-update boundary.
