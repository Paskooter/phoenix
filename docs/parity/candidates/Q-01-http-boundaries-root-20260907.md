# Q-01 attribution HTTP boundaries — root accepted, bounded

Root reviewed Luna candidate `060c126ed5fb20ce8c32f461670aacc6a998ee9c` and accepted repaired candidate `a2452733ff857ece7ce4414eb81c8df568d5df6e`. Q-01 remains open.

Attribution routes now preserve original malformed/empty JSON handling and the Account lookup before top-level body validation. JSON parser options and parser-error responses are route-specific, preserving the other service defaults.

Root found two substantive defects in the proposed fix. Archived Flask 0.12.2 accepts `application/*+json`; the candidate rejected valid vendor JSON and parsed unsupported AWS JSON. The repaired routes accept vendor JSON and leave unsupported media to the original route failure path. Root also rejected timestamp errors manufactured by the source collection double: original Python passes `before` into Mongo, whose real numeric-record queries return no rows for truthy nonnumeric bounds. The optional memory store now matches nine actual Mongo observations.

Verification: 10 fresh Python 3.6.15/Flask 0.12.2 HTTP comparisons have zero status, shape, call/mutation or semantic-body differences. The original 36-case boundary capture also matches, but its three nonnumeric-before exceptions establish only injected database-error propagation. They are explicitly superseded by real Mongo evidence for timestamp behavior. Root compared the final memory store against all nine retained Mongo results. All 13 focused tests, 754 full-suite tests and 43 strict smoke cases pass; seven tests skip.

Harmless diagnostic prose and stack differences do not block acceptance. Full Flask encoding/compression compatibility, default GQA deployment, live providers and complete Q-01 are not certified. No robot changes were made for this review.

Hashes, controls, qualifications and actual process outcomes: [root evidence](../evidence/2026-09-07/gqa-http-boundaries/review.json).
