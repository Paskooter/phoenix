# Q-01 GQA Unidecode decision-boundary follow-up

Status: **candidate, unverified; awaiting root review**.

This follow-up starts from `833fcef593e8fa66dfbeaa9b4c6989c4162107d2` in
`codex/candidate-q01-gqa-unidecode-20260907`.  It repairs the opt-in Bing
provider's default Unicode filter.  The source calls `unidecode()` only to
decide whether normalized spoken text is empty or begins with one of the
legacy unhelpful prefixes; it returns the original spoken text unchanged.

## Source contract

The source is `jiborobot/srv-gqa-ws@ebe1a7d38f511570060c1fbf61bec89d58419b26`,
`gqa/bing.py` SHA-256
`116266b442337251569954aba6eac100d141669b44a93801d20a2542799b4d73`.
`extract_spoken_answer` calls `unidecode(spoken_text).strip('.')` at source
lines 106-111, then leaves `spoken_text` Unicode when constructing the
response at lines 115-122.  No Bing query, URL, image or display field is
transliterated by this seam.

The executed source dependency is `Unidecode==1.0.22`, wheel SHA-256
`72f49d3729f3d8f5799f710b97c1451c5163102e76d64d20e170aedbbd923582`, inside
the pinned Python image selected programmatically from
`/home/shell/work/phoenix/.parity/reviews/q01-gqa-era-runtime-20260907/inventory/python36-slim-buster-manifest.json`:

```text
python@sha256:d59ee182c4629dd33b240b9bac1a6ff44276e79e66117eba17aed4016845d3b2
Python 3.6.15, requests 2.18.4, network none except the owned loopback peer
```

The source control executes `gqa.bing.call`,
`gqa.bing.extract_spoken_answer`, `gqa.nlp.clean_parentheses` and the pinned
Unidecode implementation.  Its final 34-row output is
`/home/shell/work/phoenix/.parity/reviews/q01-gqa-unidecode-20260907/source-run/source-output.json`
(SHA-256 `7474af019482276b08ba7f26885464079471cffe8a69275704b6cbd3ca0bcafa`).

## Repair

`gqaUnidecodeFilter.js` and the generated
`vendor/unidecode-1.0.22/gqaUnidecodeFilterData.js` provide a decision-only projection of the pinned
Unidecode tables.  It skips code points that the source drops, retains source
mappings that can form a legacy prefix (including mappings after an earlier
fragment), and uses a private non-prefix marker for mapped-but-unknown output.
That marker matters because one source prefix contains a literal `?`; using
`?` as the fallback can suppress a response that source Unidecode renders as
`[?]`.  The returned Bing speech remains the original string.

The generated data is deliberately not a general transliterator.  It is
derived from the GPLv2+ source wheel and records that provenance in
`SOURCE_UNIDECODE_DATA`; redistribution/licensing is a lead-review item.
Callers can still pass an exact `unidecode` function through the existing
injection option.

## Differential evidence

The paired source/candidate controls are:

```text
python3 /home/shell/work/phoenix/.parity/reviews/q01-gqa-unidecode-20260907/controls/run-source-unidecode.py
python3 /home/shell/work/phoenix/.parity/reviews/q01-gqa-unidecode-20260907/controls/run-candidate-unidecode.py
python3 /home/shell/work/phoenix/.parity/reviews/q01-gqa-unidecode-20260907/controls/compare-unidecode.py
```

The comparison is
`/home/shell/work/phoenix/.parity/reviews/q01-gqa-unidecode-20260907/comparison.json`
(SHA-256 `97645426d49491e89043bf7dd16d9268424e4a2dd2f86002e520ddfbccd4e56c`)
with the following complete ordered result:

```text
34 cases; source/candidate request fields 34/34; HTTP statuses 34/34
before repair: semantic results 19/34
after repair:  semantic results 34/34
```

The pre-repair result is retained as
`candidate-run/candidate-output-before-34.json`; its 15 semantic failures
are the ignored emoji/private-use/formatting cases and Unicode characters
that source transliterates into an unhelpful prefix.  The repaired output is
`candidate-run/candidate-output-after.json` (SHA-256
`6074b8a138e7751aef3ee924b6f2ca570e64bbb9d16360468a3960332734c596`); the
pre-repair output SHA-256 is
`c7b1ec39503c65304f8842abfad371d2f14932da2f6f0eab45112fca4368fa29`.
The pre-repair run is also recorded in
`candidate-run/candidate-before-34-receipt.json`; the earlier 31-row receipt
and output remain preserved separately.
Timestamps and loopback host
ports are retained in raw outputs and excluded only because the peers use
different clocks/authorities.  All result fields, payload Unicode, request
query/path, source headers and response status/content fields are compared.

The table projection was additionally checked against 1,077,263 code points
selected from every source-empty range and every source prefix-relevant
mapping.  The result is
`filter-vectors-result.json`: `exact=true`, `mismatches=[]`.  This is a
source-wheel/data projection check; the integrated provider proof is the
pinned Python 3.6 control above.

Representative boundaries include ordinary accented/Cyrillic/Chinese/Arabic
answers, emoji/private-use/BOM/word-joiner-only text, combining and zero-width
characters, punctuation-only text, transliterated Greek/Cyrillic/fullwidth
“I found this”, ignored emoji between prefix fragments, and an unknown
codepoint inside the `Moist sang ? (Heart) Is` prefix.  No article or phrase
exception was added.

## Candidate validation and limits

In the candidate worktree, the focused Q-01 Bing/GQA/Wikipedia/profile
selection passes 54/54.  The complete `packages/skills/test/*.test.js` run
passes 220/220, including the new decision-boundary and payload-preservation
checks.

This remains an opt-in Bing adapter with no live Bing credential, real Bing
reachability proof, default registry activation, or full provider parity.
The data projection intentionally does not expose arbitrary Unidecode output;
it only covers the predicate the recovered source observes.  The generated
GPLv2+ provenance requires root review before integration.
