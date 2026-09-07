# Q-01 Wikipedia lexical follow-up

This candidate starts at `3a42dba1a584178df7916a9b4bbdfea1c6117014` and is
limited to the lexical helpers in `gqaWikipediaProvider.js`. The HTTP adapter
and its receipts remain unchanged from that base. The changes port the
source-observed NLTK 3.2.5 Punkt boundary details that the 336-case review
exposed:

- Python `re` whitespace includes U+001C..U+001F and U+0085, so normalization,
  token scanning, and boundary lookahead treat those characters as whitespace.
- Punkt's numeric expression uses Unicode decimal digits. This preserves the
  `is_number` path for Arabic and other decimal-digit tokens.
- Punkt's `_RE_INITIAL` is `[^\W\d]\.`. The JavaScript equivalent
  accepts letters and non-decimal Unicode numbers plus underscore, while
  excluding decimal digits, rather than limiting initials to `\p{L}`.
- The source period-context expression is greedy over adjacent non-whitespace
  sentence punctuation. Boundary extraction therefore keeps `Hello!!` and
  `What?!` together before applying closing-quote realignment.

The source oracle is the actual recovered `gqa.nlp` module with the pinned
NLTK 3.2.5 Punkt implementation and English model. The source control used
the named support shims and corpus loader recorded by the root review and host
Python `3.10.12`; it is source-runtime evidence with those qualifications,
not a claim about an unpinned deployment data build. Source hashes are:

```text
nltk-source/punkt-3.2.5.py       38476c043323fd87feaa0040332b29ede7fecad6cb4938630630480ec481ba20
punkt/PY3/english.pickle         5cad3758596392364e3be9803dbd7ebeda384b68937b488a01365f5551bb942c
stopwords/english                f6d005956f407dbc6ea32e5ff0c7e8e6f71488d3239b9023efdc7fc139d6375b
```

The fresh source/candidate receipt is under
`.parity/reviews/q01-wikipedia-lexical-followup-20260907/controls/`. It uses
the unchanged 336-case input (`cases.json`, SHA-256
`2a704d2147f559f41d249d45e560f87ab322d2f2b21101276047e2199d0b5ee9`). The
source and candidate each produced 336 rows, and the comparison found
336/336 exact `strict_query` and `first_sentence` rows with no differences.
The raw output hashes are:

```text
source.json     27b900588b6e359e9972914911ae481df982142fdf9b64b215885f33a328a18c
candidate.json  ff2219dba22ca43c10a1da2e281066429d7d66abf4d4ddec5388793ee570f26e
comparison.json 5a5b39680b84b3448fa1c5678203748b116e952a904e9440ead9409265f9ac26
```

The retained smaller controls also ran against this worktree's candidate:

```text
source vectors: 10/10 exact
extended vectors: 20/20 exact
abbreviation vectors: 64/64 exact
```

Their comparison receipts are `controls/regressions/*comparison-followup.json`.
The focused HTTP and lexical suite passed 11/11:

```text
node --test packages/skills/test/q01Wikipedia.test.js
```

The separate `q01Gqa.test.js` suite remains 18/19. Its existing primitive-body
case still reports expected 500 versus actual 400; this lexical-only change
does not alter GQA core or establish a cause, so that failure remains
explicitly unexplained and outside this candidate's claim.

This candidate remains unverified pending root review. It does not establish
full Q-01 parity, provider registration, or live Wikipedia availability.
