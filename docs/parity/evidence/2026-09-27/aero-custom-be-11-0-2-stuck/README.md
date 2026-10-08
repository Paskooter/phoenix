# Aero custom BE startup and stuck Stop diagnosis

Date: 2026-09-27 UTC

Robot: the project's Aero development robot (network address and MAC omitted)

Mode: `int-developer`

Build under test: the custom `@be/be` build currently labeled `11.0.2`. This is
based on official BE 11.0.1 with project changes; it is not the archived official
BE 11.0.2 release. The version will be changed before release.

## Finding

There are two failures.

1. The installed BE payload is incomplete. It is missing 354 files from the
   official 11.0.1 base, including the declared JavaScript entry points of five
   installed packages. BE's Electron renderer starts as a process, but the BE
   loader cannot complete with those modules absent. The process remains alive,
   so process presence and SSM's `running` flag are false positives for successful
   BE initialization.
2. After Stop is clicked, System Manager loses the session but retains the skill's
   `running:true` flag and the Electron process. SSM then displays a running skill
   that it cannot stop. The SSM Stop endpoint discards the System Manager terminate
   error and returns success, so the browser refreshes the same stale state.

The archived mode documentation says `int-developer` starts platform services
but launches no skills at boot. That explains why BE must be started manually in
this mode. It does not explain the failed manual SSM launch: all platform services
needed for skill development are intended to be running in this mode.

## Primary BE failure: incomplete OTA payload

A complete path comparison against the archived official 11.0.1 payload found:

```text
official 11.0.1 files   21,590
installed custom files  21,249
official files missing     354
custom files added           13
```

Of the missing files, 316 are JavaScript files. Five missing files are the exact
`main` paths declared by their installed package manifests:

```text
node_modules/@be/nimbus/index.js
node_modules/@be/surprises/lib/surprises.js
node_modules/@jibo/chitchat-mims/index.js
node_modules/jibo-interaction-memory/lib/jibo-interaction-memory.js
node_modules/jibo-node-xml/lib/jibo-node-xml.js
```

These are confirmed absent on Aero; they are not symlinks. BE's own manifest
includes `@be/nimbus` and `@be/surprises` in its skill list, and names
`@be/surprises` as its end-of-speech skill. The loader must resolve those package
entry points during initialization.

Nimbus is the largest loss: the official base contains 501 files under
`node_modules/@be/nimbus`, while the installed tree contains 180. The installed
Nimbus manifest is still version 3.0.1 and still declares `index.js`, so the
manifest and payload contradict each other.

This incomplete payload is the actionable cause of the BE startup failure. The
logs do not expose the exact failed `require` or loader callback because the
renderer output is not retained, but the package cannot initialize correctly
with declared runtime entry points absent.

## Robot evidence

The launch sequence in `/var/log/messages` is:

```text
2026-09-27T23:05:17.621Z ssm: attempting to run skill @be/be
2026-09-27T23:05:17.654Z ssm: During launch(), got skill record for @be/be
2026-09-27T19:05:17.661406-04:00 jibo-system-monitoring-service: createSession Adding "<session-id>"
2026-09-27T19:05:18.231697-04:00 jibo-system-manager: SkillNotification for @be/be, reason 0, code 0
2026-09-27T23:05:18.261Z ssm: System Manager launched skill @be/be
```

No BE `Indexing...`, `Jibo is ready... awaiting launch command.`, uncaught
exception, or rejection appears after launch. The root BE code would normally log
those messages while advancing through initialization.

The Stop attempt is visible 99 seconds later:

```text
2026-09-27T19:06:56.893870-04:00 jibo-system-manager:
  SkillManager: bucket::terminate Could not delete session for @be/be:
  <session-id>
2026-09-27T23:06:56.896Z ssm: screen scheduler timer: skills service post terminate
```

The robot subsequently reports contradictory state:

```json
GET http://127.0.0.1:8779/skill/list
{"skills":[{"name":"@be/be","version":"11.0.2","running":true,"lastStartTime":[132,655680]}]}

GET http://127.0.0.1:8585/session/list
{"sessions":[]}
```

The original Electron tree is still present:

```text
1044 jibo-ski electron ... /opt/jibo/Jibo/Skills/@be/be/index.html {}
1064 jibo-ski electron --type=gpu-process ...
1069 jibo-ski electron ... /opt/jibo/Jibo/Skills/@be/be/index.html {}
```

The renderer (PID 1069 during capture) was sleeping in `hrtimer_nanosleep`. Port
9222 and SSM's proxied debugger on 9191 both timed out without response.

The logs available through `/var/log/messages` do not include the exact module
resolution error. System Manager owns the Electron child process and its
stdout/stderr are pipes rather than durable files. The current BE build also has
no stage logs before and after each startup callback. The last logged boundary is
therefore "System Manager launched the renderer," while the filesystem audit
supplies the missing failure evidence.

## Why the SSM Stop button becomes stuck

The archived Jibo documentation says SSM delegates centralized session and skill
switching to System Manager. Aero's installed `skills-service-manager` 16.0.0 does
exactly that.

The browser's Stop button posts `{command: record.name}` to `/terminate` and then
reloads `/skill/list`.

The installed SSM `/terminate` handler calls:

```js
SystemManagerClient.instance.terminate(data.command, (error) => {
  this.currentSkill = null;
  this.finishNoContent(res);
});
```

It never checks `error`. Therefore the System Manager failure is returned to the
browser as HTTP 204 success. The browser reloads the System Manager list, sees
`running:true`, and presents Stop again. Repeated clicks cannot repair the missing
session or kill the orphaned Electron process.

This behavior is in SSM 16.0.0 rather than the BE Stop lifecycle. BE can make it
more likely by hanging during initialization, but BE cannot repair SSM's discarded
terminate error or System Manager's inconsistent session/skill bookkeeping.

## Build identity clarification

The installed build is intentionally based on BE 11.0.1. Its root `index.js` and
`index.js.map` are byte-identical to the official 11.0.1 archive:

```text
index.js      ec00118360299001a6c8b6a56a322cc3bb742a6e320072e6e5ee7c24ea28e3da
index.js.map  28d92b3f4dbfc7e7fa7c2911b11162afc8d964e06ba59b12473c0fcc68e3aa87
```

The installed package manifest differs at least in its version field. The older
dependency versions are expected for this custom build and are not evidence of an
accidental official 11.0.1/11.0.2 mixture.

The source maps show that the project changes are in `@be/settings`. Compared
with official 11.0.1, `Settings.ts` adds the SSH access, firewall, and robot mode
subskills and adds this call at the start of `postInit`:

```ts
restoreFirewallPreference();
```

The remainder of `Settings.postInit`, including the `/error-codes` and
`/settings` knowledge-base loads and the Wi-Fi callback, is unchanged from
official 11.0.1. `restoreFirewallPreference()` can start a System Manager request,
but it does not await that request before `postInit` continues.

Aero's Electron Local Storage directory was empty during capture, with no
`jibo.settings.firewallMode` key. The restore call therefore selects `off` and
does not start its timer or System Manager request. Its storage read is protected
by `try/catch`. The added startup call is consequently not a viable explanation
for this occurrence of the hang.

The added settings sources are:

```text
src/SystemAccess.ts
src/subskills/FirewallSkill.ts
src/subskills/RobotModeSkill.ts
src/subskills/ScreenFlowSkill.ts
src/subskills/SshAccessSkill.ts
```

The installed settings bundle passes a JavaScript syntax check, and all 11 JSON
assets referenced by the added access and mode screens are present. Those
subskills do not perform their service requests until the corresponding intent is
opened. The evidence therefore does not identify the custom settings behavior as
the failing startup gate. The independently confirmed missing package entry points
provide the packaging failure before BE logging initializes.

## Changes recommended to the BE build author

1. Rebuild from the complete archived `jibo-be-11.0.1.tar.gz` payload, overlay the
   reviewed custom settings files, and change the package version to the selected
   unused number. Do not use the incomplete extracted parity tree as the package
   source.
2. Before publishing, compare the output file manifest with the official base.
   Permit only the reviewed additions, replacements, and version metadata change.
3. Add an OTA build check that walks every installed `package.json` used at
   runtime and verifies that its declared `main` file exists. At minimum, pin and
   verify the five entry points listed above. The current package checks validate
   the root BE entry and patched server client but do not catch missing dependency
   entry points.
4. Add a durable startup-stage log before and after each asynchronous gate in
   `Be.init`: `jibo.init`, log-config load, notification initialization,
   expression indexing, plugin initialization, post-init loading, first-skill
   selection, first-skill redirect, and the final init callback.
5. Add entry, exit, exception, and elapsed-time logging around
   `restoreFirewallPreference()` and the three existing waits in
   `Settings.postInit` (`/error-codes`, `/settings`, and current Wi-Fi network).
   This will identify whether startup reaches the changed package and which
   callback, if any, fails to return.
6. Put a bounded timeout around every gate. On timeout, log the stage and error and
   fail initialization instead of leaving Electron alive indefinitely.
7. Ensure the final initialization callback is invoked exactly once on every
   success and failure path. In the current root code, the expression-indexing
   rejection records `F4-Index_timeout` but does not call `initDoneCallback(err)`,
   which can leave startup permanently pending.
8. Add a startup watchdog that exits the renderer on failed initialization. That
   lets System Manager observe process death instead of retaining a live but
   unusable BE process.
9. Treat SSM/System Manager cleanup as a separate platform fix: propagate the
   `/terminate` error, reconcile `running` from the actual session/process state,
   and force-clean an orphaned skill when no session exists.

## Current scope

No files or processes on Aero were changed during this diagnosis. The stuck
process was left in place so its state remains available for further inspection.
