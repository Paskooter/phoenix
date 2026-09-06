# S-01 request boundary candidate

Status: **bounded request boundary repair; awaiting lead review**

Owner: Luna Max
Base: `a803418`
Reference revision: `5c0a7390539663ba749d360de348a428c088505c`
Audit date: 2026-09-06

This candidate removes Phoenix's pre-handler `SkillRequest` schema gate. The
frozen `BaseSkill` forwards any parsed object to the concrete skill; the shared
HTTP parser remains responsible for malformed JSON and primitive top-level
entities. The change is limited to `packages/skills/src/skillService.js` and
the request-boundary evidence/tests.

## Source contract

The frozen source paths and hashes are:

| source | SHA-256 |
| --- | --- |
| `packages/baseskill/src/BaseSkill.ts` | `d5e70fafdafdd1e9ddd1a3f38ebe898283a95d7c478b91c260aed9dc9a288ed3` |
| `packages/baseskill/src/SkillService.ts` | `b2a240d1a0f7560a613457b133eea81ef20bf558a6bf3322c768be7c57df58bf` |
| `packages/utils/src/service/handlers/BaseHttpHandler.ts` | `d675e8e1756b1c5212c2b8db6d4efa9c4caa748cd2dd1f60893fd69ae449f385` |

`BaseSkill` calls the concrete `handle(req)` for every body that the common
JSON parser accepts. It performs no `SkillRequest` validation. A graph skill
then applies its own checks and returns a skill-scoped `ERROR` response. The
source body parser rejects primitive top-level JSON and malformed JSON before
the skill route, producing a service-level status `400` response with
`final:true`.

## Phoenix change

`skillRoute` no longer imports or invokes `schemas.skillRequest` validation. It
passes the parsed `body` unchanged to the handler, retaining the existing
timing assignment and source error envelope. `createService` and its strict
JSON body parser are unchanged, so transport parse failures remain outside the
skill wrapper.

## Source probe

`packages/skills/tools/s01-skill-request-source-boundaries.cjs` runs the pinned
Node 8.9.4 `SkillService` with the real compiled `ExampleSkill`, `Chitchat`,
and `PersonalReport` handlers. It sends object bodies with missing type/data/
general/skill/session fields and an invalid request type, plus primitive and
malformed JSON entities:

```text
docker run --rm --network none -w /ref/packages/chitchat-skill \
  -v packages/skills/tools/s01-skill-request-source-boundaries.cjs:/fixture/probe.cjs:ro \
  -v .parity/reference/5c0a7390539663ba749d360de348a428c088505c:/ref:ro \
  node@sha256:8233daae003ba0ecba4e6d70cab8525c30a3f085935afc624a275892ebe23f7c \
  node /fixture/probe.cjs /ref
```

All three source handlers produced the same normalized envelope shape for the
object cases: status `200`, `type:"ERROR"`, generated `msgID`/`ts`, and
`data.skill.id` set to the concrete skill. The source messages were:

| case | source `data.message` |
| --- | --- |
| missing body fields | `Cannot read property 'general' of undefined` |
| missing type | `Unknown request type 'undefined'` |
| missing data | `Cannot read property 'general' of undefined` |
| missing general | `Skill request without general.accountID arrived` |
| missing skill | `Unknown request type 'NOT_A_REQUEST'` |
| missing session | `Skill session is required` |
| invalid request type | `Unknown request type 'NOT_A_REQUEST'` |

The source parser cases were status `400`, `type:"ERROR"`, `final:true`,
without `data.skill`:

| entity | `data.message` |
| --- | --- |
| `null` | `Unexpected token n in JSON at position 0` |
| JSON string | `Unexpected token " in JSON at position 0` |
| JSON number | `Unexpected token 7 in JSON at position 0` |
| truncated object | `Unexpected end of JSON input` |

Phoenix's common parser produced the same status and complete normalized error
bodies for those four transport cases.

## Handler comparison and limits

The corresponding Phoenix HTTP trace kept status `200`, `type:"ERROR"`,
generated `msgID`/`ts`, and the concrete `data.skill.id` for every object case.
After masking only `msgID` and `ts`, the message field comparison was:

| case | source | Phoenix example | Phoenix chitchat | Phoenix report |
| --- | --- | --- | --- | --- |
| missing body fields | `Cannot read property 'general' of undefined` | `Unknown request type 'undefined'` | `Unknown request type 'undefined'` | `Unknown request type 'undefined'` |
| missing type | `Unknown request type 'undefined'` | same | same | same |
| missing data | `Cannot read property 'general' of undefined` | `Cannot read properties of undefined (reading 'nlu')` | `Chitchat launched without required memo!` | `Unknown memo: 'undefined'` |
| missing general | `Skill request without general.accountID arrived` | `Cannot read properties of undefined (reading 'nlu')` | `Chitchat launched without required memo!` | `Unknown memo: 'undefined'` |
| missing skill | `Unknown request type 'NOT_A_REQUEST'` | same | same | same |
| missing session | `Skill session is required` | `LISTEN_UPDATE without a session` | `LISTEN_UPDATE without a session` | `LISTEN_UPDATE without a session` |
| invalid request type | `Unknown request type 'NOT_A_REQUEST'` | same | same | same |

Thus the boundary repair removes the false global validation response and
preserves each concrete skill's error envelope. The remaining missing-data and
missing-general message differences are pre-existing graph-facade behavior,
not a reason to add validation back at the service boundary.

The focused test exercises the real Phoenix graph, chitchat, and report
handlers for invalid request type and missing session. Invalid request type
matches the source complete body; the exact missing-session fixture retains
the concrete Phoenix error above and records its source wording difference.
The test also verifies that a simple handler receives every object body
unchanged and that primitive/invalid JSON entities stop at the common parser.

The exact source missing-session fixture is:
`{type:"LISTEN_UPDATE", data:{general:{accountID,robotID}, skill:{id}}}` with
no `skill.session`; pinned Node 8 execution of `ExampleSkill`, `Chitchat`,
and `PersonalReport` returned `Skill session is required`. The string
`LISTEN_UPDATE without a session` is emitted by Phoenix's existing
`packages/skills/src/graph/graphSkill.js` guard and does not occur in the
frozen source. The source `GraphSkill` also performs shared `data.general`
checks before dispatch.
Phoenix's existing graph facade has separate lifecycle behavior for an object
with missing `data` or `general`: after this boundary repair it still reaches
the concrete handler, but its current per-skill messages differ from the
source (`Cannot read properties of undefined (reading 'nlu')` for the example
graph, `Chitchat launched without required memo!` for chitchat, and `Unknown
memo: 'undefined'` for report). These are graph-handler parity gaps and are
recorded here rather than hidden behind a new global validation policy. Fixing
them would require the separate graph lifecycle scope.

Validation run:

```text
node --test packages/skills/test/skillRequest.test.js
# 3 passed, 0 failed
```

The pre-existing skill response tests remain covered by the parent candidate;
this candidate does not alter timing, assignment, or handler error conversion.
