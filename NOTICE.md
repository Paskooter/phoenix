# Notices

Phoenix's own source code is licensed under the BSD 3-Clause License in
[LICENSE](LICENSE). That license covers only material the Phoenix authors own.
The items below are not covered by it and keep their own terms.

## Third-party code

| Path | Component | License |
|---|---|---|
| `packages/account/portal/vendor/leaflet.js`, `leaflet.css` | Leaflet 1.9.4 | BSD-2-Clause, see [`LEAFLET-LICENSE`](packages/account/portal/vendor/LEAFLET-LICENSE) |
| `packages/common/src/vendor/minimist.cjs` | minimist | MIT, see [`MINIMIST-LICENSE`](packages/common/src/vendor/MINIMIST-LICENSE) |
| `packages/skills/src/vendor/unidecode-1.0.22/` | Data table derived from Unidecode 1.0.22 | GPL-2.0-or-later, see `LICENSE.txt` and `NOTICE.md` in that directory |
| `scripts/robot-client/patch-ssm-wifi-check.cjs` (bundled section) | Acorn 8.15.0 | MIT, reproduced in the file |
| `scripts/parity-robot/test-fixtures/canonical-jibo-server-client/` | Test fixture from `srv-jibo-server-client` | Apache-2.0, see `LICENSE.txt` in that directory |

Dependencies installed through npm keep their own licenses, recorded in
`package-lock.json`.

## Material from the original Jibo software

Phoenix is a compatibility reimplementation of the cloud service Jibo robots
used until 2019. To match the original behavior, some resources reproduce or
are derived from the original Jibo software and its archived reference source.
Examples are the dialog content under `packages/skills/resources/mims/`, grammar
and rule sources under `packages/nlu/resources/`, the skill manifests under
`packages/gateway/resources/skills/pegasus-skills/`, and the reference corpora
and captured outputs under `packages/harness/resources/`. They are included for
compatibility and preservation. The Phoenix authors do not license them under
the BSD 3-Clause License, and any rights in them remain with their respective
owners.

Phoenix is an independent project. It is not affiliated with or endorsed by
Jibo, Inc. or any current rights holder. "Jibo" is used only to name the robots
Phoenix works with.
