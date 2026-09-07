# Q-01 GQA Bing provider candidate

Status: **candidate, unverified; awaiting root review**.

This candidate adds an opt-in Bing provider adapter. It does not register Bing in the default Phoenix profile and it does not contain a live API key or a live-provider fallback. A caller must provide the source deployment endpoint (`CONFIG_DICT["bing_api"]`) explicitly when constructing `createBingProvider`.

## Source contract

The implementation is based on `jiborobot/srv-gqa-ws@ebe1a7d38f511570060c1fbf61bec89d58419b26`, recovered module `gqa/bing.py` (SHA-256 `116266b442337251569954aba6eac100d141669b44a93801d20a2542799b4d73`). The relevant source boundaries are:

- `extract_spoken_answer`, lines 53-135: first ranked answer selection, WebPages/Images/Videos/Lyrics rejection, US/Canada answer-type licensing, lower-first-letter answer lookup, `unidecode`/boilerplate/parentheses cleanup, spoken response and screenshot URL projection.
- `call`, lines 138-171: country gates, US-territory and Canada market mapping, ordered query parameters, client-IP and optional search-location headers.
- `call`, lines 172-197: request/response timestamps and the visible `Unexpected exception: ...` provider result for request/status/JSON failures.
- `call`, lines 204-215: returned `BingAPIs-Market` controls decoding, missing market remains an uncaught boundary, and responses without a screenshot receive the Bing search URL.

The source `gqa/nlp.py:74-84` iterative `clean_parentheses` implementation is also represented. Its recovered SHA-256 is `6745ad3cbf648282d71ee732c2198652c47daeda8998bf69929a3a927587178b`.

The candidate implementation is [gqaBingProvider.js](../../../packages/skills/src/gqaBingProvider.js). It exports `createBingProvider` for the existing GQA provider seam and `extractBingSpokenAnswer` for direct source-shaped decoding. It preserves the source's request field order, country/license gates, returned-market selection, empty-result behavior, screenshot paths, fallback URL, timestamp fields, and uncaught missing-market/decoder boundary. HTTP status 3xx is left to the transport's redirect behavior, matching `requests.raise_for_status()` rather than treating every `fetch.ok === false` response as an error.

## Offline source control

The source control uses an owned loopback HTTP peer inside a pinned, network-isolated Python container. No historical Bing endpoint or credential was contacted. The source runner is:

```text
python3 /home/shell/work/phoenix/.parity/reviews/q01-gqa-bing-provider-20260907/controls/run-source-bing.py
```

It reads the image digest from `q01-gqa-era-runtime-20260907/inventory/python36-slim-buster-manifest.json` instead of embedding a manually typed digest. The final Docker receipt is `controls/source-run-v4/docker-run.json` and reports:

- image `python@sha256:d59ee182c4629dd33b240b9bac1a6ff44276e79e66117eba17aed4016845d3b2`, selected `linux/amd64`;
- inferred compatibility runtime Python 3.6.15, `requests==2.18.4`;
- pinned `Unidecode==1.0.22` wheel SHA-256 `72f49d3729f3d8f5799f710b97c1451c5163102e76d64d20e170aedbbd923582`;
- source container exit 0, elapsed 5.631 seconds, `--network none`, read-only source/dependency mounts;
- all source and candidate control output remains under the private review directory.

The final source output is [source-output.json](../../../../../reviews/q01-gqa-bing-provider-20260907/controls/source-run-v4/source-output.json), SHA-256 `c690df5dde1f85ac3070ad26ea13965d1b4275a5a0932d4a2230f32ae4375c66`. The candidate output is [candidate-output-v4.json](../../../../../reviews/q01-gqa-bing-provider-20260907/controls/candidate-output-v4.json), SHA-256 `ac3315bca89cceb6dbd9e88a6f574b10555e59332aed2d6997652217b1160c10`. The ordered comparison is [comparison-v4.json](../../../../../reviews/q01-gqa-bing-provider-20260907/controls/comparison-v4.json), SHA-256 `b5d44e9904b95781d8a1a601ce8e2ac88bf7f79ab9988c2575dcc25bccebe19e`.

The comparison contains these 16 source-shaped cases, in order:

```text
us-facts, entities, sports-team, empty, answer-blacklisted,
unhelpful-spoken-text, suppression-and-parentheses, unicode-spoken-text,
unknown-us-type, canada-disallowed-type, market-mismatch, http-error,
malformed-json, missing-country, unsupported-country, missing-market-header
```

The source/candidate loopback control reports 16/16 request matches on source fields and 16/16 result matches after two explicit runtime qualifications:

- `bing_request` and `bing_response` are retained in both raw outputs and excluded from semantic equality because they are clock values;
- Python traceback text versus JavaScript `Error` text is retained in both raw outputs and classified as the same request/parse exception boundary. The missing `BingAPIs-Market` case likewise retains the source `AttributeError` and candidate `TypeError` as an uncaught missing-header boundary.

Query/path, status, relevant request headers, response market/content headers, licensing results, result field presence/order and payload values are compared. Runtime-generated default HTTP headers and loopback host/port are recorded but are not asserted as cross-runtime provider semantics.

## Tests

The candidate worktree has its own `node_modules` links; `@phoenix/common`, `@phoenix/contracts` and `@phoenix/skills` resolve to this worktree. Focused validation passed:

```text
node --test packages/skills/test/q01BingProvider.test.js
11 passed, 0 failed

node --test packages/skills/test/q01BingProvider.test.js packages/skills/test/q01Wikipedia.test.js packages/skills/test/q01Gqa.test.js
45 passed, 0 failed
```

The product file hashes at the recorded candidate state are:

```text
8e2755b3030ca02e62d30abff6aceb99a0ca2b3bd38749a3885edd326db93017  packages/skills/src/gqaBingProvider.js
d31265af99a733ee37bd68d4f3ec33957e9b1021fa6d02f7c472557c2460dd4f  packages/skills/src/index.js
7b8888afe8b1b74d6acb2564f659176d59039ba3690153b6e23997366d697709  packages/skills/test/q01BingProvider.test.js
```

## Limits

This is a bounded adapter candidate, not full Q-01 provider parity. It has no default profile wiring, no real Bing reachability test, and no live credential. The adapter accepts an exact `unidecode` function for source-compatible deployment, while its default uses a conservative NFKD/ASCII-marker implementation. The packaging follow-up vendors the decision-only projection at `packages/skills/src/vendor/unidecode-1.0.22/`; that table is not a general transliterator. The source controls used the exact pinned `Unidecode==1.0.22` package. Python traceback wording, JavaScript error wording and runtime HTTP default headers remain qualified as above; semantic status, request, licensing and result behavior remain asserted. No Bing answer content, image, dimension or credential is invented by this candidate.
