# H-10 optional account verification deadline

Root accepted `f9a2498`: when the account endpoint stalls before its headers
or during its JSON body, Hub rejects the upgrade within the configured lookup
timeout. `ETCO_hub_accountVerifyTimeoutMs` defaults to 5000 milliseconds; the
optional extension is still selected with `ETCO_hub_accountUrl`.

The root control reproduced pending requests in the previous implementation
and rejection at approximately 150 ms with the candidate configured to 150 ms.
Ten real WebSocket exchanges cover both Hub paths, failure/recovery and
revocation. Six checks against the actual Phoenix Account service cover active,
revoked, reactivated and unavailable accounts, unknown keys and friendly-ID
mismatch. The frozen combined suite passes 718 tests and strict43.

The [review](../evidence/2026-09-07/hub-account-deadline/review.json) distinguishes
this Phoenix extension from original shared-secret behavior and the native
signed-token lifecycle. Full H-10 remains open.
