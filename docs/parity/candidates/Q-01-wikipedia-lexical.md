# Q-01 Wikipedia lexical follow-up

Status: candidate, unverified pending root review.

This follow-up is based on `681988690e349dee3e26271fedd2c7264c17a794` and is
limited to the Wikipedia provider's query preprocessing and first-sentence
selection. It does not change the GQA route, provider orchestration, profile
registration, or the Wikipedia HTTP contract.

## Source contract

The source is `jiborobot/srv-gqa-ws` at
`ebe1a7d38f511570060c1fbf61bec89d58419b26`:

* `gqa.nlp.remove_initial_stop_words` loads `nltk.corpus.stopwords.words('english')`
  and adds the source `WH_PHRASES` before removing leading words.
* `gqa.wiki.search` cleans nested parentheses, normalizes whitespace, then
  returns `nltk.tokenize.sent_tokenize(text)[0]`.
* The source requirements file pins `nltk==3.2.5`, while its Dockerfile uses
  an unpinned `python:3` image and downloads `punkt` and `stopwords` during the
  image build. Therefore the historical Python image/data-build identity is
  not fully recoverable from source alone.

The candidate vendors the official English stopword corpus and the English
Punkt parameter tables as data. The JavaScript boundary interpreter applies
the trained abbreviation, collocation, sentence-starter, and orthographic
context tables; it does not add article names or phrase-specific exceptions.

Asset fingerprints:

* `wikipedia_stopwords_english.txt`: SHA-256
  `f6d005956f407dbc6ea32e5ff0c7e8e6f71488d3239b9023efdc7fc139d6375b`.
* `wikipedia_punkt_english.json`: SHA-256
  `aaba20ed5a8d613be3e70edabfd3ce22560f02e6b1f9f9c4b9b8d2121f4b8bce`.
* The downloaded NLTK data archives were the official `nltk_data` packages
  `stopwords.zip` (`48c0e52d8b52546e827f53761fb30300c0ab94f70660d28bd65ba0a86270946b`)
  and `punkt.zip`
  (`51c3078994aeaf650bfc8e028be4fb42b4a0d177d41c012b6a983979653660ec`).
  Their package index is
  <https://raw.githubusercontent.com/nltk/nltk_data/gh-pages/index.xml>.
* The source control used the pinned NLTK 3.2.5 `punkt.py` source, SHA-256
  `38476c043323fd87feaa0040332b29ede7fecad6cb4938630630480ec481ba20`,
  and the Python 3 English model from `punkt.zip`, SHA-256
  `5cad3758596392364e3be9803dbd7ebeda384b68937b488a01365f5551bb942c`.

## Changes

`gqaWikipediaProvider.js` now reads the complete English stopword corpus and
uses a source-model-backed Punkt interpreter. The previous 32-word fixture
set and punctuation split treated `what is about the moon` as
`about the moon`; the source and candidate both produce `moon`. The model
handles title abbreviations, initial sequences, initialisms, decimals,
ellipsis, closing quotes, nested-parenthesis cleanup, and Unicode text in the
covered controls.

`q01Wikipedia.test.js` adds ten source-derived lexical vectors covering
ordinary questions, expanded stopwords, contractions, title abbreviations,
initials, initialisms, decimals, nested parentheses, Unicode, quotes, and
ellipsis.

## Validation

The reproducible private source controls are under:
`.parity/reviews/q01-wikipedia-lexical-20260907/controls`.

`source-vectors.py` executes the pinned NLTK 3.2.5 Punkt implementation with
the recovered English model; it uses the recovered corpus file for the source
stopword operation. `candidate-vectors.mjs` runs the provider helpers from
this worktree. `comparison.json` records the complete ordered result set:
10/10 cases match exactly. An independent 20-case extension also matched
20/20, including additional title, initialism, decimal, quote, newline,
ellipsis, and no-terminal-punctuation controls.

Commands:

```text
python3 .parity/reviews/q01-wikipedia-lexical-20260907/controls/source-vectors.py
node .parity/reviews/q01-wikipedia-lexical-20260907/controls/candidate-vectors.mjs
python3 .parity/reviews/q01-wikipedia-lexical-20260907/controls/compare-vectors.py
node --test packages/skills/test/q01Wikipedia.test.js
```

Focused Wikipedia tests pass 9/9. The skills test set excluding the unrelated
pre-core `q01Gqa.test.js` file passes 142/142. Running all 161 tests on this
`6819886` base has the known existing primitive-body result of 400 versus 500
in `q01Gqa.test.js`; that route repair is in root's separate `c1e760ff`
candidate and is outside this lexical change.

The source vectors prove the recovered model behavior for the covered forms;
they do not establish that the original unpinned `python:3` image used these
archive bytes at deployment time. Full Punkt Python tokenization outside the
implemented model-driven boundary controls remains a follow-up qualification.
