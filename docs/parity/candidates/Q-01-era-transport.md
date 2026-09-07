> Root accepted the bounded GQA core slice; see the [integration review](Q-01-core-integration-root-20260907.md). Candidate history below retains its original scope and qualifications.

# Q-01 — GQA pinned-era runtime and transport follow-up

Status: **working candidate; unverified**

Owner: Luna Max

Base: `3393df8cbb2a3ad1965146e03f5b4b5edeb58090`
Source: `jiborobot/srv-gqa-ws@ebe1a7d38f511570060c1fbf61bec89d58419b26`

This follow-up adds a GQA-owned HTTP adapter in
`packages/skills/src/gqaAnswerSkill.js`. `createGqaHttpRoute` checks the
source answer route's `X-JIBO-transID` requirement before calling the handler.
When the adapter is installed in a Phoenix service, a missing header returns
HTTP 400 with the source-observed HTML body and the handler is not called. A
present header is copied into the parsed request body as the source answer
route's one-element `request_data["transID"]` list, then the existing
`skillRoute` supplies the common timing/error wrapper. The adapter is exported
but is not silently installed in the shared skill registry; a GQA deployment
must select it deliberately. The common `skillRoute` remains unchanged.

The adapter handles only the source-specific header boundary. It leaves
arrays, scalar bodies, and malformed parsed objects on the ordinary handler or
parser path so that this GQA slice does not add a global schema policy. The
source answer route evaluates `request.json` and skill-entry analytics before
checking the header; the candidate's common parser therefore still runs before
the adapter. The source's precise invalid-body Flask diagnostics remain a
runtime-qualified difference below.

## Source runtime and fixture provenance

The first-step plan is frozen at
`/home/shell/work/phoenix/.parity/reviews/q01-gqa-era-20260906/runtime-plan.md`
(SHA-256
`59906921c2e0429d6e5dae9f099328d2ff8c2f651389baba0760462dc2085dda`). It
keeps the earlier Q-01 worktrees and captures unchanged.

The recovered source tree is the private snapshot at
`/home/shell/work/phoenix/.parity/reviews/q01-gqa-20260906/source/`. Its
source-manifest SHA-256 is
`397de78466cc803690e9a9121a0bef056e9a0e007f36563dd472a6347a5e7f05`.
The additional provider modules and MIM fixtures used by the source control
are under
`/home/shell/work/phoenix/.parity/reviews/q01-gqa-era-20260906/source-fixture/`;
the fixture manifest SHA-256 is
`d78f645dc0245fe95fa637fd07b9edfd710f95b3daa8165e3242a908d10c1aae`.
The recovered provider modules are the source `account.py`, `bing.py`,
`wiki.py`, `wolfram.py`, and `banned_words.py`; their individual hashes are
recorded in `source-fixture/manifest.sha256`.

The source runtime pin files are preserved under
`/home/shell/work/phoenix/.parity/reviews/q01-gqa-runtime-20260906/source-pins/`:

| file | SHA-256 |
| --- | --- |
| `Dockerfile` | `95a5ad5cd69b2dd68cc0b539c9aaeef84b65121158b97e38c14cffb24dbf11f2` |
| `docker-compose.yml` | `b72d55c12cf2b85bcc58ce23a3c7310d7a174dc88f2e90f09a0391017f5a6363` |
| `requirements.txt` | `06a97bca915111e4fcab4ca98a2e34c292501020c5923adaf52662573da33607` |
| `start_fake_services.sh` | `7ca2037e9369ea3e954aafa03d05d979e7b403585b87ae2a2c0518def04534f9` |
| `start_gunicorn.py` | `be43ad567ab2424f7f6e83ea155fe22c8ba8face5136a95675c5b66b0d14232f` |

The Dockerfile itself says `FROM python:3` and installs Flask 0.12.2,
gevent 1.2.2, gunicorn 19.7.1, NLTK 3.2.5, pymongo 3.4.0, requests 2.18.4,
and the remaining historical requirements. The bounded local inventory is
`q01-gqa-era-20260906/inventory/runtime-inventory.json` (SHA-256
`c571632b6cc8da560195d9ebb8a4cd29186b71386f742779c6be88141e3b7111`). It
found Python 3.10.12 and Flask 3.1.3, with no Python 2 executable and no
cached Flask 0.12.2, gevent, gunicorn, NLTK, pymongo, wikipedia, dateutils,
or unidecode closure. The internal registry observation
`inventory/registry-observation.json` (SHA-256
`73076ee2a98115c5f59372f20cd0e802564176d0bb0ae3e2510a94330e0312cc`) found
no `srv-gqa-ws` or GQA image. The listed `mitprg/python38` tags are a
different ROS/Python 3.8 image and are not used as a source-runtime claim.

One private no-network Docker build was attempted with the recovered
Dockerfile and requirements. The exact command was:

```text
docker build --pull=false --network=none --progress=plain --file Dockerfile --tag phoenix-q01-gqa-era-bootstrap-20260906 .
```

The command ran from the private `attempts/docker-context` directory and was
bounded at 30.007 seconds. Docker resolved the unpinned `python:3` reference
to `sha256:8edbf9e42c7fb168b9c523718ed907117e6d2e60f5889c0c499bbda3a787da53`,
then timed out while extracting that base and before dependency installation.
No image or container was created. The complete result is
`attempts/original-runtime-attempt-corrected.json`; the first harness
serialization failure remains separately preserved as
`attempts/original-runtime-attempt.json`. A prior offline pip bootstrap also
failed because the historical Flask wheel was absent. These results establish
that the exact source runtime was not available locally; they do not establish
that the source service itself fails to build elsewhere.

## Source-backed request controls

`controls/source-request-era-control.py` executes the recovered source route,
`gqa.gqa.gqa_pegasus`, `GqaParallelQuery`, `choose_slim`,
`make_response_for_hub`, analytics, cleaning, PII filtering, MIM builders, and
the recovered provider decoders. Its output is
`controls/source-request-era-output-7.json` (SHA-256
`f2224cfba82187041d0ad64747cd90b128fe72ee215f3541b86ffbf89361dc8a`), with
script SHA-256
`89e7e7003602f307baf016b0469fe8634e0c61913222f1542f5d54f5ae63aff0` and
exit `0`. The source control leaves the production `SERVICE_PATTERN` at its
source values of three seconds for the Bing/Wikipedia group and four seconds
for Wolfram Alpha. The local fake provider returns promptly by changing only
fixture sleep/random selection, so this control does not replace the source
deadline policy with a shorter timeout.

The eight original route cases are `success`, `no-answer`,
`provider-failure`, `missing-transid`, `invalid-shape`, `empty-text`,
`missing-ip`, and `pii-email`. Four additional rows exercise the recovered
Bing, Wikipedia, Wolfram, and banned-word boundaries. The route rows contain
ten HTTP 200 results, one 400 result for missing transID, and one 500 result
for invalid shape. Provider dispatch is visible in the receipt: normal
success selects Bing before Wikipedia, no-answer proceeds to the Wolfram
group, and a provider exception remains a private failed source result before
the normal no-answer MIM. The direct decoder and banned-word results are
source-module execution against local fixtures, not hand-authored candidate
answers.

The control uses these named offline seams, all recorded in its JSON output:

* synthetic `gqa.config` URLs and keys, because the source deployment config
  is not copied;
* a local `requests`/account response seam and an in-process recovered
  `fake_external` Flask client for provider HTTP;
* a fixture-backed `wikipedia` package/page, NLTK stopword/sentence-tokenizer
  data, and `unidecode` function;
* attribution persistence, AP, API-AI, and MIM-registry modules where the
  source route imports deployment-only services.

No provider network, archived service, robot, credential, or live service was
contacted. Python 3.10.12 and Flask 3.1.3 are the host runtime for this
control, so the source route's Flask 3 error renderer is not presented as
Flask 0.12.2 evidence.

The source transport rows record status, all available Flask response headers,
raw body hashes, and byte lengths:

| case | status | content type | bytes | raw body SHA-256 |
| --- | ---: | --- | ---: | --- |
| missing transID | 400 | `text/html; charset=utf-8` | 120 | `eff3b1c39715c9eab783d3b967e98abac146bf39ddffb703b913d2c83725a714` |
| invalid shape | 500 | `text/html; charset=utf-8` | 996 | `3a7aaffc934393b95af8cfe7bf11b0d298587fd5c6800014fc5a71ebd99a66c8` |
| malformed JSON | 400 | `text/html; charset=utf-8` | 167 | `3f48916adedde6dec8149e67f56c02d7d3006f340e8156abe95f1cfb8e4714da` |
| empty JSON entity | 400 | `text/html; charset=utf-8` | 167 | `3f48916adedde6dec8149e67f56c02d7d3006f340e8156abe95f1cfb8e4714da` |
| JSON null | 500 | `text/html; charset=utf-8` | 1241 | `4f5f4c634613cc916199a0a87763bc22205f0f99b068e139da0e675295276a57` |
| JSON array | 500 | `text/html; charset=utf-8` | 1251 | `6e25eb853a9ad8f2cb4aa6355be59879845c182d277b5c839b7b7457d61938a1` |
| JSON without content type | 415 | `text/html; charset=utf-8` | 215 | `ecc6dcc6ee4792d7992ca001e73409af3a3c11767078d2d21c14b2d098d2a3bf` |

The missing-header body is:

```text
<!doctype html>
<html lang=en>
<title>400 Bad Request</title>
<h1>Bad Request</h1>
<p>Missing X-JIBO-transID header</p>
```

The source body and header values above are exact observations from the host
Flask control. The historical Flask 0.12.2 parser/error formatting remains
unverified because the dependency-complete runtime could not be assembled.

The separate parser-order control
`controls/source-transport-order-output.json` (SHA-256
`6b55fb80292fd9389610d81331479d4d7d4e1e2faa8ec4201583272047ef8517`, script
SHA-256
`b5a535c3fde1f56786c68bb2f2f803c38bbb68dffdcfc9fcb6b0d42433121563`, exit
`0`) confirms the source ordering for malformed parsed bodies without a
header: a valid object still returns the 400 missing-header body, an object
without `type` returns 500, malformed/empty JSON returns 400, JSON null and
array return 500, and a missing content type returns 415. Thus the source
analytics access can fail before its missing-header branch. The adapter's
simple header guard intentionally does not reproduce those Flask diagnostic
responses; for a malformed body with no header it can return the missing-header
400 before the handler. This is an explicit remaining transport difference,
not hidden as a GQA result.

## Candidate boundary controls

The candidate route control imports the exact candidate worktree by absolute
path. `controls/candidate-gqa-route-output-3.json` was produced with:

```text
LOG_LEVEL=error node /home/shell/work/phoenix/.parity/reviews/q01-gqa-era-20260906/controls/candidate-gqa-route-control.mjs > controls/candidate-gqa-route-output-3.json 2> controls/candidate-gqa-route-3.stderr
```

It exited `0`; script SHA-256 is
`e3d7449832474cc01e0eb440120eafcd49e371787c967e7a3eba19eebbca7e38`, output
SHA-256 is
`0a1bc60528e412368cfad462640db53a3aa6f20feda38eda47971287524e9bf1`, and
stderr is empty. A valid request returned 200 with the first transID in the
handler's observed list and one numeric `timings.total`; a missing-header
request returned 400, content type `text/html; charset=utf-8`, 120 bytes, and
the exact source body/hash above. The handler call count was one across the
two requests, proving that the rejected request did not enter the handler.

The expanded matrix uses the actual candidate `gqaAnswerSkill` rather than a
body-inspecting test stub. Its command was the same form with
`candidate-gqa-transport-matrix.mjs`, and its final result is
`controls/candidate-gqa-transport-matrix-output-3.json` (SHA-256
`895f64bb00b4a1b226d54952af26cba6112bdf588e3bdb970a6e8d11293d06c2`), exit
`0`, script SHA-256
`2ef0efc74df18c2143dbbd35442004e77f04d1262fc7567cb37327a2a60d5669`, and
stderr SHA-256
`50803bcb0b5a0649d81cc159c370b8eb12319de1bd544a704e013c625a2220a2`.

The candidate matrix intentionally retains the common transport behavior so
the remaining boundary is visible:

| case | candidate status | candidate content type | bytes | result |
| --- | ---: | --- | ---: | --- |
| missing transID | 400 | `text/html; charset=utf-8` | 120 | exact source body/hash; handler skipped |
| invalid shape | 200 | `application/json; charset=utf-8` | 182 | common `skillRoute` ERROR object |
| malformed JSON | 400 | `application/json; charset=utf-8` | 145 | common parser ERROR envelope |
| empty entity | 200 | `application/json; charset=utf-8` | 182 | handler ERROR envelope |
| JSON null | 400 | `application/json; charset=utf-8` | 157 | strict common parser rejection |
| JSON array | 200 | `application/json; charset=utf-8` | 182 | handler ERROR envelope |
| JSON without content type | 200 | `application/json; charset=utf-8` | 182 | common empty-body/handler path |

For the same combined malformed/no-header ordering controls, the candidate
returns 400 missing-header HTML for missing `type`, empty body, JSON null,
JSON array, and missing content type; malformed JSON is rejected by the common
parser as a 400 JSON envelope. Those rows are retained in the final matrix
output with their dynamic bodies. This is the consequence of the adapter's
GQA-specific early guard and is why the candidate does not claim full source
invalid-body parity.

Dynamic message IDs and timestamps make the candidate error raw hashes
run-specific; the complete raw values and response headers are retained in the
matrix output. Its stderr contains only the expected common error logs for
malformed JSON and JSON null. The differences show why the adapter does not
claim to reproduce the historical Flask invalid-body renderer: matching that
renderer would require a GQA-specific transport error path and a verified
Flask 0.12.2 runtime. Successful normal Phoenix skill responses also retain
the common JSON content type, whereas the recovered Flask route returns its
JSON string as `text/html`; that is a separate common framing qualification.

## Validation

On the candidate worktree, before final commit, these checks passed:

```text
node --test packages/skills/test/q01Gqa.test.js       # 14/14
node --test packages/skills/test/*.test.js            # 147/147
node --check packages/skills/src/gqaAnswerSkill.js   # exit 0
git diff --check                                      # exit 0
```

The implementation changes only
`packages/skills/src/gqaAnswerSkill.js`, `packages/skills/src/index.js`, and
the GQA-focused test file. The untracked `node_modules` entry is the existing
workspace dependency link and is not part of the candidate. The old Q-01
worktrees, source snapshots, provider fixtures, reference/golden data, shared
service code, main branch, robot, and live services were not changed.

This is a bounded, source-backed transport improvement with explicit runtime
and dependency qualifications. It is not a claim of full GQA provider,
historical Flask, deadline, attribution, account, or deployment parity.
Root review and integration remain required.
