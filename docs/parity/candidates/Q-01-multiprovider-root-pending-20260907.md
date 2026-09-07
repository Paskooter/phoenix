# Q-01 multi-provider profile — bounded integration accepted

The isolated candidate adds an explicit Bing/Wikipedia/Wolfram profile.
Root reproduced 36 complete source/candidate response and recovery cases with
MarkupSafe 1.0 and Unidecode 1.0.22. All agree, including late Bing/Wikipedia
answers while Wolfram remains pending.

A separate root run now passes 12 real connection/decode failure and recovery
cases. Owned peers close without headers, truncate an HTTP body, or return
invalid JSON; each is followed by success from the same provider. Complete
responses agree. The source retains Bing sessions and replaces Wolfram sessions
after failures. Phoenix matches the observable recovery. The 157 transport
checks and eight corrupted controls support this bounded result; they are not
157 independent requests or a live-provider test.

Root previously found Unicode faults that changed whether a reply was spoken.
Luna repaired period composition and trimming in `65e5994`. Root inspected the
change and reran all 210 candidate cases against Luna's original Python provider
capture: all complete provider results and request contracts agree, with finite
ordered timestamp checks and nine rejected corrupted controls. Root did not
repeat that 210-case Python run. The generated data, exact license, attribution, provenance and guarded reusable
generator are now integrated. Root reproduced the generator controls, including
rejection of invalid wheel inputs without overwriting existing output.

The profile is integrated at `91fd385` and remains an explicit deployment option.
Root reran all 36 response and phase cases on that final revision; 711 units
and strict43 pass. Eight original extraction controls also verify the repair
of repeated Wolfram date placeholders without changing fallback sample text.

Q-01, account/attribution,
live provider access, full corpus coverage and robot acceptance remain open.
Harmless diagnostic wording does not block acceptance.
The [review](../evidence/2026-09-07/gqa-multiprovider-pending/review.json)
retains earlier findings and the subsequent repairs.
