# N-08 portable graph profile — root accepted implementation

The explicit compiled parser now loads JSON graph data, optionally compressed with gzip.
Its JavaScript executor preserves the original graphs' symbol bytes, weights, state/arc
ordering and factory calls. A tracked hash manifest independently approves every decoded
graph; changing a provisioned profile cannot approve altered graph contents.

Root regenerated all 98 public graphs and 15 factory graphs from pinned source artifacts.
All 114 profile/data files and the separate hash manifest match the reviewed candidate.
The complete compressed bundle is 9,978,000 bytes. Runtime, exporter and production harness
share one inventory approval.

The [full review](../evidence/2026-09-07/nlu-portable-snapshot/review.json) records all
20,534 cases on frozen `e127104`: zero field differences and zero invariant failures.
The same eight external-answer cases remain unhosted on both sides, producing 16 gap
instances. The complete gate exits 1 and remains open. It completed in 772.83 seconds
within a 7,200-second budget, without timeout or interruption.

Root integrated the unchanged NLU tree with the reviewed Settings repairs as `270033d`.
The combined tree passes 641 unit tests and both default and snapshot strict 43-case
smoke profiles. At the full replay, nine configured binary checks and 23 configured
snapshot checks passed; the snapshot suite skips one binary-artifact control. The
ordinary unit profile retains five artifact-dependent skips.

Runtime/export tooling and the small hash manifest are committed. Graph payloads are
privately provisioned for verification; deployment provisioning and a robot trial are
next. Default AST retains its separately tracked 57 differences. This review does not
claim a default switch, complete N-08 or new hardware acceptance.
