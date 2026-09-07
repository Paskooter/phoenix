# H-04 root review: disconnect and timeout

Root accepted this bounded slice at runtime `e9b81bd0fa87048fae7182f4f49eaf0b390670d0`. A robot disconnect no longer reports a successful unfinished listen. The 60-second transaction deadline rejects its outer promise with an uncoded error while allowing the underlying skill request to finish and record launch history, as the original handler does.

Root independently executed the pinned Node 8 original handler, message reader, response wrapper and skill request maker with a controlled HTTP peer. Phoenix used an actual WebSocket connection. The source socket was an EventEmitter with explicit send/onclose adapters; the source full WebSocket upgrade was not exercised. Both sides used identical mapped transaction deadlines and provider delays for close before input, provider completion after close, and provider completion after timeout.

All three cases match complete functional response bodies, write/drop behavior, ordered provider requests, actual outer/internal settlement and history payloads. All 140 guards pass. Raw timeout wording and Node 8/22 transport header/close-event differences remain classified separately. The updated regression tests hold the real HTTP response until the server observes disconnect, then explicitly invoke the transaction deadline where required. All three fail on the unchanged previous runtime and pass on the candidate.

The frozen integrated tree passes 591 unit tests (three skipped), and the strict 43-case smoke has zero differences, invariant failures or coverage gaps. See [review](../evidence/2026-09-07/listen-disconnect/review.json) and [comparison](../evidence/2026-09-07/listen-disconnect/comparison.json). H-04 remains open for the other lifecycle and deployed robot boundaries.
