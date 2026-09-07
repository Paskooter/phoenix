# Q-01 selectable default GQA wiring — candidate

Status: **unverified; pending root review**.

This candidate wires the accepted source-backed Bing/Wikipedia/Wolfram provider
pipeline into the shared Phoenix skills host and its gateway registry as an
explicit deployment profile. Set `PHOENIX_GQA_DEFAULT_PROFILE=multi-provider`
and provide the source provider configuration:

* `ETCO_gqa_bingApi`, `ETCO_gqa_bingKey`
* `ETCO_gqa_wikiApi`
* `ETCO_gqa_wolframApi`, `ETCO_gqa_wolframKey`

The selector fails during startup when a required endpoint is absent or when
the selector is unknown. It never falls back to the generic LLM answer
handler, contacts a public provider URL implicitly, or embeds credentials.
The existing `PHOENIX_GQA_PROFILE=wikipedia` and
`PHOENIX_GQA_PROFILE=multi-provider` standalone profiles retain their prior
behavior.

## Source contract and Phoenix mapping

The frozen Pegasus registry calls the service `answer`, points its local entry
at `http://docker.for.mac.localhost:9002`, and uses
`external-skills/answer_manifest.json`. That manifest declares `id: answer`
and `basePath: /answer_skill`. The original GQA Flask handler registers both
`POST /answer_skill` and `POST /answer_skill/v1/main`; its source provider
groups call Bing and Wikipedia first, then Wolfram after the source group
deadline. Source registry/URL construction is visible at
`packages/hub/resources/skills/skills-local.json:2-9`,
`packages/hub/external-skills/answer_manifest.json:2-3`, and
`packages/hub/src/skill/SkillUtils.ts:48-55` in the frozen reference.

The shared Phoenix host already has the deployment alias `answer-skill`. The
new `skills-gqa-default.json` keeps that alias and the existing report,
chitchat, color, and built-in skill entries. The GQA handler is attached to
the alias's `/v1/answer-skill/main` route and to the host default `/v1/main`;
the route keeps the source GQA loose JSON, transID validation, status, and
no-answer action behavior instead of inheriting the generic BaseSkill route.
`createSkillsService` accepts an optional route on a descriptor so this one
source-specific HTTP contract can coexist with ordinary skill routes.

This is a deployment mapping: the source identity remains `answer` and
`/answer_skill`, while the Phoenix registry identity remains `answer-skill`
and `/v1/answer-skill/main`. The explicit resource documents the environment
selector and provider inputs. The ordinary `skills-phoenix.json` and default
environment selection are unchanged because the repository contains no
provider endpoints or safe credentials with which to enable the external
services unconditionally.

## Controls

The new test `packages/skills/test/q01GqaDefaultWiring.test.js` uses three
owned loopback HTTP peers and exercises:

* missing and unknown profile configuration, including startup rejection;
* combined shared-host `/v1/main` and `/v1/answer-skill/main` GQA routing;
* selected `PHOENIX_SKILL_ID=answer-skill` host routing;
* report routing remaining on the report handler in the same shared host;
* gateway loading of `skills-gqa-default.json` and a real `SkillClient.launch`;
* provider outage returning the source no-answer `SKILL_ACTION` rather than
  the generic placeholder.

The focused command passed:

```text
timeout 120s node --test packages/skills/test/q01GqaDefaultWiring.test.js packages/skills/test/q01GqaProfile.test.js packages/skills/test/q01GqaMultiProvider.test.js packages/skills/test/start.test.js packages/skills/test/graphNodeIdentityDeployment.test.js packages/gateway/test/registry.test.js
```

Result: 35 tests passed, 0 failed, 0 skipped. The complete skills test glob
also passed: 236 tests, 0 failed, 0 skipped, exit 0.

The controls use loopback provider fixtures, so they prove route selection,
source response/error path selection, and provider request orchestration. They
do not prove access to Bing, Wikipedia, or Wolfram from a deployment, nor do
they close the remaining account, attribution, provider credentials, and
real-robot Q-01 gaps.

## Provenance

Candidate base at checkout: `da42b5592562232e88b552ae2f94632bb2f8fb84`.
The main branch moved after this worktree was created; no main files were
modified. The source revision used by the accepted GQA implementation is
`jiborobot/srv-gqa-ws@ebe1a7d38f511570060c1fbf61bec89d58419b26`.

Relevant source hashes:

```text
source gqa/gqa.py: cbfabe20e61ea744642ec96b5fe83457dbea9353ae54c3f8a308ef378bbb302a
source skills-local.json: fdbcea33c683d88781ea104f1db03efe921011329259cca8553da1518b0f7629
source answer_manifest.json: 39d392236cdc9dbd48a2aeaaefb1ef1a03a17fffd9921c1321d93205cf549573
```

The candidate changes are limited to the shared-host route hook, the default
GQA descriptor, the skills host selector/exports, the selectable registry
resource, and the focused wiring test. Root should rerun its current-main
strict and integration controls after cherry-picking; this report does not
claim full Q-01 acceptance.
