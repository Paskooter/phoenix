# Q-01 Wikipedia scanner follow-up

Status: **candidate; unverified pending root review**

Owner: Luna Max  
Worktree: `codex/candidate-q01-wikipedia-scanner-followup-20260907`  
Base: `8c51eb8eba68c8bb6021daa3a98d104f9bcff8e1`

This bounded follow-up repairs first-sentence boundary selection in
`packages/skills/src/gqaWikipediaProvider.js`. The previous scanner split each
`!`/`?` independently and used JavaScript `\s`, which changed source spans for
adjacent punctuation and treated U+FEFF as whitespace. The candidate now uses
source-shaped Punkt 3.2.5 word-token and period-context expressions, including
`text_contains_sentbreak`'s delayed break decision and closing-punctuation
realignment. It expands Python's Unicode whitespace class explicitly: U+FEFF
stays inside a token, while U+001C..U+001F and U+0085 remain boundary
whitespace. Normalization uses that same class instead of JavaScript `trim`.

The source mechanism is pinned to `jiborobot/srv-gqa-ws@ebe1a7d38f511570060c1fbf61bec89d58419b26`, recovered `gqa.nlp`, and NLTK 3.2.5 Punkt. The source assets are recorded in the private receipt:

```text
nltk-source/punkt-3.2.5.py       38476c043323fd87feaa0040332b29ede7fecad6cb4938630630480ec481ba20
punkt/PY3/english.pickle         5cad3758596392364e3be9803dbd7ebeda384b68937b488a01365f5551bb942c
stopwords/english                f6d005956f407dbc6ea32e5ff0c7e8e6f71488d3239b9023efdc7fc139d6375b
gqa/nlp.py                       6745ad3cbf648282d71ee732c2198652c47daeda8998bf69929a3a927587178b
```

The fresh systematic grammar has 169 cases covering no-space `!`/`?`
punctuation, mixed punctuation, ellipses, hyphens, apostrophes, quotes,
closing brackets, Python whitespace, and U+FEFF. It improved from 124/169 to
169/169 exact `strict_query` and `first_sentence` rows. The unchanged root
336-case control is 336/336, and the retained 10-, 20-, and 64-case vectors
are 10/10, 20/20, and 64/64. Complete source/candidate rows and the before/after
comparison are preserved under:

`/home/shell/work/phoenix/.parity/reviews/q01-wikipedia-scanner-followup-20260907/`

The source runner executes the recovered functions with named compatibility and
corpus-loading shims under host Python 3.10.12; the candidate runs under Node
22.22.0. This is source-and-model evidence, not a claim about the historical
unpinned deployment image or a full Q-01 runtime. Existing Wikipedia HTTP and
GQA behavior remains covered by the focused provider tests and is outside this
scanner delta.

Validation from the candidate's own `npm ci --ignore-scripts --offline`
workspace links:

```text
node --test packages/skills/test/q01Wikipedia.test.js  # 11/11
node --test packages/skills/test/q01Gqa.test.js        # 19/19
node --test packages/skills/test/*.test.js             # 163/163
node --check packages/skills/src/gqaWikipediaProvider.js
node --check packages/skills/test/q01Wikipedia.test.js
git diff --check
```

The candidate remains unverified pending root review and integration.
