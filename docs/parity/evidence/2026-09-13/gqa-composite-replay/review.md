# Q-01 current-main composite replay

This receipt covers the selected multi-provider answer path at the current-main base `48a10fccf0eae8d6f2d6e2a001ee08c4da45e616`. The replay drives `start(..., { gqaProfile: "multi-provider" })` over HTTP and points the real Bing, Wikipedia, and Wolfram adapters at loopback peers. A loopback Account peer returns the source loop identity, and the explicit deterministic attribution store is exposed through the source `/retrieveAtt` and `/wipeID` routes.

The source pin is `jiborobot/srv-gqa-ws@ebe1a7d38f511570060c1fbf61bec89d58419b26`, read through Jibo MCP. The relevant source modules are `gqa/gqa.py`, `gqa/account.py`, `gqa/attribute.py`, `gqa/analytics.py`, and `fake_external/fake_external.py`. The replay keeps the source group boundary visible: Bing and Wikipedia start together, Bing has priority, Wolfram starts after the first group has no answer, and a late Bing answer can still win while Wolfram is pending.

The executable receipt is [q01GqaCompositeReplay.test.js](../../../../../packages/skills/test/q01GqaCompositeReplay.test.js). It passed all five tests with:

```text
node --test packages/skills/test/q01GqaCompositeReplay.test.js
5 tests, 5 passed, 0 failed
```

The five controls cover:

- Bing success over `/answer_skill/v1/main`, source `SLIM`/`PLAY` and `DISPLAY` shapes, analytics, provider timings, status/media, and route 404 behavior;
- Bing priority, Wikipedia fallback, Wolfram fallback, and delayed Bing priority;
- all-empty and HTTP-503 peers producing source no-answer MIM/display recovery without leaking provider errors;
- Account lookup plus Bing/Wolfram attribution insertion, URL/image/null fields, retrieve, and wipe;
- missing provider endpoints failing before profile construction/listener creation.

Each control has an explicit falsifier in [replay.json](replay.json): changing provider order, starting a lower-priority provider early, settling before the late answer, substituting a generic no-answer, skipping account/attribution normalization, drifting status/media, or adding an implicit provider URL causes a named assertion to fail.

This is controlled evidence. It does not establish live provider, Account, Mongo, deployment, or robot reachability, and it stays within the existing answer path; news implementation files are outside this replay.
