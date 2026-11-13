# Skill cookbook

[Developer guide](../SKILLS.md) · [SDK](SDK.md) · [Host API](CONTEXT.md)

These are small changes to the runnable starters, not complete replacement
entry modules. All recipes run inside your `create(context)` instance
or its owned skill, after services initialize. Keep the starter's lifecycle,
focus checks, generation guards and shutdown. Use Node 6-compatible syntax.
Scaffold with `node tools/skill-kit/cli.mjs new my-skill --template <name>`, then
check/pack as shown in [the workflow](WORKFLOW.md).

## 1. Speak an authored ESML line

Start with `voice`. Its `say()` method checks speaker ownership and returns
whether speech succeeded. Use fixed markup, not raw remote text:

```js
this.say('One moment. <break size="0.2"/> Here we go!');
```

The starter uses `dispatchComplete: 'TTS'`. For a question, wait for a successful
speech result before opening exactly one listen turn. STOPPED is not success.
The [speech options](SDK.md#embodied-speech-and-esml) explain timing and cleanup.

## 2. Show a screen with buttons

Start with `touch-ui`. Its welcome screen changes to a counter screen, then
Back restores the welcome text. To change a label from a guarded button callback:

```js
if (!self.ready || views.currentView !== view || view.inputLocked) return;
view.getComponentById('title').text = 'Ready';
view.getComponentById('tap-label').text = 'Continue';
```

Keep the painted button and hit area aligned. Decoration belongs in the loaded
callback; readiness belongs in transition completion. Do not replace the
starter's verified close with a global remove-current-view call.

## 3. Listen for a word

Start with `voice`. In its answer handler, normalize and match the successful
final text locally:

```js
var matched = /\bhello\b/i.test(text);
self.view.getComponentById('title').text = matched ? 'Hello to you too!' : 'Try saying hello';
```

`hintPhrases: ['hello']` biases recognition but does not restrict answers. The
starter discards timeout/cancel/failure results and cancels its exact request
on close, including a request that arrives after close started. A microphone
request uses Jibo's configured voice service; it is not an offline recognizer.

## 4. Play a bundled sound

Add a small `chime.wav` to `skill.json.files`. Within an owned interaction,
load it and retain the returned object:

```js
var path = require('path'), ownedSound = null, closed = false;
jibo.loader.load({ id: context.appId + '-chime', type: 'sound',
    src: path.join(context.appRoot, 'chime.wav') },
    function (error, sound) {
        if (error) return;
        if (closed) { sound.destroy(); return; }
        ownedSound = sound;
        sound.play(function () { /* your playback finished */ });
    });
// In your existing close/stop path:
closed = true;
if (ownedSound) { ownedSound.stop(); ownedSound.destroy(); ownedSound = null; }
```

Add `audio` disclosure. Do not stop the shared audio context or another app's
sound. A loader callback can arrive after your screen closes; destroy that
late owned sound instead of playing it. Keep the app-scoped `id`: the default
filename-stem alias can overwrite another app's sound. Do not overlap loads or
reuse that ID before the previous load and cleanup have completed.

## 5. Call a web API

Start with `network-service`; replace only `config.js.url` with your HTTPS
endpoint. Its actual code demonstrates the complete request lifetime: no
overlapping polls, ten-second timeout, 65,536-byte response cap, error/abort/
premature-close handling, and stop-time cancellation.

```js
module.exports = {
    url: 'https://example.com/', periodMs: 60000, port: 8897
};
```

For a JSON API, validate status/content type before parsing a bounded body and
validate the shape before using it. Reject redirects to untrusted hosts. Keep
TLS checks enabled. Never put credentials in a URL, source, screenshot or log.

## 6. Run a background service with a port

The `network-service` starter runs without a Home tile. It serves only
`GET /status`, on `127.0.0.1:8897`, with a short JSON summary and no response
bodies or credentials. It declares `incomingPorts: [8897]`.

To choose a different port, change **both** config and the manifest claim.
A declaration does not open a firewall. Keep the loopback bind for local-only
access. A LAN service additionally needs authentication, authorization, request
limits and a privacy review; never expose a control endpoint just by changing
the bind to all interfaces.

## 7. Schedule a periodic update without overlap

The network starter owns an interval through the context. The general pattern:

```js
var running = false, timer = null;
function refresh() {
    if (running) return;
    running = true;
    doBoundedUpdate().then(function () { running = false; }, function () { running = false; });
}
// In startAfterInit:
timer = context.timers.setInterval(refresh, 60000);
// In stop, before awaiting the outstanding update:
context.timers.clearInterval(timer); timer = null;
```

`doBoundedUpdate` is your own bounded operation, not an SDK method. Retain its
Promise and cancellation handle and await it in stop. A cleared interval does
not stop an already-running request.

## 8. Store settings and erase only your own file

Use an app-owned, bounded JSON file. This helper is independent of the screen:

```js
var fs = require('fs'), path = require('path');
var settingsFile = path.join(context.dataRoot, 'settings.json');
function readSettings() {
    try {
        var stat = fs.lstatSync(settingsFile);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) throw new Error('settings_invalid');
        var data = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
        if (!data || typeof data.greeting !== 'string' || data.greeting.length > 120) throw new Error('settings_invalid');
        return { greeting: data.greeting };
    } catch (error) {
        if (error.code === 'ENOENT') return { greeting: 'Hello!' };
        throw error;
    }
}
function writeSettings(value) {
    if (!value || typeof value.greeting !== 'string' || value.greeting.length > 120) throw new Error('settings_invalid');
    var temporary = settingsFile + '.new';
    fs.writeFileSync(temporary, JSON.stringify({ greeting: value.greeting }), { flag: 'wx', mode: 384 });
    fs.renameSync(temporary, settingsFile);
}
function eraseSettings() {
    try { fs.unlinkSync(settingsFile); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    try { fs.unlinkSync(settingsFile + '.new'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
}
```

Serialize writes; a leftover `.new` is an explicit recovery condition, not a
reason to follow or overwrite an unknown file. Wire `eraseSettings` into your
`removeData()` method for Skill Store removal. Local erase deletes `dataRoot`
without calling that method; this example keeps both files inside that root. Small synchronous files are suitable for this example;
use asynchronous I/O for larger data. Do not use shared localStorage for
private app settings. Updates keep the same `dataRoot`; version your schema.

## 9. Add a Home menu tile

Inside `registerLaunchers()`, keep the returned registration handle in your
instance's owned list:

```js
owned.push(context.launchers.register({ name: 'My counter', open: open }));
```

Declare `"menuEntries": ["My counter"]` in `app.json`, and use your unique
`skills` namespace. The label is a collision claim as well as visible copy.
On Jibo 13.8.0 a running local test shows it in Home as **LOCAL / Test — My counter**; see
[opening a local test](WORKFLOW.md#opening-a-local-test).
For a custom Home menu icon, add all three `iconApi`, `icon` and `iconImage` fields
following the [v2 icon rules](MANIFESTS.md#v2-icon-rules); an `icon` field on
its own is rejected.

## 10. Put configuration in Settings

Use a Settings entry for configuration rather than filling the Home menu with
setup shortcuts:

```js
owned.push(context.settings.register({ name: 'My counter', open: openSettings }));
```

`openSettings` is your own function. Implement its view/close/focus lifecycle as
for a Home interaction. Declare the fixed label in your manifest too. The host
can prefix Home entries with `Set up ` when `getSetupState().configured` is
false; that is a setup hint, not permission to launch uninitialized work.

## 11. Declare a voice-launch name

Add a valid declaration such as `"launchNames": ["my counter"]`. Use
lowercase words and no leading/trailing or double spaces. It is a collision
claim, not a subscription call. **Local v1 does not register voice aliases**.
Use the [local-test opening path](WORKFLOW.md#opening-a-local-test) instead.
Do not disable global hotword handling or install a system-wide subscription
to simulate a local alias.

## 12. Respect an optional grant

If an optional network feature is declared in `optionalPermissions`, keep it
off when the grant is absent:

```js
var mayUseNetwork = context.grants.indexOf('network') >= 0;
if (mayUseNetwork) { /* start this optional feature after init */ }
```

Do not declare the same label as both required and optional. Required grants
must all be present; optional absence should not make the base app fail health.
Local protocol 1 grants only required labels, so this optional feature stays
off during a local test. To test it locally, declare it as required in the test
build and review the changed build on Jibo. This is your feature policy, not a
sandbox.

## 13. Read volume without changing it

```js
jibo.system.getMasterVolume(function (error, level) {
    if (error) return;
    // level is 0–1, not the separate 1–10 user volume scale.
    showVolume(level);
});
```

`showVolume` is your own guarded screen update. Only change the owner's master
volume in response to an explicit request, and validate a finite normalized
value. Prefer per-sound gain when balancing your own sound.

## 14. Briefly request attention

Acquire the app-context attention lease first. For an SDK attention-mode
request, retain its separate releasable handle, even if it arrives late:

```js
var closing = false, mode = null;
var pendingMode = jibo.expression.pushAttentionMode(jibo.expression.AttentionMode.ENGAGED)
    .then(function (handle) {
        mode = handle;
        if (closing) return handle.release().then(function () { mode = null; });
    });
// During close:
closing = true;
var releasingMode = pendingMode.then(function () {
    if (mode) return mode.release().then(function () { mode = null; });
});
```

Await `releasingMode` before reporting resources released. Handle rejection as
cleanup failure. Do not use global `setAttentionMode` to undo another skill's
mode. For movement, use the SDK's documented coordinate frame and meters,
not guessed degrees.

## 15. Close cleanly, including pending asynchronous work

The starters demonstrate complete implementations. Use this checklist when
adding any of the recipes:

- Invalidate callbacks and stop admitting new work synchronously.
- Clear all existing context timers; new ones are refused after stop begins.
- Cancel your exact listen request and owned speech/animation, not a global
  “stop everything” call.
- Wait for view transitions; remove your own view, verify destruction, then
  release focus. A covered view is a cleanup error, not permission to remove
  the covering activity.
- Abort your own request; close your listener and its connections; await close.
- Remove hooks and your exact skill/menu registration.
- Return the same pending stop Promise on repeated calls. Resolve
  `{resourcesReleased:true}` only at the end; reject if cleanup fails.

Do not return a success object immediately and perform cleanup later. The host
uses stop completion as a barrier before changing executable code or data.
