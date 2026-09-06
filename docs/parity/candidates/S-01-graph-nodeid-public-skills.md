# S-01 exported skills registry follow-up

Status: **candidate, awaiting lead review**

Base: `e043a276c4dd9f0e14703a282a3f346b6f6f2878`

The selected `start()` and explicit production adapter already construct
cohosted graphs in source order, but the exported `SKILLS` descriptors still
called the default lazy Chitchat/Report getters independently. A fresh
`createSkillsService({ skills: SKILLS })` therefore allocated based on the
first request: Report-first returned report session node 31, while
Chitchat-first returned node 35.

The repair keeps the registry lazy but initializes one private cohost manager
through `createBuiltinSkills()` on its first handler call. Both fresh-process
order controls now return Report node 35 and Chitchat node 0. Selected hosts
continue to use fresh managers and return Report node 31.

The source Node 8 standalone control constructs only `new PersonalReport()`;
two fresh source processes both returned launch node 31 and follow-up node 40,
with manager counter 41. Candidate follow-up controls returned those same
standalone IDs, and the cohosted candidate returned launch node 35 and
follow-up node 44 in both start/stop cycles. All four candidate cycles returned
HTTP 200. The original source has no multi-skill `SKILLS` registry; the
cohosted node 35 expectation is the Phoenix host construction contract.

Evidence is under
`.parity/reviews/s01-graph-nodeid-public-skills-20260906/`:

- `report-first.json` and `chitchat-first.json` preserve the order-dependent
  pre-repair results; `report-first-repaired.json` and
  `chitchat-first-repaired.json` preserve the fixed results.
- `source-followup-1.json` and `source-followup-2.json` are fresh pinned Node
  8 source controls.
- `deployment-followup-repaired.json` records standalone/cohosted launch and
  update results across two start/stop cycles.
- `skills-tests-repaired.log` records the full skills suite.

The candidate remains unverified pending lead review. The frozen e043 strict
production evidence was not modified or recaptured.
