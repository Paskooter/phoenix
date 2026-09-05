# `@be/be` release index

This index records the production BE archives visible in the pinned Jibo archive repository on 2026-09-05 and the source comparison relevant to listening, HJ handoff, the blue ring, Nimbus follow-ups, and speech/display behavior. Archive listing: <https://pvindex.org/repository/skills/jibo-be/>.

## Descending archive inventory

| Releases | Audit status |
| --- | --- |
| 12.0.0 | Archive verified; selected source map and source files recovered. HJ visual path disabled. |
| 11.0.3 | Archive verified; selected compiled bundles, source maps, and `jibo-embodied-dialog`/action-system sources recovered. Matches disabled 11.0.2/12 implementation. |
| 11.0.2 | Archive verified; selected source map and source files recovered. First inspected disabled HJ visual path. |
| 11.0.1 | Archive verified; selected source map and source files recovered. HJ LED/eye path retained; nearest preceding test candidate. |
| 10.0.18, 10.0.17, 10.0.16, 10.0.15, 10.0.14, 10.0.13, 10.0.12, 10.0.11 | Archive listing and selected source-map comparisons. The 10.0.18 embodied-dialog source matched the retained 11.0.1 behavior; Nimbus follow-up cleanup appears from 10.0.13 onward. |
| 10.0.9, 10.0.8, 10.0.6, 10.0.5, 10.0.4, 10.0.3, 10.0.2, 10.0.1 | Archive listed; not downloaded for this focused audit. |
| 9.1.11, 9.1.10, 9.0.4 | Archive listed; not downloaded for this focused audit. |
| 8.11.3 | Archive listed; not downloaded for this focused audit. |
| 2.0.2 | Archive listed; not downloaded for this focused audit. |

Verified archive inputs and recovered source manifests are recorded in [release-comparison.json](evidence/2026-09-05/be-release-audit/release-comparison.json). The concise analysis is in [the BE release audit report](evidence/2026-09-05/be-release-audit/report.md).

## Package streams at the investigated boundary

| BE release | `jibo` | `nimbus` | `be-framework` | `jetstream-client` | `jibo-embodied-dialog` |
| --- | --- | --- | --- | --- | --- |
| 12.0.0 | 15.0.4 | 3.0.4 | 13.0.0 | 3.0.4 | 9.0.4 |
| 11.0.3 | 15.0.3 | 3.0.3 | 12.0.3 | 3.0.3 | 9.0.3 |
| 11.0.2 | 15.0.2 | 3.0.2 | 12.0.2 | 3.0.2 | 9.0.2 |
| 11.0.1 | 15.0.1 | 3.0.1 | 12.0.1 | 3.0.1 | 9.0.1 |
| 10.0.18 | 14.2.9 | 2.2.9 | 11.0.18 | 2.2.2 | 8.0.18 |
| 10.0.16 | 14.2.7 | 2.2.7 | 11.0.16 | 2.2.0 | 8.0.16 |

## Findings for parity testing

The HJ recognition and cloud handoff remain wired in `jibo-embodied-dialog/src/api.ts`; its source hash is unchanged across BE 11.0.1, 11.0.2, and 12.0.0. The loss is in `EmbodiedListen.ts`: 11.0.1 calls `Led.LISTENING` and starts the HJ eye transition, while 11.0.2 and 12.0.0 call `Led.OFF`, return empty engagement promises, and comment out the eye implementation. `Assets.ts` still defines the blue value `[0.05, 0.73, 0.94]`, so the color asset survived while its listening call site was removed.

The nearest preceding candidate for the root-owned robot test is BE 11.0.1:

`.parity/consumers/be-release-audit/downloads/jibo-be-11.0.1.tar.gz`

SHA-256: `1f85e593cf7e868b969d74bed3eef78b447e72207fa4b3892de013aeb3e97d8d`

The joke asset `RA_JBO_TellAJoke_AN_41` is plain TTS with `es_auto_tagging: true` and no explicit screen graphic, so its lack of a joke screen animation is a separate asset property. Nimbus and Jetstream sources do not show a BE12-specific removal. The action-system bundle is byte-identical across 11.0.1–12, but its package option `pegasusProactiveTrigger` changes from true in 11.0.1 to false from 11.0.2 onward; `ActionRuntime` then leaves `proactive` null while `api.checkEnvironmentContext` dereferences it. This is a configuration/source-contract finding for the runtime null and requires no robot code patch.
