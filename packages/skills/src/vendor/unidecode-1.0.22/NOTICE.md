# Unidecode 1.0.22 derived data

This directory contains a generated JavaScript decision table derived from the
Unidecode 1.0.22 package. It is used only by Phoenix's Bing empty/unhelpful
answer predicate. It is not a general transliterator and must not be used to
produce answer text.

The source wheel inspected for this artifact is Unidecode-1.0.22-py2.py3-none-any.whl,
SHA-256:
72f49d3729f3d8f5799f710b97c1451c5163102e76d64d20e170aedbbd923582.
The source package metadata reports Name Unidecode, Version 1.0.22, Summary
ASCII transliterations of Unicode text, Author Tomaz Solc, and the original
table copyright attribution to Sean M. Burke. The source URLs recorded in the
metadata are:

- https://www.tablix.org/~avian/git/unidecode.git
- https://github.com/avian2/unidecode

The metadata member reports License: GPL and a classifier for the GNU General
Public License v2 or later (GPLv2+). The accompanying LICENSE.txt is the exact
byte copy of the wheel member Unidecode-1.0.22.dist-info/LICENSE.txt:

- 18,092 bytes
- SHA-256 8177f97513213526df2cf6184d8ff986c675afb514d4e68a404010521b880643

The generated artifact is
`gqaUnidecodeFilterData.js`, SHA-256
`605a670a0874aa6433f2043606cd26e43a6553a1080c7b9242be72bfaadfcab1`.
`PROVENANCE.json` records the source metadata hashes, exact license member,
generator path/hash, command, and relocation-only origin. The reusable generator is tracked at
`packages/skills/src/vendor/unidecode-1.0.22/generate-filter-data.py`, SHA-256
`71e247a9516234935a822d7b5c8af0c97ba9da3cd142fd03f37c8a57d0ce0d07`. It
accepts explicit `--wheel` and `--output` arguments, requires a regular file
with the exact source-wheel SHA-256 above, and verifies that the import came
from that wheel before writing output. The prior pre-validation source-control
receipt is retained at
`/home/shell/work/phoenix/.parity/reviews/q01-gqa-unidecode-repair-20260907/controls/generate-filter-data.py`, SHA-256
`fb183a2fc1de1fdb0bfe5208f79f6ebd83b00097cab46a37eb0e57254cf14c05`.

This notice records package metadata and byte provenance. It does not make a
project-level licensing determination.
