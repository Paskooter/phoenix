# Q-01 GQA HTTP framing and media boundaries — candidate

Status: **unverified; pending root review**. This is a bounded HTTP-framing
candidate. It does not close Q-01.

Phoenix revision: `fb3ae576fa51ca4b41c23a27935cc25aec3e2346` on
`codex/candidate-q01-gqa-http-framing-20260907` (base `19e01ad`). Source
revision: `jiborobot/srv-gqa-ws@ebe1a7d38f511570060c1fbf61bec89d58419b26`.
Oracle runtime: Python 3.6.15 / Flask 0.12.2 / Werkzeug 0.12.2 in
`python@sha256:d59ee182c4629dd33b240b9bac1a6ff44276e79e66117eba17aed4016845d3b2`,
`--network none`. Host Python 3.10 / Flask 3.1 was not used as the oracle.

`PHOENIX_GQA_DEFAULT_PROFILE` isolation from `19e01ad` is unchanged.

## Defects addressed

Root's default-wire comparison
(`.parity/reviews/q01-gqa-default-wire-verification-20260907`) had 8/8 paired
route statuses and 15/15 transport statuses, with two remaining classes of
mismatch:

1. `malformed-json` and `malformed-json-no-header`: original HTML 400 vs
   candidate JSON `ERROR` envelope.
2. Successful responses: original `text/html; charset=utf-8` vs candidate
   `application/json; charset=utf-8`.

Plus the previously noted Flask vendor-JSON (`application/*+json`) and
unsupported AWS JSON (`application/x-amz-json-1.1`) parser boundary.

## Layer that produces the original HTML

Established from pinned Flask 0.12.2 / Werkzeug 0.12.2 sources and from the
recovered `gqa.APP` test client, not from host Flask 3.

| Input | Layer | Status | Content-Type | Body |
| --- | --- | --- | --- | --- |
| Malformed or empty JSON with `application/json` or `application/*+json` | `flask.wrappers.Request.get_json` → `on_json_loading_failed` → `werkzeug.exceptions.BadRequest()` (debug is false, so the default description is used). `gqa.py:log_http_error` is registered for 400 and returns the exception unchanged. | 400 | `text/html` (Werkzeug `HTTPException.get_headers`; no charset) | Werkzeug `HTTPException.get_body()` HTML 3.2 page with *The browser (or proxy) sent a request that this server could not understand.* |
| Missing `X-JIBO-transID` after a parsed object that still has `type` | `abort(400, "Missing X-JIBO-transID header")` → same Werkzeug HTML renderer via `log_http_error` | 400 | `text/html` | Same HTML 3.2 wrapper with that description |
| `json.dumps(...)` success string from `make_response_for_hub` | Flask `Response.default_mimetype = 'text/html'` | 200 | `text/html; charset=utf-8` | JSON text |
| Uncaught exception (`request.json` is `None`, primitive JSON, invalid shape) | `@APP.errorhandler(500)` returns a `json.dumps` string | 500 | `text/html; charset=utf-8` | `{version, message, stacktrace}` |
| `application/x-amz-json-1.1`, missing content type, `text/plain` | `Request.is_json` is false, so `request.json` is `None` and never parsed. Analytics then indexes `None`. | 500 | `text/html; charset=utf-8` | same 500 envelope |

The HTML 3.2 page is **not** an application template. Flask 3 HTML5
`<!doctype html><html lang=en>...` pages are a different renderer and were
the previous candidate's mistake.

`Request.is_json` is `application/json` or `application/` + `+json`. AWS JSON
does not match, so malformed AWS input bypasses the parser.

## Candidate change

`createGqaHttpRoute` now:

* sets `jsonTypes` to `['application/json', 'application/*+json']` and keeps
  `jsonStrict = false`;
* uses a route-scoped `parserError` that emits the Werkzeug 400 HTML with
  `Content-Type: text/html` and no charset;
* treats empty Flask-JSON entities as that same 400 (body-parser does not);
* leaves AWS JSON unparsed so it reaches the source 500 branch;
* sends success and 500 `json.dumps`-shaped strings as
  `text/html; charset=utf-8`.

The named-robot default-profile isolation is not touched.

## Evidence

Failing-before (previous candidate vs this same source control): default-wire
verification, 2 substantive malformed-JSON envelope diffs and 6+4 success
Content-Type diffs. Artifact
`/home/shell/work/phoenix/.parity/reviews/q01-gqa-default-wire-verification-20260907/comparison/comparison.json`.

Passing-after, this worktree:

```text
python3 .parity/reviews/Q-01-gqa-http-framing-20260907/run-source-framing.py
node .parity/reviews/Q-01-gqa-http-framing-20260907/candidate-framing.mjs
python3 .parity/reviews/Q-01-gqa-http-framing-20260907/compare-framing.py
node --test packages/skills/test/q01GqaHttpFraming.test.js packages/skills/test/q01Gqa.test.js
```

Source Docker: exit 0, 16.867s, Python 3.6.15 / Flask 0.12.2. Comparison of
22 paired transport/framing rows: **22/22 status, 22/22 exact Content-Type,
22/22 semantic after path-specific qualification, 7/7 exact 400 HTML bodies,
0 substantive diffs, 0 wire-media diffs.**

Qualification: 200 action JSON is a stub `SKILL_ACTION` vs the source GQA
action (status and Content-Type only). 500 `message`/`stacktrace` text is
diagnostic and was compared as the `{version, message, stacktrace}` field
set, not byte-identical strings. Duplicate `X-JIBO-transID` was not in this
22-row capture; existing unit tests already cover Flask `getlist` selection.

SHA-256 of retained artifacts:

```text
8580ef4f20b12796d354f5567b3a81b1cf53b08eeff7eb82aef3feae90f5c194  source-framing-container.py
a0132b36d21c00ddc245aa4d8b3f359b477c6de801bf3aabf5f2bd20eb594636  run-source-framing.py
75afc38ba0c06aa0b63f1f08eae65fb65427c3e3506ccd5f00c5de22a16ac523  candidate-framing.mjs
c3d54fe092e3f5c12645d17e2a0ff0bf88c5e6247315d4c31c934d9d9a5ee663  compare-framing.py
281d9856ec070f87b94d289943cb2ce496879b57d4b0ca533d4cd44c4c621249  source-run/docker-run.json
d460951c1461212d1654c3d7966ff335509d7555885ed9c220521cfe4fa57ef2  source-run/source-output.json
2303f03db116f0972a2ae72fc51dcbf4714f59ce908a74fdf778a714514360d3  candidate-run/candidate-output.json
ae93d0aaa4400bbf8c5cef2779f33b3e4bf35a01088ff11098f4eaa41ed91907  comparison/comparison.json
```

Focused tests: 27 passed, 0 failed.

`npm test` in this worktree: **770 tests, 763 passed, 0 failed, 7 skipped**;
`parity:gate` 43 cases, 0 differences, 0 invariants, 0 coverage gaps. Exit 0.

## What this does not establish

* Full Q-01 provider, account, attribution, or robot behavior.
* Gunicorn/ALB/gateway Content-Type rewriting in front of the Flask app.
* Flask `DEBUG=True`, which would change the malformed-JSON description to
  `Failed to decode JSON object: ...`.
* Byte-identical 500 stacks or 200 GQA action payloads.
* Live Bing/Wikipedia/Wolfram calls.

## Next step

Root should replay the default-wire 12-route/15-transport comparison against
this revision and decide whether the Werkzeug 400 HTML and success
`text/html; charset=utf-8` framing close this bounded defect.
