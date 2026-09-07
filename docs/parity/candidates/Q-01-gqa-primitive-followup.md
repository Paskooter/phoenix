# Q-01 GQA primitive-body diagnostic

This follow-up starts at `ca5a72ac417e4d769de5f7d15d74bcfad8d93c08`. It does
not change product code. The reported primitive-body failure is a workspace
dependency provenance problem, not a lexical or GQA-handler regression.

The exact candidate worktree was provisioned with:

```text
npm ci --ignore-scripts --offline
```

The install exited 0 and created local workspace links. With
`PHOENIX_ENV_FILE=/dev/null`, the exact command

```text
node --test packages/skills/test/q01Gqa.test.js
```

passed 19/19, including the primitive-body test. The raw receipt is
`new-local-q01Gqa.tap` under
`.parity/reviews/q01-gqa-primitive-followup-20260907/`.

The earlier 400-vs-500 observation is reproducible when the candidate skill
module resolves `@phoenix/common` through the main checkout's `node_modules`
instead of its own workspace. The frozen lexical worktree has no local
`node_modules`; Node therefore resolves
`@phoenix/common` to `/home/shell/work/phoenix/packages/common/src/index.js`.
The focused command, run from that unchanged worktree, exits 1 with the
primitive test reporting `400 !== 500`; its complete TAP output is
`frozen-leaked-worktree.tap`.

The direct paired loopback probe is `node-probe.json`. It imports the same
candidate `gqaAnswerSkill.js` in both runs, changing only the `createService`
module:

```text
candidate-local common:  null 500, array 500, number 500, empty 400
main-checkout common:    null 400, array 500, number 400, empty 400
source Python boundary:  null 500, array 500, number 500, empty 400
```

The 400 rows from the foreign service have the common `ERROR` JSON envelope
with body-parser's parse diagnostic. The local 500 rows reach
`validateGqaRequestEnvelope` and return the GQA HTML media type containing the
source error payload. The pinned Python control reaches the original
`gqa.analytics.build_skill_entry_analytics` for each primitive and returns
HTTP 500 with the source error payload; the raw source receipt is
`source-primitive-with-transid.json`.

The causal source difference is visible in the service files:

```text
ca5a/c1e common service SHA-256:
5fa21bd47d8a61c71f77ee7c9cb3db01386b9dab478208f607269c7185da95b4

main checkout common service SHA-256:
a10a71cf4c4b7e337275c938c3ab4691193c5e8136bb1be8231fadc7e8da5e88
```

The candidate and `c1e760f` service both select the route's `jsonStrict`
property before choosing strict or loose body-parser. The main checkout's
service omits that route selection and always uses its service-level strict
setting. `createGqaHttpRoute` already sets `jsonStrict = false` in the
candidate, so changing shared HTTP code here would duplicate an existing
candidate fix and would broaden the scope unnecessarily.

For dependency identity, the candidate uses Node `v22.22.0`, Express
`4.16.2`, body-parser `1.18.2`, and local realpaths:

```text
@phoenix/common    <candidate>/packages/common
@phoenix/contracts <candidate>/packages/contracts
@phoenix/skills    <candidate>/packages/skills
```

The candidate lockfile SHA-256 is
`aa4024cbcc1c0caf9945b160e6df1b1ce64dfc696281805f4277ca5967c0f70e`.
The source control uses recovered `srv-gqa-ws`
`ebe1a7d38f511570060c1fbf61bec89d58419b26`; its Python boundary script and
source outputs retain the host Python `3.10.12` qualification and named
offline seams.

As a cross-check, the frozen `c1e760f` tree has the same common service hash,
its own local workspace links, and its full GQA test file passes 22/22. That
does not make the earlier leaked-worktree failure a c1 core regression: the
candidate's own correctly provisioned tree already passes the primitive case.

No runtime or shared HTTP change is proposed. The remaining action is to
require local workspace dependency resolution before candidate tests or
captures and to reject evidence produced with a foreign `@phoenix/common`
realpath. This diagnostic candidate remains unverified pending root review.
