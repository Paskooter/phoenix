# H-03 intent-router candidate

Status: **unverified; awaiting root review**. This candidate is based on
`4aad98fbef1eb6bd252eeb459c0a633c9553d00a` and changes only the gateway
intent router, its focused tests, and this report.

The implementation follows the pinned Pegasus hub intent sources at reference
revision `5c0a7390539663ba749d360de348a428c088505c`:

- `packages/hub/lib/intent/IntentRouter.js`
- `packages/hub/lib/intent/IRDecisionMaker.js`
- `packages/hub/lib/intent/decision-tree/DecisionTreeNode.js`
- `packages/hub/lib/intent/decision-tree/abstract/Operator.js`
- `packages/utils-common/lib/Object.js`

The gateway now builds the source-shaped grouped `Map` tree. A constrained
branch is selected only when its operator matches; if no constrained branch
matches, the node's bare decisions are used. Exact and NOT operators require
nonempty values, compare scalar values case-insensitively after string
conversion, and recurse through arrays. Wildcard matching retains the accepted
content-based `isNotEmpty` behavior. Entity names use the source dotted-path
resolver. Unknown match rules throw while the tree is built, and memo is added
only when the source memo is truthy. The router accepts the source
`rules.indexOf('launch')` contract and does not launch solely from an entity
named `skill`. No-route returns the source internal `undefined` value.

The reference runs on Node 8/V8 6.x, whose decision sort is an in-place
quicksort for arrays longer than ten and insertion sort for shorter arrays.
This candidate carries that source algorithm so equal-weight registrations
retain the observed Node 8 ordering. The grouped traversal control produces
`path-ab`, `path-ac`, `path-ba`; the 20-entry equal-weight control selects
`skill-10`, as the original does on its first decision call.

Fresh source-backed evidence is in
`.parity/reviews/h03-intent-router-20260906`:

- `cases.json` contains 35 unique ordered controls covering no-NLU/no-route
  values, launch-rule variants, intentless skill entities, scalar coercion and
  case folding, empty values, recursive arrays, dotted object and array paths,
  grouped traversal, bare-parent fallback, wildcard values, invalid rules and
  configs, and Node 8 tie ordering.
- `source-decisions-v2.json` is an actual Node `v8.9.4` run using the pinned
  image `node:8.9.4-slim@sha256:8233daae003ba0ecba4e6d70cab8525c30a3f085935afc624a275892ebe23f7c`.
- `candidate-final.json` is a candidate Node `v22.22.0` run.
- `comparison-final.json` checks ordered unique IDs and route, complete
  decision arrays, and captured errors. It reports 35 controls: 34 exact, 0
  fatal, and 1 qualified runtime-wording difference.

The qualified row is `missing-intents-invalid-config`. Both implementations
fail during the source-required `skillConfig.intents.forEach` operation with
the same `TypeError` boundary; Node 8 reports
`Cannot read property 'forEach' of undefined`, while Node 22 reports
`Cannot read properties of undefined (reading 'forEach')`. The message is kept
as a runtime qualification rather than being normalized or guessed.

Validation in this worktree:

- `node --check packages/gateway/src/intentRouter.js` passed.
- `node --test packages/gateway/test/intentRouter.test.js packages/gateway/test/registry.test.js` passed: 19 tests, 0 failures.
- `git diff --check` passed.
- The fresh source/candidate matrix retained ordered IDs and matched all
  route and decision results; the one qualified error is described above.

Source and candidate file hashes are recorded with the capture commands in the
private evidence directory. Full gateway, production parser, golden, robot,
and deployment acceptance remain outside this bounded candidate. H-03 is not
marked verified here.
