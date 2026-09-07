# Q-01 — selectable Wikipedia answer profile

Status: **working candidate; unverified**

Owner: Luna Max

Base: `681988690e349dee3e26271fedd2c7264c17a794`

Worktree: `codex/candidate-q01-gqa-profile-20260907`

Source: `jiborobot/srv-gqa-ws@ebe1a7d38f511570060c1fbf61bec89d58419b26`

This candidate adds an explicit Wikipedia-only answer-service profile. It does
not change the default skill registry or the existing Phoenix answer service.
The profile creates one source-registered `answer` service, uses the source
`/answer_skill/v1/main` route, and keeps `/answer_skill` plus `/v1/main` as
explicit compatibility aliases. Its only provider is the source-shaped
Wikipedia adapter from the preceding Q-01 candidate.

Start it deliberately:

```text
PHOENIX_GQA_PROFILE=wikipedia PORT=9013 \
  node packages/skills/src/index.js
```

`ETCO_gqa_wikiApi`, `ETCO_gqa_wikiTimeoutMs`, and
`ETCO_gqa_wikiUserAgent` configure the endpoint, cancellation deadline, and
request user agent. The gateway profile is selected separately with
`ETCO_hub_skillsConfig=skills-gqa-wikipedia.json`; that file points `answer`
at `http://localhost:9013/answer_skill/v1/main`. It is not selected by
`skills-local.json`, `skills-phoenix.json`, or an unset `PHOENIX_GQA_PROFILE`.

## Boundary checks

`packages/skills/test/q01GqaProfile.test.js` exercises the complete local
gateway client path (`buildComponents` → `SkillClient.launch` → HTTP profile
route → Wikipedia fixture peer) and direct profile startup. The loopback
Wikipedia peer covers a successful page, missing page, malformed JSON, an HTTP
error, and a delayed response that is cancelled by the configured deadline.
The test also loads the explicit gateway registry and verifies the source URL,
and starts the ordinary `answer-skill` path with no profile to prove the
profile is opt-in.

The passing focused commands were:

```text
node --test packages/skills/test/q01GqaProfile.test.js       # 6/6
node --test packages/skills/test/q01Gqa.test.js packages/skills/test/q01Wikipedia.test.js packages/skills/test/start.test.js  # 30/30
node --check packages/skills/src/gqaWikipediaService.js
node --check packages/skills/src/index.js
git diff --check
```

Dependencies were installed in this worktree with
`npm ci --ignore-scripts --offline`; workspace `@phoenix/*` imports resolve
inside this worktree. No historical provider, credential, robot, or live
service was contacted by these tests.

## Qualification and open scope

This is a selectable integration profile, not a claim that the complete GQA
service is finished. The shared GQA route and answer builder remain the
source-backed implementation from `68198869`; root is separately reviewing
its inherited timing and HTTP error-envelope behavior. Bing, Wolfram Alpha,
account lookup, attribution persistence, and the original provider fallback
inventory are deliberately absent from this profile. A Wikipedia provider
failure remains visible through the source GQA error MIM; the source analytics
object retains `source: "Wikipedia"` on provider messages, so its answer
analytics reports `{success: true, type: "wiki"}` while the selected action is
an error prompt. This is the observed source-shaped field behavior, not a
claim that the provider succeeded.

The profile does not enable itself in a default deployment and does not add a
no-op adapter for any unimplemented provider. Root review and an independent
deployment decision are required before use.

## Relation to the frozen functional evidence

The preceding functional candidate `79d002f59f8fd509eaaaa11bcedc5bd975cd10fc`
and its preserved review directory remain unchanged at
`/home/shell/work/phoenix/.parity/reviews/q01-gqa-functional-20260907/`.
Its `comparison.json` records
`candidate_control_sha256=68bbfaf50cf4e3891bc5e5e2b47c187fdb01c7ae8e276ade448045c1ce4c5feb`
and points to the final `candidate-functional-output-5` controls (with the
earlier `candidate-functional-output-3` and `-4` controls retained). That
comparison contains eight shared route rows, fifteen transport rows, and two
timeout rows. It was a selected-field/status comparison: the successful
fixture's analytics category was `entities` on the candidate and `facts` in the
source, and the raw source success bytes were not retained as a complete body.
The calling-client receipt proves Axios 0.17.1 parses the source JSON string;
it does not establish byte-identical HTTP framing. Those limitations remain
visible and are not retagged by this profile.
