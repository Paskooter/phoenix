# Paper

A palette-only start. No images, no icon overrides, native menu geometry.

Theme API 1. Use a robot that advertises this API, not just a version number.
The app ID here is an unregistered local placeholder. Scaffold a copy with:

```sh
node tools/theme-kit/cli.mjs new my-theme --from paper --author "Your name"
node tools/theme-kit/cli.mjs check my-theme
node tools/theme-kit/cli.mjs pack my-theme --out out/my-theme
```

Replace the app ID with your publisher-assigned identity before publishing.
See [the theme guide](../../../../docs/THEMES.md) for fields, limits and testing.
Original abstract art is BSD-3-Clause; keep LICENSE.md alongside redistributed packs.
