# Q-01 legacy news and source route closure — candidate

Status: **reviewable candidate; provider deployment remains explicit**.

The archived `jiborobot/srv-gqa-ws@ebe1a7d38f511570060c1fbf61bec89d58419b26`
service registers the Hub news entrypoints `POST /news_skill` and
`POST /news_skill/v1/main`. The frozen `test_pegasus.py` contains nine news
cases covering adult, child, unknown speaker/loop, missing birthdate, empty
AP data, and analytics. Phoenix HEAD had the external news manifest but no
host route or `NEWS_preamble`, `NEWS_content`, and `NEWS_postamble` MIMs.

The frozen Pegasus target is authoritative for manifest routing. Both
`jiboV2/pegasus@5c0a739` and the matching `d682547` checkout keep
`external-skills/news_manifest.json` at `intents: []`; the pinned
`report_skill_manifest.json` owns the related news intent. The later mutable
`jiboV2/pegasus@dev` archive adds that intent and its integration test calls
the service explicitly with `skill: 'news'`, which proves a direct service
boundary but does not prove frozen IntentRouter selection. This candidate
preserves the frozen empty list and records the mutable integration as a
separate, provider/profile-dependent observation.

This candidate restores that source-shaped contract behind a replaceable
`newsProvider({ isKid, request })` seam. A configured provider returns the
already ordered AP summary strings from `gqa.ap.search_db`; the provider owns
the source five-item bound and the service validates that contract while
performing the source under-thirteen speaker decision. An omitted provider is
an explicit empty store and returns
the source `GQA_error` SLIM with HTTP 200 and `News Query.success: false`.
Provider rejection remains an HTTP 500 source error. No AP database, public
URL, or credential is invented.

For source AP semantics, `createApNewsProvider({ store, clock })` adapts a
replaceable store whose `find(query, options)` receives the archived 24-hour
`storedTime: {$gt: ...}` predicate, feed `42210` then `41664` fallback,
child-only `adult: false` predicate, descending `storedTime` sort, projection,
and five-item limit. It decodes byte summaries as UTF-8. A deployment may
provide this adapter around Mongo or an equivalent AP cache; no store is
selected implicitly.

The archived source registers `/news_skill` and `/news_skill/v1/main` (2 source
routes). The Phoenix descriptor additionally exposes `/v1/news/main` as an
adapter alias, giving 3 total route aliases through the shared skills host.
`skills-gqa-default.json`
now carries the existing `external-skills/news_manifest.json` beside the
source-backed answer entry, preserving its frozen empty intent list. A
selected `PHOENIX_SKILL_ID=answer-skill` host
co-hosts answer and news on the registry's `answer-skill:8080` endpoint while
keeping answer-skill as `/v1/main`; the registry-to-host test exercises both
boundaries. `skills-phoenix.json` and unset default startup still select the
ordinary Phoenix answer handler.

## Route inventory

| Archived route | Candidate status | Boundary |
| --- | --- | --- |
| `/answer_skill`, `/answer_skill/v1/main` | covered by the existing source GQA profiles | Bing/Wikipedia/Wolfram provider and attribution seams remain explicit |
| `/news_skill`, `/news_skill/v1/main` | restored here | AP/news store is replaceable; source JCP, MIM, age filter, analytics, and empty/error behavior are covered |
| `/v1/news/main` | Phoenix adapter alias | Same local source-shaped news handler; this path is not an archived source route |
| `/structQA` | classified unresolved | Legacy FCS surface routes `News`, `Scripted`, and `GQA`, and additionally depends on account credentials, API-AI, and the FCS response finalizer. It is a different contract from the Hub news/answer routes; this candidate does not silently map it to the new provider seam |
| `/retrieveAtt`, `/wipeID` | covered by the existing opt-in attribution profile | account and storage must be selected explicitly |
| `/healthcheck` | covered for HTTP health status by the common service | source payload is arbitrary (`42`); Phoenix returns its common health body |
| `/fakeAccount` | test/developer helper only | no production registry entry; account tests use an injected loopback seam |

The `/structQA` decision is deliberate: its archived route is inventoried and
its provider-specific unknowns are explicit, while the acceptance-critical
Hub GQA/news entrypoints are closed without changing the legacy FCS caller's
request or response shape.

## Controls

`packages/skills/test/q01News.test.js` is source-shaped and fail-closed. It
checks the archived MIM prompt IDs and text, child/adult selection, sequence
ordering and five-item limit, source analytics and timing type, hyphenated
UUID response IDs, empty-data `GQA_error`, provider rejection as HTTP 500,
malformed perception/loop/looper 500 boundaries, first duplicate transID and
logging-config headers, all three host aliases, missing transID 400 framing,
the frozen empty news manifest, and the registry-to-real-host answer and news
paths. The 14 test blocks provide four boundary coverage areas spanning new
and existing blocks; they are not a one-to-one mapping to the 10 archived
news/AP cases. Gateway manifest provenance tests compare the news descriptor
byte for byte with the pinned source and keep its intent list empty; they do
not claim mutable @dev intent registration as frozen news routing.

The Phoenix asset inventory requires non-GQA MIMs to declare
`mim_type: announcement`; that loader metadata is added to the three archived
NEWS prompt files without changing their prompt text, media, IDs, or weights.

The focused command is:

```text
node --test packages/skills/test/q01News.test.js
```

The source files were read through Jibo MCP archive tools; no web or live AP
provider was contacted. The candidate does not claim AP freshness, Mongo
query behavior, or `/structQA` provider parity without a configured source
store. The archived integration test's live AP/registry execution remains a
provider-dependent follow-up; the local replacement-provider sequence test
covers the same client-visible prompt boundary.

The cap is justified by the archived `gqa/ap.py` query's Mongo
`.limit(5)`. The replacement seam bypasses that query, so retaining the cap
at the service boundary prevents a provider from changing the source JCP
sequence length. The source Dockerfile has no timezone override and the
archive/runtime baseline is UTC; the candidate's UTC year subtraction is
equivalent to `datetime.utcnow() - relativedelta(years=13)` compared with
`datetime.fromtimestamp(epoch/1000)` under that baseline. A deployment with a
different local timezone would need an explicit source-timezone decision.
