# Test a theme

[Theme guide](../THEMES.md) · [API fields](REFERENCE.md) · [Surfaces](SURFACES.md) · [Publishing](PUBLISHING.md)

## Fast local loop

Use Node.js 20 or newer. PNG check/pack and the starter generator use Node built-ins
only. JPEG input also requires Python 3 and Pillow. Work in a derivative directory;
never regenerate Ember/Orbit while developing your own art.

```sh
node tools/theme-kit/cli.mjs new my-theme --from paper --author "Your name"
node tools/theme-kit/cli.mjs check my-theme
node tools/theme-kit/cli.mjs pack my-theme --out out/my-theme-v1
node --test tools/theme-kit
# Equivalent explicit test-file command:
node --test tools/theme-kit/*.test.mjs
```

The directory test entry runs the kit's bounds, failures, reference bytes,
scaffolding and extension tests. It needs no store service, credentials or robot.
`check` writes nothing. `pack` refuses to overwrite existing files. Keep a new
output directory for each trial. Check all palette groups, not just defaults;
asset paths are source-only and never reach the robot manifest.

To rebuild the four original abstract starters (not Ember/Orbit):

```sh
node tools/theme-kit/build-templates.mjs
node tools/theme-kit/cli.mjs check tools/theme-kit/templates/paper
node tools/theme-kit/cli.mjs check tools/theme-kit/templates/signals
node tools/theme-kit/cli.mjs check tools/theme-kit/templates/terrace
node tools/theme-kit/cli.mjs check tools/theme-kit/templates/cut-paper
```

`paper` deliberately has no preview or images. `signals` demonstrates the full
accepted icon map with geometric placeholder marks, not universal rendered
coverage: trusted native app icons and the accepted Tic-Tac-Toe target keep
native paint. Refine visible marks to explain their labels before listing. `terrace` demonstrates global geometry
and complete per-menu groups: Main uses Soft labels; Clock uses Light labels and
removes the background. Geometry controls label size and suppresses titles, so
changing only `fonts.labelSize` or the title fields is not a typography preview.
`cut-paper` uses neutral abstract bars, not a traced native eye or fixed recolour.

## Accessibility and design checklist

- Both `text` and `mutedText` need at least **4.5:1** contrast against every solid
  `background`, `surface` and `surfaceSecondary`. `accent` needs at least **3:1**
  against `surface`. The kit refuses palettes below these ratios; repeat this for
  each override. Do not use accent to replace danger or network-status meaning.
- Static image detail can reduce real readability despite passing solid-colour
  ratios. Keep backgrounds quiet, respect the 0.35 opacity cap, and view text
  over the busiest portion of the actual composited image.
- Use only bundled font families and their allowed sizes. Read the longest native
  labels, not just short sample names. Test ellipsis and changed label widths;
  small API 4 buttons must not become unreadable targets.
- Keep icon drawings well inside their transparent canvas. The examples use a
  centred 160 × 160 drawing in a 256 × 256 file. Check native and slide layouts,
  both ends of every page, text alongside icons and the round-screen edges.
- Icons must not be the only way to identify an action. Preserve native labels
  and distinguish important actions with shape as well as colour. No flashing,
  animated images, surprise motion or semantic status disguises.
- Test reduced motion. Layout animation belongs to native code; the theme cannot
  force motion against that choice. Do not promise that an API 4 geometry request
  overrides native safety fit or list eligibility.
- Check the Skill Store card and upload preview on desktop and phone. A pack
  preview is artwork supplied by you, not proof of how the hardware renders.
  Clearly label offline menu reconstructions; never present them as robot photos.

## Hardware checklist

Use a compatible, owner-linked Jibo. Publish/installation and application are
separate: review appearance consent, approve installation, then explicitly choose
the theme in **Settings → Themes** or **Installed → Appearance** in the console.
This kit does not submit via SSH or grant approval remotely.

Record the tested release, theme API/version and layout/reduced-motion choices.
Use a separate test identity/version when experimenting; do not replace someone
else's active release. Then check:

| Area | Required checks |
| --- | --- |
| Ordinary menus | Main, Fun, Personal Report, Clock, Create, Exercise, Settings; all supplied icon roles; all pages and long labels |
| Per-menu overrides | Expected inheritance; a supplied group fully replaces the global group; absent art uses native fallback |
| Live/status menus | Wi-Fi and saved networks, battery/status indicators, standard Hue controls; native semantics and geometry remain intact |
| Protected surfaces | Wipe/Shutdown/Firewall button colours, icon identities, label wording and actions remain native; fonts and eligible geometry may change. Confirmations, setup/update/recovery, Default and picker stay native |
| Interaction | Tap real buttons, swipe/pan, swipe-down/STOP, voice selection, app launch and dismissal; actions/order remain unchanged |
| Layout | Native and slide selection where supported; API 4 paged/continuous behavior, target fit, label fit, ineligible-list fallback |
| Eye asset | Idle/gaze/geometry blink; neutral paint keeps native status hue; native opacity/rotation and mesh animation remain in charge |
| API 4 face | Certified listening and closed sources, scale fit and background; unknown/special expressions, glow, overlay/lid and stacked views stay native |
| Trial/recovery | Keep, Undo, explicit Default while offline, interrupted trial/startup, failed or corrupt data recovery |
| Lifecycle | Restart with kept theme, install a newer version without automatic apply, explicitly select it, remove active theme and confirm Default |

Do not deliberately corrupt a production installation or interrupt an update to
simulate a fault. Use automated/disposable development tests for malicious bytes
and storage/decode failures; hardware checks should be recoverable owner actions.

After a console request, wait for Jibo's reported **Applied**, **Reverted to
Default**, **Failed** or **Conflict** outcome. **Waiting** is not success. Return
to Default before removing an experimental pack if anything is hard to read.

## What each result proves

- A passing local check proves the author input conforms to this kit's format,
  image, path, contrast and size rules. It does not install, sign or activate.
- Exact reference hashes prove normalized pack bytes under the recorded toolchain.
  Different zlib/Pillow builds may compress identical pixels differently.
- An offline reconstruction using native menu/renderer code can check policy,
  placement and source art, but host fonts, GPU/display storage and synthetic
  input are not physical-screen or real-touch evidence.
- A server signature proves signed origin/integrity, not universal animation,
  usability, licensing or hardware acceptance.
- A hardware pass applies to the named version and tested surfaces. Repeat it
  after changing art, geometry, API or native software support.

If a valid pack is refused later, keep the exact version and error code, and
open a support ticket in **#help on the Phoenix Discord**:
<https://discord.gg/FyDVYQ6FfV>. Never share tokens, keys or personal images.
