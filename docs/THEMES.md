# Making Phoenix menu themes

Ember and Orbit are open, original examples for making your own Jibo menu theme.
The kit builds **unsigned data**, not a robot skill, firmware image or executable.
You need Node.js 20 or newer. PNG authoring has no npm dependencies: the CLI uses
only Node built-ins and the files in `tools/theme-kit/`. Python 3 with Pillow is
needed only for JPEG input; the optional art generator also needs NumPy.

A robot must advertise support for `phoenix-menu-theme-v1` and theme API 1 and
satisfy your manifest's minimum firmware. A version number by itself is not proof
of theme support. The examples preserve their original `minFirmware: "13.6.1"`
metadata; this kit does not certify any firmware or physical robot.

## What a theme can change

- Six palette colors, a static background, bounded bundled-font choices/sizes.
- Static icon replacements for the exact ordinary menu items listed below.
- A firmware-owned layout: `native` (paged buttons) or `slide` (sliding cards).
  The owner can choose a layout per robot and enable reduced motion.
- An optional store preview and generic icon for declarative Store app tiles.

Full decoration is supported on the Main, Fun, Personal Report, Clock, Create,
Exercise and ordinary Settings menus. Wi-Fi submenus accept palette, background
and fonts, not replacement icons or layout. Other ordinary menus may receive
limited cosmetics according to firmware policy; a pack cannot expand coverage.
Unsupported or specialized menus keep native controls/geometry.

Themes **cannot** change actions, labels, menu order, touch targets, navigation,
STOP/swipe-down behavior, speech, camera, network access or permissions. Safety
rows (Wipe, Shutdown, Firewall), stateful network/battery indicators, confirmation
colors, update/recovery screens and the Default/picker controls stay firmware-owned.
Tutorial guided screens, Gallery custom views, idle/eye, chat, Web Panel, photos,
clock faces, volume sliders, restore and setup screens are outside this menu API.
**Eye themes are coming, but are not supported yet.** No release date is promised.

No JavaScript, actions, raw BE view configs, MIMs, timelines, downloaded fonts,
CSS, HTML, shaders, sounds, SVG or external URLs are accepted. Backgrounds and
icons are passive images; layout motion comes from firmware, never an asset.
Do not depict Jibo's robot, shell, head, face or eye in the artwork.

## Start from Ember or Orbit

Run these commands from the Phoenix checkout:

```sh
node tools/theme-kit/cli.mjs check themes/ember
node tools/theme-kit/cli.mjs check themes/orbit
node tools/theme-kit/cli.mjs new copper --from ember --author "Your name"
# Or start with the sliding-card example:
node tools/theme-kit/cli.mjs new starlight --from orbit --author "Your name"
```

`new` creates `<current-directory>/<name>/` and never overwrites an existing path.
Names are 1–40 lowercase letters/digits/hyphens beginning with a letter. It copies
the art, palette/layout/role map and original license, changes the manifest name
and description, records your name in `AUTHOR.md`, and creates a **fresh local app
ID placeholder**. `--author` is optional; without it the credit says `Your name`.
Author text is 1–100 single-line characters. Replace all author placeholders.

Before submission, create your own app identity in Publish and replace `appId`
with that publisher-assigned ID. A generated UUID is **not** a registered Store
identity. Do not publish a derivative using Ember's or Orbit's app ID. There is no
`author` manifest field: publisher ownership is checked by the store; `AUTHOR.md`
is host-side attribution, not a runtime permission or signed manifest field.

Edit `theme.json` and the images in your copy. `README.md`, `AUTHOR.md` and
`LICENSE.md` are never packed; only the manifest and its listed images are used.
A theme may omit icons/background/preview entirely and provide only a palette:
use `assets: []`, `background: {"asset": null, "opacity": 0}`, `overrides: []`,
and omit `previewAsset` and `storeAppIcon`.

## Author manifest: `theme.json`

JSON is strict: unknown/missing fields, duplicate keys, malformed UTF-8, prototype
keys (`__proto__`, `prototype`, `constructor`), nonfinite/unsafe numbers and
trailing data are rejected. Maximum depth is 12; an object or array has at most
64 members. Text is plain text, not markup or expressions. Lengths are JavaScript
string lengths (UTF-16 code units). Required text cannot be empty/whitespace-only;
single-line text excludes all control characters, and long text permits only
tabs and line breaks among controls.

All top-level fields below are required:

| Field | Contract |
| --- | --- |
| `schema` / `kind` | Exactly `2` / `"theme"` |
| `runtime` / `themeApi` | Exactly `"phoenix-menu-theme-v1"` / `1` |
| `appId` | `app-` plus a lowercase UUID in `8-4-4-4-12` hex groups; must belong to the submitting publisher |
| `version` | Plain `X.Y.Z`; components are nonnegative safe integers, no leading zeros or prerelease/build suffixes; published versions are immutable and must increase |
| `minFirmware` | The same plain `X.Y.Z` grammar; select a supported theme-capable firmware floor |
| `name` | Nonempty single-line text, at most 60 characters |
| `description` | Nonempty long text, at most 1,200 characters |
| `releaseNotes` | Long text, at most 1,200 characters; empty string is allowed |
| `permissions` | Exactly `["menu-theme"]` |
| `launchNames` | Exactly `[]`; themes are not launchable apps |
| `theme` | The object described below |
| `assets` | At most 64 source entries, each exactly `{ "id", "role", "path" }` |

### The `theme` object

| Field | Required? | Contract |
| --- | --- | --- |
| `layout` | Yes | `"native"` or `"slide"` |
| `palette` | Yes | All six `#RRGGBB` fields below |
| `fonts` | Yes | Exactly `titleFamily`, `labelFamily`, `titleSize`, `labelSize` |
| `background` | Yes | Exactly `asset` (background ID or `null`) and `opacity` (finite number 0–0.35) |
| `previewAsset` | No | An existing asset ID with role `preview`; omit if not supplied, do not set to null |
| `storeAppIcon` | No | An existing asset ID with role `icon`, for declarative Store tiles only |
| `overrides` | Yes | Array of at most 32 objects; each `menuKey` must be unique |

`fonts.titleFamily` and `fonts.labelFamily` are each one of `Proxima Nova Soft`,
`Proxima Nova Light`, `Proxima Nova`. Title size is an integer 48–100; label size is
an integer 40–56. These select fonts already bundled in firmware, not font files
included in this repository or permission to redistribute those fonts.

Each override requires `menuKey`, and may contain `layout`, `palette`, `fonts`,
`background`, `icons`. An omitted group inherits the global group; a supplied
palette/font/background group must contain **all** its fields, not a partial
patch. `icons` is an array of at most 64 entries, each exactly `{ "itemId", "asset" }`.
Item IDs are unique within an override, 1–80 letters/digits/underscores/hyphens,
and must match the semantic allowlist. Menu keys are at most 120 characters and
must match an exact allowed scope; syntactically valid unknown scopes still fail.

Allowed scopes:

| Menu | Exact `menuKey` | Allowed overrides |
| --- | --- | --- |
| Main | `@be/main-menu#main-menu` | Palette, fonts, background, layout, listed icons |
| Fun | `@be/main-menu#fun-stuff` | Same |
| Personal Report | `@be/main-menu#personal-report` | Same |
| Clock | `@be/clock#clockMenu` | Same |
| Create | `@be/create#createMenu` | Same |
| Exercise | `@be/exercise#exercise-menu` | Same |
| Settings | `@be/settings#settingsMenu` | Same, ordinary rows only |
| Wi-Fi | `@be/settings#wifiMenu` | Palette, fonts, background only |
| Saved networks | `@be/settings#yournetworks` | Palette, fonts, background only |
| Network action menu | `@be/settings#networkName` | Palette, fonts, background only |

### Palette and contrast

| Token | Use |
| --- | --- |
| `background` | Solid backing behind menu decoration |
| `surface` | Primary button/card backing |
| `surfaceSecondary` | Secondary button/card/label backing |
| `text` | Ordinary labels and titles |
| `mutedText` | Secondary text |
| `accent` | Focus/border accent, not semantic danger/status colors |

Every token is exactly a six-digit hex color (`#` plus six hex digits), without
alpha, named colors or shorthand. Both `text` and `mutedText` must have WCAG
relative-luminance contrast **at least 4.5:1** against each of `surface`,
`surfaceSecondary`, `background`. `accent` must be **at least 3:1** against
`surface`. These checks apply to the global palette and every override palette;
invalid palettes fail rather than being silently adjusted. Preview/GPU/physical
contrast still needs visual testing: a solid-color calculation is not a hardware
or accessibility certification.

### Images, paths and budgets

| Role | Recommended example size | Maximum width × height | Accepted author format |
| --- | --- | --- | --- |
| `icon` | 256 × 256, transparent padding | 256 × 256 | Static PNG |
| `background` | 1280 × 720 | 1280 × 720 | Static PNG or baseline RGB JPEG |
| `preview` | 720 × 720 | 720 × 720 | Static PNG or baseline RGB JPEG |

Smaller positive dimensions are valid. The examples ship exact recommended sizes;
icons have centered drawings within **160 × 160** on a transparent RGBA canvas.
This drawing/padding convention is checked by the example art generator, not by
the general packer. Keep important background content away from clipped corners
of the physical circular display. Previews illustrate the menu without user data
or a robot depiction; they are not hardware screenshots.

| Limit | Maximum |
| --- | --- |
| Source `theme.json` and normalized canonical manifest | 65,536 UTF-8 bytes each |
| Complete normalized `.phtheme` | 8,388,608 bytes (8 MiB) |
| Assets | 64, with at most one background and one preview |
| Each input and normalized image | 1,048,576 encoded bytes (1 MiB) |
| Total pixels across all assets | 4,194,304 (up to 16 MiB decoded RGBA) |
| Installed themes on a robot | 8, sharing the Store's overall inventory cap |
| Robot theme disk allocation | 83,886,080 bytes (80 MiB), including candidate/retained predecessor; actual admission may be tighter |

Both examples contain 40 images (38 icons + background + preview) and declare
3,930,368 pixels. Having room under the encoded-byte budget does not waive the
pixel budget. Robot-advertised limits and publisher quotas may be lower; local
validation does not guarantee store or robot storage admission.

Asset IDs are unique, begin with a lowercase letter, and have at most 40 lowercase
letters/digits/hyphens. Author entries have no hashes or size metadata:

```json
{"id": "weather", "role": "icon", "path": "assets/icons/weather.png"}
```

Paths are relative to the theme directory, either `assets/<name>.png|jpg|jpeg` or
`assets/icons/<name>.png|jpg|jpeg`, with the same bounded lowercase name grammar.
They must be regular files. No symlinks (including directory components), absolute
paths, traversal or URLs. Every asset must be used by a correctly typed reference;
unused images, missing references and duplicate IDs/scopes/items fail.

PNG must be static, noninterlaced, 8-bit RGB or RGBA. Indexed/grayscale PNG, APNG,
GIF, WebP, SVG, progressive/grayscale JPEG and arbitrary metadata are rejected.
Allowed PNG chunks are IHDR, IDAT, IEND and sRGB/gAMA/cHRM/pHYs; export without
text/EXIF chunks. JPEG permits baseline RGB with JFIF only, not comments/EXIF/ICC
or other metadata. Renaming a file does not convert its format. CRCs, image
structure and all PNG scanline filters are checked; malformed, truncated or
trailing image/compressed-stream payloads fail. JPEG is decoded by a bounded
Python/Pillow child with a 10-second deadline.

## Full icon role table

All 38 files use role `icon`, **256 × 256** recommended (maximum), with transparent
padding and a centered **160 × 160** drawing. Filenames below are the examples'
`assets/icons/<stem>.png`; derivatives may choose other valid IDs/filenames while
preserving exact `menuKey`/`itemId` targets. IDs are case-sensitive.

| Stem | Menu and exact item ID | Size |
| --- | --- | --- |
| `introduction` | Main `introduction` | 256 × 256 |
| `things-to-do` | Main `thingsToDo` | 256 × 256 |
| `fun` | Main `fun` | 256 × 256 |
| `clock` | Main `clock` | 256 × 256 |
| `report` | Main `personalReport`; Personal Report `fullReport` | 256 × 256 |
| `music` | Main `radio` | 256 × 256 |
| `camera` | Main `snapshot`; Create `photo` | 256 × 256 |
| `gallery` | Main `gallery` | 256 × 256 |
| `photobooth` | Main `photobooth`; Create `photobooth` | 256 × 256 |
| `yoga` | Main `exercise` | 256 × 256 |
| `tutorial` | Main `tutorial` tile only, not guided screens | 256 × 256 |
| `settings` | Main `settings` | 256 × 256 |
| `agent` | Main `phoenix-agent`, only if firmware already permits it | 256 × 256 |
| `spotify` | Main trusted injected `phoenix-spotify` | 256 × 256 |
| `tic-tac-toe` | Main trusted injected `phoenix-tic-tac-toe` | 256 × 256 |
| `app` | `theme.storeAppIcon`, declarative Store app tiles only | 256 × 256 |
| `circuit-saver` | Fun `circuitSaver` | 256 × 256 |
| `word-of-day` | Fun `wordOfTheDay` | 256 × 256 |
| `joke` | Fun `joke` | 256 × 256 |
| `dance` | Fun `dance` | 256 × 256 |
| `surprise` | Fun `surprise` | 256 × 256 |
| `weather` | Personal Report `weather` | 256 × 256 |
| `calendar` | Personal Report `calendar` | 256 × 256 |
| `commute` | Personal Report `commute` | 256 × 256 |
| `news` | Personal Report `news` | 256 × 256 |
| `time` | Clock `time` | 256 × 256 |
| `date` | Clock `date` | 256 × 256 |
| `timer` | Clock `timer` | 256 × 256 |
| `alarm` | Clock `alarm` | 256 × 256 |
| `yoga-sun` | Exercise `sunSalutation` | 256 × 256 |
| `yoga-warrior` | Exercise `basicWarrior` | 256 × 256 |
| `volume` | Settings `volume` | 256 × 256 |
| `wifi` | Settings `wifi` root tile, not signal/connect/delete controls | 256 × 256 |
| `battery` | Settings `battery` root tile, not live status | 256 × 256 |
| `about` | Settings `about` | 256 × 256 |
| `updates` | Settings `updates` root tile, not progress/errors | 256 × 256 |
| `home-assistant` | Settings `homeAssistant` root tile | 256 × 256 |
| `themes` | Settings firmware `themes` tile | 256 × 256 |

## Check, pack and regenerate

```sh
node tools/theme-kit/cli.mjs check copper
node tools/theme-kit/cli.mjs pack copper --out out/copper-v1
node --test tools/theme-kit/*.test.mjs
```

`check` fully validates and normalizes in memory without writing files. It reports
SHA-256 digests, canonical manifest/artifact bytes, asset/pixel counts and global
palette contrast. Override palettes are validated too. `pack` performs the same
checks before creating output and emits:

- `copper-1.0.0.phtheme`: the unsigned upload container.
- `copper-1.0.0.manifest.json`: the exact canonical runtime manifest.
- `copper-1.0.0.preview.png`: normalized preview, only if `previewAsset` is present.

The stem comes from the source directory name (or `theme` if not a valid stem).
Existing output files are never overwritten: use a fresh output directory or
remove old outputs deliberately. Nonzero exit means rejection; diagnostics name
the failing rule/limit. Neither command signs, contacts a store or installs on a
robot. There is no unsigned sideload workflow.

The packer sorts assets lexically by ID, decodes accepted images, and emits clean
RGB/RGBA PNGs with filter 0 and compression level 9. It derives each image's hash,
bytes and dimensions; source paths never enter the runtime manifest. Canonical
JSON recursively sorts object keys, preserves array order and uses compact UTF-8
JSON with no whitespace/newline. The container is not a zip/tar archive:

| Bytes | Meaning |
| --- | --- |
| 0–7 | Exact eight-byte ASCII magic `PHXTHM1\n` |
| 8–11 | Unsigned 32-bit big-endian canonical manifest byte length |
| 12 onward | Canonical UTF-8 manifest, then raw image blobs in asset order |

Length equals `12 + manifestBytes + sum(asset.bytes)`. Packed asset entries are
exactly `{id, role, mediaType, sha256, bytes, width, height}`. There are no filenames,
archive extraction paths, nested compression or executable entries. The uploaded
artifact hash covers the entire container; the manifest hash covers its exact JSON.

Committed reference hashes in `tools/theme-kit/expected-sha256.json` pin both
examples against the reference packer. Equality was measured on Node 22.22.0,
zlib 1.3.1-470d3a2, Pillow 12.3.0 and NumPy 2.2.6. Exact compressed bytes are not promised
across arbitrary zlib/Pillow versions; use the pinned toolchain to reproduce the
hash vectors. Pixel equivalence is a separate generator check:

```sh
python3 themes/build-art.py --check
python3 themes/build-art.py --check --sheets out/theme-review
# This REWRITES both original example asset sets:
python3 themes/build-art.py
```

See [themes/README.md](../themes/README.md) for dependency/regeneration guidance.
Adapt a copy of the generator for your derivative, not the original pack paths.
Review all art on its intended surfaces; a valid pack can still be hard to read.

## Submit through jibo.io Publish

1. Sign in to jibo.io and open **Publish** in the apps console. Apply for publisher
   approval if needed; approval is required to upload.
2. Use **Create an app identity** for this theme. Copy the returned `app-…` ID into
   your derivative manifest. Use a new identity, not an already-published
   declarative app: an existing app cannot silently change listing kind.
3. Set your name, description, license/attribution and release notes, then `check`
   and `pack` again. Increase `version` for each update; versions cannot be reused.
4. Submit the `.phtheme` to the theme publisher upload, **not** the declarative
   `.json` upload. Choose public visibility separately when ready; uploading alone
   does not imply public community listing or apply anything to a robot.

The authenticated publisher contract is:

```text
POST /api/skill-store/publisher/theme-releases
Content-Type: application/vnd.phoenix.menu-theme
Body: raw .phtheme bytes (not JSON, base64 or multipart)
```

It requires your same-origin publisher session, an app identity owned by you,
no content encoding, and a body of at most 8,388,608 bytes. Upload idle/absolute
deadlines are 8/90 seconds. Default publisher limits include two concurrent
uploads, six admissions/releases per hour and 32 MiB storage; invalid uploads
also consume admission budget. Policy may tighten these limits.

**Publish UI compatibility:** some console builds still expose only a `.json`
declarative-app picker. Do not rename `.phtheme` to `.json`. From your authenticated
jibo.io Publish page, this browser-console helper offers a theme file picker and
uses the separate supported endpoint (review the code before running it):

```js
const picker = document.createElement('input');
picker.type = 'file';
picker.accept = '.phtheme';
picker.onchange = async () => {
  const file = picker.files[0];
  if (!file) return;
  if (file.size > 8388608) throw new Error('Theme exceeds 8 MiB');
  const response = await fetch('/api/skill-store/publisher/theme-releases', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/vnd.phoenix.menu-theme' },
    body: file
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Theme upload failed');
  console.log(result);
};
picker.click();
```

Use this only on the console origin; it does not bypass publisher approval,
CSRF/origin checks, ownership, version or upload limits. No cookies, credentials
or keys need to be copied into a script. A self-hosted console must itself support
the theme endpoint; this public kit does not add a store service.

The store repeats validation/normalization, creates the release ID, derives the
final descriptor and signs it. Authors do **not** need signing keys and must not
hand-author signatures. A successful response returns a signed release wrapper;
verify its app ID/version and refresh your listing before changing visibility.
Publisher approval/community review is not proof that every theme is safe, has
rights clearance or renders correctly on all robots. Automated format/size/
contrast checks do not substitute for content review or hardware acceptance.
A signature authenticates origin/integrity, not a hardware certification badge;
hardware acceptance can remain `unverified`.

## Test on a robot and recover

Install through the Store onto a compatible, owner-linked robot after reviewing
the appearance consent: “Changes ordinary menu appearance on this Jibo. Does not
change actions, speech, camera or network access.” **Install is not apply.** Select
it explicitly in Settings → Themes or the console's per-robot Appearance panel.
Treat Waiting as pending, not active: the console reflects robot-reported Applied,
Reverted to Default, Failed or Conflict outcomes.

Check Main/Fun/Personal Report/Clock/Create/Exercise/Settings, all icon roles,
long labels, focus/readability, gestures and both layouts. Verify protected safety
rows/status controls, Default recovery and ordinary app behavior stay unchanged.
The preview PNG and `check` cannot prove display clipping, GPU decoding or physical
touch/voice behavior; test those on the intended hardware separately.

Default is built into firmware and requires no theme download. An invalid or
corrupt pack is rejected; unsupported/missing target overrides keep native
appearance, and missing icons/backgrounds have bundled-icon/solid-backing
fallbacks. A failed theme generation/trial returns to native Default rather than
loading pack code. An unfinished trial on startup is rolled back. Default/picker
recovery controls are outside the theme's control; use **Default theme** to turn
off decoration, including offline. Updates install a new release but do not
silently change active visuals. Removing an active theme or explicit ownership
revocation resets appearance to Default. These are firmware safety behaviors,
not a claim that this authoring kit prevents OS/GPU/power failures.

## Licensing and redistribution

The original Ember/Orbit `LICENSE.md` files explicitly license the artwork under
**BSD-3-Clause**. This kit preserves that grant rather than relicensing to CC BY.
The manifests, generator and standalone CLI also use BSD-3-Clause, like Phoenix.
Keep the copyright notices, conditions and disclaimer, including with binary
redistributions; do not imply endorsement. The pack excludes README/LICENSE/
AUTHOR files, so distribute those notices alongside source/artifact copies.
Document your own changes and permissions in `AUTHOR.md`; publisher identity is
not a substitute for attribution. No firmware, bundled font files or private
store internals are included in this kit.
