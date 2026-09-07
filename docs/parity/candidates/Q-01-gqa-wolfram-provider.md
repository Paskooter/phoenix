# Q-01 GQA Wolfram Alpha provider candidate

Status: **candidate, unverified; awaiting root review**.

This candidate adds an opt-in Wolfram Alpha provider adapter. It does not add Wolfram to the default Phoenix profile and it does not contain a live key or a live endpoint. The caller must supply the recovered deployment endpoint (`CONFIG_DICT["wolfram_api"]`) and app id explicitly.

## Source contract

The source is `jiborobot/srv-gqa-ws@ebe1a7d38f511570060c1fbf61bec89d58419b26`, recovered module `gqa/wolfram.py`, SHA-256 `9bab44d619de518f36bd5179f2fff3842254866bc8b3a78aea653a751beda164`.

The implementation follows these source boundaries:

- `extract_pod_answer`, lines 24-37: scan every pod and retain the last pod carrying `primary`, `subpods`, and `title == "Result"`; select its first subpod plaintext.
- `extract_spoken_answer`, lines 39-65: any pod titled `Response` suppresses speech; otherwise prefer `spokenresult.srtemplate.sampletext`, then `spokenresult.sampletext`, then the result pod. `EntityInformation` skips spokenresult and reaches the pod fallback. The source's `" for Date "` cleanup is applied only to `srtemplate` output.
- `clean_answer`, lines 67-106: reject the listed symbols and source phrases, reject leading-parenthesis answers, then remove remaining parentheses without trimming.
- `call`, lines 109-167: construct the ordered `input`, `appid`, `output=JSON`, `spokenresult=true`, `totaltimeout=3`, `scantimeout=1.0`, `podindex=2`, `ip`, and optional `latlong` request; emit `Wolfram Alpha` timestamps; derive the public input URL from the response URL; return a response only for a nonempty cleaned answer.
- The `call` request/status/JSON `try` block, lines 132-149, returns `Unexpected exception: ...` with the request timestamp and a response timestamp only after a response object was obtained. Post-JSON `success`/shape/extraction failures remain outside that catch.

The candidate implementation is [gqaWolframProvider.js](../../../packages/skills/src/gqaWolframProvider.js). It exports `createWolframProvider`, `extractWolframSpokenAnswer`, `extractWolframPodAnswer`, and `cleanWolframAnswer`, and re-exports the source contract from the skills index. It preserves explicit null query omission, source parameter order, URL derivation, success-false/empty no-answer behavior, post-HTTP failure boundaries, and the absence of an invented HTTP timeout. The existing named GQA pipeline can receive the adapter as its `Wolfram Alpha` provider; no registry/profile is changed here.

## Source/candidate controls

The private controls are under `/home/shell/work/phoenix/.parity/reviews/q01-gqa-wolfram-provider-20260907/controls`.

The unchanged recovered source was executed with:

```text
python3 /home/shell/work/phoenix/.parity/reviews/q01-gqa-wolfram-provider-20260907/controls/run-source-wolfram.py
```

The runner reads the selected image digest from the existing machine-readable manifest rather than retyping it. Its final receipt is `source-run-v1/docker-run.json` (SHA-256 `6714fe4533af8e5609ba74bcb8e6a62ed5a2da5677bca106aa8823c99c646717`) and records:

- image `python@sha256:d59ee182c4629dd33b240b9bac1a6ff44276e79e66117eba17aed4016845d3b2`, selected `linux/amd64`;
- inferred compatibility runtime Python 3.6.15 and `requests==2.18.4`;
- pinned requests dependency wheel hashes in the receipt (`certifi 2017.7.27.1`, `chardet 3.0.4`, `idna 2.6`, `urllib3 1.22`, and `requests 2.18.4`);
- `--network none`, read-only source/dependency mounts, local loopback peer inside the container, and source process exit 0 in 5.155 seconds.

The source peer and candidate peer run the same 25 ordered cases:

```text
srtemplate, sampletext, pod-fallback, entity-information,
response-suppressed, success-false, missing-success, empty-object,
clean-symbol, clean-parentheses, clean-empty-list,
clean-regular-expression, clean-first-one, clean-image,
clean-leading-paren, http-error, malformed-json, transport-error,
malformed-shape, non-string-answer, redirect, blank-input, null-query,
no-location, missing-ip
```

The source output is [source-output.json](../../../../../reviews/q01-gqa-wolfram-provider-20260907/controls/source-run-v1/source-output.json), SHA-256 `c41503d04f14051db3810f9e4eb3e8a0ecc770dae28e3d769e81c7b01978c104`. The candidate was run with:

```text
Q01_OUT=/home/shell/work/phoenix/.parity/reviews/q01-gqa-wolfram-provider-20260907/controls/candidate-output-v1.json node /home/shell/work/phoenix/.parity/reviews/q01-gqa-wolfram-provider-20260907/controls/candidate-wolfram-control.mjs
```

Its output is [candidate-output-v1.json](../../../../../reviews/q01-gqa-wolfram-provider-20260907/controls/candidate-output-v1.json), SHA-256 `b242c4000174f7db3c55a8120db83cb83d3d40a9b02adc671f0f1f57c0f9c75b`. The comparison command was:

```text
python3 /home/shell/work/phoenix/.parity/reviews/q01-gqa-wolfram-provider-20260907/controls/compare-wolfram.py
```

The resulting [comparison-v1.json](../../../../../reviews/q01-gqa-wolfram-provider-20260907/controls/comparison-v1.json), SHA-256 `b8b8c493a198a40819f405daaa96af01f15a92350831b405a51ceef3008aa1d0`, reports:

```text
25/25 ordered IDs
25/25 request records
25/25 result records
25/25 raised-boundary records
```

The comparison retains raw statuses, ordered query fields, redirect hops, response headers, result fields, timestamps, and raised values. Semantic equality excludes only runtime timestamp values and qualifies demonstrated Python/JavaScript diagnostic wording: traceback versus `Error` text for request/status/JSON failures; Python `KeyError` versus JavaScript `TypeError` for the missing-success/malformed-shape boundaries; and Python `AttributeError` versus JavaScript `TypeError` for the non-string extraction boundary. It does not replace those raw diagnostics with a claimed exact message.

## Tests

The candidate worktree has its own installed workspace links; `@phoenix/common`, `@phoenix/contracts`, and `@phoenix/skills` resolve inside this worktree. Validation passed:

```text
node --test packages/skills/test/q01WolframProvider.test.js
13 passed, 0 failed

node --test packages/skills/test/q01WolframProvider.test.js packages/skills/test/q01BingProvider.test.js packages/skills/test/q01Wikipedia.test.js packages/skills/test/q01Gqa.test.js
58 passed, 0 failed
```

Product hashes at the candidate state:

```text
cecf2ebfbb41e88557d57439e25a1b4f5976ce638041c0030776cc5e8b1d16dc  packages/skills/src/gqaWolframProvider.js
ef93beab101b46d1799fdfdbe647727e2770de722e1b021dd5ddee77699bf329  packages/skills/src/index.js
1c2baedd21d19b40da8269144e0aa2f0e14cacb49b740b34595109dc2d957fb8  packages/skills/test/q01WolframProvider.test.js
```

## Follow-up source correction

The follow-up candidate changes only the `srtemplate` Date-placeholder cleanup:
source `gqa/wolfram.py` uses Python `str.replace(' for Date ', ' ')` without a
count, so every occurrence is replaced. The adapter now uses a global JavaScript replacement at that same boundary,
which preserves all occurrences while retaining the source-shaped `.replace`
error boundary for malformed values. The `spokenresult.sampletext` fallback is
still returned without this cleanup. The focused regression covers repeated
placeholders and the unchanged fallback path; the original 25-case receipt
above remains immutable. The follow-up focused command passes 13/13 in the
new candidate worktree.

## Limits

This is a bounded provider candidate, not full Q-01 provider parity. No real Wolfram endpoint, credential, or archived provider was contacted. The recovered source's persistent `requests.Session` lifecycle is represented by the transport seam and tested request behavior, but connection-pool reuse itself is not claimed as cross-runtime identity. Source traceback/error wording and runtime-generated HTTP default headers remain qualified as described above. JSON decoding uses the runtime transport's parser; no XML or transliteration dependency is required by this source module. Account lookup, GQA orchestration, default registration, and live provider availability remain outside this candidate.
