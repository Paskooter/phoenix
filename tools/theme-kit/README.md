# Standalone Phoenix theme kit

Run with Node.js 20 or newer, from the Phoenix repository root:

```sh
node tools/theme-kit/cli.mjs check themes/ember
node tools/theme-kit/cli.mjs pack themes/orbit --out out/themes
node tools/theme-kit/cli.mjs new copper --from ember --author "Your name"
node --test tools/theme-kit/*.test.mjs
```

See [docs/THEMES.md](../../docs/THEMES.md) for the author manifest, every icon role,
limits, contrast, submission and Default recovery. `new` writes into the current
working directory and refuses existing destinations. The fresh local UUID and
optional default author credit are placeholders: replace the app ID with your
publisher-assigned identity and fill in your own credit before submission.

## Standalone use

Keep `tools/theme-kit/` and `themes/` in the same relative layout. No package.json,
npm install, server modules, service configuration, credentials or signing keys
are needed. PNG check/pack use Node built-ins only. JPEG authoring additionally
requires `python3` with Pillow. The generator requires Python 3/Pillow/NumPy;
see [themes/README.md](../../themes/README.md). Code is BSD-3-Clause, under the
repository [LICENSE](../../LICENSE); preserve that license when copying the kit.

## Files

- `cli.mjs`: check/pack/new command parsing and measurements/output.
- `new.mjs`: template-copy scaffold, fresh ID and author credit.
- `pack.mjs`: local source reading, semantic target policy and image normalization.
- `themeFormat.cjs`: strict JSON, author manifest validation, contrast and image inspection.
- `format.cjs`: only canonical JSON and plain version comparison helpers.
- `errors.mjs`: rejection codes with author-facing limits and remedies.
- `expected-sha256.json`: measured reference pack/artifact manifest vectors.
- `*.test.mjs`: real-source check/pack/new, failure and compatibility tests.

Only the author-facing format/packing functions are included; release signing,
repository persistence, robot transport, account management, keys and store
service code are deliberately absent. `pack` does not publish or activate a theme.
Its JSON report includes hashes and file names, not a signed release envelope.
The `.manifest.json` is a derivative, not an upload substitute for `.phtheme`.

## Reference bytes

The committed vectors pin the normalized Ember/Orbit artifacts, not their source
PNG compression. Changing source metadata/art changes the hashes. Do not update
the expectations merely to make tests pass: review an intentional source/format
change and independently measure its artifact first. Compression/JPEG-decoder
version differences may change exact output bytes even when decoded pixels agree;
use the reference toolchain in the guide for byte reproduction.
