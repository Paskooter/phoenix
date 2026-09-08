# A-04 guardian and agreement transport repair

Status: **implemented candidate; pending root review and acceptance**.

This follow-up is based on the frozen guardian/agreement candidate at
`ded7b2c6325362582480d6753f366a4d87686cd1`. It repairs only confirmed
source-observable transport boundaries:

- The default EchoSign transport suppresses bodies and `Content-Length` for
  GET and HEAD, matching Wreck's `payloadSupported` branch.
- Response decoding follows Wreck's `json: true` smart MIME behavior: empty
  bodies become `null`, `application/*json` bodies are parsed, and other MIME
  types remain Buffers. Malformed JSON still rejects.
- Provider HTTP responses with status 400 through 599 retain their status;
  agreement handler errors preserve that status at the AWS-facing boundary.
- OAuth form data uses Node's `querystring.stringify`, as the source does.
- Agreement Joi/Boom validation uses the shared Hapi-compatible 422 response
  headers (`cache-control`, `vary`, no Express identity header).
- Low-level refused connections and truncated responses receive the bounded
  source-like 502 and 500 status envelopes.

The authority is `srv-account-ws@6cea43470825657d6a5722162f28c8f233153ee2`,
with the pinned `echosign.ctrl.ts`, Loop controller/handler, Node `v8.9.4`,
Joi `10.5.2`, and Wreck `12.6.2`. The source and candidate controls use only
synthetic values and local loopback peers; no EchoSign, database, mail,
robot, or live service was contacted.

Validation in this worktree:

- `node --test packages/account/test/loopAgreements.test.js`: 3 passed.
- `node --test packages/account/test/*.test.js`: 205 passed.
- `npm run test:unit`: 878 tests, 871 passed, 7 skipped, 0 failed.
- Independent Node 8 source and Node 22 candidate controls cover JSON and
  text MIME, empty/malformed bodies, GET request bytes, form encoding,
  400/404/500/503 responses, truncation, connection failure, and Account plus
  Classic validation headers. The raw receipts are kept privately under
  `.parity/reviews/a04-agreements-transport-repair-20260908/`.

Real source controller/database execution, the real EchoSign provider, mail
delivery, concurrent save behavior, and deployment credentials remain outside
this candidate's verification. Node runtime default connection policy is explicitly set to
the source `close` behavior in the default transport; an injected test
transport remains unchanged.
