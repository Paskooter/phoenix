# Exact-bundle operator review

**Who this is for:** publishers who want to know what happens to a submitted version, and Skill Store operators reviewing submissions by hand or with a trusted review tool.

Publisher identity approval permits uploads, not public publication. Each new third-party declarative app or menu-theme version creates an immutable unsigned submission in `submissions`, never `releases`. A pending update leaves the previous published version and its installation/removal paths untouched. A corrected or rejected submission needs a new version; approval never transfers to it. Pending/rejected evidence consumes the existing publisher storage and submission-rate quotas. Theme source and normalized containers are both retained and charged when different.

Supported formats and native policy are unchanged. This does not enable third-party native execution, add a cloud runtime or change first-party signed native ingestion, JiboTube, owner-test or migration-only routes. Operator review is not hardware certification or a guarantee of safety or rights clearance.

## Human review

Open **Publisher review** at `/apps#operator` using an existing administrator session. The bundle queue shows publisher, app, version and state. **Inspect** opens an inert manifest/file tree, normalized PNG viewer, source/normalized downloads, permissions, runtime, minimum firmware, hashes and changed top-level manifest fields against the most recent approved published submission. No developer URLs are followed, no HTML is interpreted and no bundle is run. Downloaded input is untrusted: inspect it in an isolated environment without operator credentials.

Record a bounded reason and test summary, then choose **Approve only**, **Approve and publish exact bytes**, **Reject** or **Request changes**. An approved submission has a separate **Publish approved bytes** decision. The UI re-reads exact state before deciding; the service independently enforces the hash and expected state inside the durable mutation. A changed/revoked publisher or inactive/non-admin reviewer cannot authorize publication. The actual authenticated operator principal, human/agent metadata, decision, time, source/normalized/material hashes, reason and test summary are recorded in submission history and the bounded operator audit trail. `method` is caller-supplied attribution, not an authentication mechanism.

Publication signs exactly the reviewed normalized descriptor and stores those exact bytes; it does not change an author's chosen draft/unlisted/public visibility. A private-scope review cannot be used to widen its release to public. Source changes require a new submission/version.

## JSON HTTP contract

All endpoints require the existing operator user session. Mutation uses existing same-origin/CSRF protections; send the deployment's exact Origin. Responses are no-store. Do not give session credentials to bundles, reviewer prompts or untrusted tests.

Base: `/api/skill-store/operator/submissions`

- `GET /` (no trailing slash required): `{ "submissions": [...] }`, including pending, approved and terminal states.
- `GET /:id`: exact material identity, normalized manifest, descriptor, scope, files with SHA-256 and sizes, previous approved version and changed manifest fields. Published detail includes its signed release.
- `GET /:id/material?part=source|normalized`: bounded hash-verified bytes as an attachment (`application/octet-stream`, `nosniff`, sandbox CSP, `X-Content-SHA256`). Declarative source means the canonical submitted JSON object: HTTP whitespace is not part of the package identity. For ZIP theme uploads, the browser packs the ZIP before upload, so source means the submitted `.phtheme`, not the ZIP or unpacked author folder.
- `GET /:id/file?path=package.json|theme.json|assets/ID.png`: allowlisted inert JSON text or normalized PNG base64; paths never access the filesystem directly.
- `POST /:id/decision`:

```json
{
  "materialHash": "<64-hex SHA-256 from detail>",
  "expectedState": "pending",
  "decision": "approve_publish",
  "reason": "Inspected manifest and all listed files",
  "testSummary": "Offline validation and isolated smoke checks passed",
  "method": "agent",
  "requestId": "operator-generated-unique-id"
}
```

Decisions: `approve`, `reject`, `request_changes`, `approve_publish` from `pending`; `publish`, `reject` or `request_changes` from `approved`. Rejection or requested changes revokes an unconsumed approval; a stale publication can no longer use it. Reasons allow 1–1200 characters, test summaries 1–2400; control characters are refused. Request IDs allow 8–100 letters/digits/underscore/hyphen. Exact retries by the same principal return the original result; changed bodies or principals conflict. Stale state/hash/scope conflicts return 409. GET the exact ID after mutation and compare material hash, state and (when published) signed descriptor/signature. There is no author-controlled approval flag or publication shortcut.

`materialHash = SHA256(canonical({appId,publisherId,descriptor,manifest,sourceSha256,sourceBytes,artifactSha256,artifactBytes,kind,scope}))`. Canonical JSON is the existing Store format. This binds runtime, permissions, minimum firmware, launch names, notes, assets, support URLs and every manifest field, not just a version string.

## Thin agent client

The included client is an operator-side trusted harness, not an LLM service. It fetches and hash-verifies both containers and material identity before a decision, uses the same HTTP decision gate as the human UI, and verifies exact readback. It never executes reviewed input or follows submitted URLs. HTTPS is required except for loopback offline tests; redirects are refused and responses are size/time bounded.

Have the trusted harness provision a private regular cookie file (mode 0600). Do not paste cookies into commands or reports. Set these only in the trusted harness environment:

```sh
export PHOENIX_REVIEW_ORIGIN=https://your-phoenix.example
export PHOENIX_REVIEW_COOKIE_FILE=/private/operator-session.cookie
node scripts/skill-store-review.mjs queue
node scripts/skill-store-review.mjs inspect sub-UUID /private/new-review-directory
node scripts/skill-store-review.mjs decide sub-UUID approve_publish MATERIAL_HASH pending \
  'Inspected exact files' 'Offline checks passed' unique-request-id
```

Use the real `sub-…` ID and hash from the queue/detail. `inspect` creates a new mode-0700 directory with mode-0600 `detail.json`, `source.bin`, `normalized.bin`. Keep credentials separate from this material. `decide` can also approve only, reject, request changes or publish an earlier approval; provide its exact expected state. JSON stdout contains the decision result and `readbackVerified: true`; error output never includes the cookie header.

## Existing releases and rollback

No historical release is silently withdrawn or marked reviewed. A pre-existing public legacy release remains as it was, including inventory/removal/migration access; future submissions must pass this gate. A legacy third-party draft/unlisted release cannot newly become public without a recorded bundle review: publish a new reviewed version. This code does not retroactively certify legacy content or decide a production inventory/removal policy. A production operator must inventory any real legacy third-party releases separately.

Keep the new gate when rolling forward; older server code lacks it and must not be used as a publication writer without an explicit operator policy. The schema remains additive for read/removal compatibility, not a guarantee that a predecessor enforces review.
