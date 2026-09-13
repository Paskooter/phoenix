# S-10 news selection and presentation verification

Date: 2026-09-13  
Reference: `jiboV2/pegasus@5c0a7390539663ba749d360de348a428c088505c`  
Reviewed Phoenix implementation: `f9b76ba71f47851e25127a0b703dcbaccc87fd9e`

## Verdict

**VERIFIED:** S-10 satisfies both written acceptance criteria for the pinned
Pegasus AP News contract. Phoenix matches all 22 archived News cases and both
archived AP fixture projections, then matches the source again through 16
frozen Report HTTP graph cases. No source/candidate difference remains.

The source material was obtained through the Jibo/Gebo archive. Source runs use
the prepared pinned checkout in a digest-pinned Node 8.9.4 container with
networking disabled. No live provider or web lookup participates in the proof.

## Archived source differential

`scripts/parity-s10-source-diff/compare.mjs` executes the compiled Pegasus
`NewsParse`, `NewsMimLogic`, and `NewsViews` modules and the current Phoenix
modules against one fail-closed matrix. It verifies source, compiled module,
fixture, and view-resource hashes before accepting a run. The comparator
requires every expected source and candidate row and rejects missing, extra,
duplicate, reordered, or mutated rows.

The receipt at `.parity/runs/s10-news-source-f9b76ba/` reports:

- 22/22 named archived cases and 22/22 expanded runs;
- all 60 archived `expect(...)` assertions represented in complete projections;
- 7 top-level, 7 filtering, and 8 view cases;
- both `apNewsXMLResponse` and `apNewsXMLResponseTwo` projections;
- zero differences;
- source receipt SHA-256
  `0717aa014a16297b9ed5efccd11ca772c607214e203ea9922ed10e5b0f964e03`;
- candidate receipt SHA-256
  `34c384e3f41c27bd35d75c5cbd1f3d5bb9f7c02c51f3bfae55697e58b263a704`.

The matrix covers absent data, empty headlines, default and configured category
order, one/two/many-category limits, deterministic five-category trimming,
missing summaries and images, corrections, the complete banned-word filter,
adult filtering for children and unidentified speakers, adult playback for an
identified adult, duplicate removal, image geometry, IDs, assets, category
labels, and final `leaveEmpty` behavior.

Root removed one candidate row before replay. The candidate runner rejected it
at 21 rather than 22 cases, and the outer comparator failed closed.

## Real Report HTTP graph

`scripts/parity-s10-http-graph/run.mjs` starts the actual pinned Pegasus and
Phoenix Report HTTP services against the same frozen AP-shaped Data peer. Its 16
cases cover full and single-skill reports, production defaults, configured and
unidentified users, settings failure, one/two/many-category limits, source
order, `strange` presentation, provider-header and image filtering, view
geometry, partial and total provider failure, empty and malformed XML, and both
original AP XML exports.

The comparator checks complete normalized actions and displays, response type
and finality, ordered MIM and prompt IDs, rendered ESML, AP attribution,
headline order, view projections, transitions, analytics, and every AP relay
request's route, query, headers, response status, and order. The receipt at
`.parity/runs/s10-news-http-f9b76ba/` reports 16/16 cases and zero differences.
Its source and candidate receipt SHA-256 values are
`a6e2b7bdb2238ad66c8cf146151da9008adf44de9c65d67b4abdf540e25f5610`
and `a37c4a3920dbe104bcde5f0417879e3a335a96d5537c4dc0a947573814c2f3e9`.

The committed negative control swaps two ordered MIMs and requires the
comparator to reject the forged receipt. Root separately removed the
`full-news-service-down` row; the comparator reported row-count, row-order, and
missing-row failures.

## Repairs and direct falsification

Phoenix now vendors the exact source set of 361 banned terms. The prior set had
123 terms, omitted 240 source terms including the archived `fudgepacker` case,
and added two terms absent from Pegasus. Parser error and malformed-shape
behavior now also matches source: direct string operations remain direct,
missing category arrays throw, and a duplicate headline is reserved only after
image extraction completes.

The view implementation now preserves the source's inferred-radix `parseInt`
calls. This is observable for the archived legacy dimension inputs. The XML
feed parser now matches the relevant `xml2js 0.4.19` structure and failure
semantics for AP/RSS feeds, including namespaces, repeated arrays, attributes,
entities, CDATA, comments, empty documents, and malformed tags. Root compared
57 valid and malformed XML vectors directly with the pinned dependency and
observed zero differences.

Root independently falsified each central repair:

- removing `fudgepacker` admitted the forbidden story and failed the named
  filter test;
- restoring radix 10 produced `Infinity` instead of the source scale `2.5` and
  failed the legacy-dimension test;
- allowing an unknown XML entity failed the malformed-response test.

Each production file was restored byte-for-byte after its negative control.

All six News MIM files, the shared prompt resource, and the headline view resource
match the pinned source hashes. Every reachable News prompt renders with the
source headline/category substitutions, title, Associated Press attribution,
MIM order, and GUI data reference. The focused News/report/RSS suite passes
119/119 tests. The controlled-concurrency repository suite passes 2,193 tests
with 9 skips and zero failures. The parity tracker is valid, and the strict
production smoke gate matches all 43 cases with zero differences, invariants,
or coverage gaps.

## RSS adapter boundary

The Phoenix RSS/Atom provider adapter was verified separately from original AP
parity. Its tests cover RSS and Atom media forms, feed-title presence and
absence, CDATA and escaping, missing source/dimensions, non-image or absent
media, provider rights/author fields, AP-shaped preview-slot translation,
empty/error feeds, cache warming, polling, and upstream error propagation.

The adapter preserves provider rights and author values when supplied and does
not invent AP metadata. It does not recreate original AP IDs, dates, rights
structures, media variants, or authenticated URLs. The source News MIM still
speaks “Associated Press” for adapter-backed stories; this is preserved source
presentation and is not evidence that an RSS provider is AP.

## Scope

Live AP/RSS availability and freshness, deployment, and physical Moth rendering
remain outside S-10. This task verifies frozen source behavior and the local RSS
adapter contract. It does not claim parity for arbitrary XML outside the tested
AP/RSS feed shapes.

## Reproduction

```bash
node scripts/parity-s10-source-diff/compare.mjs --out .parity/runs/s10-news-source-f9b76ba
node scripts/parity-s10-http-graph/run.mjs --out .parity/runs/s10-news-http-f9b76ba
node --test packages/skills/test/s10News*.test.js packages/data/test/news.test.js packages/data/test/news-poller.test.js packages/skills/test/report.e2e.test.js packages/skills/test/reportSubskills.test.js packages/skills/test/reportViews.test.js packages/skills/test/reportViews.source-vectors.test.js packages/skills/test/q01News.test.js
node --test --test-concurrency=4
npm run parity:check
npm run parity:gate
```
