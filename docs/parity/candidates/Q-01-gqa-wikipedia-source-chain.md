# Q-01 — Wikipedia profile source-chain follow-up

Status: **working candidate; unverified**

Owner: Luna Max

Base: `96e913615af535730ea8888496e1b41c5f02fd68`

Worktree: `/home/shell/work/phoenix/.parity/worktrees/q01-wikipedia-profile-source-chain`

Source revision: `jiborobot/srv-gqa-ws@ebe1a7d38f511570060c1fbf61bec89d58419b26`

This follow-up keeps the Wikipedia profile opt-in and adds the source
provider timing phase boundary. The source `GqaParallelQuery` records a
`wikipedia_fork` timestamp before its worker starts; `wiki_tokenization` is
fork minus tokenization start, and `wiki` is provider response minus fork.
The profile now retains both measured keys instead of folding tokenization
into the network timing. The deterministic regression uses a clock sequence
and verifies `wiki=0.005`, `wiki_tokenization=0`, and `total=6`.

## Actual source-chain control

The source control executes the recovered Python route and the actual
`wikipedia==1.4.0` package against a controlled loopback MediaWiki HTTP peer.
It does not replace `WikipediaPage`, `requests.get`, JSON decoding, page
loading, category handling, disambiguation HTML parsing, or sentence
tokenization. The NLTK side uses the recovered NLTK 3.2.5 source, the PY3
English Punkt model, and the complete 198-entry English stopword corpus.

The source runtime is Python 3.6.15 and Flask 0.12.2 in the image selected
programmatically from:

```text
/home/shell/work/phoenix/.parity/reviews/q01-gqa-era-runtime-20260907/inventory/python36-slim-buster-manifest.json
image: python@sha256:d59ee182c4629dd33b240b9bac1a6ff44276e79e66117eba17aed4016845d3b2
manifest SHA-256: 64ca459331e6f34e7116a3f2c63af7bbe9afbcc2fe485f1832a176c294d49328
```

The locked MarkupSafe 1.0 wheel could not build with the image's available
tooling; the run records the inferred compatibility fallback to MarkupSafe
1.1.1. The six 1.10.0 wheel is also an inferred transitive dependency. The
source revision, Python image, dependency installation, package/data hashes,
and complete Docker argv are recorded in
`/home/shell/work/phoenix/.parity/reviews/q01-gqa-wikipedia-source-chain-20260907/source-run-actual-package-4/docker-run.json`.

The successful source command was:

```text
python3 /home/shell/work/phoenix/.parity/reviews/q01-gqa-wikipedia-source-chain-20260907/controls/run-source-wikipedia-package-profile.py
```

The wrapper read the image digest from the manifest, used `--network none`,
mounted the route/provider/package/data trees read-only, and gave only its
output directory write access. Earlier attempts are preserved as
`source-run-actual-package`, `-2`, and `-3`; their exits record wrapper
compatibility/data/path mistakes and are not presented as source results.
`source-run-actual-package-4` exited 0 in 22.076 seconds. Its source control
SHA-256 is
`4ea3837c7a3b7448319c7fa98b11847c1dc89756c5e5d35516891760d3e2c4af` and its
stdout SHA-256 is
`12593149948f97a74642ee60b9fffab2570f0ba9699b2ee1cabe744a030ae8f5`.

The source primary rows cover success, no-result, disambiguation, article
blacklist, category blacklist, upstream 503, malformed JSON, and missing
transaction ID. The actual package made 1, 1, 3, 0, 1, 1, 1, and 0 MediaWiki
requests respectively. The source run also contains three direct decoder
rows and banned-word/transport controls; those extra rows are retained but
excluded from the eight-row profile comparison.

## Candidate comparison

The candidate command was:

```text
Q01_OUTPUT_DIR=/home/shell/work/phoenix/.parity/reviews/q01-gqa-wikipedia-source-chain-20260907/candidate-run-actual-package-3 \
  node /home/shell/work/phoenix/.parity/reviews/q01-gqa-wikipedia-source-chain-20260907/controls/candidate-profile-control.mjs
```

It imports the candidate service from this worktree, uses the same eight
scenario IDs and request order, and sends the corresponding controlled
MediaWiki responses over loopback HTTP. It exited 0; the captured candidate
JSON SHA-256 is
`e582618f4dc2ff58a494f2b8316fbba7299b7b13448b59c9c0fe5f9872ce7544`.

The comparison command and final result are:

```text
python3 /home/shell/work/phoenix/.parity/reviews/q01-gqa-wikipedia-source-chain-20260907/controls/compare-constructed-profile.py \
  --source /home/shell/work/phoenix/.parity/reviews/q01-gqa-wikipedia-source-chain-20260907/source-run-actual-package-4/docker-run.stdout \
  --candidate /home/shell/work/phoenix/.parity/reviews/q01-gqa-wikipedia-source-chain-20260907/candidate-run-actual-package-3/candidate-profile.json \
  --output /home/shell/work/phoenix/.parity/reviews/q01-gqa-wikipedia-source-chain-20260907/source-candidate-comparison-final.json
```

`source-candidate-comparison-final.json` reports 8/8 case count, identity,
and order agreement; 7 `exact-action` rows and 1
`exact-status-diagnostic-qualified` row. All eight statuses match: seven
200 action responses and the missing-transID 400. Action bodies are compared
completely after only these validated generated-field rules:

* the top-level response `msgID` must be a lower-case UUIDv4, then is replaced
  by a bijective generated-ID sentinel;
* only JCP command-container IDs at `data.action.config.jcp.id` and its direct
  `config.play`/`config.listen`/`config.display` children must be lower-case
  32-hex IDs, then are replaced by a bijective sentinel;
* the top-level `timings` object must retain its exact keys, and every value
  must be finite, numeric, and non-negative before values are replaced by a
  timing sentinel.

Nulls, semantic and display IDs, analytics, action structure, speech, status,
response fields, and field presence remain compared. A negative timing,
invalid UUID, semantic prompt change, inserted null, changed status, and
reordered cases are each rejected by the repeatable checks in
`checks/comparator-self-check.json` (exit 0; comparator self-check stdout is
also retained beside it).

The source 200 action responses carry Flask's `text/html; charset=utf-8`
media type for JSON text, while the candidate uses
`application/json; charset=utf-8`. This is retained as an explicit wire
observation rather than normalized away. The 400 rows have the same
`text/html` media type but differ in charset framing/diagnostic rendering.
The source and candidate parsed machine-readable action bodies and statuses
match under the rules above; raw body bytes and these media-type differences
are not claimed byte-identical.

## Verification and limits

The final focused test command was:

```text
node --test packages/skills/test/q01GqaProfile.test.js
```

It passed 11/11. The TAP receipt is
`/home/shell/work/phoenix/.parity/reviews/q01-gqa-wikipedia-source-chain-20260907/checks/profile-source-chain-focused.tap`.
The combined GQA/Wikipedia suite passed 45/45, and the complete skills test
glob passed 178/178; receipts are retained as
`checks/profile-source-chain-combined.tap` and
`checks/skills-source-chain-all.tap` in the same review directory. The prior
176/176 receipt from the frozen profile candidate remains unchanged for
historical comparison. The present product delta is limited to provider
timing phase capture and its focused regression.

The earlier constructed profile evidence remains separate and immutable at
`/home/shell/work/phoenix/.parity/reviews/q01-gqa-wikipedia-profile-followup-20260907/`.
Its broad comparator reported 5 exact actions plus 1 status row, but it used a
fixture Wikipedia adapter and simplified NLTK seam. That 5+1 result is
historical constructed evidence and is not combined with this actual-package
chain result.

The source route still has explicit seams for disabled Bing and Wolfram
transport, fixture account response, attribution persistence, AP/API-AI,
and other unused modules. No historical provider or public network was
contacted. Therefore this control establishes the recovered Wikipedia/NLTK
path and selected answer behavior only; it does not establish the complete
multi-provider GQA deployment, live public Wikipedia operation, account or
attribution behavior, or a default profile rollout. Root review and an
independent integration capture remain required.
