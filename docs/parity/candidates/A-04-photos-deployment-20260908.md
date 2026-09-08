# A-04 photo deployment wiring — candidate

Status: **candidate-unverified; isolated for root review**.

This follow-up starts from the frozen HTTP/storage candidate
`05039642b2829db3ff7cd82ae754c445fa0458ba`. It makes the local photo adapter
available to a normal Account process and gives its returned URLs a public
Classic ingress. No real household data, photos, credentials, robot, live
service, or production store was used.

The Account entrypoint now resolves photo settings in this order:

1. `loopConfig.server.photoBaseUrl` and `loopConfig.server.photoDirectory`;
2. `ETCO_account_photoBaseUrl` and `ETCO_account_photoDirectory`;
3. the Phoenix-friendly `PHOTO_PUBLIC_URL` and `PHOTO_DIRECTORY` aliases.

An origin without a path is normalized to the Account route
`/member-photos`. An explicitly supplied path is retained for an external
reverse proxy that mounts that path. The directory defaults beside the Account
store and is created with private directory/object permissions by the existing
`MemberPhotoStorage` adapter. An explicit `memberPhotoProvider` still takes
precedence for tests or another fully configured storage seam.

Classic now serves `GET /member-photos/:key` on the same listener the robot
reaches. It forwards the object response from `NET_account` without parsing or
rewriting bytes and returns a bounded 502 on an unavailable Account upstream.
The URL handed to a robot must therefore be an externally reachable
Classic/TLS origin, such as `https://region.example`; it must not be
`account:8080`, `localhost`, or another backend-only address. A pathful public
URL must be mounted by the surrounding ingress as well.

The Compose service passes `PHOTO_PUBLIC_URL`/`PHOTO_DIRECTORY` to Account and
`CLASSIC_PUBLIC_URL` to Classic. The no-Docker launcher passes the equivalent
ETCO settings and uses the same public URL fallback. The normal launchers keep
the existing local Account object store; the photo directory is under the
mounted `packages` tree in Compose unless `PHOTO_DIRECTORY` is overridden.

Focused verification in this worktree:

* `node --test packages/account/test/loopPhotoDeployment.test.js`: 2 passed.
  The first starts Account through `start(0)`, uploads synthetic binary bytes
  through Classic's signed Loop endpoint, follows the returned public URL back
  through Classic, and verifies the downloaded bytes and durable store/file.
  The second verifies explicit programmatic configuration wins over the
  environment aliases.
* `node --test packages/account/test/loopPhotoDeployment.test.js packages/account/test/loopPhotoHttp.test.js packages/account/test/loopMemberPhotos.test.js`: 5 passed.
* `npm run test:unit`: 880 tests, 873 passed, 7 skipped, 0 failed.
* `node --check` passed for the changed JavaScript; `bash -n
  scripts/run-compose-stack.sh` and PyYAML parsing of `docker-compose.yml`
  passed. `docker compose config` also rendered both friendly public URL
  aliases and direct ETCO settings without starting containers.
  `@phoenix/common`, `@phoenix/account`, and `@phoenix/contracts` all resolve
  to this worktree after `npm ci --ignore-scripts --offline`.

The candidate has no Docker image build or live Compose run receipt. Root must
verify the deployment image/mount and the actual external TLS ingress before
accepting it. The archived `@jibo/binary` dependency version remains
unresolved; this candidate continues to use the previously reviewed local
adapter and does not claim deployed binary-package parity. Public photo GETs
are intentionally unauthenticated as required by the existing photo URL
contract; authenticated upload/remove behavior remains inherited from the
frozen candidate.
