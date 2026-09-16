# Wikipedia's "No match" — a real gap, and why the obvious fix is NOT shipped

Date: 2026-09-16
Status: **RESOLVED. Phoenix is correct as it stands; the proposed change would
have been a divergence. No code changed, and none should be.**

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


---

# Resolved: the source never calls the function that has auto_suggest

`gqa/wiki.py` was not missing from the archive, only from the local recovered
copy. It is in `jiborobot/srv-gqa-ws` at `ebe1a7d3` — the same revision Phoenix
already pins as `WIKIPEDIA_SOURCE_REVISION`:

```bash
git clone --bare https://pvindex.org/gitea/jiborobot/srv-gqa-ws.git
git show ebe1a7d38f511570060c1fbf61bec89d58419b26:gqa/wiki.py
```

`gqa/wiki.py:110-112`:

```python
    try:
        wikipedia.set_api_url(gqa.config.CONFIG_DICT["wiki_api"])
        page = wikipedia.WikipediaPage(title=query)
```

It constructs **`wikipedia.WikipediaPage` directly**. `auto_suggest` is a
parameter of the module-level helper `wikipedia.page()`, which this file never
calls:

```
$ git show ebe1a7d3:gqa/wiki.py | grep -c auto_suggest      -> 0
$ git show ebe1a7d3:gqa/wiki.py | grep -c 'wikipedia\.page(' -> 0
```

`WikipediaPage.__init__` goes straight to `__load`, the direct title lookup.
There is no search stage, and there never was one.

**So Phoenix's strict title lookup is exactly right**, and the change measured
in the section above would have been a divergence from the service Jibo ran —
one that broke "who is Ada Lovelace" and "who was Marie Curie" to fix a question
form Wikipedia was never the provider for. Reverting it was correct.

Corroboration that the port was made from this file: its error strings are the
source's, one for one.

| string | `wiki.py` | `gqaWikipediaProvider.js` |
| --- | --- | --- |
| `No match for query '{0}'` | 1 | 1 |
| `apparently got article on related but different topic` | 1 | 1 |
| `Unexpected empty summary for query '{0}'` | 1 | 1 |
| `due to article blacklist` | 1 | 1 |

`wiki.py` is now saved to
`.parity/reviews/q01-gqa-20260906/source/gqa/wiki.py` so the next agent to ask
this question finds the answer instead of the gap.

## What the owner actually asked

> "is that just broken then... there's no way they intended it to just be
> stupid and not work"

It is not broken, and it was intended — but the intent only makes sense with the
rest of the pipeline present. Wikipedia was never meant to field "how tall is
X". Bing was, through an answer card written to be spoken, and Wikipedia raced
alongside it for entity questions, which it still does correctly. What changed
is that Bing is gone. The replacement for that role is Wolfram Alpha, now
configured, which answers exactly the quantitative class Wikipedia declines.
