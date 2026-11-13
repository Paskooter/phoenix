# Jibo APIs for skills

[Developer guide](../SKILLS.md) · [App context](CONTEXT.md) · [Recipes](COOKBOOK.md)

Use the initialized `context.services.jibo` and `context.services.Be`; do not
bundle a second SDK or start global services yourself. This guide covers the
skill-facing surfaces and their ownership rules. For the original SDK's class,
enum and asset-schema details, use the [SDK reference](https://pvindex.org/api-docs/)
with the installed software's API. An old SDK entry is not a promise that an
optional service, remote provider or asset is present on every Jibo.

## Runtime and resource budget

- Robot service code targets Node **6.9.2**; Electron **1.4.3** embeds Node
  **6.5.0** and Chrome **53**. Write skills for the stricter embedded Node.
- Use CommonJS `require`, `var`/ES2015 syntax and Promises with `.then()`.
  No async/await, optional chaining, object spread, ESM imports, `fetch`,
  `AbortController`, `fs.promises` or modern CSS/browser API assumptions.
- Run the kit itself with Node **20+** on your computer. Its default syntax
  check uses the host parser. Add `--syntax-node "$NODE_6_5"` for the exact
  trusted local Node 6.5.0 parser; Jibo still parses independently.
- Budget for **2 GB RAM and no swap**, shared with Jibo's services. These are
  whole-robot resources, not an app allowance. Avoid large decoded images,
  unbounded caches, video buffers, huge JSON and CPU-heavy synchronous loops.
- Startup and stop are bounded by the host. Offload expensive preparation to
  your computer; ship small assets and JavaScript dependencies without install
  scripts or native binary modules. Never block the main renderer/event loop.

## Surface map

| Surface | What a skill can do | Ownership / limit |
| --- | --- | --- |
| `Be.BeSkill`, `Be.SkillSwitchData`, `be.skills`, `be.redirect`, `be.exit` | Participate in BE's skill switching and screen lifecycle | Register only your unique skill name, forward exit/redirect events, remove your exact registration |
| `jibo.face.views` | Create native views, Labels, Buttons, transitions and gestures | Own one view, guard asynchronous callbacks, wait for transitions and verify removal |
| `jibo.face.tween`, `jibo.rendering`, PIXI | Render and animate native components | Chrome 53 renderer; free owned display objects, textures and tweens |
| `jibo.embodied.speech`, `jibo.tts` | Speech with coordinated motion/ESML, or lower-level TTS | One speech owner; retain/cancel only owned work |
| `jibo.jetstream`, `jibo.embodied.listen`, `jibo.mim`, `jibo.bt`, `jibo.flow` | Local listening turns, dialog behavior, MIM/behavior/flow assets | Local request handles and typed events; no implicit local voice alias registration |
| `jibo.loader` and loaded Sound objects | Load packaged sounds/images/data and cache assets | Bound caches; destroy only your own sound/assets |
| `jibo.animDB`, `jibo.expression` | Catalog animations, head/body movement, attention, LED color | Use installed catalog names or your own assets; retain handles, respect focus and faults |
| `jibo.system`, `jibo.globalEvents` | Touch, power/temperature telemetry, volume/backlight and shared events | SDK typed events use `.on(fn)` / `.off(fn)`; do not suppress global STOP |
| `jibo.media` | Take photos, display photo textures or viewfinder | Explicit owner intent and declared camera behavior; household media is private |
| `jibo.lps`, `jibo.kb` | Local perception and knowledge-base data | Check freshness and availability; do not log identities or silently persist household information |
| Node `http`, `https`, `net`, `fs`, `path`, `timers` | Web APIs, your own service, settings, bounded work | Full access is not isolation; close all handles; preserve TLS verification |
| `jibo.log`, `jibo.performance` | SDK diagnostics | Keep diagnostics bounded and free of private data |

Other shared runtime namespaces include services/session/remote integration,
Wi-Fi, scheduler, system manager, analytics, secure transfer, loader/plugin
infrastructure, interaction memory (`im`), action/emotion, location and versions.
They serve BE and its built-in behavior; they are not extra app-context services
or permission grants. Do not reinitialize or shut them down, rewrite identity,
change the owner's Wi-Fi, schedule arbitrary system work, or register colliding
plugins. The historical internal `ics` service is not a skill API. Use the
exposed perception/knowledge surfaces instead of assuming an `ics` object works.

## BE skills and focus

The hello, touch and voice starters subclass `Be.BeSkill` with an asset pack
name and root path. BE owns switching between skills; the native host owns
installation. `create(context)` is not itself a screen-open event.

```js
var Be = context.services.Be, be = context.services.be;
// After acquiring attention/speech and registering your skill:
be.redirect(new Be.SkillSwitchData(skill, { source: 'native_app' }));
```

Wire the skill's `exit`, `redirect` and `refresh` events to BE during prepare;
the public `entry.js` starters show the exact forwarding shape. `skill.exit()`
asks BE to leave. Implement both `close(done)` and `destroy(done)`: the base
class does not remove your custom view. Never delete another skill's registry
entry; test identity before deleting your own.

## Native views and components

The display canvas is 1280×720. Put the main content and touch controls in the
central safe area; use large labels and at least 64-pixel-high touch targets.
Use text, abstract skill glyphs or licensed real photos; never draw Jibo.

```js
var views = jibo.face.views;
var view = views.createView('View', {
    viewConfig: { type: 'View', id: 'counter', category: 'gui',
        ignoreSwipeDown: true, transitionStageOnly: true },
    componentConfigs: [
        { type: 'Label', id: 'title', text: 'Counter',
          position: { x: 640, y: 240 }, targetAnchor: { x: 0.5, y: 0.5 },
          bounds: { width: 420, height: 70 },
          style: { fontFamily: 'Proxima Nova Soft', fontSize: 48,
              fill: '#FFFFFF', align: 'center' } },
        { type: 'Button', id: 'count', assets: [],
          position: { x: 440, y: 320 },
          hitArea: { x: 0, y: 0, width: 400, height: 100 },
          action: { type: views.ActionData.CALLBACK,
              data: { callback: function () { /* guard ownership, then act */ } } } }
    ]
});
```

`viewConfig.id` identifies the view; `category: 'gui'` creates a GUI screen.
`ignoreSwipeDown` means your app handles leaving explicitly. Labels expose
`text`, `style`, `position`, `targetAnchor` and `bounds`. A Button's hit rectangle
is local to its position. A hit target does not automatically paint a visible
button: add its background to the component's display after load. Keep text
and hit-area coordinates aligned.

Open with `views.changeView(options, complete, failure, loaded)`:

```js
view.viewStateStacked = true;
views.changeView({ addView: view, transitionOpen: views.TRANSITION.IN,
    transitionClose: views.TRANSITION.OUT }, onComplete, onFailure, onLoaded);
```

Create PIXI decoration in `onLoaded`; enable interaction and speak after
`onComplete`. Update text with `view.getComponentById('title').text`.
A callback should confirm the same generation/view, `views.currentView === view`,
and `!view.inputLocked`. An old callback must not draw over a replacement screen.

For swipe-down, `view.addAction(views.ActionData.CALLBACK, {callback: leave},
true, false, views.GESTURE.SWIPE_DOWN)` registers the exit gesture. The starters
also exit on head touch and a new Hey Jibo. During close, listen to
`views.events.process` while a transition is pending, then remove only your own
current view with `{remove:true, transitionClose:views.TRANSITION.NONE}`. Verify
`view.state === 'destroyed'`; a covered view is not proof of cleanup. Never
remove whichever view happens to be current if it is not yours.

## Embodied speech and ESML

`jibo.embodied.speech.speak(text, options, autoRuleConfig)` returns a Promise
for a request status. The installed statuses include `SUCCEEDED` and `STOPPED`;
Promise fulfillment alone does not mean the utterance completed normally.
The namespace also exposes `RequestStatus`, `isActive()`, `waitForAnimDispatch()`
and `setPaths(assetPack)`; changing asset paths affects the shared speech engine.
`stop()` is global to embodied speech, so call it only after confirming the
active/pending session belongs to your skill. The templates include that
ownership check; do not copy only their `speak()` line and discard cleanup.

```js
// Fixed author text, while this app owns speech and no other speaker is active.
jibo.embodied.speech.speak('Hello! <break size="0.2"/> Ready?', {
    disableAutoRules: true, dispatchComplete: 'TTS'
});
```

The installed option names are case-sensitive properties:

| Option | Type / effect |
| --- | --- |
| `disableAutoRules` | Boolean; disable automatic embodied speech rules |
| `dispatchComplete` | String `TTS` or `ALL`; choose which completion boundary resolves dispatch |
| `enableLayerMerging` | Boolean; allow merging animation layers |
| `frameBuffer` | Nonnegative number, timing buffer in seconds |
| `followedByListen` | Boolean; selects TTS completion and trims trailing animation timing for an ensuing listen |
| `assetRelativeEnd` | Number; relative asset end timing in seconds |
| `debugMode` | Boolean; SDK debugging |

The optional auto-rule configuration controls punctuation, hot words, voice,
beat and the other installed rule categories; use defaults unless your authored
speech needs a specific change. `followedByListen` **does not start a local
microphone request**; call the listening API once after the owned speech result.

ESML combines text with speech markup and catalog-backed expressive assets.
The fixed `<break size="0.2"/>` example inserts a pause; installed speech markup
also handles pronunciation, pitch/duration shaping and asset references. The
[embodied SDK reference](https://pvindex.org/api-docs/jibo.embodied.html) describes
the full authored markup and asset grammar. Resolve animation/sound identifiers
against the installed catalog, not a guessed expression name. A web SSML tag
is not automatically a supported ESML tag. Do not add a fabricated `<speak>`
wrapper or arbitrary HTML.

Treat remote/user text as text, never trusted ESML. Escape XML-sensitive
characters before insertion, or use a plain-text TTS path for untrusted content.
Do not put transcripts, tokens or URLs with secrets into speech markup. The
low-level `jibo.tts` service is shared with embodied speech; bypassing it does
not grant independent speaker ownership.

## Local listening and voice

For a one-reply interaction, `jibo.jetstream.startLocalTurn(options)` resolves to
a `LocalTurnRequest`. Its `.promise` resolves to the **final** turn result.
Retain the request through cancellation/completion. Read text only when
`result.status === 'SUCCEEDED'`, then `result.result.asr.text`. Timeout,
cancellation and failure can contain partial data; discard it.

| Local-turn option | Meaning |
| --- | --- |
| `nluRules` | Required list of configured NLU contexts; `[]` for a text-focused reply |
| `ignoreHJ` | Whether Hey Jibo can interrupt the turn; preserve normal interruption by default |
| `rejectIfBusy` | Reject instead of interfering with an existing turn |
| `ignoreGlobalRules` | Keep a reply within your interaction rather than route a new global skill |
| `hintPhrases`, `earlyEOS` | Recognition hints / phrases that can end capture; hints are not strict allowed-word validation |
| `sosTimeout`, `maxSpeechTimeout` | Seconds to start speaking / maximum utterance duration; `-1` or omitted uses service defaults |
| `language` | Service-supported language label |
| `meta`, `log` | Caller metadata; do not include household/private data |
| `clientASR`, `clientNLU` | Injected input for menu/testing; not microphone evidence |
| `suppressedEvents` | Event suppression list; leave unset for ordinary skills |

```js
jibo.jetstream.startLocalTurn({ nluRules: [], hintPhrases: ['hello'],
    ignoreGlobalRules: true, rejectIfBusy: true, sosTimeout: 6,
    maxSpeechTimeout: 8 }).then(function (request) {
    // Save request immediately. Cancel this exact request during close.
    return request.promise;
}).then(function (result) {
    if (result.status !== 'SUCCEEDED') return;
    var asr = result.result && result.result.asr;
    if (asr && typeof asr.text === 'string') { /* validate the word locally */ }
});
```

A request has `id`, `status`, typed `events` and `error`, `.promise`, `.cancel()`
and `.update(asrOrNlu, meta)`. `cancel()` resolves false if it could not cancel.
When canceling an active request, treat false as unconfirmed release: the SDK
can force-end the local promise after a transport failure without the service
acknowledging cancellation. A terminal local status alone is not proof of release. Request status uses `ACTIVE`,
`CANCELED`, `FINISHED`, `ERROR` (one L in CANCELED). Turn-result status has its
own enum. Update is injected input, not an ASR test.

`request.events.on(fn)` / `.off(fn)` carry `TURN_STARTED`, `SOS`, `EOS` and
other service events with request/transaction IDs. Global
`jibo.jetstream.events.localTurnStarted`, `sos`, `eos`, `hjHeard`, `localTurnResult`
and errors are shared. Subscribe **before** opening a turn if you need its
first event: localTurnStarted can precede the request acknowledgement. Attribute
all shared events to your request and remove listeners on terminal paths.

`jibo.embodied.listen` provides active/ambient listening presentation, including
`getActiveMode()`, `getAmbientMode()`, `setAmbientMode(mode)`,
`enterActiveMode(mode,options)`, `exitActiveMode(fastForward)`, `waitForIdle(fastForward)`
and `disableOnce()`. The shared `dispose()` and `demoEngaged(turnOn)` functions
are host/presentation tools, not ordinary per-skill capture operations. It follows Jetstream's capture lifecycle;
it is not the ASR request itself. Do not repeatedly open listening or compete
with its eye/LED/motion presentation. The voice template retains late request
creation, invalidates stale replies and cancels only its owned turn.

### MIMs, behavior trees and flows

The initialized runtime also exposes `jibo.mim`, `jibo.bt` and `jibo.flow` for
packaged MIM dialog, behavior trees and flow assets. Those assets resolve
against the installed SDK/asset packs; they are not JavaScript-only local
launch declarations or an automatic way to add arbitrary NLU grammars. Keep
asset-pack names unique, include your own assets in `skill.json.files`, and
stop owned behavior when the skill closes. Use direct local turns for the
small voice starter; use the [SDK reference](https://pvindex.org/api-docs/) for
the complete MIM/flow schema when authoring a larger dialog.

## Sound and asset loading

Use the initialized loader to load a bundled sound, then retain its Sound
object and playback instance. The installed Sound has `play`, `pause`, `resume`,
`stop`, `destroy`, `volume`, `panning` and `loop`; SoundInstance is the individual
playback. Load through `jibo.loader`; there is no per-Sound `load()` or `muted`
property in this implementation. Use the owned Sound's `volume` for per-sound
gain, not the shared SoundContext's mute. Read the callback shape instead of
assuming playback returns a Promise.

```js
var path = require('path');
jibo.loader.load({ id: context.appId + '-chime', type: 'sound',
    src: path.join(context.appRoot, 'chime.wav') },
    function (error, sound) {
        if (error) return;
        // Save sound; on close stop/destroy only this owned object.
        sound.play(function () { /* playback complete */ });
    });
```

List `chime.wav` in your packed files. Use a small format the original renderer
can decode, such as a short WAV. Do not assume codecs from a modern desktop.
A sound completing is different from an utterance completing. Do not raise the
robot's master volume just to make your app louder. Asset caching is shared:
use an app-specific cache name and release only your own cache. Always provide
an app-scoped sound `id`: without it the loader uses the filename stem, and
loading another `chime.wav` can replace another app's sound. Do not overlap
loads/reuse that ID while an earlier owned load is still outstanding.

## Animation, motion, attention and LEDs

`jibo.animDB.getAnimByName(name)` looks up the installed animation catalog
case-insensitively and returns `undefined` when no name matches. Treat that
missing result as an error, not permission to make up a name.
`getAnimationNames()` and `getAnimationCategories()` list catalog entries;
`search(term)` and `query(query)` return structured search/query results.
These are the installed API names, not the older `collect` / `getAnimationInfo`
names found in historical references. `jibo.expression` is the native motion/expression surface; there is no
`context.motion.move()` convenience API.

| Expression API | Result / responsibility |
| --- | --- |
| `createAnimation(options)` | Promise of AnimationInstance; use an app-specific `cacheName` to allow later cache release |
| `createAndPlayAnimation(options, requestor)` | Promise of AnimationInstance; attach terminal event listeners immediately when resolved |
| `destroyCaches(nameOrNames)` | Destroy only your own animation caches |
| `acquireTarget({position:{x,y,z}})` | Promise of AcquireHandle; position is in meters, not degrees or normalized screen coordinates |
| `pushAttentionMode(mode)` | Promise of AttentionHandle; call its `release()` when done |
| `getAttentionMode()`, `setAttentionMode(mode)` | Read/set global base mode; prefer a releasable pushed mode |
| `setLEDColor([r,g,b])` | Promise; components are in 0–1, not 0–255 |
| `awaitFace(options)` | Promise of cancelable face-wait handle, with its own result Promise |
| `centerRobot(options)`, `cleanup(options)` | Global-capable movement/cleanup; scope DOFs/owners and avoid disturbing another skill |
| `blink()` | Procedural blink request; not screen art |
| `indexRobot()`, `setSkillRoot(root)`, `doCenterRobotOnDisconnect(allow)` | Global robot/host operations; not ordinary per-interaction setup/teardown |
| `events.dofs`, `events.kinematics`, `dofs`, `features` | Typed motion updates, DOF sets and latest kinematic features |

Animation options include `path` (absolute project root), `src` (absolute `.anim`
asset), optional raw `data`, `cacheName`, `speed`, `loops`, and `dofs`. An
AnimationInstance has `.play(requestor)`, `.stop()` and typed events including
stopped/cancelled/rejected. Use a bounded animation, retain the instance and
await its stop on close. Do not loop forever without a retained stop path.

```js
var modeHandle;
jibo.expression.pushAttentionMode(jibo.expression.AttentionMode.ENGAGED)
    .then(function (handle) { modeHandle = handle; });
// During close, including a late handle returned after close:
// await/chain modeHandle.release(); do not merely drop the reference.
```

Acquire the app-context attention lease as well; it coordinates apps but is not
this SDK mode handle. Respect touch/STOP, range limits and axis-fault events.
Do not bypass safety or repeatedly reissue a command after a fault. LED writes
are global and can conflict with listening cues; use them briefly in an owned
interaction and do not overwrite another activity's final state during cleanup.

## Touch, volume and system information

SDK typed Events take one function, not Node's `(eventName, function)` signature.
Available system events include `touchChanged`, `touchOn`, `touchOff`,
`inputEnergy`, `axisFaultOn`, `axisFaultOff`, `hatchOpen`, `hatchClose`,
`pluggedIn` and `unplugged`. `touchOn` is a local notification, **not** the
global STOP handler. Observe it to leave your screen; do not override STOP.
`padState` / `getTouchState()` describe six head pads.

System telemetry includes `pluggedIn`, `batteryCharging`, `batteryChargeRate`,
`inputEnergy`, battery level/temperature, CPU/main-board temperature, system
voltage and callback-based fan-speed/mode reads. Keep high-rate input-energy or
motion callbacks lightweight; do not log every sample.

`getMasterVolume(callback)` and `setMasterVolume(value, callback)` use **0–1**.
`getBacklight` / `setBacklight` use the same normalized brightness range. The
separate BE volume plugin uses a 1–10 user volume scale; never mix the units.
Changing volume/backlight is a global owner setting, not a per-sound gain.

```js
jibo.system.getMasterVolume(function (error, level) {
    if (!error) { /* level is normalized 0–1; show it without changing it */ }
});
```

## Camera and photos

The initialized `jibo.media` wrapper offers `CameraID`, `PhotoType`,
`ThumbnailType`, `takePhoto(params, callback)`, photo URL/preview and texture
loading, plus viewfinder support. Its service layer and the media-manager
storage/upload APIs are shared; do not turn a simple capture into silent
publication or household photo enumeration.

```js
// Only after an explicit camera action by the owner; don't auto-run on startup.
jibo.media.takePhoto({ camera: jibo.media.CameraID.RIGHT,
    photoType: jibo.media.PhotoType.SNAP }, function (error, photo) {
    if (error) return;
    // Use only for the requested action. Do not log photo bytes or private URLs.
});
```

This wrapper always requests an unstored capture; it does not read a `store`
option. Its callback receives `{id, url}`, with a preview URL, not image bytes.
Persisting a photo is a separate `storePhoto` operation and needs explicit owner
intent. Do not confuse wrapper options with lower-level media-service arguments.

Capture is asynchronous and cannot be undone by invalidating a callback. Guard
the consumer with a generation check, discard late output, and close only your
viewfinder when leaving. A declared `camera` label is disclosure, not a
sandbox-enforced permission boundary.

## Perception and knowledge

`jibo.lps` exposes local perception; `jibo.expression.features` gives latest
kinematics. Interpret timestamps, coordinate frames and unknown values instead
of treating a cached face/person detection as a current observation. `jibo.kb`
is the shared knowledge-base client; identity, media and settings data belong
to the owner. Prefer your app's own bounded data under `dataRoot`. Do not
register colliding global models or use KB access as permission to collect,
transmit or persist household information.

## Network, filesystem and timers

Use Node `https` for web APIs; there is no global `fetch` on this runtime. Set
request/response limits, check HTTP status, handle premature close, reject
unexpected content, and do not disable TLS verification. Keep credentials in
private app data with restrictive permissions, never a manifest, asset or log.

A background server must declare its incoming port, bind deliberately (prefer
loopback), authenticate any LAN control surface, retain connections, and await
listener shutdown. Port declarations are collision checks, not a firewall
opening. The network-service starter is loopback-only, caps responses, skips
overlapping polls and does not retain response bodies.

Use `context.timers` while active, not global repeating timers that the host
cannot track. Use asynchronous I/O for nontrivial work; large synchronous reads
block Jibo's UI and speech coordination. Every allocated socket, stream, file
descriptor, timer and child process belongs in the shutdown inventory.
