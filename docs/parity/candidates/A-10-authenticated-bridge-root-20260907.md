# A-10 authenticated bridge root review

Accepted for the bounded colocated launcher; whole A-10 remains open.

The launcher now shares one Account Store with the Notification verifier, routes
verified account document identities, and connects the durable Loop suspension
outbox after Classic is listening. Restart retries retained publications.

Root fixed a remaining request-body gap: an omitted body was converted to an
empty object and rotated a token. Notification now preserves the Hapi body
default and lets its validator reject null/scalar values. Other Classic routes
retain their existing defaults. Invalid requests leave prior tokens usable.

The original Node8/Joi/Hapi control and root signed HTTP matrix agree on all23
cases. The reusable launcher control now verifies certificate/hostname trust
and asserts identity, account isolation from before publication, offline
retention and restart delivery. Final root candidate902cea1 passes751 tests
with7 skips and strict43 with no differences, invariants or coverage gaps.

The first full suite hit an existing one-second outbox watchdog during heavy
host I/O. Its failure is retained; the unchanged candidate subsequently passed
the focused concurrency tests and complete suite. No timeout was relaxed.

Moth still runs29ffac3. Other Loop-save producers, network Notification
deployment, shared persistence and real-robot notification acceptance remain open.
[Detailed review](../evidence/2026-09-07/notification-authenticated-bridge/review.json).
