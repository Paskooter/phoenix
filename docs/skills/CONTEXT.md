# App context and lifecycle

[Developer guide](../SKILLS.md) · [Manifests](MANIFESTS.md) · [SDK](SDK.md) · [Recipes](COOKBOOK.md)

A skill's entry is a CommonJS module exporting `create(context)`. The host calls
it once per activation. Keep all mutable state inside that instance; an update
can load a new instance after the old one has stopped. Do not do work at module
load time. Skill code runs inside BE, not in an isolated browser tab or sandbox.

## Lifecycle: all seven methods

Every returned app object must implement all seven methods. The host accepts a
synchronous return or a Promise except that menu projection reads
`getSetupState()` synchronously. Keep that method synchronous.

| Method | Call order / result | Responsibilities |
| --- | --- | --- |
| `prepareBeforeInit()` | After create; before startup | Construct your skill, declare/register hooks and skill names needed during BE initialization. Do not use uninitialized services or start listeners here |
| `startAfterInit()` | After BE services initialize | Start your background work; return a Promise that settles when startup is ready |
| `health()` | After startup and during activation checks | Return `{ok: true}` only if healthy. Any other result fails activation |
| `registerLaunchers()` | After successful startup and health | Register Home and/or Settings entries. A background service can implement a no-op |
| `getSetupState()` | When projecting Home menu | Return `{configured: true}` or `{configured: false}`. False makes the Home label `Set up <name>`; it does not disable the entry |
| `stop(reason)` | On removal, replacement, pause or failed start | Stop **all** owned work. Resolve `{resourcesReleased: true}` only after it is released. Reject on incomplete cleanup |
| `removeData(scope)` | Skill Store erase-data removal after stopping; that host passes `"all"`. Local test removal does not call this method | Remove only this app's saved data. For local tests, keep all persistent data under `dataRoot` so the host can erase it without running app code |

The normal order is create → prepare → initialized services → start → health →
register. The default host lifecycle deadline is five seconds for create/prepare,
five seconds for start/health/register combined, and five seconds for stop. Return promptly; do not make an external API's availability block startup.
A timer deadline cannot rescue code that synchronously blocks BE's event loop.

Updates preserve the app's data directory. The host verifies content on load,
purges that app root from the module cache, and handles activation/restart and
rollback. Local install/update uses Jibo's guarded idle restart path; do not
restart his software from your app.

## Every top-level context member

| Member | Type / contract | Example |
| --- | --- | --- |
| `appId` | String; app identity for this activation | Include it in your own diagnostic prefix |
| `releaseId` | String; release identity assigned by the installation path | Log it without assuming it is the author project version |
| `appRoot` | Absolute path of immutable verified executable/assets tree | `path.join(context.appRoot, 'assets/chime.wav')` |
| `dataRoot` | Absolute directory for this app's saved data, created by the host | `path.join(context.dataRoot, 'settings.json')` |
| `legacySettings` | Copy of allowlisted compatibility paths attached to this installation; normally empty for a new skill | Do not populate or infer these paths yourself |
| `grants` | Copy of granted permission-label strings | `context.grants.indexOf('network') >= 0` |
| `services` | Shared runtime integration objects, below; use hardware services after initialization | `context.services.jibo` |
| `hooks` | Owned cleanup and EventEmitter hooks | `context.hooks.add(dispose)` |
| `launchers` | Home menu registrations | `context.launchers.register({name:'Counter',open:open})` |
| `settings` | Settings registrations | `context.settings.register({name:'Counter',open:openSettings})` |
| `timers` | Owned ordinary Node timers | `context.timers.setInterval(refresh,60000)` |
| `speech` | Exclusive host speech lease | `context.speech.acquire()` |
| `attention` | Exclusive host attention lease | `context.attention.acquire()` |

The local-test host adds three members; a Skill Store instance need not have them:

| Local-only member | Value |
| --- | --- |
| `channel` | `"test"` |
| `identity` | `"@phoenix/local-test/" + projectId`; installation identity, not a skill registration name |
| `badge` | `"LOCAL / Test"` |

These labels distinguish local tests; they do not grant trust or isolation.

There is no `context.permissions`, `context.storage`, `context.fetch`,
`context.listen`, `context.log`, `context.camera`, `context.onStop`, automatic
HTTP router or publisher API. Use `grants`, your data directory, Node libraries,
and the initialized SDK. Never add invented convenience APIs to an example.

### Shared services: every default property

| Property | Purpose / ownership |
| --- | --- |
| `services.Be` | BE framework constructors, including `BeSkill` and `SkillSwitchData` |
| `services.be` | The running BE instance: skill registry, redirects and exits. Do not construct another BE |
| `services.jibo` | Already initialized Jibo SDK instance. Do not initialize/close global SDK services |
| `services.systemAccess` | Shared Settings/system-access implementation. It changes global owner choices; it is not a per-app port grant or a shortcut around the owner's Settings flow |
| `services.requireModule` | Host-relative CommonJS loader; not scoped to your package and not a sandbox. Prefer your entry's ordinary relative `require()` for bundled dependencies |
| `services.localStorage` | Shared Electron localStorage object, or null if unavailable; not an app-isolated store. Prefer `dataRoot` for new app settings |
| `services.legacyLocations` | Host-provided compatibility-location map for existing built-in data. Not a new app's storage API; do not edit other entries |

`systemAccess` exposes firewall constants `FIREWALL_OFF`, `FIREWALL_SSH`,
`FIREWALL_ALL`, `FIREWALL_REMOTE_OPERATION` and robot-mode constants
`MODE_NORMAL`, `MODE_DEVELOPER`, `MODE_SETUP`; callbacks for `getFirewallMode`,
`setFirewallMode`, `turnSshOn`, `turnFirewallOff`, `turnAccessOff` / `turnSshOff`,
`robotAddress`, `switchRobotMode`; and host integration functions
`restoreFirewallPreference`, `registerAppAdmission`. These are **global Settings
internals**, not a skill authoring permission model. A normal skill should not
change firewall, robot mode or app-admission policy. Ask the owner to use the
existing Settings screens instead. Never silently turn the firewall off to make
a template's listener reachable.

For local tests, `services.localStorage` is always `null`,
`services.legacyLocations` is `{}`, and `legacySettings` is empty. This prevents
accidental reuse of a Skill Store app's compatibility data. It is not a sandbox.

An embedding/test host may supply its own `services` object. For a hardware
feature, check its namespace before use, fail the affected feature clearly, and
keep unrelated functionality available. Presence does not prove a service is
connected or that physical behavior succeeded.

## Owned handles

Registration, hook and lease operations return a handle with a `remove()`
method. Removal is idempotent; keep each handle and remove it once your work is
done. The host also tracks a `category` (`hook`, `launcher`, `settings`, `timer`,
`lease`), but authors should not mutate it.

### `hooks.add(dispose)`

`dispose` must be a function. It runs on `handle.remove()` or host disposal.
This is for **synchronous** cleanup; the host does not await a Promise returned
by a disposer. Perform asynchronous cleanup in `stop()` first, then remove the
handle. Invalid functions fail with `native_hook_invalid`.

```js
var hook = context.hooks.add(function () { socket.removeListener('data', onData); });
// In stop(), after awaiting the socket's own shutdown:
hook.remove();
```

### `hooks.on(emitter, event, handler)`

For Node-style EventEmitters: calls `emitter.on(event,handler)` and removes that
same listener with `.off()` or `.removeListener()` later. It does not validate
an arbitrary emitter for you. Do not pass SDK typed Events as if they were
EventEmitters; those take `.on(handler)` with no event-name argument.

```js
var nodeHook = context.hooks.on(skill, 'exit', function () { be.exit(skill); });
var typed = jibo.system.events.touchOn;
function touched(pads) { /* close this interaction */ }
typed.on(touched);
var typedHook = context.hooks.add(function () { typed.off(touched); });
```

### `launchers.register(entry)` and `settings.register(entry)`

Each takes an object with string `name` (<=80 characters) and function `open`.
Use a nonempty human-readable name even though the host check only bounds its
length. The returned handle removes that exact registration. Bad entries fail
with `native_registration_invalid`. Add the fixed label to `app.json.menuEntries`
as a collision declaration too.

Menu registrations are not proof that the installed release displays local
tests. See [local-test menu availability](WORKFLOW.md#opening-a-local-test) before
relying on a Home or Settings entry.

Home entries are projected only for started, installed, nonclosed instances
with no pending change. A setup-state exception hides the Home entry. Settings
entries are also hidden during a pending change. Home and Settings are separate:
register the former for a skill people use, the latter for configuration. Some
built-in signed apps have fixed placement overrides; those are not an author
field, and registering both is not a way to override them.

### `timers`

All four members are available:

- `setTimeout(fn, delay)` and `setInterval(fn, delay)` return the ordinary Node
  timer ID, not a removable handle. `fn` must be a function.
- `clearTimeout(id)` and `clearInterval(id)` remove the tracked timer with that
  ID; they use the same cleanup lookup.
- A one-shot timer is untracked before its callback runs. An interval stays
  tracked until cleared. Ordinary Node delay semantics apply; there is no extra
  app-context delay-validation schema.

Bad callbacks fail with `native_timer_invalid`. Never poll every frame or start
an overlapping network request on each tick. Use a busy flag and a bounded
request, as in the network-service template.

### `speech.acquire()` and `attention.acquire()`

Both return a removable lease handle or **null** if busy or the host says the
resource cannot be acquired. They throw `native_admission_closed` after
admission closes. A lease coordinates cooperating apps; it neither speaks nor
moves Jibo, and cannot isolate arbitrary full-access skill code.

```js
var attention = context.attention.acquire();
if (!attention) return 'native_focus_unavailable';
var speech = context.speech.acquire();
if (!speech) { attention.remove(); return 'native_focus_unavailable'; }
// Open your skill, then release BOTH on close, including error paths.
```

Acquire both before a screen-and-speech interaction. If redirect throws, release
both. Do not acquire a new lease from `stop()`.

## Stop is a completion barrier, not a notification

The host closes resource admission **before** calling `stop(reason)`. New hooks,
registrations, timers or leases then throw `native_admission_closed`. Clear
existing timers, remove existing hooks and release existing leases explicitly.
A teardown watchdog, if needed, must use an ordinary `require('timers')` timer,
not allocate a context timer after stop begins.

The host checks for remaining tracked resources **before** doing its final
fallback disposal. Remaining non-menu resources or a result other than
`{resourcesReleased:true}` fail with `native_cleanup_unconfirmed`. Menu handles
may be removed by host disposal, but removing your own registrations is clearer.
Tracked cleanup is not proof that untracked sockets, child processes, global
listeners or native animations have stopped: that proof is your responsibility.

A complete stop should:

1. Mark the instance stopped and increment its callback generation immediately.
2. Clear polling timers; block new work and reject/ignore late callbacks.
3. Cancel only owned listening/speech/animation operations and await completion.
4. Finish any pending view transition, remove your own view and verify destruction.
5. Close HTTP servers, sockets, streams and child processes; await close/exit.
6. Remove hooks, leases, registrations and your exact global skill entry.
7. Resolve success only after all steps complete. Reject on timeout/failure.

Make stop idempotent by retaining and returning the same pending Promise.
Do not swallow a close error and claim success. Do not call global
`cancelAnyTurn`, `speech.stop`, SDK cleanup or listener removal to compensate for
not knowing which resources belong to you. The hello and voice templates show
owned speech/session checks; the network template shows listener teardown.

## Storage and removal

Treat `appRoot` as immutable. Store versioned, bounded JSON under `dataRoot`.
Validate data on read; absence can mean first run or owner-requested erase.
Write a temporary file in the same directory, close it, then rename for an
atomic replacement. Never store auth tokens in logs or commit local state.

Normal updates keep data. Local `--keep-data` removal retains the project's
`dataRoot`; `--erase-data` deletes that directory. The local host **does not call `removeData()`**,
even when Allow is on: removal must not evaluate stopped test code. Data saved
outside `dataRoot` is not covered by local erase. Keep local-test data inside it.

The Skill Store host can call `removeData("all")` on a small host-created
instance during removal. Implement it without opening a screen, starting a
service or acquiring focus. Delete only your own known files and handle missing
files. Never erase the Skill Store version's data from a local test or touch
another project's data.
