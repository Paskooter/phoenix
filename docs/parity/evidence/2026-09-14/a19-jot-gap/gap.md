# A-19 gap analysis — versioned Jot messaging contracts

Date: 2026-09-14
Status: **gap analysis only — A-19 is not claimed or verified by this file.**

A-19's finding ends: *"Party-era operations lack recovered matching-era
controllers, and the real SDK SigV4/TLS plus Kafka fan-out remain open."* Each
of those three is a distinct kind of gap, and only one of them is work Phoenix
could do unilaterally.

## The version map

`packages/classic/src/jot.js:15-25` records the recovered models:

| model | target prefix | pairs |
| --- | --- | --- |
| `jot-2016-01-26` | `Jot_20160126` | 10 |
| `jot-2016-03-10` | `Jot_20160310` | 14 (party era) |
| `jot-2016-05-10` | `Jot_20160310` | — |
| `jot-2016-05-12` | `Jot_20160126` | the last model |

The last model's operations are `CreateMessage`, `ListMessages`, `MarkRead`,
`MarkLoopRead` and `NumberOfUnreadMessagesInLoops`, plus the direct,
non-`X-Amz-Target` `POST /numberOfUnreadMessagesBulk` route. Those five handlers
work across both observed prefixes today, which is what the accepted portion of
A-19 covers.

## Gap 1 — party-era controllers: already handled correctly

The 14 party-era (`Jot_20160310`) pairs have no recovered matching-era
controller. Phoenix does not invent one, and that refusal is already asserted:
`packages/classic/test/jot.test.js:487-491` sends `Jot_20160310.CreatePart` and
requires a `404` with `errType` null, under the comment *"A party-era operation
with no recovered matching-era handler is NOT invented."*

This is an archive-availability fact, not missing Phoenix work. The honest
outcome is to bound it explicitly in A-19's acceptance rather than to leave the
task open waiting for controllers that do not exist. Criterion 1 asks to "map
every required versioned Jot pair … and resolve model/test prefix conflicts
explicitly" — the mapping and the conflict resolution are present; what is
missing is a ratified statement that party-era is out of scope for want of
source.

## Gap 2 — SigV4/TLS: a documented divergence, not an omission

`packages/classic/src/awsJson.js:1-11` states the posture in-source:

> `Authorization: AWS4-HMAC-SHA256 …` (SigV4 — **NOT verified**; LAN trust like
> the hub)

Only `accessKeyIdFromAuth` (`awsJson.js:21-26`) reads the header, extracting the
`Credential=` access key id and nothing else. This matches the hub's posture
rather than diverging from it silently.

Criterion 2 asks to compare authentication against original source/runtime.
Closing it means exercising the real `@jibo/jibo-server-client` over TLS against
the classic face — the same installed-original-SDK approach A-05 already uses
successfully under Node 8.9.4, which is the natural vehicle.

## Gap 3 — Kafka fan-out: event produced, no consumer

`packages/classic/src/jot.js:100-103` is explicit:

> `bus.eventSender.send(JotMessageCreated)` -> Kafka … The bus is gone; the
> event is reproduced in full (payload + eventKey, from message-bus
> `src/events`) and handed to an `onEvent` sink whose default records it
> durably and logs. Kafka fan-out (e.g. a downstream push notification of a new
> jot) is **NOT** reconstructed, so no consumer is notified.

So criterion 3's "observable event side effects" is half-discharged: the event
and its key are produced and durably recorded, and can be asserted; what cannot
be asserted is any downstream consumer, because the bus no longer exists.

Durability for criterion 4 is addressed by design — `jot.js:105-106` keeps the
`Message` collection and the event ledger in one atomically replaced JSON file,
so messages created before a restart are still listed after it.

## Where this leaves A-19

| criterion | state |
| --- | --- |
| 1 — map required pairs + bulk route | mapping present; party-era needs an explicit out-of-scope ratification |
| 2 — auth/membership/impersonation/validation/error precedence | covered except SigV4/TLS, which needs a real-SDK run |
| 3 — create/list/update/read, pagination, media, event side effects | covered except Kafka fan-out, which has no surviving consumer |
| 4 — durability, retry, cross-loop isolation, client journeys | durability designed in; original-client journeys need the real SDK |

Two of the three open items (party-era controllers, Kafka fan-out) are dead-
archive facts that should be **bounded and ratified**, not built. The one item
that is genuinely actionable is a real-SDK SigV4/TLS run against the classic
Jot face, which would also supply criterion 4's original-client journeys.

`packages/classic/test/jot.test.js` currently holds 28 cases.

A-19 stays `todo`. Nothing was run against a robot and no source file was
changed to produce this document.
