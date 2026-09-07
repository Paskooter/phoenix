# N-08 compiled inventory approval — root accepted repair

The first-name factory correction changed the shipped rule-inventory digest. The optional
compiled runtime and its production harness still approved the older digest, so configured
startup on `9304139` failed before serving a request. The default suite had skipped the
artifact-dependent tests. This was a functional startup regression.

Root accepted runtime `3108820` after moving the approval into a shared tracked JSON file
used by both JavaScript and Python. An always-run test now checks the shipped inventory
without requiring private compiled data. The parser algorithms, graph/factory bytes and
reference expectations are unchanged.

The [review receipt](../evidence/2026-09-07/nlu-inventory-approval/review.json) records the
baseline failure, an intermediate runtime-only repair rejected by the harness, and the
final checks: 633 unit tests, nine configured tests, and both default and compiled
43-case production profiles with zero differences, invariant failures or coverage gaps.
All child commands exited zero; 5,178 tracked files, HEAD, profile and workspace links
remained fixed during the final checks.

This acceptance restores compiled-profile startup and keeps approval checking consistent.
It does not replace the separately scoped full-corpus results or verify a new robot
release. Complete N-08 and the portable graph candidate remain open.
