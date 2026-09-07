# Q-01 — selectable Wikipedia profile integration follow-up

Status: **working candidate; unverified**

Owner: Luna Max

Base: `ee200b4` (the frozen Wikipedia scanner candidate)

Integrated source candidates: `c1e760ff698c6d62b7e2e8d2a83cfbd11721b509`
(GQA core semantics), `ef4c758073ad82ef6d7d1c9da134e203aea1225d` (GQA NLP
query/filter behavior), and `4c09883855bcf36beba9adc896dda21a86ebb8b4`
(opt-in profile). The follow-up worktree is
`codex/candidate-q01-wikipedia-profile-followup-20260907`.

This candidate keeps the normal skill registry unchanged and adds an explicit
`PHOENIX_GQA_PROFILE=wikipedia` service. It registers the source
`answer` service at `POST /answer_skill/v1/main`, retains the source legacy
`POST /answer_skill` route, and exposes `/v1/main` only as a profile-local
single-service alias. `skills-gqa-wikipedia.json` is a separate gateway
registry; it is never selected by an unset profile or by the default skill
registry.

The profile contains one source-shaped Wikipedia provider. It reads the
explicit `ETCO_gqa_wikiApi`, `ETCO_gqa_wikiTimeoutMs`, and
`ETCO_gqa_wikiUserAgent` settings. The profile adapter maps a message-only
Wikipedia result to an empty provider result before the answer builder. This
matches the observed source `GqaParallelQuery` route controls: a failed or
empty provider contributes no answer, so the route emits the normal
`GQA_no_answer_*` SLIM with `success: false`. The lower-level provider factory
still returns its source/message diagnostic object to direct callers. An
injected random function is shared by provider disambiguation and MIM prompt
selection, preserving the source's single random stream and making controls
reproducible.

## Verification

`packages/skills/test/q01GqaProfile.test.js` now checks the direct profile
HTTP service, the actual gateway HTTP server and `SkillClient` path, the
explicit registry, the unchanged default registry, success, no-result,
disambiguation, article and category blacklist handling, malformed/HTTP/late
provider failures, and missing `X-JIBO-transID` status/media type. The
profile assertions cover the complete action shape relevant to the robot:
skill/version, JCP/SLIM/PLAY, speech, display presence, final and
fire-and-forget flags, analytics, and timing type.

The final local commands were:

```text
npm ci --ignore-scripts --offline
node --test packages/skills/test/q01GqaProfile.test.js                 # 9/9
node --test packages/skills/test/q01GqaProfile.test.js packages/skills/test/q01Gqa.test.js packages/skills/test/q01Wikipedia.test.js  # 43/43
node --check packages/skills/src/gqaWikipediaService.js
node --check packages/skills/test/q01GqaProfile.test.js
git diff --check
```

The final TAP receipts are `profile-tests-final.tap` (9/9, SHA-256
`0672a8da3fb763537086e80c196d63ebb949bfb9a371fad8a77180ec12ef3ca5`),
`combined-tests-final.tap` (43/43, SHA-256
`cdad3c3f23f87cd6a041bc89917e59edb39bbba68d7b63703acb6bd70b528e40`), and
`skills-tests-final.tap` (176/176, SHA-256
`7e30819c29765146ebdbd4f47734d2a5c1a4da8ba7b44b4df293f55c0841da62`).
The candidate source and focused test SHA-256 values are
`ef105d3504c0a52a797e246af4e02adf7d7e1e77e08f320d85bc5e1cf8cfbc19` and
`ea8015d1a3c807de3b49e3a6e06a400cbae7fc72f6bd44dacc55f843b313fa00`.

The source/candidate complete-action control is preserved under
`/home/shell/work/phoenix/.parity/reviews/q01-gqa-wikipedia-profile-followup-20260907/`.
Its final source run is `source-control/run-5`; its final candidate run is
`source-control/candidate-run/candidate-profile.json`; the normalized
comparison is `profile-action-comparison.json`. It compares six constructed
rows (five HTTP 200 actions and one missing-transID 400 response). After
removing only generated message/action IDs and timing values, the result is
`exact-action: 5`, `exact-status: 1`. The action comparison includes speech,
display JSON, analytics, final/fire-and-forget flags, skill/version, and JCP
structure. The 400 diagnostic body is qualified for Flask/Express renderer
wording and charset framing while status and failure media type are retained.

The original side executes the recovered `gqa.gqa`, `gqa.wiki`,
`gqa.pegasus_mims`, and analytics functions from
`jiborobot/srv-gqa-ws@ebe1a7d38f511570060c1fbf61bec89d58419b26` in Python
3.6.15 and Flask 0.12.2. It uses the pinned Python image
`python@sha256:d59ee182c4629dd33b240b9bac1a6ff44276e79e66117eba17aed4016845d3b2`,
manifest SHA-256
`64ca459331e6f34e7116a3f2c63af7bbe9afbcc2fe485f1832a176c294d49328`, and
the source fixture manifest SHA-256
`d78f645dc0245fe95fa637fd07b9edfd710f95b3daa8165e3242a908d10c1aae`.
The locked MarkupSafe 1.0 install failed under the image's available build
tooling, so the wrapper records the explicitly qualified MarkupSafe 1.1.1
compatibility fallback. The recovered Wikipedia package, NLTK stopword and
sentence-tokenizer interfaces, fake external responses, and source config are
named fixture seams; no historical provider or public network was contacted.

The final source invocation and hashes are recorded in
`source-control/run-5/docker-run.json`. Its source control SHA-256 is
`795730ee3b54a52d9a725f613ce1749c0b7c97c74033b18ecda8dd1ca31c3bf8`, and the
unchanged source wrapper SHA-256 is
`d8bd60ca62147c93aca478bb14e71e00abbe793ade29d66721b5b3f10d058d78`.

## Scope and limits

The profile is opt-in and unverified. It supplies Wikipedia only. Bing,
Wolfram Alpha, account lookup, attribution persistence, and the original
multi-provider deployment/fallback inventory remain disabled and explicitly
open. The source route control shows the selected Wikipedia provider's
successful, missing, disambiguation, blacklisted, and failure actions; it is
not evidence that disabled providers or live public answers work. Its
provider-failure row uses the recovered fixture's transport-failure scenario,
while the candidate row uses a 503 Wikipedia peer; they establish the shared
answer-level failure action, not every live-provider failure path. The source
disambiguation choice is pinned to the first source preamble only in the
constructed control; production remains random.

The frozen lower-level Wikipedia evidence remains at
`/home/shell/work/phoenix/.parity/reviews/q01-gqa-wikipedia-20260907/`.
Its provider-level rows are useful source/provider controls, while the new
profile evidence above is the separate complete action comparison. No default
profile, public credentials, robot, main branch, golden, comparator, or live
service was changed.
