# BE release audit: Hey Jibo listening and blue ring

This audit compares the pinned BE archives from `12.0.0` downward, with source maps recovered for the listening implementation. The high confidence regression boundary is **BE 11.0.1 -> BE 11.0.2**: `jibo-embodied-dialog` changes from `9.0.1` to `9.0.2`, and the latter disables the listening LED and eye implementation. BE 11.0.3 and BE 12.0.0 retain that disabled implementation. This matches the live BE12 observation that the HJ event reaches Nimbus and TTS works while the LED calls are `[0, 0, 0]`.

## Evidence and provenance

| Release | Archive | SHA-256 | Embodied dialog | `EmbodiedListen.ts` SHA-256 | Result |
| --- | --- | --- | --- | --- | --- |
| 12.0.0 | `.parity/consumers/downloads/jibo-be-12.0.0.tar.gz` | `e29f476c75e35e9bbd07c0211c75e2385772e4dfb3dd079a1d832e3832450657` | 9.0.4 | `46f35e53cc4b7ff75164aaca5bb12a9afdc9048239fb86b5f3295deb9f5a6b83` | HJ LED/eye disabled |
| 11.0.3 | `.parity/consumers/be-release-audit/downloads/jibo-be-11.0.3.tar.gz` | `64690ab4f99b717cf49768993f7a750e8df4746a2a96179cd0a54f575190dc41` | 9.0.3 | `46f35e53cc4b7ff75164aaca5bb12a9afdc9048239fb86b5f3295deb9f5a6b83` | HJ LED/eye disabled; compiled bundle matches 11.0.2/12 |
| 11.0.2 | `.parity/consumers/be-release-audit/downloads/jibo-be-11.0.2.tar.gz` | `f52cd40f078a8d357e515127276b724dd2ee132deaa5e89b62b09b49f26c60ec` | 9.0.2 | `46f35e53cc4b7ff75164aaca5bb12a9afdc9048239fb86b5f3295deb9f5a6b83` | First inspected release with HJ LED/eye disabled |
| 11.0.1 | `.parity/consumers/be-release-audit/downloads/jibo-be-11.0.1.tar.gz` | `1f85e593cf7e868b969d74bed3eef78b447e72207fa4b3892de013aeb3e97d8d` | 9.0.1 | `4b6e2a51686949d2555da7b8740f7b15b54cf1d61a6b0f3b7685dba821968cbb` | HJ LED/eye retained; nearest test candidate |

The selected source trees are under `.parity/consumers/be-release-audit/sources/{11.0.1,11.0.2,11.0.3,12.0.0}/jibo-embodied-dialog/`. The 11.0.3 supplement records seven selected package manifests, compiled bundles, and source maps without unpacking the full archive. Each recovery manifest records archive-member and source hashes. No source files were changed in these inputs.

## Exact regression

In BE 11.0.1, `src/listen/EmbodiedListen.ts` contains the active HJ path:

* Lines 281–300 enter the HJ expression, call `Utils.setLED(this._jibo, Led.LISTENING)` at line 293, and call `this.startListeningEye(true)` at line 299.
* Lines 313–325 do the same for a non-HJ listening turn.
* Lines 439–446 make `demoEngaged(true)` set `Led.LISTENING` and queue the listening eye.
* Lines 547–567 implement `startListeningEye`, selecting the HJ blink or pop transition. Lines 574–590 clean up that eye state.
* `src/listen/Assets.ts` is unchanged across the inspected versions; lines 65–70 define `Led.LISTENING` as `[0.05, 0.73, 0.94]`, the blue ring color.

In BE 11.0.2 and BE 12.0.0, the corresponding source is materially different:

* Lines 281–300 call `Led.OFF` at line 293 and comment out `startListeningEye(true)` at line 299.
* Lines 313–325 call `Led.OFF` at line 323 and comment out the eye start.
* Lines 439–447 make both branches of `demoEngaged` call `Led.OFF` and return `Promise.all([])`.
* Lines 547–567, 574–590, and 612–633 wrap `startListeningEye`, `stopListeningEye`, and `addEyeAnimationToQueue` in block comments.

The source files that carry the HJ event and cloud completion wiring are unchanged: `src/api.ts` has SHA-256 `bf2cfdd070f0ce8f462ccaa6a79dd7ca733f1b637d24af1f6b670a3462b96a2f` in all three selected releases. Its lines 60–70 still forward `jetstream.events.hjHeard` into `listen.eventsIn.hjHeard` and `globalEvents.shared.hjOnly` into `cloudFinished`. Thus the release change removes the visual response after HJ recognition; it does not remove HJ recognition or Nimbus handoff.

## Other functionality checks

The recovered BE source comparisons found no BE12-specific deletion in the cloud or transport path:

* BE root `Be.ts`, `SkillSwitchScheduler.ts`, and lifecycle sources are identical across the inspected 10.0.11–12.0.0 source maps.
* Nimbus `ProcessCloud.ts` and `WaitForAdditional.ts` are identical. The Nimbus 10.0.12 -> 10.0.13 change adds cleanup for an unfinished next cloud turn; BE12 retains that fix. It is not a removal of HJ or follow-up behavior.
* `jibo-embodied-dialog` `api.ts`, `Assets.ts`, and the Jetstream client source are unchanged through the HJ boundary.
* `jibo-action-system` source-map SHA-256 `61aad74b938a3b94938d64c178d6851807087ec76bc740deeb24fcf610f89a47` and compiled bundle SHA-256 `593bb5ac5d9575d7b611ac763b0263ca5094becc7ec18b74b348ad5e07b3fb54` are shared by BE 11.0.1–11.0.3 and BE 12. Its package options change at the same boundary: `pegasusProactiveTrigger` is true in 11.0.1 and false from 11.0.2 onward. `ActionRuntime.ts` lines 142–155 then leaves `runtime.proactive` null, while `api.ts` line 233 unconditionally calls `_runtime.proactive.checkEnvironmentInhibitors()`. This is a configuration/source-contract candidate for the observed null error, not a blue-ring code deletion; do not patch the robot for this audit.
* BE root `SkillSwitchUtil` changed at 10.0.14 to protect proactive switches from a higher-priority current switch. That guard remains in BE12 and is unrelated to the missing blue ring.

The package-identity issue is separate from this release boundary. The initial `@phoenix/be12-parity` slot did not pass the SSM `startsWith('@be/')` relaunch gate; the corrected `@be/phoenix-parity` slot reaches Nimbus and plays TTS. The exact `@be/be` checks observed in the SSM bundle govern finished-relaunch handling, and do not statically disable the `EmbodiedListen` LED path. Keep the runtime `checkEnvironmentInhibitors` null in the action context investigation rather than attributing it to the BE12 archive.

The `RA_JBO_TellAJoke_AN_41` joke asset in BE12 is a plain TTS action with `es_auto_tagging: true` and no explicit screen graphic. Its lack of a screen animation is therefore asset behavior, separate from the listening-ring regression.

## Root test recommendation

Use `.parity/consumers/be-release-audit/downloads/jibo-be-11.0.1.tar.gz` as the nearest preceding candidate, preserving the required `@be/` package identity. A successful HJ test should show a `Led.LISTENING` call with `[0.05, 0.73, 0.94]` and the HJ eye transition. If 11.0.1 restores the ring while BE12 does not, the release regression is confirmed. If it does not, retain the static result and investigate the runtime action context separately.

This report makes no hardware parity claim; the archive comparison is static evidence for the root-owned robot test.
