# Q-01 Wikipedia HTTP retrieval follow-up

This follow-up starts at `537676488678b9ed1df1885519fe0b3086b3d41c` and is
limited to the source Wikipedia package's combined page request and revision
HTML option extraction. It does not change GQA orchestration, provider
registration, or the lexical model files.

The exact dependency is `jiborobot/Wikipedia` at
`d8ffb27d197ae0f906ba571f7f5c02a525b8cb52`, package version 1.4.0. The archived
source file `wikipedia/wikipedia.py` has SHA-256
`e4e714e516c48a3becf34558a281da4ebdd6a08abf86b1fe342225959833be3b`; the
downloaded archive from the Jibo Gitea mirror has SHA-256
`bfb2ebc78a74dc1aea47a2dba4deab2a3eacb626990d2a8e4e4c96a7cde18ff5`.

The source `WikipediaPage.__load` request inserts
`prop=info|pageprops|extracts|categories`, `cllimit=max`, `explaintext`,
`exintro`, `list=allcategories`, `inprop=url`, `ppprop=disambiguation`,
`redirects`, and `titles`, followed by `format=json` and `action=query` in
`_wiki_request`. It copies `page.get('categories', [])` into the page object
and does not consume a top-level `continue` from this combined response. The
exact source has no categories property that performs a second continuation
request. The candidate now emits the same parameter set and order. A control
with an empty category list plus a later blacklisted category in `continue`
therefore remains a one-request, non-blacklisted result, matching the source;
following that continuation would invent a behavior the pinned dependency does
not have.

For disambiguation, the source makes a `prop=revisions` request and uses
BeautifulSoup to enumerate `li` elements, removes entries whose class string
contains `tocsection`, and takes the first descendant anchor's text. The
candidate's revision parser now applies that filtering, retains nested anchor
text, and decodes the common and numeric HTML character references used by the
control. The existing recursive GQA selection then requests the first source
option and preserves the source prefix/summary behavior.

The exact package was run in the pinned local `python@sha256:d59ee182c4629dd33b240b9bac1a6ff44276e79e66117eba17aed4016845d3b` image
(Python 3.6.15) with `requests==2.18.4`, `beautifulsoup4==4.6.3`, and
`soupsieve==1.9.6` plus the pinned requests dependencies. Both it and the
Node 22 candidate used real loopback HTTP peers and the same raw JSON/HTML
fixtures. They were not given replacement Wikipedia page objects.

The three source cases are `category_empty_initial_ignores_continuation`,
`category_nonempty_initial_does_not_follow_continue`, and
`disambiguation_html`. The first two had exact request parameter maps and raw
response bodies, one request each. The disambiguation source extracted
`["First Option & Co", "Second Choice"]`; the candidate selected the exact
first title, and the shared initial/revision request maps and response bytes
matched. The candidate's additional request is the GQA recursive lookup after
the package raises `DisambiguationError`, so it is expected in the provider
control rather than a package request-count equality claim.

Private raw receipts and comparison hashes are under
`.parity/reviews/q01-wikipedia-http-20260907/controls/`:

```text
source-exact/source-package-python36.json
candidate-exact/candidate-provider.json
source-candidate-comparison.json
```

The source/candidate comparison SHA-256 is
`2186f9a600e7e6201ce6ca1e2826ddc8f087b32201916fcffb4608dd9a44a1a4`.

Validation:

```text
node --test packages/skills/test/q01Wikipedia.test.js  # 10/10
git diff --check
```

The candidate remains unverified pending root review. The adapter is still
opt-in and this control does not establish full Q-01 parity or live Wikipedia
availability. The HTML parser is intentionally bounded to the source option
shape exercised here; malformed HTML beyond these controls remains open.
