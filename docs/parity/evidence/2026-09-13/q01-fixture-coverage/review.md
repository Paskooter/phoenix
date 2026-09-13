# Q-01 fixture coverage receipt

The independent lane ran from Phoenix `48a10fc` in the isolated
`codex/q01-fixture-coverage` worktree. Source acquisition used Jibo MCP
Gitea only.

Command:

```sh
npm run parity:q01:fixtures
```

The command exited `0`. The async matrix also passed in 10 consecutive runs.
The focused Phoenix Q-01 suite passed 120 tests with `node --test packages/skills/test/q01*.test.js`.

| Scope | Inventory | Local result |
| --- | ---: | --- |
| Archived GQA MIM files | 11 | 11 checked; 77 prompt IDs/text/media/weight rows exact |
| Archived unit test modules | 13 of 15 files | 136 named tests / 385 assertion calls inventoried |
| Archived answer rows | 28 | 18 success, 7 no-answer, 3 blocked; JCP/display/metadata/analytics checked |
| Archived async rows | 12 | 12 matched, including timeout and provider fallback cases |
| Fake-provider routes | 3 | Bing decoder/provider, Wikipedia provider, and Wolfram extraction/provider replayed |
| Source-shaped news closure | 3 MIMs / 5 prompts / 3 aliases | Local sequence, speaker, AP seam, analytics, empty/error, and route controls passed |
| Complete integration inputs | 340 rows | Inventory only; no response goldens exist |
| Moved live answer suite | 11 cases | Inventory only; live vendor assertions have no goldens |
| Moved live news suite | 1 sequence | Local route/MIM boundary replayed; live AP/vendor execution remains unexecuted |

The answer-row provider is deliberately synthetic: those rows prove source
request cleaning and Phoenix response shaping. The source fake-provider bodies
are separately decoded through the current provider adapters. Provider query
capture covers all 25 rows that invoke a provider, including the cleaned
`fuck, who is OPANAL` row and contractions. A boundary control proves
`what is a fixture?` reaches the provider as `what is a fixture`.

Falsifiers passed for an omitted async row, a corrupted MIM value, and a
mutated archived Bing thumbnail byte (`%252C` → `%2520`). Attribution insert,
retrieve, and wipe passed; malformed provider output returned the expected
HTTP 500 HTML envelope with `message`, `stacktrace`, and `version`.

Known blockers remain explicit:

* `beta3-4902.txt` is live-input-only. Gitea metadata reports 177,307 bytes;
  the bounded MCP read exposed 69,069 code units and 2,073 nonblank rows,
  ending mid-line at `tha`. The filename label is not treated as a 4,902-row
  authoritative count.
* The moved `answer.ts` cases depend on live Bing, Wikipedia, and Wolfram
  behavior and contain no output goldens, so they are not claimed as local
  replays.
* The moved `news.ts` sequence still requires live AP/vendor execution. Its
  source-shaped `/news_skill` route, NEWS MIMs, preamble/postamble sequence,
  and local error/speaker controls are covered; the live source file provides
  no response golden. Personal Report news assets are not substituted.
