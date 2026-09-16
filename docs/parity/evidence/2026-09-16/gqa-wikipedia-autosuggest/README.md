# Wikipedia's "No match" — a real gap, and why the obvious fix is NOT shipped

Date: 2026-09-16
Status: **open question, deliberately unresolved. No code changed.**

The owner asked, fairly: is the Wikipedia provider just broken? I had said it
was "behaving as the source designed it". That was an assertion, not a finding,
and checking it turned up something real — and then a reason not to act on it
yet.

## The gap is real

Jibo's fork of the `wikipedia` PyPI library
(`.parity/reviews/q01-wikipedia-http-20260907/source/jiborobot/wikipedia/wikipedia/wikipedia.py:262-288`):

```python
def page(title=None, pageid=None, auto_suggest=True, redirect=True, preload=False):
  if title is not None:
    if auto_suggest:
      results, suggestion = search(title, results=1, suggestion=True)
      try:
        title = suggestion or results[0]
      except IndexError:
        raise PageError(title)
    return WikipediaPage(title, redirect=redirect, preload=preload)
```

`auto_suggest` **defaults to True**: `page()` normally resolves the title
through a search before loading the article.

Phoenix's `searchArticle` has no such stage. It goes straight to the title
lookup, so it asks Wikipedia "is there an article *titled* `tall is mount
everest`?" — there is not. Wikipedia's search API, asked that exact string,
returns `Mount Everest` as its top result.

So the missing search stage is a genuine difference from the library Jibo
shipped.

## And the obvious fix makes things worse

Implemented and measured against the live API, then **reverted**:

| query | strict title lookup (today) | with auto_suggest |
| --- | --- | --- |
| how tall is mount everest | ✗ No match | **✓ Mount Everest** |
| what is the eiffel tower | ✓ | ✓ |
| who is ada lovelace | **✓** | **✗ No match** |
| who was marie curie | **✓** | **✗ No match** |

The cause is the fork's own precedence, `suggestion or results[0]`: the
spelling suggestion wins even when the top hit is exact. Wikipedia suggests
`as lovelace` for "ada lovelace" and the correct `Ada Lovelace` is discarded.
Meanwhile the strict lookup gets those right for free, because MediaWiki
normalises the first letter and follows redirects — `titles=ada lovelace`
resolves to `Ada Lovelace`.

Neither behaviour dominates. Adding auto_suggest buys question-form lookups and
loses person lookups, which are the ones that work on the robot today.

## Why nothing was shipped

The caller is missing. `gqa.py:31` does `import gqa.wiki` and `gqa.py:247`
calls `gqa.wiki.call(self.text, self.question_type)`, but **`gqa/wiki.py` is
not in the recovered source** — `.parity/reviews/q01-gqa-20260906/source/gqa/`
has `gqa.py`, `nlp.py`, `analytics.py`, `log_helper.py`, `pegasus_mims.py` and
`version.py`, and nothing else.

So the one fact that decides this is not in hand: whether `gqa.wiki.call`
passed `auto_suggest=False` or took the `True` default. If it passed `False`,
Phoenix is already correct and the strict lookup is the source behaviour. If it
took the default, Phoenix is missing a stage — and Jibo's own "who is X"
lookups went to Bing while Wikipedia raced alongside it, which would make the
suggestion quirk survivable in a way it is not now that Bing is gone.

Shipping either one on a guess would be picking which questions the robot
stops answering. A subagent is searching the archives for `gqa/wiki.py`; the
patch is small and reproducible from this file once the answer is known.

## Reproduction

```bash
# the gap
curl -sG 'https://en.wikipedia.org/w/api.php' --data-urlencode 'srsearch=tall is mount everest' \
  -d 'action=query&list=search&srlimit=1&srinfo=suggestion&srprop=&format=json'
# -> top result "Mount Everest", suggestion null

# why auto_suggest loses people
curl -sG 'https://en.wikipedia.org/w/api.php' --data-urlencode 'srsearch=ada lovelace' \
  -d 'action=query&list=search&srlimit=1&srinfo=suggestion&srprop=&format=json'
# -> top result "Ada Lovelace", suggestion "as lovelace"  <- suggestion wins in the fork

# why the strict lookup gets people right
curl -sG 'https://en.wikipedia.org/w/api.php' --data-urlencode 'titles=ada lovelace' \
  -d 'action=query&format=json&redirects=&prop=info&inprop=url'
# -> FOUND: Ada Lovelace, via redirect
```

## Separately: "how" questions are blocked before any of this

With the real `question_type`, `canAnswer` refuses "how tall is mount everest"
outright — `Blocked by WIKIPEDIA_QUESTION_WORDS restriction.` — before any
lookup happens. That part *is* source behaviour and is not in question here.
Wolfram Alpha, now configured, answers that class of question.
