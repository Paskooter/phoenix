# Q-01 Unidecode derived-data packaging candidate

Status: **candidate, unverified; awaiting root review**.

This candidate starts at Phoenix main 3af2c09c11729bd2bd35aee568ec05de9d74a4d0
and cherry-picks only the requested provider/data commits: db9a2fa811ba46c8f839902e41c893c231f3dc78,
fc730402fdc5a45877c963df60c6c565b8e85201,
d43b3537bbca5f5d97f5e9f8c41aa1dcf893bc68,
cc77f73c9c32252955b731e3042d8b39743d8ed9, and
65e5994a2c7812f458ebe06b40eedcde50656b53. The resulting cherry-pick commits
are recorded in the candidate history. No default profile, project license,
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

The generated file was produced in the earlier source control by
/home/shell/work/phoenix/.parity/reviews/q01-gqa-unidecode-repair-20260907/controls/generate-filter-data.py,
SHA-256
fb183a2fc1de1fdb0bfe5208f79f6ebd83b00097cab46a37eb0e57254cf14c05. Its
reproducible input/output command is recorded in PROVENANCE.json and uses the
pinned wheel above. The prior source-wheel vector output was exact for
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

The focused Bing tests and the complete skills suite were run after
workspace dependencies were installed in this worktree. The prior unchanged
repair receipts recorded 13/13 focused tests and 221/221 skills tests; fresh
local-linked results for this import path and provider commit composition are
recorded below. Full Q-01 provider parity, real Bing
reachability, credentials, and default registration remain outside this
packaging slice.

The tracked root and @phoenix/skills package declarations remain
license UNLICENSED. The vendor NOTICE/LICENSE files document the inspected
source package and bytes; they do not change those declarations or resolve any
project distribution decision.

## Fresh candidate validation

The candidate received its own offline dependency install with
npm ci --ignore-scripts --offline. Every @phoenix workspace package resolved
inside this worktree; the resolution receipt is retained privately with the
packaging evidence.

The pinned generator was run against the pinned wheel into a private evidence
output, not over the tracked table. It exited 0 and reproduced the tracked
vendor table byte-for-byte: both output hashes are
605a670a0874aa6433f2043606cd26e43a6553a1080c7b9242be72bfaadfcab1. Focused
Bing tests passed 13/13; the complete skills suite passed 221/221. The full
npm test command exited 0 with 717 tests, 710 passes, 7 skips and no failures.
Its strict production smoke gate covered 43 cases with 0 differences,
invariants, or coverage gaps. Raw logs, exits, generated private output,
workspace resolution, and hashes are in
/home/shell/work/phoenix/.parity/reviews/q01-gqa-vendor-packaging-20260907.
These checks do not establish live provider reachability or full Q-01 parity.
