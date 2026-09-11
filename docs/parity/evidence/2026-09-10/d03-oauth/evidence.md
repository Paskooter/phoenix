# D-03 — OAuth exchange, refresh and invalidation

Reference revision: `5c0a7390539663ba749d360de348a428c088505c` (pinned tree at
`.parity/reference/5c0a7390539663ba749d360de348a428c088505c`).
Runtime harness: `packages/data/scripts/oauth-runtime.mjs` → `runtime.json`.
Unit gate: `packages/data/test/oauth.test.js` → `unit.txt` (15/0).

## Pinned contract (source, quoted)

- `packages/lasso/src/credential/Credentials.ts:44-47,79-103` — an authCode save
  stores `oauth2 = {clientId, authCode, redirectUri, accessToken:null,
  refreshToken:existing, expiresAt:null}`, then `redeemAuthCode(credential)` and
  only thereafter `credential.save()`. A replayed authCode is rejected at :53-57
  **before** the provider call.
- `Credentials.ts:158-184` — `redeemAuthCode` builds a `GoogleCalendarClient` /
  `OutlookCalendarClient` (secret lookup by clientId) and `credential.setTokens(tokens)`.
- `packages/lasso/src/calendar-client/GoogleCalendarClient.ts:70-75,92-99` —
  `getToken` / `refreshAccessToken`, errors wrapped with
  `Failed to redeem authCode` / `Failed to refresh access token`.
- `packages/lasso/src/calendar-client/OutlookCalendarClient.ts:97-107,119-132` —
  authorizationCode / refresh grants with `scope: scopes.join(' ')`.
- `packages/lasso/src/oauth2/OAuth2Secrets.ts:20-39` — `client_*.json` registry,
  `Cannot find secret for <service> client <id>`.
- `packages/lasso/src/mongo/StoredCredential.ts:143-178` — `setTokens` (Google
  `expiry_date`; Outlook `expires_in` → `Date.now()+expires_in*1000`; refresh_token
  updated only when returned), `updateTokens` sets `refreshedAt`, `setInactive`
  sets `isActive=false` + `error=CredentialError`.
- `packages/lasso/src/credential/interfaces.ts:39-43` — `CredentialError`
  `REFRESH_FAILED | REVOKED_ACCESS | INVALID_TOKEN`.
- `packages/lasso/src/relay/GoogleCalendarHandler.ts:91-126` — refresh when
  `Date.now() > expiresAt`, `setInactive(REFRESH_FAILED)` on refresh error, and
  `setInactive(REVOKED_ACCESS)` when the events error matches `/expired or revoked/`.
  `OutlookCalendarHandler.ts:93-125` mirrors it and uses `InvalidAuthenticationToken`
  → `INVALID_TOKEN`.
- `packages/lasso/src/relay/AbstractRelayRequestHandler.ts:154-168` — non-response
  errors become `502 Error getting <Name> data: <err>`.
- `packages/lasso/src/relay/GoogleCalendarHandler.ts:16,26-35,60-62` —
  `cacheSecondsToLive = 60`; `onNewCredentialArrived` deletes the redis key
  `google_calendar:<skillId>:<accountId>:<calendar>`; `LassoService.ts:86-95`
  wires `newCredential` to it.

## Runtime observations (runtime.json)

| step | observed |
| --- | --- |
| exchange | POST /v1/credential → 200 `{created:true}`, one real POST to `/oauth2/v4/token` with `grant_type=authorization_code`, `code`, `client_id`, `client_secret`, `redirect_uri` |
| exchange_stored | `accessToken=googleAccessToken`, `refreshToken=googleRefreshToken`, `expiresAt - now = 3599997` ms |
| exchange_error | 400 body `Failed to redeem authCode, Google response was 400 Code was already redeemed.` |
| refresh | expired credential → real `grant_type=refresh_token` request; stored `accessToken=refreshedAccessToken-1`, `refreshedAt` set, `expiresAt` +3599999 ms |
| refresh_failure_invalidation | 502 body `Error getting GoogleCalendar data: Error: Failed to refresh access token, Google response was 400 Bad Request`; stored `isActive=false`, `error=REFRESH_FAILED` |

The binary has no events provider wired, so the calendar route answers 502 with
the reference envelope after a **successful** refresh — the refresh itself is
observable in the stored credential and the token-endpoint request.

## Status

- VERIFIED: exchange, duplicate/replayed rejection, refresh + expiry, refresh
  failure → REFRESH_FAILED, Google `/expired or revoked/` → REVOKED_ACCESS,
  Outlook `InvalidAuthenticationToken` → INVALID_TOKEN, credential-cache
  invalidation, error envelopes.
- INFERRED: exact live Google/Microsoft response quirks beyond the recorded
  fixtures (test-owned credentials only).
- UNKNOWN / gate: no live Google/Outlook endpoint was exercised (no live
  credentials); D-03 acceptance item 3's "supported current provider" remains a
  visible external gate.
