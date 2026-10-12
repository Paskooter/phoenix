# Phoenix Orbit

Deep navy and slate, white duotone icons with a cyan accent; firmware-owned
sliding cards on supported menus. Other menus retain native geometry. Title
Proxima Nova Soft 72; labels Proxima Nova Soft 48. Background opacity 0.18.

Version 1.0.0; manifest minimum firmware 13.6.1. A theme-capable robot is also
required: the version field alone does not prove theme support. Installing does
not apply the theme; choose it in Settings → Themes or the console's Appearance
panel. Default remains available.

- `theme.json`: author manifest; local asset paths are removed when packed.
- `assets/background.png`: 1280 × 720; `assets/preview.png`: 720 × 720.
- `assets/icons/`: 38 transparent 256 × 256 icons; centered 160 × 160 drawings.
- `LICENSE.md`: explicit BSD-3-Clause artwork license and attribution notice.

From the repository root:

```sh
node tools/theme-kit/cli.mjs check themes/orbit
node tools/theme-kit/cli.mjs pack themes/orbit --out out/themes
node tools/theme-kit/cli.mjs new my-orbit --from orbit --author "Your name"
python3 themes/build-art.py --check --theme orbit
```

See [the theme sources overview](../README.md) for regeneration/dependencies and
[the author guide](../../docs/THEMES.md) for the palette, full icon role table,
limits and publisher workflow. The art contains no Jibo depiction; protected
safety rows and status images are never replaced. Hardware fit/gesture testing
is separate from local validation.
