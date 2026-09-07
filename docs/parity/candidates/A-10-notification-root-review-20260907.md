# A-10 notification review and bounded acceptance

Candidate `2d3563f` adds durable token/pending storage and source-shaped socket
delivery. It remains isolated and unverified.

Root forced a write failure using an owned temporary path. Token rotation
failed but invalidated the old in-memory token; notification removal failed
but removed the pending in-memory row. Disk bytes stayed unchanged. The new
store also inherited mode 0664 on this host. These affect reliability and
credential protection. The agent is repairing persistence failure handling
and permissions before integration.

The [review](../evidence/2026-09-07/notification-pending/review.json) retains
the control result. Automatic LoopUpdated production, verified account identity
and complete socket/hardware acceptance remain open.

The follow-up `7f56d06` adds rollback/private persistence and a suspension
outbox, but root reproduced three further storage-fault crashes: connection
setup, socket close, and the scheduled expiry poll. Failed setup also retains
live cache entries. A separate controlled concurrency test leaves the second
loop update waiting until explicit recovery when it arrives during an active
drain. These substantive delivery failures require repair before integration;
exact diagnostic wording is nonblocking. The linked review preserves the
baseline controls and follow-up receipts separately.

Root accepted the combined local lifecycle at `29ffac3` after independent
reproduction: the three storage-fault children exit cleanly, concurrent updates
both drain, and the complete LoopUpdated source payload matches fresh original
Node8 execution. The integrated suite passes **740 units, seven skips and
strict43 with zero differences, invariants or gaps**. A real local TLS launcher
check preserves an offline notification across restart, receives the full
large source-shaped document and verifies deletion after the successful send.

Earlier failures above remain historical evidence. The accepted scope is local
persistence/socket delivery plus the explicitly injected suspension outbox.
Verified public notification account resolution, default Account publishing,
other Loop saves, shared storage and real-robot acceptance remain open. Full
A-10 is not checked off.
