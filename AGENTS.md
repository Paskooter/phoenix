# Phoenix release guardrails

Before building or publishing a robot OTA, read `docs/RUNBOOK.md` (OTA section)
and `docs/parity/BE-RELEASES.md`. In particular:

- Never use an extracted parity tree, an installed robot tree, or a prior OTA
  payload as the **base** for `@be/be`. The 2026-09-27 BE 11.0.2 OTA silently
  omitted 354 files and left robots stuck on a checkmark or black screen.
- Keep the entire BE source and its package artifacts in the separate local
  `../jibo-be` project; never add them to Phoenix or publish them to GitHub.
  Build from its complete, committed `be/` tree with `python3 tools/pack.py be
  --out out/`. Its packer checks tracked file coverage and critical runtime
  entry points. Run Phoenix's `scripts/be_ota_integrity.py` against the
  hash-pinned complete official 11.0.1 archive before publishing any BE OTA.
  The same gate applies to legacy `scripts/build-jibo-io-ota-13-0-6.py` output.
- Do not publish a BE package if that gate fails, even if SSM reports the skill
  as `running`: that flag can be true while Electron never initializes.
- When changing an already-offered OTA manifest entry, assign a new update ID.
  System Manager caches metadata by ID in memory. Align exact OS/services
  dependencies in every filter (`""`, `fcs`, `eau`) and test on hardware.
