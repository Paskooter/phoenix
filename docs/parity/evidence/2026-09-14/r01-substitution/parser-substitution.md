# R-01 first substitution run — Phoenix parser into the original stack

Date: 2026-09-14
Status: **first substitution result — R-01 is not claimed or verified by this file.**

The original `integration-tests-int` suite was run twice against the same
in-process original hub: once all-original, once with the original hub's
`parser` peer pointed at a Phoenix NLU service. No test case was modified.

## Result

| run | passing | failing |
| --- | --- | --- |
| all-original baseline | **21** | 4 |
| Phoenix parser substituted | **19** | 6 |

The 4 dead-endpoint lasso failures are identical in both runs. The delta is
exactly two cases:

1. `Listen with external agents — A request with a second Dialogflow agent provided`
2. `Listen with external agents — A request with bad second Dialogflow agent provided`

## The substitution really happened

This matters more than the numbers, because a substitution harness that
silently falls back proves nothing. The Phoenix NLU container logged the
original hub's traffic arriving and failing:

```
{"level":"error","ns":"nlu","msg":"handler threw",
 "transId":"tid:0adcf348-…","error":"Cannot read property 'external' of null"}
{"level":"error","ns":"nlu","msg":"handler threw",
 "transId":"tid:f5d23b6a-…","error":"Cannot read property 'external' of null"}
```

Two logged failures, two failing cases, same contract (`POST /v1/parse`), and
the other 23 cases behaved identically. The original hub was genuinely talking
to Phoenix.

## Diagnosis — a ratified divergence, not a defect

`packages/nlu/src/externalAgents.js:1-50` documents this boundary and pins it
deliberately. The original `ParseRequestHandler.ts:67-72` does:

```ts
if (result && data.external) {
    const dialogflowResult = await dialogflowPromise;
    result.external = dialogflowResult.external;
}
```

With a **disabled** Dialogflow client that null result dereferences and throws a
Node 8 TypeError. Phoenix pins `EXTERNAL_ATTACHMENT_REVISION.ATTACH` to
reproduce exactly that boundary, and its default provider is
`createDisabledExternalAgentProvider()` because Dialogflow is dead.

So the two runs differ in a precondition, not in fidelity:

- In the baseline the **original** parser has an *enabled* Dialogflow client
  (the compose dev key) whose calls the suite nocks at `api.api.ai`, so the two
  external-agent cases pass.
- Phoenix's parser has a *disabled* provider, so it takes the original's own
  disabled-client path and throws.

Phoenix is reproducing the source boundary faithfully; it simply cannot reach
the enabled-client path with its default provider.

## The next experiment

`requestParser.js:310-317` makes this replaceable:
`options.externalProvider` overrides `DEFAULT_EXTERNAL_PROVIDER`, and
`createExternalAgentProvider({ enabled: true, accessToken, agents })` yields a
READY provider that returns the archived `{ [agent]: AgentResult }` shape.

The open question is whether R-01 should run the Phoenix parser with an enabled,
fixture-backed external provider standing in for the nocked Dialogflow the
original enjoys. That would make the comparison like-for-like and, if the two
cases then pass, would put Phoenix at 21/21 against the achievable baseline.

That is a real decision about what "without changing callers" permits on the
*substituted* side, and it is deliberately left open here rather than assumed.

## Harness seam

The only file touched in the reference copy is the test **helper**
`src/utils/integration.ts`, which now reads:

```ts
baseURL: process.env.R01_PARSER_BASE_URL || `http://localhost:${parserPort}`,
```

No test case, assertion, URL path or request shape was changed; the original
`.orig` file is kept beside it. All work is in the scratch copy at
`~/.local/share/phoenix/r01/ref-with-devdeps`; the pinned reference tree is
untouched.

## Not yet done

Hub and skill substitution, the all-Phoenix run, per-case HTTP/WS/JCP and
history/data side-effect capture, and adversarial controls over the comparison
itself. R-01 remains `todo`.
