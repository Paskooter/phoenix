# Q-01 current-main composite replay

This receipt covers the selected multi-provider answer path at the current-main base `48a10fccf0eae8d6f2d6e2a001ee08c4da45e616`. The replay drives `start(..., { gqaProfile: "multi-provider" })` over HTTP and points the real Bing, Wikipedia, and Wolfram adapters at loopback peers. A loopback Account peer returns the source loop identity, and the explicit deterministic attribution store is exposed through the source `/retrieveAtt` and `/wipeID` routes.

The source pin is `jiborobot/srv-gqa-ws@ebe1a7d38f511570060c1fbf61bec89d58419b26`, read through Jibo MCP. The relevant source modules are `gqa/gqa.py`, `gqa/account.py`, `gqa/attribute.py`, `gqa/analytics.py`, and `fake_external/fake_external.py`. The replay keeps the source group boundary visible: Bing and Wikipedia start together, Bing has priority even when Wikipedia resolves first and Bing resolves later within the first-group deadline, Wolfram starts only after both first-group responses complete without an answer, and a late Bing answer can still win while Wolfram is pending.

The executable receipt is [q01GqaCompositeReplay.test.js](../../../../../packages/skills/test/q01GqaCompositeReplay.test.js). It passed all seven tests with:

```text
node --test packages/skills/test/q01GqaCompositeReplay.test.js
7 tests, 7 passed, 0 failed
```

The two timing controls use separated margins: the both-useful phase uses a 1,000ms first-group deadline with 50ms Wikipedia and 200ms Bing delays, while the late phase uses a 250ms first-group deadline, 1,200ms Wolfram-group deadline, 500ms Bing delay, and 800ms Wolfram delay. The assertions still require source timing keys, a Wikipedia-first/Bing-later result within its deadline, and a Bing response after the delayed Wolfram request has started.

To exercise the load that exposed the earlier timing race, the complete integrated Q-01 glob, including the current news tests, was run from a temporary detached `d1564a4` worktree with this replay overlaid. Ten sequential repetitions each completed 130/130 tests: **10/10 runs passed**, with no timing failures.

The plan-order falsifier is [falsify-source-provider-plan.mjs](falsify-source-provider-plan.mjs). It reverses the first `SOURCE_PROVIDER_PLAN` group to Wikipedia before Bing, runs only the named both-useful case, observes that case fail, restores `packages/skills/src/gqaAnswerSkill.js` byte-identically, and reruns the focused case green:

```text
./docs/parity/evidence/2026-09-13/gqa-composite-replay/falsify-source-provider-plan.mjs
reversed run: status 1, named case failed
restored byte-identical: true
restored focused run: status 0
```

The six controls cover:

- Bing success over `/answer_skill/v1/main`, source `SLIM`/`PLAY` and `DISPLAY` shapes, analytics, provider timings, status/media, and route 404 behavior;
- `/answer_skill` and `/v1/main` aliases through the selected multi-provider profile;
- Bing priority when both peers are useful, with Wikipedia resolving first, plus Wikipedia fallback, Wolfram fallback after both first-group response completions, and delayed Bing priority;
- all-empty and HTTP-503 peers producing source no-answer MIM/display recovery without leaking provider errors;
- Account lookup arriving before provider dispatch, plus Bing/Wolfram attribution insertion, an explicit non-attributed Wikipedia answer, URL/image/null fields, retrieve, and wipe;
- missing provider endpoints failing before profile construction/listener creation.

Each control has an explicit falsifier in [replay.json](replay.json): reversing the first provider group (with the executable restore check), starting a lower-priority provider early, settling before the late answer, substituting a generic no-answer, skipping account/attribution normalization, attributing Wikipedia, drifting status/media, or adding an implicit provider URL causes a named assertion to fail.

This is controlled evidence. It does not establish live provider, Account, Mongo, deployment, or robot reachability, and it stays within the existing answer path; news implementation files are outside this replay.
