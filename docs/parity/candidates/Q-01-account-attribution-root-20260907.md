# Q-01 account lookup and attribution root review

Status: accepted for the bounded explicit profile; whole Q-01 remains open.

The optional GQA profile now resolves the account's loop before provider work,
saves Bing/Wolfram attribution after answer punctuation, and exposes retrieval
and deletion when storage is configured. The Mongo adapter uses the original
fields, index, exclusive time window, 90-day floor and 50-record cap.

Root reviewed the pinned Python 3.6 source execution and real Mongo/Node-driver
evidence, rehashed four artifacts, and independently compared eight actual HTTP
responses plus the inserted record and complete account calls. Successful bodies
match; error status, field types and version match with prose and stack paths
excluded under the user's compatibility policy. The integrated candidate
`4bb55831436b5ed9967a4229b68db55015247a25` passed750 tests with7 skips and
the strict43-case gate with zero differences, invariants or coverage gaps.

Malformed-request and timestamp-type boundaries are being checked separately.
The default profile, live providers, production persistence deployment and full
GQA parity are not accepted by this review. Source collection order is unspecified;
the in-memory fixture's order is not a production promise.

[Review and evidence qualification](../evidence/2026-09-07/gqa-account-attribution/review.json).
