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
21 cases the baseline itself can pass -- measured, not assumed, by running the
original parser out of process. Phoenix scored exactly 19. Every case that can
distinguish the two implementations behaved identically.

This does not lower the bar for R-01; it identifies a case class the
substitution lane cannot speak to, which criterion 3 requires be published as a
missing case rather than silently counted as a pass or a failure.

## Control — run, and it settles the question

The claim is falsifiable without Phoenix: run the **original** parser out of
process and the same two cases must fail. `r01-standalone-parser.js` in the
scratch tree starts the same `ParserService` in its own process, on the same
docker network, and the unmodified suite is pointed at it with
`R01_PARSER_BASE_URL`.

| run | passing | failing |
| --- | --- | --- |
| all-original, parser in-process (baseline) | 21 | 4 |
| **all-original, parser out of process (control)** | **19** | **6** |
| Phoenix parser substituted (out of process) | **19** | **6** |

The control's six failures are the same six, case for case:

```
1) Listen with external agents  A request with a second Dialogflow agent provided
2) Listen with external agents  A request with bad second Dialogflow agent provided
3) Lasso  Dark Sky live GET with cache miss
4) Lasso  Dark Sky rejects invalid timestamp
5) Lasso  Google Maps live GET with cache miss
6) Lasso  AP News live GET with cache miss
```

and the external-agent failures present identically —
`Error: Request failed with status code 500` — because out of process the
original's own Dialogflow client makes a real call to the dead `api.api.ai`
instead of a nocked one, and the handler dereferences the null result exactly
as Phoenix's disabled provider does.

**Phoenix is indistinguishable from the original parser under identical
conditions.** The two-case delta belongs to the harness, not to the
implementation, and no provider configuration would have changed it.

Reproduce:

```
docker network create r01net
docker run -d --name r01-orig-parser --network r01net \
  -v <scratch>:/work -w /work node:8.9.4-slim node r01-standalone-parser.js
docker run --rm --network r01net -v <scratch>:/work \
  -w /work/packages/integration-tests-int \
  -e R01_PARSER_BASE_URL=http://r01-orig-parser:9999 \
  node:8.9.4-slim ../../node_modules/.bin/mocha -r ts-node/register ./tests/index.js
```

## The live lane answers what the dead one could not

Independent of the harness question, the external-agent lane now has a live
implementation behind it (`PHOENIX_NLU_EXTERNAL=llm`). Running the same
unmodified suite a third time, against Phoenix with that lane enabled, changes
what the two cases fail *on*:

| run | external-agent failure |
| --- | --- |
| all-original, out of process | `Error: Request failed with status code 500` |
| Phoenix, provider disabled | `Error: Request failed with status code 500` |
| **Phoenix, `PHOENIX_NLU_EXTERNAL=llm`** | `AssertionError: expected false to equal true` |

That assertion is `expect(dialogflowRequest1.isDone()).to.equal(true)`, and it
runs **after** `checkExpectations(messages, expectations)`. So everything the
suite checks about the *response* passed, including:

```ts
expect(listenMsg.data.nlu.external[name].intent).to.equal(agent.intent);
```

with `agent.intent = test.TestIntents.DOES_LIKE`, which is
`"doesJiboLikeThing"`.

In other words: asked "do you like being Jibo" through an agent named
`someAgent`, the LLM standing in for Dialogflow returned the **same intent the
real Dialogflow returned** — the one the nocked fixture encodes
(`DIALOGFLOW_RESPONSE.result.metadata.intentName`). The transaction completed,
the skill responded, and the only thing left failing is the in-process
interception that no out-of-process parser can satisfy.

Where the original parser out of process cannot answer these requests at all,
Phoenix with a live provider answers them correctly. That is the dead
dependency replaced, not excluded.

Count is unchanged at 19 passing / 6 failing, because the unreachable assertion
still fails. The count is not the finding; the failure *reason* is.

## Status

Parser substitution is now characterised end to end:

* the achievable ceiling out of process is 19, measured by running the original
  parser out of process rather than assumed;
* Phoenix matches that ceiling exactly, case for case;
* with the dead dependency replaced, Phoenix does strictly better than the
  original under those conditions on the two cases the ceiling excludes.

Still outstanding for R-01: hub and skill substitution, the all-Phoenix run,
per-case HTTP/WS/JCP and history/data side-effect capture, and adversarial
controls over the comparison itself. **R-01 remains `todo`.**
