# A-04 pending implementation reviews

Main contains accepted guardian/agreement and membership-list work. Moth is
on `fb79e6d`, verified with eight installed-client read-only checks. The candidates below are separate worktrees;
passing a candidate check does not mark the whole lifecycle verified.

| Candidate | Revision | Current evidence and remaining work |
| --- | --- | --- |
| Photos | `0503964` | Independent source/wire/abort checks favorable; normal startup upload returns 500 because storage/public URL wiring is absent. Changes requested; repair in progress. |
| ListLoopMembers | `660fe838` | Accepted after source/client/integration checks; deployed with installed-client membership/filter checks passed. |
| Invitation transport | `ba0e3b4` | Local SMTP/event controls submitted; independent source/transport review in progress. |
| Membership events | `19cace3` | Three original event payloads match; 873 tests pass, 7 skipped. Independent controller/client review and transport dependency acceptance pending. |
| CreateLoop gate/event | `eaa6724` | Eight original controller controls, ten original SDK calls, ten HTTP peer checks; 874 tests pass, 7 skipped. Independent review and dependency acceptance pending. |

Root verified all 27 photo review artifact hashes. Photo acceptance requires
normal deployment to supply durable storage and robot-reachable public URLs.
Hashless binary staging remains an explicit extension; the original generated
client sends a body hash. The exact deployed binary dependency version is still
unresolved. See [photo review](../evidence/2026-09-08/photo-independent-review/review.json).

CreateLoop original-client calls used Node 8.9.4 and client 3.0.110 against
Account and Classic with a synthetic local robot-read peer. Four successful
creations produced four creation events and four save events. Explicitly
suspended robots, invalid credentials, and missing fields left state unchanged.
See [client evidence](../evidence/2026-09-08/create-original-client/review.json).

No real provisioning, family data, or live mail was used in these controls.
The verified checklist remains 8/79 (10.1%).
