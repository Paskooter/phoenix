# Theme API reference

[Theme guide](../THEMES.md) · [Surfaces](SURFACES.md) · [Testing](TESTING.md) · [Publishing](PUBLISHING.md)

The [base manifest reference](../THEMES.md#author-manifest-themejson) defines every
required identity, text, asset, palette, font and menu override field. Those fields
remain required in APIs 2–4. This page defines every additional field. Unknown
fields are errors at every level: there is no custom extension namespace.

## API selection

| `themeApi` | Required feature shape | Optional additions |
| --- | --- | --- |
| `1` | Base menus only | None of `eye`, `eyeAsset`, `face`, `menuLayout` |
| `2` | `theme.eye` | Legacy colour modulation, optionally a colour-field texture |
| `3` | `theme.eyeAsset` | Original neutral paint replacing native texture alpha |
| `4` | `theme.face`, global `theme.menuLayout`, or an override's `menuLayout` | API 3 `eyeAsset`; legacy `eye` only when there is no `face` and no `eyeAsset` |

`eye` and `eyeAsset` are mutually exclusive. `face` and `eye` are mutually
exclusive. A menu-only API 4 pack need not change the eye. Merely setting a larger
API number without its feature fields fails. `face` can exist without `eyeAsset`:
for example a face background alone, or listening paint with native idle paint.
Every theme still declares exactly `permissions: ["menu-theme"]` and
`launchNames: []`; eye/geometry fields do not grant additional permissions.

The runtime name remains `phoenix-menu-theme-v1` in every row. `schema` remains
`2`. Set `minFirmware` to a tested plain `X.Y.Z` release; eligibility also checks
the recipient's advertised API. An upload that packs on a PC is not proof of
support on any particular Jibo.

## Eye paint replacement — API 3

```json
{
  "eyeAsset": { "texture": "step-paint", "alpha": "replace" }
}
```

This is the `theme.eyeAsset` group, not a whole manifest. Reference a source asset
such as `{"id":"step-paint","role":"eye-asset","path":"assets/step-paint.png"}`.

| Field | Required | Contract |
| --- | --- | --- |
| `texture` | Yes | Existing asset ID with role `eye-asset` |
| `alpha` | Yes | Exactly `"replace"`; there is no multiply/blend option |

The asset replaces paint on the **native eye mesh and animated UVs**. Transparent
cutouts are real cutouts, not a colour filter. Native gaze, blink vertices,
rotation, opacity, semantic status tint, lighting and permitted animation remain
in charge. It is not an image overlay or permission to draw a replacement robot.
Use original abstract art. Do not recolour or trace the stock eye.

## Face additions — API 4

`theme.face` must be a nonempty object. All four groups below are optional, but
at least one must be present. They cannot appear in individual menu overrides.

```json
{
  "face": {
    "closed": { "texture": "closed-paint", "alpha": "replace" },
    "states": {
      "listening": { "texture": "listening-paint", "colorMode": "author" }
    },
    "scalePercent": 125,
    "background": { "color": "#101923" }
  }
}
```

| Field | Contract |
| --- | --- |
| `closed` | Exact object `{texture, alpha}`; `texture` references role `eye-closed`; `alpha` is `"replace"` |
| `states` | Exact object with required `listening`; no other state names are accepted |
| `states.listening` | Exact `{texture, colorMode}`; `texture` references role `eye-state`; `colorMode` is exactly `"author"` |
| `scalePercent` | Integer 50–300; requested display scale, further constrained by the native safe fit |
| `background` | Exactly one of `{color}` or `{texture}`; never both and never empty |
| `background.color` | Six-digit `#RRGGBB`; separate from the menu palette |
| `background.texture` | Asset ID with role `face-background`; static PNG up to 1280 × 720 |

Closed paint is selected only when native mesh geometry is closed; it does not
schedule a blink. Listening paint is selected only for a certified native
listening source **and** its expected semantic tint. `colorMode: "author"` is the
explicit, narrow exception that permits authored listening colours. It does not
recolour thinking, speaking, errors or any arbitrary animation with a similar RGB
value. There are no `thinking`, `speaking`, `happy`, lid, overlay or motion fields.

Scale composes with native mesh scale; it does not rewrite points, UVs, gaze or
rotation. The request is bounded to an ellipse centred at (640, 360), radii
(600, 320), and may be reduced or bypassed when native transforms cannot be
safely fitted. Face decoration is bypassed outside the certified native sources.
A face background is behind the permitted native eye view, not a screen-wide
replacement for menus, photos, chat or safety controls.

## Eye and face asset rules

These count toward the same 64 assets, 4,194,304 total pixels and 8 MiB pack as
menu assets. All eye-role images are **exactly 256 × 256** static PNG; no JPEG,
SVG, animation, font, shader or remote URL. Each eye-role image is at most
262,144 encoded bytes before and after normalization. `face-background` follows
the 1 MiB image cap instead.

| Role | Pixel contract |
| --- | --- |
| `eye-asset` | RGBA; R=G=B at every pixel, including transparent pixels; painted RGB ≥224; outer 4-pixel border alpha 0; 10–80% of pixels have alpha ≥192 |
| `eye-closed` | RGBA; painted R=G=B ≥224; outer 4-pixel border alpha 0; 1–80% of pixels have alpha ≥192 |
| `eye-state` | RGBA; author colours allowed; outer 4-pixel border alpha 0; 10–80% of pixels have alpha ≥192 |
| `face-background` | RGB/RGBA PNG, positive dimensions up to 1280 × 720; no coverage/border requirement |
| `eye` | Legacy RGB/RGBA colour field: every RGB channel ≥160, alpha exactly 255 if present |

Alpha 1–191 is allowed inside the border, but does not count toward strong
coverage. Use unique IDs for the separate face references. Every image must be
referenced with its correct role; unused assets fail. The kit verifies pixel
rules after decoding all PNG scanline filters, not merely from image headers.

## Legacy colour modulation — API 2

`theme.eye` is exactly `{color}` or `{color, texture}`. `color` is `#RRGGBB` with
relative luminance at least 0.15. Optional `texture` references role `eye` and
obeys the legacy opaque bright-field rules above. This multiplies native colour
and preserves native alpha/silhouette. **It is not asset replacement.**

This contract is documented for existing packs. For new original eye designs,
start from `cut-paper` and use `eyeAsset`; do not ship fixed recolours of the
stock eye. Special/native status surfaces can bypass legacy modulation too.

## Bounded menu geometry (API 4)

Place `menuLayout` at `theme.menuLayout` for defaults, or inside one allowlisted
menu override for a complete per-menu replacement. All eight fields are required
whenever the group is supplied. An override replaces the group, not individual
members. It still needs its required `menuKey`.

```json
{
  "scrollMode": "continuous",
  "buttonSize": 36,
  "buttonOffset": { "x": 0, "y": 0 },
  "iconSize": 44,
  "iconOffset": { "x": 0, "y": 12 },
  "labelSize": 14,
  "labelWidth": 90,
  "labelOffset": { "x": 0, "y": -28 }
}
```

| Field | Range and units |
| --- | --- |
| `scrollMode` | `"paged"` or `"continuous"`; native navigation still owns actions |
| `buttonSize` | Finite percentage 9–90 of the 720-pixel screen height |
| `buttonOffset.x`, `.y` | Finite −50 to 50 percent of screen height; positive X right, positive Y up |
| `iconSize` | Finite 0–100 percent of the clamped button size; 0 hides only the icon paint |
| `iconOffset.x`, `.y` | Finite −50 to 50 percent of button size; positive X right, positive Y up |
| `labelSize` | Finite 5–30 percent of button size; native effective font size is clamped to 24–56 pixels |
| `labelWidth` | Finite 50–100 percent of button size; constrained to its button interior |
| `labelOffset.x`, `.y` | Finite −50 to 50 percent of button size; positive X right, positive Y up |

Offsets are exactly `{x,y}`. Fractions are accepted; NaN/infinities are not JSON.
The effective square button is clamped to the native safe rectangle x=120–1160,
y=120–600, with at least 64-pixel targets and a 30-pixel inter-button gap. The
maximum effective size is 480 pixels even if a larger percentage is requested.
Icons and labels are clamped inside the button with an 8-pixel inset. Text is
measured and ellipsized, not arbitrarily shrunk. Geometry that cannot paint safely
falls back to native. In this mode labels ride with the buttons; the usual
separate menu title is suppressed by the native renderer. `fonts.titleFamily`
and `fonts.titleSize` therefore have no visible effect on an eligible geometry
menu. Labels still use `fonts.labelFamily`, but their size comes from
`menuLayout.labelSize`, not `fonts.labelSize`. The complete `fonts` group remains
required for fallback and other menu surfaces. Terrace demonstrates visible
per-menu family changes: Soft labels on Main and Light labels on Clock.

Only full-tier, ordinary horizontal menu lists are eligible. Dynamic/progress,
vertical/no-pan, guided/toggle/custom-component and unsupported lists retain
native layout. Wi-Fi scopes cannot request geometry. Global geometry does not
expand that allowlist. `layout` remains required even with geometry: it is the
base layout/fallback. Without an owner override, geometry uses its declared
`scrollMode`. An explicit per-Jibo **native** choice forces `paged`; **slide**
forces `continuous`, retaining the rest of the geometry group. Neither choice
disables a pack's `menuLayout`; choose Default to remove all decoration.

## Packed and signed metadata

Authors write `{id, role, path}` source assets only. The kit derives the canonical
packed entries `{id, role, mediaType, sha256, bytes, width, height}`. `mediaType` is
`image/png` after normalization; hashes are lowercase 64-digit SHA-256; `bytes`
is the encoded blob length; dimensions count decoded pixels. Do not insert those
fields into author source entries.

The unsigned kit descriptor reports `schema`, `kind`, `runtime`, `appId`,
`version`, `minFirmware`, `permissions`, `launchNames`, `sha256`, `bytes`,
`manifestSha256`, `manifestBytes`, `assetCount` and `themeApi`. The server adds
`releaseId` (`rel-` plus a lowercase UUID) and signs the descriptor. The signed
wrapper is `{descriptor, keyId, signature}`; `signature` is base64 RSA-SHA256,
`keyId` selects a key already trusted by Jibo. No signing keys, key URLs, release
IDs or signatures belong in `theme.json`. The artifact and manifest hashes cover
their exact bytes and must agree with every asset hash and count.

The [container layout and normalization rules](../THEMES.md#check-pack-and-regenerate)
are unchanged across APIs. Higher APIs add data fields and roles, not new archive
entries, scripts or unpacking paths.
