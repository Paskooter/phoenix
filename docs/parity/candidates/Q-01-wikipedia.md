# Q-01 Wikipedia provider candidate

This candidate adds an opt-in `createWikipediaProvider` adapter for the
existing named `createGqaProviderPipeline` seam. Importing the adapter does not
register it in the default skill host or enable network access on a robot.

The implementation follows `jiborobot/srv-gqa-ws@ebe1a7d38f511570060c1fbf61bec89d58419b26`,
`gqa/wiki.py`, `gqa/nlp.py`, and the recovered `fake_external/fake_wiki` fixture.
It removes the source stop words, applies the source Wikipedia question gate,
requests `info|pageprops|extracts|categories`, strips the first safe summary
sentence, applies the source article/category/list/template filters, and
preserves source error messages. Disambiguation uses the Python client’s
revision option shape when the response supplies revision HTML, while the
fixture control also accepts its explicit option list. Wikipedia URLs are not
added to attribution because the source `gqa.wiki.call` output intentionally
does not persist one.

The transport is configurable through `endpoint`, `fetchImpl`, `headers`,
`signal`, and `timeoutMs`. It supplies the pinned Python client's default
Wikipedia User-Agent unless the caller overrides it. The factory uses the official
`https://en.wikipedia.org/w/api.php` endpoint by default but performs no call
until a caller invokes the returned adapter. The request shape is consistent
with the [MediaWiki Action API query properties documentation](https://www.mediawiki.org/wiki/API:Properties/en).

Source and candidate loopback controls used the same seven cases: successful
page, missing page, disambiguation with a valid option, malformed JSON, a
valid API error envelope, a question-word block, and a delayed response. The
source control ran the recovered `gqa.wiki.call/search/can_answer` functions in
the pinned `python@sha256:d59ee182c4629dd33b240b9bac1a6ff44276e79e66117eba17aed4016845d3b2`
image with network mode `none` and an owned `127.0.0.1` HTTP server. Its
requests and outputs are recorded under
`.parity/reviews/q01-gqa-wikipedia-20260907/controls/source-run/`.

The source/candidate comparison has five exact semantic/request matches. Two
rows remain qualified differences:

- The recovered fake `wikipedia` seam maps a valid top-level API error body to
  `PageError` and therefore “No match”; the real Python client path used by the
  candidate retains a generic API error. This is isolated in the comparison
  rather than hidden.
- The source call has no internal cancellation and completes after the delayed
  response. The candidate’s explicit `timeoutMs` aborts its fetch and returns a
  visible provider error. The normal GQA pipeline’s existing group deadline
  remains the caller-owned boundary.

The public read-only check queried `Earth` from the official endpoint on
2026-09-07 and received HTTP 200 with a JSON page and extract. Both the raw
API response and a candidate adapter invocation are recorded under
`.parity/reviews/q01-gqa-wikipedia-20260907/public/`; this live result is
separate from the offline fixture evidence and is not used as a golden.
The candidate invocation receipt is `candidate-earth.json` (SHA-256
`b8ec23df346935d60f60a5e0325c8d60ad54adff08135cba4198d0860baa8fbe`).

Validation in the candidate worktree:

```text
node --test packages/skills/test/q01Wikipedia.test.js       # 8/8
node --test packages/skills/test/q01Gqa.test.js             # 19/19
node --test packages/skills/test/*.test.js                  # 160/160
```

The focused test covers request parameters/order, source filtering, missing and
disambiguated pages, malformed/HTTP responses, cancellation, and pipeline
integration. The candidate remains unverified pending root review.
