# Standalone Phoenix theme kit

Run with Node.js 20 or newer, from the Phoenix repository root:

```sh
node tools/theme-kit/cli.mjs check themes/ember
node tools/theme-kit/cli.mjs pack themes/orbit --out out/themes
node tools/theme-kit/cli.mjs new copper --from ember --author "Your name"
node tools/theme-kit/cli.mjs new notebook --from paper --author "Your name"
node --test tools/theme-kit
```

See [docs/THEMES.md](../../docs/THEMES.md) for the author manifest, every icon role,
limits, contrast, submission and Default recovery. `new` writes into the current
working directory and refuses existing destinations. The fresh local UUID and
optional default author credit are placeholders: replace the app ID with your
publisher-assigned identity and fill in your own credit before submission.

## Starters and API coverage

`new --from` accepts `ember`, `orbit`, `paper`, `signals`, `terrace`, `cut-paper`.
The additional originals live in `templates/`: palette-only Paper, complete
accepted abstract icon-map Signals, background/per-menu-font/bounded-geometry
Terrace and neutral native-mesh paint Cut Paper. Accepted icon mappings are not
universal rendered coverage: trusted native app identities keep native art; see
[the runtime exceptions](../../docs/THEMES.md#accepted-targets-and-visible-replacements).
All have unregistered local app IDs; `new`
always generates a fresh placeholder. API 1–4 fields and decoded eye-pixel rules
are checked locally. Support on a robot still requires its advertised capability.

Rebuild only the four additional starters with
`node tools/theme-kit/build-templates.mjs`. Their checked pack vectors live in
`templates/expected-sha256.json`. Ember/Orbit and their original vectors are not
changed by that command. The generator uses Node built-ins, not Python or npm.

## Standalone use

Keep `tools/theme-kit/` and `themes/` in the same relative layout. No package.json,
npm install, server modules, service configuration, credentials or signing keys
are needed. PNG check/pack use Node built-ins only. JPEG authoring additionally
requires `python3` with Pillow. The separate Ember/Orbit art generator,
`themes/build-art.py`, requires Python 3/Pillow/NumPy; the additional starter
generator `tools/theme-kit/build-templates.mjs` needs only Node. See
[themes/README.md](../../themes/README.md). Code is BSD-3-Clause, under the
repository [LICENSE](../../LICENSE); preserve that license when copying the kit.

## Files

- `cli.mjs`: check/pack/new command parsing and measurements/output.
- `new.mjs`: template-copy scaffold, fresh ID and author credit.
- `pack.mjs`: local source reading, semantic target policy and image normalization.
- `themeFormat.cjs`: strict JSON, author manifest validation, contrast and image inspection.
- `extensions.mjs`: host validation for API 2–4 fields and decoded eye pixels.
- `build-templates.mjs` / `templates/`: original abstract starter generation and runnable sources.
- `index.js`: explicit directory test entry point.
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
