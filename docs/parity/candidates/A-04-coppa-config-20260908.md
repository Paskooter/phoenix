# A-04 candidate: Loop COPPA configuration

Status: **implemented in an isolated root review branch; source-runtime comparison and integration pending.** A-04 remains open.

Pegasus `LoopController` snapshots `isCoppaEnabled` from
`!config.features || config.features.coppa !== "off"`. The exact source is
`jiborobot/srv-account-ws@6cea43470825657d6a5722162f28c8f233153ee2`,
`src/controllers/loop.ctrl.ts` (SHA-256
`8eab9312ba611b1dc5735599521bf73f1dbd2ede49f8da53ad3b4b543d729024`):
constructor line 33, invitation status lines 290–292, and UpdateMember
child authorization lines 330–340. UpdateMember editability separately checks
the stored child flag, regardless of that configuration.

Phoenix now accepts the corresponding `loopConfig` object when constructing
`createAccountService` or `robotFaceRoutes`. Its default preserves COPPA-on
behavior. With `features.coppa: "off"`, a child invitation without email becomes
accepted and UpdateLoopMember uses owner/robot authorization. With the default,
it remains invited and child edits require the designated guardian. The flag
neither erases the stored child classification nor alters the separate
editability predicate. Other configuration values, including boolean false and
uppercase `OFF`, retain the source default.

The controls use invented accounts and actual signed requests to temporary
Account listeners. Six configuration cases check invitation state, owner,
robot and guardian authorization, retained child state, and child editability
in a declined membership. They do not send mail or use a real household.

Validation:

- The same controls against the frozen pre-repair candidate reproduce the
  COPPA-off invitation mismatch (`invited` instead of `accepted`).
- All six repaired configuration cases pass.
- Account tests: 175 passed, zero failed.

This is configuration compatibility, not verification of the entire COPPA,
EchoSign, guardian-agreement, mail, or event-provider lifecycle. Original Node 8
comparison is pending. The UpdateLoopMember base candidate still has separate
review work for public authentication and provider side effects. No deployment
configuration or real household record was changed.
