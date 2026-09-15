# R-01: the two external-agent cases are unreachable out of process

Date: 2026-09-15
Status: **analysis — R-01 is not claimed or verified by this file.**

## The delta being explained

The parser substitution run left exactly two cases behind:

| run | passing | failing |
| --- | --- | --- |
| all-original baseline | 21 | 4 |
| Phoenix parser substituted | 19 | 6 |

Both extra failures are in `listen-with-agents.test.ts`:

* `A request with a second Dialogflow agent provided`
* `A request with bad second Dialogflow agent provided`

The earlier evidence diagnosed this as a *precondition* difference — the
original parser has an enabled Dialogflow client, Phoenix's default provider is
disabled — and left open whether R-01 should run Phoenix with an enabled
provider to make the comparison like-for-like.

**That question is moot.** No provider configuration can make these two cases
pass out of process.

## Why

The tests do not only assert on the response. They assert that the parser made
the outbound call:

```ts
function nockDialogflowRequest(statusCode = 200){
    return nock('https://api.api.ai:443', {"encodedQueryParams":true})
        .post('/v1/query')
        .query({"v":"20150910"})
        .reply(statusCode, DIALOGFLOW_RESPONSE);
}
...
expect(dialogflowRequest1.isDone()).to.equal(true);
expect(dialogflowRequest2.isDone()).to.equal(true);
```

`nock` works by patching Node's `http`/`https` modules **inside one process**.
`isDone()` is true only if an intercepted request was made by that same process.

In the all-original baseline the parser is constructed in the test's own
process (`integration-tests-int/src/utils/integration.ts:28-31`):

```ts
parserService = new ParserService(ParserConfigProvider.getConfig());
await parserService.init(parserPort);
```

so the parser's Dialogflow POST is intercepted and `isDone()` is true.

Substitution points the hub at a parser over HTTP
(`R01_PARSER_BASE_URL`). That parser is a different process. Its outbound calls
cannot reach the test process's nock interceptors, so `isDone()` is false no
matter what the substituted parser does — whether it answers correctly, answers
differently, or is the original parser itself.

## What this means for the acceptance criteria

Criterion 1 asks for substitution "without changing callers, URLs or request
shapes". These two cases do not test the parser's *contract*; they test that a
specific in-process HTTP interception fired. That is a property of the harness,
not of the service under substitution.

So the achievable ceiling for an out-of-process parser substitution is 19 of the
21 cases the baseline itself can pass, and Phoenix scored exactly 19. Every case
that can distinguish the two implementations behaved identically.

This does not lower the bar for R-01; it identifies a case class the
substitution lane cannot speak to, which criterion 3 requires be published as a
missing case rather than silently counted as a pass or a failure.

## Control

The claim above is falsifiable without Phoenix: run the **original** parser out
of process and the same two cases must fail. `r01-standalone-parser.js` in the
scratch tree starts the same `ParserService` in its own process for exactly
this purpose.

If that control shows the two cases failing with the original parser behind the
URL, the cause is the process boundary and Phoenix is exonerated. If it shows
them passing, this analysis is wrong and the difference is Phoenix's.

**Control status: attempted, not yet completed.** The standalone parser exits
during `RobustParserClient` startup with "5 errors" when launched from the repo
root; the in-suite path starts it from the test package directory, so working
directory and config resolution are the first thing to vary. Until it runs, the
reasoning above rests on reading nock's interception model and
`integration.ts:28-31`, not on a measured result.

## Separately: the lane itself is no longer dead

Independent of the harness question, the external-agent lane now has a live
implementation behind it (`PHOENIX_NLU_EXTERNAL=llm`), so a client that sends
`data.external` gets a real per-agent result instead of the dead-Dialogflow
boundary error:

```
PHOENIX_NLU_EXTERNAL=disabled -> 500 Cannot read property 'external' of null
PHOENIX_NLU_EXTERNAL=llm      -> 200 {"someAgent":{"rules":["launch"],
                                      "intent":"doesJiboLikeTasteOfThing",
                                      "entities":{"Food":"pizza"}}}
```

That closes the capability gap. It does not close these two test cases, for the
reason above.
