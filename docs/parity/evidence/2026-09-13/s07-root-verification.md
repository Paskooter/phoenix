# S-07 root verification

## Decision

S-07 is **VERIFIED** against original Pegasus revision
`5c0a7390539663ba749d360de348a428c088505c`. Root reviewed the complete
routing, MIM-library, context, order, weighted-prompt, and host-continuation
lanes; reproduced their central checks; rejected two earlier weighted
receipts after adversarial review found fail-open comparisons; and accepted
only the hardened lane at Phoenix integration revision `1a475b1`.

| Written criterion | Result | Evidence |
| --- | --- | --- |
| Intent/entity/memo branches, semispecific categories, fallback and deflection | **VERIFIED** for the public consumer boundary | The routing closure retains 4,808 rows: 4,801 exact supported rows and seven explicitly accepted malformed internal-request differences. The separate public-boundary proof shows those seven shapes cannot be emitted by the normal parser -> `IntentRouter` -> `SkillClient` path. The order lane exhaustively covers all 8,186 semispecific mappings and 120 overlaps. |
| Fun-and-games transformations, weighted and conditional prompts | **VERIFIED** | The weighted lane retains 23,387 contexts and 132,967 rows per side with zero source errors, candidate errors, or observable differences. It covers every one of 4,424 MIMs, 11,883 prompt IDs, Dice/Coin RNG, exact lower/interior/total boundaries, conditions, fallback, exact ESML, authored MIM aliases, `autoRuleConfig`, JCP, normalized SLIM, analytics, and action/no-action envelopes. Twenty-eight comparator falsifiers and two aggregate falsifiers pass. |
| Identity, emotion, birthday and seasonal output | **VERIFIED** | The library/context and weighted receipts compare exact prompts, MIMs, ESML, JCP, analytics and context-dependent output. The dedicated PromptData and DateTime boundaries, MIM identity lane, and exact source condition inventory cover these values. |
| Multi-turn paths | **VERIFIED by the source contract** | All 4,424 source MIMs are announcements with `final: true`; the source graph has no Chitchat-owned question or optional-response continuation. Four representative scripted, emotion, semispecific and fallback launches match, and retained-session host updates terminate as `Success`/`Done` with no action. |
| Complete parser corpus | **Owned by verified N-08** | N-08 owns the 10,035-row utterance/parser corpus and the accepted N1 intent residuals. S-07 retains its assigned 120 MIM/identity rows: three repaired native entity collisions and 117 classified MIM-only rows. S-07 does not claim a duplicate full parser replay. |

## Accepted malformed-request difference

Root accepts seven source-versus-Phoenix precedence differences as defensive
behavior outside the public S-07 contract:

- `result` omitted, null, or empty;
- `result.nlu` omitted or null;
- semispecific `result.nlu.entities` omitted or null.

The original skill throws while reading these malformed direct
`LISTEN_LAUNCH` requests. Phoenix either reports the missing memo or retains a
defensive memo/fallback result. The public-boundary receipt proves that
`SkillClient` constructs `result` with `nlu`, `asr`, and `memo`; missing/null
NLU produces no route; and missing/null semispecific entities route to the
generic known-unknown response rather than the semispecific launch. Its five
falsifiers reject omitted rows, forged routes/results/guards, and scope-hash
changes. Exact original error precedence for manually injected internal
requests is therefore waived; the candidate behavior is an accepted
robustness improvement.

## Weighted source oracle and adversarial review

The accepted weighted receipt uses original Node `v8.9.4` and candidate Node
`v22.22.0`. All source and candidate receipts pin the original MIM tree digest
`dfc7e6db41c072ef01f431736df5b00abd2f8cff469593fc51b0d1fb977f28ca`.
The source eligibility oracle independently supplies exact prompt ESML,
`autoRuleConfig` presence/value, authored output-MIM aliases, and prompt VM
call counts. It also records the exact six source prompt-resolution error
tuples totaling 46; those source failures resolve to empty ESML and match in
Phoenix.

The first adversarial review rejected paired response-envelope, analytics,
JCP, RNG, inventory and aggregate-receipt blind spots. A second review then
rejected paired ESML, `autoRuleConfig`, and authored-alias mutations. After
both repairs, all 28 named comparator mutations fail with diagnostic receipts,
the aggregate independently reruns all 24 comparators, and an independent
reviewer replayed the three formerly passing attacks and returned **ACCEPT**.

The weighted receipts were generated against production revision
`dd2199d0b7f5bff6a5bf799b7e2a115e8e0385ec`. Root binds them to integrated
revision `1a475b1` because the following command reports an empty diff for the
complete S-07 runtime surface:

```text
git diff --quiet dd2199d..1a475b1 -- packages/gateway/src/intentRouter.js packages/gateway/src/skillClient.js packages/gateway/resources/skills/skills-local.json packages/nlu/src/requestParser.js packages/nlu/src/chitchatEntityNormalization.js packages/skills/src/chitchatSkill.js packages/skills/src/chitchat packages/skills/src/graph/mims packages/skills/src/graph/graphSkill.js packages/skills/src/report/dateTime.js packages/skills/src/report/analytics.js
```

The only intervening production change is the independently verified S-12
calendar end-date formatter, which is outside every Chitchat dependency above.

## Evidence index

- [Routing closure](s07-routing-closure/review.md), including its
  [receipt](s07-routing-closure/receipt.json),
  [falsification](s07-routing-closure/falsification.json), and
  [native normalization differential](s07-routing-closure/normalization-differential.json)
- [Public malformed-boundary proof](s07-routing-public-boundary/review.md),
  [receipt](s07-routing-public-boundary/receipt.json), and
  [falsification](s07-routing-public-boundary/falsification.json)
- [PromptData/DateTime boundaries](s07-boundaries/review.md),
  [library/context differential](../../reviews/s07-library-context/review.md),
  [context review](s07-context/review.md), and
  [semispecific order proof](s07-order/review.md)
- [MIM identity/native collision review](s07-mim-identity/review.md) and
  [N-08 parser ownership](n08-routing-closure/review.md)
- [Host continuation review](s07-followup/review.md),
  [inventory](s07-followup/inventory.json),
  [differential](s07-followup/differential-receipt.json), and
  [falsification](s07-followup/falsification.log)
- [Weighted review](../../reviews/s07-weighted/review.md),
  [differential summary](../../reviews/s07-weighted/differential-summary.json),
  [28 falsifiers](../../reviews/s07-weighted/falsification-summary.json),
  [aggregate falsifiers](../../reviews/s07-weighted/aggregate-falsification-summary.json), and
  [101-file manifest](../../reviews/s07-weighted/raw-receipt-manifest.json)

## Root validation

Root independently ran the routing-closure aggregator and falsifier, the
public-boundary verifier and falsifier, the representative continuation test,
a hardened weighted batch comparator, all 28 weighted comparator falsifiers,
and the complete 24-batch weighted aggregate. The final weighted result is
132,967 rows per side with zero errors and zero observable differences. The
isolated weighted worktree passed 1,981 tests with nine skips and the strict
43-case production gate with zero differences, invariants, or gaps.

After integration, root ran the 32 focused S-07 checks, the complete unit
suite (1,996 passed and nine skipped out of 2,005), `npm run parity:check`, and
`npm run parity:gate`. All passed; the generated ledger reports 66/79 verified
and the strict production gate remains 43/43 with zero differences, invariant
failures, or coverage gaps.
