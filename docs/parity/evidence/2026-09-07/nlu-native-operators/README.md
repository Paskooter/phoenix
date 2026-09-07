# Native grammar operator acceptance

The default AST parser now matches 20,460 of 20,528 archived Pegasus HTTP status/data cases. The source-backed operator and explicit-weight repair removes 81 of the previous 149 differences without adding any newly failing case. Sixty-eight differences remain; two still-failing outputs changed. This accepts a bounded improvement, not the complete N-08 task.

The full replay used frozen `e26b0725`; the reviewed integration retains identical NLU source/resource bytes and main's existing wildcard regression tests. The source driver, inputs, worktree head, runtime files and workspace links were checked before and after the completed run. The compiled profile's separate full-production comparison is not retagged as this AST result.

See `review.json`, `full-replay.json`, and `reconciliation.json` for counts, hashes, qualifications and remaining work. The source/native controls, complete process receipts, and pre/postflight manifests remain under `.parity/reviews/n08-plus-general-root-20260907/full-replay-e26-7200` and `.parity/reviews/n08-session-root-main-20260907`.
