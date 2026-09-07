# Q-01 GQA Unidecode projection repair

Status: **candidate, unverified; awaiting root review**.

This follow-up starts from `cc77f73c9c32252955b731e3042d8b39743d8ed9` in
`codex/candidate-q01-gqa-unidecode-repair-20260907`. It repairs the opt-in
Bing provider's decision-only Unidecode projection in two source-observable
ways:

- Per-codepoint output made only of periods is retained until the complete
  normalized string is assembled. The source may map a character to `.`, `..`
  or `...`; those periods disappear at the final edge but remain significant
  when internal. Truly empty mappings remain omitted.
- The assembled normalized string is stripped of leading and trailing ASCII
  periods before the fixed unhelpful-prefix check, matching
  `unidecode(spoken_text).strip('.')` in the recovered Python source.

The source is `jiborobot/srv-gqa-ws@ebe1a7d38f511570060c1fbf61bec89d58419b26`,
`gqa/bing.py` SHA-256
`116266b442337251569954aba6eac100d141669b44a93801d20a2542799b4d73`.
The source call is at lines 106–111 of that file. It executes in the pinned
`python@sha256:d59ee182c4629dd33b240b9bac1a6ff44276e79e66117eba17aed4016845d3b2`
image, Python 3.6.15, requests 2.18.4 and Unidecode 1.0.22. The Unidecode
wheel SHA-256 is
`72f49d3729f3d8f5799f710b97c1451c5163102e76d64d20e170aedbbd923582`.

The source/candidate control set is
`/home/shell/work/phoenix/.parity/reviews/q01-gqa-unidecode-repair-20260907`.
It contains the original 34 controls plus 176 constructed composition rows:
all 19 period-only mappings found in the pinned wheel, leading/trailing and
internal period cases, ignored-character composition, and leading/trailing,
both-edge and internal-period cases for all 17 legacy unhelpful prefixes.
The source control runs the recovered `gqa.bing.call` and decoder against an
owned loopback HTTP peer; no historical provider or credential is used.

The unchanged source and candidate outputs have 210 ordered IDs. The source
run exited 0 in 71.4 seconds. With the query fixture corrected, the frozen
`cc77` projection matched 131/210 semantic results; the repaired candidate
matched source results, raised values, selected request fields, and statuses
210/210. The complete comparison is
`comparison.json` (SHA-256
`c2251667e68c04a0735c7744815865e013b0330582419307e27fe922826ef9d3`).
The hash-checked run manifest is `manifest.json` in the same evidence
directory.
Raw source and candidate outputs remain available there; timestamps and
loopback authority differences are retained in raw data and are excluded only
from the semantic comparison.

The generated table now records 201 empty ranges and 8,530 retained mappings.
An exhaustive 1,077,263-row source-wheel decision vector is exact after the
repair (`filter-vectors-result.json`, `exact: true`). The generated table is
still a predicate projection, not a general transliterator, and its GPLv2+
source-data provenance remains a lead-review item.

Focused `q01BingProvider` tests pass 13/13, including every legacy prefix and
the internal-versus-edge period boundaries. The full skills test set passes
221/221 under Node v22.22.0. There is no live Bing reachability, default
registry activation, or full provider parity claim in this candidate.

Reproduction commands:

```text
cd /home/shell/work/phoenix/.parity/reviews/q01-gqa-unidecode-repair-20260907
python3 controls/run-source-unidecode.py
python3 controls/run-candidate-unidecode.py
python3 controls/compare-unidecode.py
node controls/validate-filter-vectors.mjs
python3 controls/run-candidate-tests.py
```

All old `cc77` source/candidate receipts and the root challenge evidence are
left unchanged. Root review is still required for generated source-data
licensing and integration.
