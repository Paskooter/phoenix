# A-06 Settings provider error codes — root accepted repair

Settings now preserves machine-readable provider error codes on reads, updates and deletes,
including HTTP 500. A transport error's private code remains absent when the source Boom
payload omits it, and ordinary internal errors retain the source generic response.

The initial agent candidate repaired missing Hub codes and leaked transport codes. Root
integration controls then found a new ordinary-error code leak and two remaining mutation
paths that dropped provider codes. Root corrected those paths before acceptance.

The [review receipt](../evidence/2026-09-07/settings-hub-projection/review.json) records
22 complete source/candidate HTTP controls, including all 17 original transport scenarios
and five added read/update/delete error controls. All agree after qualifying only the
validated refusal port and reset timestamp in diagnostic messages; the other 20 decoded
responses agree without message qualification. Every following valid request succeeds.
Hub request methods, paths, body and header values also agree after listener-authority
mapping. The original Node 8 host run reproduces all 17 preserved container response cases.

The final runtime is `85ea30c`. All 45 command processes exited zero. The complete test
command passes 636 unit tests, checklist validation and the strict 43-case production smoke
gate. Runtime files, source/harness inputs and workspace links stayed fixed during capture.

Only named Account/Hub loopback peers are exercised; Person and Lasso are inert seams.
Account membership's inherited fetch default headers remain a separate contract limit.
Raw bytes, failure evidence and qualified diagnostics are retained. Full A-06, live provider
and robot acceptance remain open.
