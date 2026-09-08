# A-04 ListLoops integration and visibility correction

Status: **candidate; original-client review pending, not deployed**.

Root integrated the List payload validation candidate into the combined Loop
candidate and corrected a further source mismatch: accepted and invited
members can list their loops. Removed and declined membership does not grant
visibility, and a robot association alone does not bypass the membership query.
The optional loop ID restricts the selection before robot mode is inferred.
A matching robot relation or the credential's friendly ID enables robot mode,
which excludes suspended loops and loops associated with another robot.

The source is `jiborobot/srv-account-ws` at
`6cea43470825657d6a5722162f28c8f233153ee2`, `LoopController.list` in
`src/controllers/loop.ctrl.ts` (SHA-256
`8eab9312ba611b1dc5735599521bf73f1dbd2ede49f8da53ad3b4b543d729024`).
The `src/schemes/loop.ts` find middleware excludes deleted records. Phoenix
retains its existing normalization of legacy uppercase membership statuses;
this is a storage compatibility adaptation rather than raw Mongo equality.

Root's signed HTTP tests exercise both Account and Classic, including valid
member visibility, rejected membership states, suspended and deleted records,
robot inference without a friendly ID, explicit robot hints, and optional ID
selection before inference. The focused list, authentication, bootstrap and
robot-face regression set passed all 15 tests. The full combined suite passed
868 tests, with seven skipped and zero failures.

Six controls also execute the exact transpiled source controller under Node
8.9.4. They verify the source query structure and post-selection robot rules.
Model selection and population are controlled seams: these are not full Mongo,
Hapi, or generated-client results. Private runner and results are retained in
`.parity/reviews/a04-list-validation-20260908/root-source-list.cjs` and
`root-source-list-result.json`.

The inherited list-validation report records that candidate's earlier baseline;
this integration includes root's deleted-account credential exclusion. Full
list population, Mongo behavior and whole A-04 acceptance remain open. No
household data or robot runtime was changed by this review.
