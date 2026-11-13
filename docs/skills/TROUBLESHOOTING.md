# Skill troubleshooting

[Developer guide](../SKILLS.md) · [Workflow](WORKFLOW.md) · [SDK](SDK.md)

Read the exact error code and the exact request status before trying again.
Host validation does not execute your app or prove it is safe. An upload is
not an installation; approval is not proof that startup completed. Never edit
inventory, identity, approval or policy journals to bypass a refusal.

## Common kit messages

| Exact message / code | What happened | Next action |
| --- | --- | --- |
| `Skill request failed: unknown_template` | Unknown starter | Use hello, touch-ui, voice or network-service with `--template`, or leave it out for hello |
| `Skill request failed: invalid_option` | Duplicate, unsupported or ambiguous flags | Read `--help`; pass each option once |
| `Skill request failed: EEXIST` | Project/output already exists | Use a fresh name or output directory; never overwrite a packed artifact |
| `Skill request failed: invalid_app_manifest` | Author manifest has unknown fields or bad names/declarations | Use the exact [app.json fields](MANIFESTS.md); Store release fields such as `releaseId`, `reviewId` or signatures do not belong in it |
| `Skill request failed: app_icon_ref_invalid` | Icon declaration is incomplete or invalid | Declare all three of `iconApi`, `icon` and `iconImage`, or none; see [v2 icon rules](MANIFESTS.md#v2-icon-rules) |
| `Skill request failed: invalid_file_list` | File list missing/duplicated or not including app.json | Explicitly list all shipped files, including entry and assets |
| `Skill request failed: test_native_syntax_invalid` | A listed `.js` does not compile for the chosen parser | Use CommonJS/Node 6 syntax and check every dependency with `--syntax-node` |
| `Skill request failed: invalid_syntax_runtime` | Legacy parser path/version is wrong or unusable | Supply an absolute trusted local Node 6.5.0 executable; keep Node 20+ for the kit |
| `Skill request failed: test_native_binary_forbidden` | Binary module in pack | Remove `.node` / `.so`; use pure JavaScript/data |
| `Skill request failed: test_native_scripts_forbidden` | A package has scripts | Build on your computer and ship script-free runtime dependencies |
| `This Jibo can't install skill test builds: its info has no native in localKinds. Check that Jibo runs its current software.` | Jibo's `info` does not offer test builds | Run `info` and check `localKinds`; Jibo's current software (13.8.0) reports `native` |
| `Checking the packed skill on Jibo` | Robot-side validation, not approval | Wait for the next request state; do not assume upload success means installation |
| `Tap Install full-access test on Jibo` | Physical review waiting | Open Test builds if the automatic idle prompt is not visible; read permissions and final warning |
| `Tap Remove test build on Jibo` | Removal waiting for final tap | Confirm the selected keep/erase choice and tap the final button |
| `Waiting for Jibo to reconnect; request <id> is still being checked` | Software may be restarting or SSH temporarily unavailable | Let the kit reconnect; preserve the printed request ID |
| `Request <id>: pending_restart` | Approval is recorded; the CLI is waiting for Jibo's restart/trial | Let the kit follow the request. The wait can end in a startup failure or timeout as well as success. Do not tap again for this progress state |
| `Skill request failed: approval_timeout (request <id>)` | Computer wait expired | Read that request with status; the timeout did not cancel it |

The literal `<id>` above represents the request ID printed by your command;
copy that exact value. Do not substitute a Store release ID or a project ID.

## Robot refusal and recovery

| Code / exact screen wording | Next action |
| --- | --- |
| `unsupported_firmware`, `test_manager_unavailable`, `test_runtime_unavailable` | Use Jibo's current software (13.8.0), which advertises protocol 1 and test builds. Wait for normal startup; do not copy a replacement installer onto an older release |
| `robot_path_mismatch` | Compare `beRoot`, `runtimeNode` and `stateRoot` from info with your options; supply all differing paths explicitly |
| `ssh_unavailable`, `ssh_or_robot_failed`, `ssh_timeout`, `ssh_stream_failed` | Check OpenSSH, authorized developer access, address, credentials and host key. Read status after reconnecting |
| `test_builds_disabled` / `Turn on Allow test builds to continue.` | Open Settings → Developer testing, turn on Allow test builds and physically confirm it. A CLI flag cannot enable it |
| `test_execution_paused` / `This test is paused. Check Allow test builds.` | Physically turn Allow back on to resume approved tests; their code/data remain |
| `test_owner_unknown` / `Jibo needs a linked owner to use test builds.` | Finish owner setup. If already set up, retain the code for support; do not edit identity files |
| `test_native_collision`, `test_identity_collision` / `Remove “<installed app name>” first, then try again.` | Remove the named installed app through its supported flow. A new app ID is not global-name/port isolation |
| `test_disk_limit` / `Jibo needs more space. Remove an unused test, then try again.` | Remove unused tests or free storage through supported tools |
| `test_count_limit`, `test_project_limit` | Only one skill test build can be installed; update the same project or remove that test before installing another. Removal retains the project record. Reuse allocation state rather than making new projects; there is no kit project-deletion command. Do not delete manager journals |
| `test_queue_full`, `test_validation_busy`, `test_rate_limited`, `robot_install_busy` | Inspect pending requests and let current work finish; do not repeatedly submit |
| `test_input_changed` / `The build changed. Send it again and review the new request.` | Finish editing/copying; rebuild and send unchanged bytes |
| `pack_changed`, `input_changed`, artifact digest/size errors | Rebuild once input is stable; check exact request status before retrying after a lost reply |
| `client_request_conflict` | A retry ID refers to different content. Keep original state for an identical retry; changed bytes need a new build. A confirmed failed, canceled, declined or expired request retires the attempt; run `install` again for a fresh request and physical tap. |
| `physical_tap_required`, `physical_approval_missing` / `Tap the button on Jibo’s screen to confirm.` | Use the real on-screen final confirmation. Scripts/voice/Agent cannot approve |
| `test_approval_expired` / `This request timed out. Send the build again.` | Submit/review a fresh request; do not replay an old approval. Run `install` again; an explicit install after a confirmed terminal refusal creates a fresh request ID even with unchanged bytes. |
| `test_request_stale` / `This request changed. Open Test builds again.` | Reopen the current request and review its actual content |
| `native_health_failed` | Make health report readiness truthfully; inspect your bounded startup diagnostics |
| `native_entry_invalid` | Export create(context) and all seven lifecycle methods |
| `native_admission_closed` | stop has begun; clear existing handles, do not allocate a new context timer/hook/lease |
| `native_cleanup_unconfirmed` | Stop did not prove resource release. Fix view/speech/listen/socket/timer cleanup; do not return a success object early |
| `native_lifecycle_timeout` | Startup or stop exceeded its deadline. Bound work, cancel owned operations and do not block the event loop |

If Allow changes after a request was queued, the CLI explains that the request
stays queued until Allow is on and is canceled if Jibo restarts. It prints an
exact `ssh.mjs cancel` command if you choose to cancel it. A queued request and
an installed-but-paused test are different states.

If the CLI observes a confirmed `failed`, `canceled`, `declined`, or `expired`
request, that attempt is retired. Run `install` again from the same project
with the same connection options to create a fresh request ID and physical tap;
the packed bytes can remain unchanged. This is different from a lost reply or
timeout: read status first when the original request may still be live. For
unexplained or persistent failures, keep the exact code and request ID for
support.

## It installed, but the skill looks wrong

| Symptom | Check |
| --- | --- |
| No Home tile | On 13.8.0 a running local test's entries appear in Home after the Skill Store entries, prefixed LOCAL / Test — (see the [local-test opening path](WORKFLOW.md#opening-a-local-test)). Open Home by touch and check runtimeState, registerLaunchers, getSetupState and pending changes. A background service intentionally has no tile |
| Tile says `Set up …` | getSetupState returned configured:false; complete your own setup rather than hiding the state |
| Tap does nothing | Current-view identity, ready/generation flag, inputLocked, component hit-area coordinates and visible button paint |
| Blank or covered screen | Pending transition, unsupported renderer features/assets, view ownership; do not remove a covering view that is not yours |
| Speech interrupts another activity | App-context lease and native speaker-session checks; no global speech stop without proven ownership |
| Listen never starts | Did the prompt actually return SUCCEEDED? Is another local turn busy? Are voice services connected? followedByListen alone does not open a request |
| Wrong or late answer | Accept only SUCCEEDED final ASR text, validate the word, and generation-check replies after close; hints are not an allowlist |
| Voice alias does nothing | Local v1 records claims but does not register aliases. Use the [local-test opening path](WORKFLOW.md#opening-a-local-test) |
| Background API fails | HTTPS/TLS/status, bounded response, timeout and endpoint compatibility. Do not disable TLS or retry forever |
| Port already in use (`EADDRINUSE`) | Declared port/name collision and actual listener state. Choose a unique port and update incomingPorts as well as config |
| Cannot reach status service from a PC | Network starter intentionally binds loopback. Read it from the robot's authorized shell; do not silently expose it on the LAN |
| Stop hangs | Pending request creation, owned listening cancellation, transition completion, open keepalive sockets and raw timers. Track and await each one |
| Counter opens on wrong page | Reset page-local state on open; do not reuse state from a closed interaction unintentionally |
| An update loses settings | Write to dataRoot, not appRoot; version your schema and keep malformed-data recovery separate from erase-data removal |

The network starter's diagnostic strings are `request_timeout`,
`response_too_large`, `request_failed`, `response_failed`, `response_aborted`,
`response_closed`, `request_aborted`, `service_config_invalid` and `service_stopped`. These describe
its own sample service, not new protocol errors. The voice starter rejects
unconfirmed cancellation with `voice_cancel_unconfirmed`, even if the SDK has
already completed the local request after a transport failure. That local state
does not prove that the service acknowledged cancellation. The screen starters
return `native_view_unavailable` before acquiring focus when the renderer is
disabled. Hello-derived view
errors (`hello_close_timeout`, `hello_view_covered`, `hello_view_retained`,
`hello_view_close_failed`, `hello_speech_busy`) mean cleanup was not proven.

## Details for support

Open a support ticket in **#help on the Phoenix Discord**:
https://discord.gg/FyDVYQ6FfV. Include only a short diagnostic block, for example:

```text
Command: install
Code: native_cleanup_unconfirmed
Stage: stop
Project version: 1.0.0
Request reference: [the exact request ID printed by your command]
Expected: the app closes and the test is removed
Observed: removal stopped with the code above
```

Keep credentials, pairing tokens, private source, account data, household names,
photos, full inventories and unredacted logs out of public support messages.
For the existing exhaustive named-code list, see the
[entry guide's error-code reference](../SKILLS.md#error-code-reference).
