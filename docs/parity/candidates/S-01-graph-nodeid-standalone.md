# S-01 standalone graph host identity follow-up

Root accepted the repaired bounded allocation slice in `4f9d5a7`. The [independent review](../evidence/2026-09-06/service-integration/graph-allocation-review.json) records all 45 source node identities, standalone/cohosted follow-ups, 492 unit passes on confirmation and 218 remaining strict differences. Full S-01 remains open; earlier candidate observations below retain their historical scope.

Status: **candidate, awaiting lead review**

Base: `d77c6e3725da8de6decc1ae440aa9dfc7beb4820`

The accepted co-hosted repair made the built-in Chitchat and PersonalReport
handlers share one manager, but `packages/skills/src/index.js` imported both
singletons before applying `PHOENIX_SKILL_ID`. A report-only process therefore
allocated Chitchat's four nodes first. The pinned source report service creates
only `new PersonalReport()` and starts its graph at node 0.

This follow-up keeps direct handler imports compatible through lazy named
handlers, adds `createReportSkill`/`getReportSkill`, and has `start()` create a
new manager per service host. A selected Chitchat or report service constructs
only its selected graph. The combined host constructs Chitchat first and
PersonalReport second on one manager. The production capture adapter now uses
the same explicit host manager for its two co-hosted handlers.

The source and candidate HTTP control uses the `skill:report-known` request
from the preserved production reference, with report preferences from config
and no network provider. It ran the original report service in the pinned
Node `v8.9.4` image and the candidate in Node 22. The source standalone
response has session `nodeID: 31`, trace length 14, and manager counter 41.
The frozen d77 candidate had `nodeID: 35`, trace length 18, and allocated 45
nodes. The follow-up candidate HTTP response has `nodeID: 31`; its standalone
factory witness has manager counter 41 and `Send All Mims` node 31. Its graph
trace contains additional existing Phoenix graph nodes, so this control
credits the host allocation and selected session ID only.

Evidence is retained under
`.parity/reviews/s01-graph-nodeid-standalone-20260906/`:

- `source-http.log` and `source-result.json`: original HTTP response and logs.
- `candidate-http-followup.log` and `candidate-followup-result.json`: repaired
  candidate HTTP response.
- `candidate-factory-witness.log`: candidate standalone manager allocation.
- `standalone-comparison-followup.json`: source/candidate IDs and allocation
  comparison. `standalone-comparison-before.json` records the d77 mismatch.

The focused graph/deployment/request/start controls pass (19 tests), and the
full `packages/skills/test/*.test.js` suite passes 111/111. The co-hosted
production recapture is in
`production-followup/{candidate.json.gz,comparison.json,capture-run.json}`:
the pinned Node image completed 43/43 cases with zero capture failures. Its
comparison has 349 differences, zero invariants, and one existing coverage
gap, exactly matching the frozen d77 comparison byte-for-byte at the
comparison artifact level; the difference set has 349 shared records, with no
removed or added records. This confirms that selected-host scoping did not
change the co-hosted production profile. Source manifests
`phoenix-source-before-followup.json` and `phoenix-source-after-followup.json`
have the same 5,113-file tree hash, with no changed entries.

The standalone HTTP control credits only graph allocation and the selected
session ID: source and candidate both allocate 41 nodes, assign `Send All
Mims` node 31, and return session `nodeID` 31. Their traces still differ in
pre-existing graph behavior, so this is not a whole standalone response
parity claim. Root review and independent recapture remain required before
acceptance.
