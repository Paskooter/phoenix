# Phoenix menu theme sources

Ember (`native` layout) and Orbit (`slide` layout) are original Phoenix examples:
each includes a manifest, a background, a preview and 38 icons. They contain no
robot firmware, downloaded code, fonts or third-party artwork.

See [the author guide](../docs/THEMES.md) for the format, limits and submission
workflow. From the repository root:

```sh
node tools/theme-kit/cli.mjs check themes/ember
node tools/theme-kit/cli.mjs check themes/orbit
node tools/theme-kit/cli.mjs pack themes/ember --out out/themes
node tools/theme-kit/cli.mjs new copper --from ember --author "Your name"
```

## Art generator

The CLI needs Node.js 20 or newer and no npm packages for PNG packs. The optional
art generator needs Python 3, Pillow and NumPy; JPEG input also needs Pillow.
Use your Python environment/package manager to install those dependencies. The
reference art was generated with Pillow 12.3.0 and NumPy 2.2.6. A recent Pillow
with `ImageDraw.rounded_rectangle(..., corners=...)` is required for Orbit.

```sh
python3 themes/build-art.py --check
python3 themes/build-art.py --theme ember
python3 themes/build-art.py --check --sheets out/theme-review
```

The first command re-renders and compares decoded pixels without rewriting art.
The second rewrites the Ember example's images; omit `--theme` to regenerate both.
The last also writes icon contact sheets and background/preview copies for review.
For a derivative, work on a copy of the generator and adapt its output directory,
palettes and shapes. Do not accidentally overwrite the original examples.

The images use only programmatically drawn shapes. Previews are abstract menu
illustrations, not screenshots or hardware certification. Keep icon drawings in
the centered 160 × 160 box on transparent 256 × 256 canvases. Do not draw Jibo's
robot, shell, head, face or eye in theme art.

## License

The source packs already carry a BSD-3-Clause artwork license. That explicit
license is preserved for this public release rather than replaced with a new
license. Artwork, manifests and generator code are BSD-3-Clause; see each pack's
`LICENSE.md` and the repository's [LICENSE](../LICENSE). Preserve the copyright
notice, conditions and disclaimer in redistributions; do not imply endorsement.
