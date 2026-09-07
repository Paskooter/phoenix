# Q-01 Unidecode derived-data packaging candidate

Status: **candidate, unverified; awaiting root review**.

This integration candidate starts at Phoenix main df8b9bd3e84c16a02fd5f26e3f31f9ad7c10e7a5
and cherry-picks only the requested provider/data commits:

- b55ccace9774fa81c2429f8ce426d50264c65edb (Bing provider);
- f5fee3a16d73595863505f174cb5677cf76a044c (Wolfram provider);
- 8aeb0032a218e30472d96ed41751db296cbacc4d (multi-provider profile);
- 6246c1dd176ab288f5295462dbbc587392a132eb (Unidecode boundary);
- a558b29c2af7b97163642b902fa20597c96a9f98 (internal Unidecode periods); and
- 05d86d3f96873ba5ae15450815bc680c21b3b0fa (vendor packaging).

The resulting integration commits are e95167f7f31c44f378d08cd6684717e922a579a3,
cad2a8cfe962143f9a7f765f2e2cc20e4aeb11f5, 7da41b59fc455d96ac7a7cc23e78464d76b93d09,
4ab83198a588c16e20bf045d1056136df61a4bdd, 4c179a0513d60f3b325b6784cd736de75e489902,
and 18d038c8f91aeb4789883e7fc96a73b810a51df8, followed by the tracked-generator
provenance correction in this candidate. No default profile, project license,
main branch, robot, source wheel, or prior capture was changed.

## Relocation and tracked artifacts

The generated table moved byte-for-byte from
packages/skills/src/gqaUnidecodeFilterData.js to
packages/skills/src/vendor/unidecode-1.0.22/gqaUnidecodeFilterData.js. The
old and new bytes both have SHA-256
605a670a0874aa6433f2043606cd26e43a6553a1080c7b9242be72bfaadfcab1. The only
runtime source change required by the relocation is the relative import in
packages/skills/src/gqaUnidecodeFilter.js and its focused test import.

The vendor directory now contains:

- gqaUnidecodeFilterData.js — the decision-only projection, not a general
  transliterator;
- LICENSE.txt — an exact byte copy of the source wheel's
  Unidecode-1.0.22.dist-info/LICENSE.txt, 18,092 bytes, SHA-256
  8177f97513213526df2cf6184d8ff986c675afb514d4e68a404010521b880643;
- NOTICE.md — package metadata attribution, source URLs, license metadata,
  source wheel/license hashes, and projection scope; and
- PROVENANCE.json — machine-readable source, generator, output, and license
  paths/hashes.

The exact source-wheel member inventory and candidate hashes are in the
private read-only inventory
/home/shell/work/phoenix/.parity/reviews/q01-gqa-unidecode-provenance-20260907/inventory.json.
Its source wheel is
/home/shell/work/phoenix/.parity/reviews/q01-gqa-bing-provider-20260907/source-wheels/Unidecode-1.0.22-py2.py3-none-any.whl,
235,421 bytes, SHA-256
72f49d3729f3d8f5799f710b97c1451c5163102e76d64d20e170aedbbd923582.

## Source and generator provenance

The source package is Unidecode 1.0.22. Its wheel METADATA member SHA-256 is
aca995ac6d3e3fb51cf42b820950f355c1542913b4e69071a54b8901dea5546d and its
metadata.json member SHA-256 is
0e4a27112e8747939c57f13001ac155573ae0d7703a4fc43c9a39b94b4ebbe0a. The
metadata reports License: GPL and a GPLv2+ classifier; the full license bytes
are retained as LICENSE.txt. This report records those package facts without
making a project-level licensing determination.

The reusable generator is tracked at
packages/skills/src/vendor/unidecode-1.0.22/generate-filter-data.py,
SHA-256
fb183a2fc1de1fdb0bfe5208f79f6ebd83b00097cab46a37eb0e57254cf14c05. It
accepts explicit --wheel and --output arguments; a portable command and the
verified private receipt are recorded in PROVENANCE.json. The prior source-wheel
vector output was exact for
1,077,263 rows; the source and candidate control receipts remain unchanged.
The relocation preserves the generated output hash, so this packaging change
has no data-generation delta.

The recovered source reference is
jiborobot/srv-gqa-ws@ebe1a7d38f511570060c1fbf61bec89d58419b26, module
gqa/bing.py SHA-256
116266b442337251569954aba6eac100d141669b44a93801d20a2542799b4d73. The
source call observes only the empty/unhelpful predicate; Phoenix retains the
original spoken text and does not expose this table as a general transliterator.

## Validation and limits

The data relocation is checked with the following read-only commands:

~~~text
git show a558b29:packages/skills/src/gqaUnidecodeFilterData.js | sha256sum
sha256sum packages/skills/src/vendor/unidecode-1.0.22/gqaUnidecodeFilterData.js
sha256sum packages/skills/src/vendor/unidecode-1.0.22/LICENSE.txt
~~~

The earlier packaging worktree recorded 13/13 focused Bing tests, 221/221
skills tests, and a full npm test run; those historical receipts remain at
/home/shell/work/phoenix/.parity/reviews/q01-gqa-vendor-packaging-20260907.
Full Q-01 provider parity, real Bing reachability, credentials, and default
registration remain outside this packaging slice.

The tracked root and @phoenix/skills package declarations remain
license UNLICENSED. The vendor NOTICE/LICENSE files document the inspected
source package and bytes; they do not change those declarations or resolve any
project distribution decision.

## Fresh candidate validation

This integration candidate received its own offline dependency install with
npm ci --ignore-scripts --offline. All 11 @phoenix workspace packages resolved
inside this worktree; the resolution, npm listing, test logs, exits, generated
private output, and hashes are retained at
/home/shell/work/phoenix/.parity/reviews/q01-gqa-vendor-integration-20260907.

The tracked generator was run against the pinned wheel into a private evidence
output, not over the tracked table. It exited 0 and reproduced the tracked
vendor table byte-for-byte: both output hashes are
605a670a0874aa6433f2043606cd26e43a6553a1080c7b9242be72bfaadfcab1. Fresh
focused Bing tests passed 13/13 and the complete skills suite passed 221/221.

The three fresh candidate controllers reused existing immutable original
source captures and wrote separate candidate outputs; they did not rerun or
modify the source captures:

- the 36-row multi-provider controller matched 36/36 with its typed comparator;
- the 12-row transport controller matched 12/12 with its typed comparator; and
- the 210-row Unidecode controller matched 210/210, with all 9 negative
  controls rejected.

The controller reports retain status, complete decoded fields, request
metadata, generated IDs, timing guards, and their explicit comparison scope.
These checks do not establish live provider reachability or full Q-01 parity.
