# A-10 durable notification candidate — changes requested

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
