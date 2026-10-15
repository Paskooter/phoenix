# Raw upload staging

Classic checks SigV4 headers before creating an authentication staging directory or
consuming a raw entity. Missing or malformed signing metadata, expired dates,
unavailable credentials, inactive/deleted accounts, and header-verifiable signature
mismatches retain the existing authentication error codes and statuses.

When `X-Amz-Content-Sha256` is present, preflight checks the HMAC against that
advertised hash without reading the body. The final verifier still checks the
received-byte digest, native payload-hash policy, credentials and replay guard
before dispatch. Native `Media.Create` streams retain the existing, narrowly
scoped `UNSIGNED-PAYLOAD` allowance; this does not skip the signed-header HMAC.

Supported body-hash SDK signers may omit `X-Amz-Content-Sha256`. Their canonical
request includes the body digest, so full HMAC verification follows bounded staging.
Header preflight still validates metadata, credential state and authorization shape.
Both signer forms remain part of the supported client protocol.

The locally archived signer documents both forms in
`jibo/phoenix-jibo-server-client@dd4594bfb8554034075632a9bcc3499732a1d599`,
`lib/signers/v4.js:217–224`. That file is unchanged from the archive base in the
local Phoenix client fork. No archive network access is needed for that source
comparison.

## Limits

The existing default entity caps are **1,000,000,000 bytes** for Classic's caller
boundary, Key binary, Media, Account/Loop photo and OTA CreateUpdate uploads.
Those caps remain unchanged and retain their existing configuration seams
(`createVerifiedClassicCaller({ maxBodyBytes })`, `createOtaService({
maxUploadBytes })`, and the individual stores' options/environment overrides).

All Classic caller boundaries and OTA services in one Node process share a staging
budget by default:

| Setting | Default | Scope |
| --- | ---: | --- |
| `ETCO_upload_stagingMaxBytes` | 2,000,000,000 bytes | Reserved/received staged bytes retained across uploads |
| `ETCO_upload_stagingMaxUploads` | 4 | Uploads being staged or awaiting dispatch cleanup |

The byte default has room for two maximum-sized reservations; the upload count
also bounds small and unknown-length requests. A colocated Classic-to-OTA proxy
reserves each hop separately while both retain their copy. Known lengths reserve bytes before
any staging allocation/read. Unknown lengths, and bytes beyond a declared length,
are charged before each chunk is stored. A reservation lasts through dispatch and
removal of Classic's replay file, not just through body receipt. Services in
separate processes have independent budgets; account for worker count when sizing
the staging filesystem. OTA retains its existing in-memory buffering, so this is
a staged-payload budget, not a bound on total process RSS or durable object storage.

Set overrides before the first raw upload is admitted. Values are nonnegative safe
integers; invalid environment values fall back to defaults, and zero disables the
corresponding admission capacity. Tests or embedded launchers may explicitly inject
one shared `createUploadStagingBudget({ maxBytes, maxUploads })` through the
`stagingBudget` option on both boundaries. Do not create one budget per caller in
production.

Saturation returns AWS-JSON **503 `REQUEST_THROTTLED`**, with the existing throttle
message. Authentication still runs first. The per-request cap continues to use its
existing size error and takes precedence over staging admission for a signed entity
with an oversized declared length.

## Lifetime and OTA

Classic removes staging on body/write/rename errors, final verification failures,
replay refusals, and router dispatch completion or failure. A mid-body abort ends
the pipeline, closes its file handles and removes its partial file/directory before
releasing the budget. Cleanup is idempotent and waits for the replay stream to close.
The caller boundary cleans its own failures; callers using it outside the Classic
router must still call `cleanupVerifiedClassicRequest(req)` after successful dispatch.

Direct authenticated OTA CreateUpdate requests run the same header preflight before
the raw reader. The production OTA launcher always enables authentication. Its
separate Classic loopback-peer path checks both transport and the private peer token
before reading; Classic has already performed public SigV4 verification. The legacy
standalone `requireAuth: false` fixture mode retains its existing behavior. Custom
final `authenticate` hooks do not replace the raw preflight credential resolver.
OTA releases its buffer reference and reservation in `finally`, including aborted,
rejected and failed creates.

These lifecycle guarantees cover handled requests and stream errors, not process
termination or an operating-system failure that prevents file removal. Configure a
private staging filesystem with sufficient capacity; treat filesystem cleanup errors
as operational failures, not successful uploads.
