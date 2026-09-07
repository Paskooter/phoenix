# Q-01 — functional GQA transport and orchestration

Status: **working candidate; unverified**

Owner: Luna Max

Base: `b0091358d0a9e77d19b490ee8890a13b91f1e5c6`

Worktree: `codex/candidate-q01-gqa-functional-20260907`

Source: `jiborobot/srv-gqa-ws@ebe1a7d38f511570060c1fbf61bec89d58419b26`

This candidate repairs two observable source boundaries in the GQA profile. The
HTTP adapter now evaluates the source request envelope and analytics `type`
before the transID branch, preserves Flask's first value when Node has folded
duplicate `X-JIBO-transID` fields, and exposes source-status 400/500 responses
for parsed body-shape failures. The common service has one route-scoped
`jsonStrict = false` opt-in; every other service keeps its strict parser. This
lets GQA reach the source 500 branch for JSON `null`, arrays, numbers, strings,
and booleans without changing shared transport defaults.

The provider pipeline now follows the source `GqaParallelQuery` group loop:
Bing and Wikipedia start together with a 3-second deadline, Wolfram Alpha
starts after that group fails or times out with a 4-second deadline, and a late
first-group answer can still win while the second group is active. Provider
exceptions remain private no-answer failures. Request field access was reordered
to match the source query, location, IP, NLU type, account, then cleaning
sequence.

The pinned calling-client source was inspected in the private receipt
`/home/shell/work/phoenix/.parity/reviews/q01-gqa-functional-20260907/calling-client-proof.json`:
`SkillRequestMaker` posts `jiboHeaders.toHeader()` and returns Axios
`response.data`; `JiboHeaders` emits lower-case `x-jibo-transid`; pinned Axios
0.17.1 parses any JSON string in `transformResponse`, regardless of the
server's content type.

## Validation

Candidate-local dependencies were installed with `npm ci --ignore-scripts --offline`.
The resulting `node_modules` is a directory inside this worktree, and every
`@phoenix/*` package resolves to this worktree. The machine-readable receipt is
`/home/shell/work/phoenix/.parity/reviews/q01-gqa-functional-20260907/dependency-resolution.json`.

Focused checks passed:

```text
node --test packages/skills/test/q01Gqa.test.js       # 19/19
node --test packages/skills/test/*.test.js            # 151/151
node --check packages/skills/src/gqaAnswerSkill.js   # exit 0
node --check packages/skills/src/index.js            # exit 0
node --check packages/common/src/service.js          # exit 0
git diff --check                                      # exit 0
```

The source control ran once in the inferred pinned era runtime and was not a
host-Flask substitution:

* image: `python@sha256:d59ee182c4629dd33b240b9bac1a6ff44276e79e66117eba17aed4016845d3b2`
  (Python 3.6.15/Flask 0.12.2; Python choice inferred because the recovered
  Dockerfile says only `python:3`);
* source-locked Flask/Werkzeug/Jinja2/requests artifacts were installed;
  source MarkupSafe 1.0 failed on removed `setuptools.Feature`, so the recorded
  cp36 MarkupSafe 1.1.1 wheel was used as an inferred compatibility fallback;
* source command receipt:
  `controls/source-functional-run-5/docker-run.json`, exit `0`, 17.651s,
  network `none`;
* source control hash:
  `21e022da1a675f7db1625994ac2a65d6775339c3480fef982b75dea6b481e905`;
* source raw stdout hash:
  `controls/source-functional-run-5/docker-run.stdout`,
  `0cddad1b0a366c47bd087d1937b515164ebc8b7893fb83d6af45ee6b07640fe8`.

The source and candidate controls are preserved under
`/home/shell/work/phoenix/.parity/reviews/q01-gqa-functional-20260907/`.
The final comparison is `comparison.json`:

* 8 shared route cases: status `8/8`, selected MIM/source `7/8` (the missing
  transID case has no response object to select);
* 15 identical transport cases covering missing/type-less headers, malformed
  JSON with and without headers, empty entity, null/array/number/string/boolean
  JSON, absent content type, `text/plain`, empty transID, and duplicate transID:
  status `15/15`;
* 2 timeout cases with unchanged source 3/4-second deadlines: status and
  selected source `2/2`; first-group timeout falls to Wolfram and a late Bing
  answer wins the second-group race.

The source fake providers are recovered local fixtures only. No historical
provider, credential, archived service, robot, or live network was contacted.

## Remaining scope

Raw HTTP framing is not byte-identical: Flask returns its JSON string as
`text/html`, while Phoenix sends the same machine object as
`application/json`; pinned Axios 0.17.1 parses either form. Flask diagnostic
HTML and Node stack/message text remain runtime-specific and are not treated as
compatibility failures under `docs/parity/COMPATIBILITY.md`.

Real Bing/Wikipedia/Wolfram HTTP adapters, account lookup, attribution
persistence, banned-word filtering, deployment configuration, and the exact
historical provider environment remain outside this bounded transport and
orchestration repair. The source control uses named local fake-provider and
support-module seams recorded in its raw output. Root review and integration
are required; this candidate is not parity-verified.
