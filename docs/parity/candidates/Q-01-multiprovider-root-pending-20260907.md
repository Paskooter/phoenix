# Q-01 multi-provider candidate — awaiting root acceptance

The isolated candidate adds an explicit Bing/Wikipedia/Wolfram profile.
Root reran 32 complete source/candidate response and recovery cases with native
provider sessions retained between requests. All 32 agree. Monotonic traces
also pass bounded provider-order and three/four-second deadline checks; five
corrupted controls are rejected. Six original Node 8 Hub client framing cases
were independently reproduced.

These results do not accept the full provider implementation yet. The source
runtime used the declared MarkupSafe 1.1.1 fallback because the original 1.0
package failed to build with the available tooling. Compatible isolated build
tooling is being established. The Unicode follow-up is also under source and
provenance review. Transport-exception session replacement and a late Bing
winner while Wolfram remains pending require further controls.

The profile has not been integrated or deployed. Q-01, account/attribution,
live provider access, full corpus coverage and robot acceptance remain open.
The [pending review](../evidence/2026-09-07/gqa-multiprovider-pending/review.json)
records the scope and execution hashes.
