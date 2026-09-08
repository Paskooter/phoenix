# A-04 candidate: invitation mail and `InvitedToJoinLoop` side effects

Status: **implementation candidate, unverified; root review required.**

This isolated candidate adds the two source side effects that accompany an
email invitation in `InviteLoopMember` and `UpdateLoopMember`. Mail and event
delivery remain explicit injection seams because this repository has no
source SMTP/SES or SNS deployment credentials. The candidate does not close
A-04.

## Source contract

The controller and handler are pinned to
`jiborobot/srv-account-ws@6cea43470825657d6a5722162f28c8f233153ee2`. The
recovered source files have these hashes:

| Source file | SHA-256 |
| --- | --- |
| `src/controllers/loop.ctrl.ts` | `8eab9312ba611b1dc5735599521bf73f1dbd2ede49f8da53ad3b4b543d729024` |
| `src/handlers/loop.handler.ts` | `abb558d7f7b873b80d765d6fde344d56876e408ce6bdf928be7a57b37605826d` |

The relevant source ranges are:

- `LoopHandler.InviteMember`, lines 77–101, and `UpdateMember`, lines
  104–126: validate the payload, lowercase email, trim names, and pass the
  authenticated owner id to the controller.
- `LoopController.inviteMember`, lines 221–250: look up a non-deleted
  account, generate a code, add the member, then populate the saved loop.
- `LoopController.sendInvitationMail`, lines 252–268: choose
  `invitationExistingUser` and `/home?email=...` for a known account, or
  `invitation` and `/create?email=...&code=...` for a new account; look up the
  owner before calling the mail controller.
- `LoopController.addMember`, lines 269–322: save the loop before mail/event
  dispatch, then call mail followed by `InvitedToJoinLoop`.
- `LoopController.updateMember`, lines 324–390: mutate the request-local
  member, call mail followed by `InvitedToJoinLoop`, then perform the final
  `saveAndPopulate`.

The source mail controller is
`src/controllers/mail.ctrl.ts` at the same pin (2377 bytes, read from the
Jibo source archive). Its `send(to, options)` renders the selected template
and returns the transport promise. The source call sites attach `.catch()` to
that promise without awaiting transport completion. The source
`@jibo/server@4.0.12` event runtime is retained under the private evidence
directory. `InvitedToJoinLoop` extends `BaseEvent`, adds `eventKey`, and
requires nonempty `email`, `loopId`, and `ownerId`; `accountId`, names, and
`memberIds` are optional.

## Candidate behavior

`invitationProviders` is an explicit `createAccountService` option:

```js
{
  portalUrl,
  invitation: { send(to, options) },
  invitationExistingUser: { send(to, options) },
  eventSender: { send(event) },
  onError(error, kind),
}
```

The two mail providers receive the source options `{ email, name, photoUrl,
url }`. Known accounts use the existing-user provider and `/home`; unknown
accounts use the invitation provider and `/create` with the newly generated
code. The event payload preserves the source own-key shape, including an
undefined `accountId` for a new account, and includes first/last names only
when truthy. The candidate event object is source-shaped and its payload
serialization/own keys match the archived `@jibo/server` event runtime.

Provider invocation order is mail, then event. Promise rejections are
observed and passed to the optional `onError` hook, so they do not undo the
successful source mutation. The focused test also records the behavior of a
malformed provider seam that throws before returning a Promise; that remains
a request failure. The source MailController and EventSender themselves
return Promises, so their transport rejections follow the contained path.
With no providers configured, the default seams resolve without external
delivery; that deployment gap is explicit rather than represented as a sent
message.

The existing detached loop draft and `LoopUpdatedOutbox` behavior are kept:
Invite saves before side effects, while Update dispatches before its final
save. Existing membership authorization, validation, and persistence paths
are otherwise unchanged.

## Controls and evidence

The focused candidate test
`packages/account/test/loopInvitationProviders.test.js` uses only synthetic
accounts, loops, addresses, and providers through an ephemeral actual HTTP
listener. It covers:

- unknown and known-account InviteLoopMember template/URL selection;
- lowercased email, trimmed names, owner-name fallback, event payload fields,
  and the source mail→event order;
- email-less invitation behavior;
- UpdateLoopMember side-effect order relative to its final save;
- rejected asynchronous mail/event promises with successful state recovery;
- a malformed synchronous provider seam and the Invite save-before-mail
  boundary.

The test exited 0 with **2 subtests passed**. The relevant existing
membership/profile/gateway regression command, including this focused test,
exited 0 with **17 tests passed**. The complete repository unit command
exited 0 with **868 passed, 7 skipped, 0 failed** (875 tests). The complete private receipt is
`.parity/reviews/a04-invitation-side-effects-20260908/test-receipt.json`.

The exact pinned Node 8 source controller/handler chain was also run against
two synthetic InviteMember cases (unknown and known account): **2/2 returned
status 200** with the expected mail URL/template branch and one
`InvitedToJoinLoop` event each. It used TypeScript 2.5.3 output, real
`@jibo/server` event classes, controlled model/mail/event seams, and
`node:8.9.4-slim@sha256:8233daae003ba0ecba4e6d70cab8525c30a3f085935afc624a275892ebe23f7c`.
The source command and hashes are in
`.parity/reviews/a04-invitation-side-effects-20260908/source-provenance.json`.

The archived event comparison records matching own properties, payload keys,
and JSON serialization for a known-account event. It is
`event-shape.json` in that same private evidence directory.

## Boundaries

This candidate does not provide SMTP/SES credentials, template files, SNS
credentials, a deployed EventSender, or a public mail/event transport. The
source controls use named model and transport seams; they do not claim Mongo,
Hapi, security-gateway, SMTP/SES, SNS, generated-client, or live-robot parity.
The local `LoopUpdatedOutbox` remains a separate durable notification path.
No real credentials, household data, external mail, robot, or live service
was used. Root acceptance and the wider A-04 task remain open.
