# A-06 Settings provider error-envelope fallback candidate

Root update: this bounded candidate is accepted as part of the
[final Person review](A-06-settings-person-root-20260907.md). The original
submission below is retained as historical evidence; full A-06 remains open.

Status: unverified candidate, pending root review. This focused slice starts at
`f074a8b11b5bdd50f8ad53cd147556b292ba8ba3` and owns only the Settings outer
error projection and its focused regression test. It does not change Person or
Lasso transport, the shared server, the public AWS face, or the accepted local
storage code.

## Contract and change

The source Settings service is
`jiborobot/srv-settings-ws@0d37e1fd2f4fca40538fb470194a3c5daf2c9830`. Its
ordinary Hapi/Boom error payload contains `statusCode`, `error`, and `message`,
and preserves an explicitly present `code`, including `code: ""`. The candidate
previously selected a small status-to-label table and tested `code` for
truthiness. Consequently a valid provider 400/401/503 response whose code was
absent or empty could become an `Internal Server Error` label, and an empty
code disappeared from the wire response.

`packages/account/src/settingsFace.js` now takes the label from the existing
Boom output payload for non-generic statuses and distinguishes an absent code
from an explicitly empty code. `sourceError()` emits the code whenever it is
defined, so JSON serialization retains `"code":""` while still omitting an
absent value. The generic source 500 wrapper remains unchanged: it keeps the
source message and generic `Internal Server Error` envelope.

The distinction is machine-readable to the pinned Jibo Server Client. Its
archived Settings JSON extractor at
`.parity/consumers/be-12.0.0/server-clients/settings/lib/protocol/json.js`
uses `e.__type || e.code || e.error` for the client error code. Thus an absent
or empty wire `code` falls back to the wire `error` label; this is why the
400/401/503 label repair is functional rather than wording-only.

## Source and candidate evidence

The fresh source/candidate controls are under
`/home/shell/work/phoenix/.parity/reviews/settings-error-envelope-20260907`.
Each control uses a synthetic account and loop identifier and a real loopback
HTTP Person provider. The source side runs the pinned compiled Settings service
under Node `v8.9.4` from image
`sha256:8233daae003ba0ecba4e6d70cab8525c30a3f085935afc624a275892ebe23f7c`,
with `@jibo/server` 4.0.12, Hapi 16.4.1, Wreck 12.6.2, and Boom 5.1.0. The
candidate runs in this worktree under Node `v22.22.0`; its
`node_modules/@phoenix/*` links resolve to this worktree's package directories.

The seven source/candidate UpdateSettings controls are:

| control | result |
| --- | --- |
| provider 400, code absent | exact status, raw body, decoded body, provider count, and settlement |
| provider 400, code empty | exact status, raw body, decoded body, provider count, and settlement |
| provider 400, code `P400` | exact status, raw body, decoded body, provider count, and settlement |
| provider 401, code absent | exact status, raw body, decoded body, provider count, and settlement |
| provider 404, code absent | exact status, raw body, decoded body, provider count, and settlement |
| provider 503, code empty | exact status, raw body, decoded body, provider count, and settlement |
| provider 500, code absent | status, decoded body, provider count, and settlement; raw body differs only in JSON member order |

The final comparison is therefore 7/7 for status and decoded response data,
with 6/7 byte-identical bodies. The one retained raw difference is the
generic-500 object member order: source
`{"statusCode":500,"error":"Internal Server Error","message":"An internal server error occurred"}`
versus candidate
`{"message":"An internal server error occurred","statusCode":500,"error":"Internal Server Error"}`.
This is a known generic-500 serialization qualification; the candidate did not
alter that source path.

The pinned Node 8 Jibo Server Client extractor was also run against the source
and final candidate bodies. For all seven controls, the extracted
machine-readable `code`, `message`, and attached HTTP `statusCode` agree. The
immutable pre-fix extractor receipt records the substantive mismatches for
400-without-code, 400-with-empty-code, 401-without-code, and 503-with-empty-code:
the candidate previously exposed `Internal Server Error` as the client code
where the source exposed `Bad Request`, `Unauthorized`, or `Service
Unavailable`.

The extractor probe uses only a small `util.error` property-attachment shim
because the archived consumer omits its shared utility modules. It records
that boundary and the exact source file hash
`6cf151a37c4b1b394eefaae34b59ef1b06d1599524b4783c02175e45329399b4`; it does
not claim a full BE process integration.

The prior original 19-case Settings boundary captures at
`/home/shell/work/phoenix/.parity/reviews/settings-mediation-integration-root-20260907/person-boundary`
were preserved and not retagged or overwritten. The new controls are separate
and do not expand the original 19-case claim.

## Validation and limits

The focused test passes:

```text
node --test packages/account/test/settingsErrorEnvelope.test.js
```

The complete Settings/account test glob passes 62/62:

```text
node --test packages/account/test/settings*.test.js
```

The candidate remains unverified until root reviews the diff and reruns the
combined acceptance controls. OAuth, Mongo persistence, live provider
availability, and production Jibo Server Client end-to-end behavior remain
outside this slice. Exact generic-500 byte ordering is retained as the one
source/candidate qualification above; no error normalization was used to hide
it.
