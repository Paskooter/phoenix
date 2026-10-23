# Replaceable surfaces and native boundaries

[Theme guide](../THEMES.md) · [API fields](REFERENCE.md) · [Testing](TESTING.md) · [Publishing](PUBLISHING.md)

Themes decorate existing surfaces. They do not add skills, create menu entries,
change labels or reorder actions. These boundaries preserve recognisable status
and safety controls, reachable touch targets and a recovery path independent of
a downloaded pack. Passive images/data cannot run code or request new access.
An icon reference for an absent item does not
make that item appear. Use only the exact [menu keys and icon targets](../THEMES.md#full-icon-role-table).

## Surface inventory

| Surface | What can change | What remains native |
| --- | --- | --- |
| Main, Fun, Personal Report, Clock **menu**, Create **menu**, Exercise **menu** | Palette, background, bundled font choice/size, listed ordinary icons, `native`/`slide`, API 4 bounded geometry | Labels, item presence/order, actions, navigation, gesture handling |
| Settings menu | Same treatment for ordinary rows; listed root icons include Wi-Fi, battery, updates, themes and Home Assistant | Wipe/Shutdown/Firewall rows keep label wording, icon identity, button colours and actions; label font/colour and eligible geometry can change |
| Wi-Fi menu, saved networks, per-network actions | Palette text/backing, background and bundled fonts | Live controls, button colours/icons, status, geometry and connect/delete behavior |
| Standard Hue menus | Palette-tier cosmetics | Live list identity, icons, state and geometry |
| Other standard native-origin menu views | Backing/background, fonts and ordinary label/title colour | Controls, native button colours/icons and geometry; unknown origins are not themed |
| Declarative Skill Store tiles on supported menus | Optional `storeAppIcon` generic icon | App identity, launcher action and permissions; this is not a blanket native-app icon override |
| Menu buttons/cards | Palette surfaces, accent and permitted image slot; API 4 size/offsets inside bounds | Native timeline/interaction state and safety semantics; no authored button code or arbitrary shapes |
| Normal eligible eye view | API 3 original neutral paint replaces texture/alpha through native animated UVs; API 4 adds narrowly selected face paint/background/scale | Native mesh points, UVs, gaze, blink timing, rotation, opacity, semantic status and protected compositions |
| Closed/listening eye states | API 4 `face.closed` and `face.states.listening` under native source/state checks | Native state detection and animation source selection; no theme-defined state machine |
| Publish preview and Skill Store theme card | Optional `previewAsset` in the upload check; listing name/description from the manifest | Store page layout/buttons/badges; unknown theme IDs use a neutral card impression rather than rendering arbitrary pack art |
| Default theme, theme picker, approval/recovery controls | Nothing | Always available native recovery and consent |

A permitted icon mapping is not necessarily a visible replacement. Trusted
native app identities take precedence; the accepted `phoenix-tic-tac-toe` mapping
also keeps native paint on BE 13.7.1. See the
[accepted-target exceptions](../THEMES.md#accepted-targets-and-visible-replacements).

Menu `background` is a static image composited at opacity 0–0.35 over a solid
palette backing. It is not a wallpaper for every app. An omitted icon uses native
art; an omitted background uses the solid backing. A missing/unavailable decoded
image may fall back to native paint, but an invalid signed pack is rejected rather
than accepted as a partial untrusted theme.

## Outside the menu contract

- Tutorial guided screens, Gallery custom views, friendly tips, restore, initial
  setup, update/recovery surfaces and safety confirmations.
- Chat text, Web Panel content, photos, video, camera output, clock faces, alarms'
  custom views and volume sliders. Replacing the Clock menu's `time` icon does
  not replace a clock face; replacing the `volume` icon does not reskin its slider.
- Speech, voices, words, sound effects, music, microphone/camera behavior,
  movement, attention, sensors, networking, storage permissions or account policy.
- Behaviour code, HTML/CSS, JS, timelines, MIMs, expressions, custom fonts,
  shaders, URLs, executable archives and scriptable image formats.
- Any expansion of native allowlists. A theme cannot authorize its own eye
  source, add a semantic icon target or bypass a protected view.

There is **no sounds manifest field or audio asset role**. Use a skill for
behaviour; a theme stays passive data. There is no independent border/shadow,
button-shape, cursor, animation-speed, navigation-bar or transition scripting API.

## Eye boundaries in detail

Replacement is deliberately conservative. Jibo checks that the current view is
an eligible, unstacked normal eye view, its origin is permitted, native textures
are loaded and known, and overlays/lids, glow and pending compositions are safe.
Outside that boundary he uses native paint. Menu selection is not permission to
theme a recovery screen or an arbitrary expression.

API 3 does not replace active or pending KeysAnimation compositions. Native
geometry-only DOF changes can still animate. API 4 admits only specific native
listening, blink/closed, sleeping and patting sources. It does not admit the
whole animation library or let authors list paths. Untraced/special textures,
unknown transforms, overlays, transitions and glow keep native appearance.

Neutral API 3/closed assets preserve native semantic hue. The authored listening
asset is a separately declared exception, selected only when both native source
and expected listening tint agree. No theme can promise that every animation or
every native status will look like its preview. Always test native bypasses and
Default, not only the most favourable idle state.

## Apply, trial, remove and recover

1. Publish creates a release; it does not list it publicly or install it.
2. Install downloads a verified release after the owner's approval; it does not
   apply it. A theme has no launch name and does not run code after installation.
3. Choose a theme for each Jibo in **Settings → Themes**, or **Installed →
   Appearance** in the console. The picker offers a trial with **Keep** and
   **Undo**. The local trial lasts 20 seconds after it is shown; without Keep it
   returns to the previous selection. An unfinished trial is rolled back on
   startup. A per-Jibo layout choice and reduced-motion setting remain owner
   controls. Trial/readiness timers are native policy, not manifest fields.
4. Treat console **Waiting** as pending. Jibo reports **Applied**, **Reverted to
   Default**, **Failed** or **Conflict**. Do not infer active appearance from a
   successful upload or install response.
5. **Default theme** removes decoration locally, including offline. It does not
   need a theme download and is not an asset a pack can replace.
6. Removing an active theme or explicit owner revocation resets to Default.
   Installing an update does not silently activate its visuals; select it again.
   A failed/corrupt/quarantined generation is not evaluated as code. A candidate
   failure before commit can retain the prior menu appearance while restoring
   native eye paint. A failure of the committed renderer restores Default.

Native safety behavior is not a promise against OS, display-driver, power or
storage failures. If you need help, open a support ticket in **#help on the
Phoenix Discord**: <https://discord.gg/FyDVYQ6FfV>.
