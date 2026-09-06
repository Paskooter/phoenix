# Settings candidate — root review

Status: changes requested; no A-06 integration or full-task acceptance.

Root independently recovered all 23 selected Settings source files from
`jiborobot/srv-settings-ws@0d37e1fd2f4fca40538fb470194a3c5daf2c9830`, verified
their bytes, emitted the original modules with TypeScript 2.5.3, and exercised
the real original Node 8 HTTP listener with controlled provider seams.

All 51 earlier cases match status, raw JSON body and key order, headers other
than Date, and provider calls. Adding 27 credential, target and transport edge
cases exposed 18 differences. Root repaired four credential cases: parsed JSON
null must fail before invoking a provider, while false, zero and the empty
string produce an undefined user ID. Request validation still precedes that
property access.

The isolated repair is `32f382f`; all 14 focused Settings/provider tests pass.
The [review](../evidence/2026-09-06/settings-root/credentials-repair-review.json)
records 64/78 complete matches, four fixes and zero new failures. The remaining
14 IDs are retained explicitly.

Some remaining cases compare different deployment boundaries. Original Hub and
Report clients send ordinary JSON to an internal Settings service. The public
security gateway authenticates requests, replaces the identity header and
rewrites the AWS JSON content type before forwarding internally. Phoenix's
aggregate listener currently combines these roles. Copying the private Hapi
listener's 415 response onto the public AWS endpoint would be incorrect.

The transport adapter candidate `77f994f` and Account peer candidate `d36a1af`
await independent review and actual integration. Update/Delete behavior,
persisted state, configured peer failures, and the full real-client graph remain
open. The controlled provider comparison does not establish those behaviors.
