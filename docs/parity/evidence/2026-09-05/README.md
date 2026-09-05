# Evidence for the 2026-09-05 audit

- [baseline.json](baseline.json): revisions, exact commands, run results, limitations and hashes of the seven primary evidence files.
- [source-inventory.json](source-inventory.json): pre-existing working-tree status, per-package inventory, original/restored source differences, asset/corpus hashes, 88 missing grammar paths, and hashes of 4,838 implementation files. The tree hash uses Python `json.dumps(fileSha256, sort_keys=True)` encoded as UTF-8, then SHA-256.
- [npm-test.log](npm-test.log): 232 passing Node tests. Includes a grader subtest that prints 74/89 but exits zero.
- [corpus.log](corpus.log), [corpus.json](corpus.json): full 10,035-utterance chitchat run, 329 mismatch entries. Intent/MIM checks only; no no-match cases.
- [oracle-grade.log](oracle-grade.log): stored-golden comparison, 74/89, not a live original NLU run.
- [probes.json](probes.json): 14 source-backed Phoenix observations from isolated local services. These are not assertions that the original runtime was executed.
- [classic-api-inventory.json](classic-api-inventory.json): 26 archived client API definitions / 134 unique wire targets, with input/output shape names, required top-level inputs and source locations. This is an inventory, not a complete schema validator.
- [tracker-check.log](tracker-check.log): validation of the new task ledger, dependency graph, evidence links and generated checklist. This is planning-tool validation, not a product parity run.

Reproduce observations with `node scripts/parity-probes.mjs --out /tmp/phoenix-probes.json` from the repository root. The full corpus command and environment settings are in baseline.json. New runs should go in a new dated/run directory; do not overwrite this initial baseline.

Historical hardware/simulator claims were not re-executed. Neither a corpus mismatch nor a probe observation currently produces a failing parity gate; implementing that gate is V-02/V-03.
