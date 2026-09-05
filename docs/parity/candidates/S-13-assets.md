# S-13 asset compatibility audit

Status: **read-only archive audit; S-13 remains unverified**

Owner: Luna Max
Candidate: `bfd4ac5`
Reference revision: `5c0a7390539663ba749d360de348a428c088505c`
Audit date: 2026-09-05

This audit used only the local BE 11.0.1 and BE 12.0.0 release archives. It
did not start an original runtime, access a robot, use SSH, or change product
code, assets, goldens, or the comparator.

## Archive and package provenance

The report assets are archive members below
`node_modules/@be/nimbus/`. The two Nimbus asset trees are byte-identical,
including the missing path described below.

| bundle | local archive | archive bytes | archive SHA-256 | `@be/nimbus` | `@be/nimbus/package.json` SHA-256 | asset manifest |
| --- | --- | ---: | --- | --- | --- | --- |
| BE 11.0.1 | `.parity/consumers/be-release-audit/downloads/jibo-be-11.0.1.tar.gz` | 188,708,417 | `1f85e593cf7e868b969d74bed3eef78b447e72207fa4b3892de013aeb3e97d8d` | 3.0.1 | `993b0d3b7e7347d524e9c96fe1eddb90b61f88005e17f171fade32919fe9cad1` | 150 files, 6,040,277 bytes, `b541f1e3ac39aa634dd416d28a51e6a191b5de78b10abd95ce1a523979f8c272` |
| BE 12.0.0 | `.parity/consumers/downloads/jibo-be-12.0.0.tar.gz` | 192,233,932 | `e29f476c75e35e9bbd07c0211c75e2385772e4dfb3dd079a1d832e3832450657` | 3.0.4 | `a76a079ac1b5773549cef7f5e6b8e3ca5e2de5ba69c029db007d9b58bd7d9317` | 150 files, 6,040,277 bytes, `b541f1e3ac39aa634dd416d28a51e6a191b5de78b10abd95ce1a523979f8c272` |

The final BE 12 asset-manifest value above is the deterministic SHA-256 of
sorted `relative-path`, `byte-count`, and file-SHA rows. The same manifest
was computed from BE 11.0.1. The principal Nimbus artifacts are also stable
across the release pair:

| archive member | BE 11.0.1 SHA-256 | BE 12.0.0 SHA-256 |
| --- | --- | --- |
| `node_modules/@be/nimbus/index.js` | `59fcc567686966d6d99f724bd217dc1c1cebee33e03f58bd3db2ed6763ea0f93` | same |
| `node_modules/@be/nimbus/index.js.map` | `5d935addf94ffbf590cd1fa1fe28fef4af8fddbf79756fa7cf7ce54d61865b73` | same |
| `node_modules/jibo-plugins/lib/jibo-plugins.js.map` | `21aa528881645cefcc5062f78c474b6fe8b181f87ede95bd6c5f2037cd1b59b6` | same |
| `node_modules/jibo-loader/lib/jibo-loader.js.map` | `27fe5085609a25078df4f5a6a978e778d51f20c23545beb5392e1077dda870fe` | same |

The embedded source content used for loader and display inspection is also
identical in both maps. Relevant source-content hashes are:

| embedded source | SHA-256 |
| --- | --- |
| `jibo-plugins/src/PathUtils.ts` | `5b4a6f80dc28a449034c843e819bd5400efd04cee1a8d9382f85514772b8dc92` |
| `jibo-loader/src/loaders/LocalLoader.ts` | `4761f0203351702e23e1648eb473f6e5ace914c799f72951280b72a5d95a5b83` |
| `jibo-loader/src/loaders/RemoteLoader.ts` | `2d9950085f03297aac71f98d33fb0a960abaa5faa47732d07c89adda034232a3` |
| `jibo-loader/src/AssetManager.ts` | `03bc0d011efd1c319032db93dd8d1d55ac43d49e042eba27df34116c5dae9569` |
| `jibo/src/bt/behaviors/Mim.ts` | `4ba1b4a7ec5cfc527c48933d6e38a969243a5e59358fc13c04c49427d63b3122` |
| `jibo/src/rendering/gui/views/View.ts` | `6f6d5e74200530461557a90274c80307762fac717831317dc0a11d0a51d3916b` |
| `jibo/src/rendering/gui/components/Clip.ts` | `ad41a1da17081ecd621ae1b3e3a0fe998fcb5774c216dc840b2e72423c4a3840` |
| `jibo/src/rendering/tasks/CompressedImageTask.ts` | `e4c5c154ccb28ac4a0686ca46acf155f868fffe36c386005139709ca8e630554` |

## Expected asset references and archive results

The six copied templates are `weatherHiLo.json`, `newsHeadline.json`,
`commuteTraffic.json`, `commuteDepart.json`, `calendarEvent.json`, and
`calendarIconWords.json`. The first five contain the template asset slots;
the last supplies the calendar icon family. Empty template `src` values are
populated by the source-backed builders. There are 76 unique Nimbus CRN
references in the complete family inventory. Every present CRN has a same
named PNG sidecar in both archives; the source builders select CRN.

| family | exact generated path(s), below `assets/personal-report-skill/` | expected | BE 11.0.1 | BE 12.0.0 |
| --- | --- | ---: | --- | --- |
| weather backgrounds | `weather/bg/temp{Hot,Cold,Normal}_v01.crn` | 3 | CRN 3/3, PNG 3/3 | CRN 3/3, PNG 3/3 |
| weather icons | `weather/icons/{clear-day,clear-night,rain,snow,sleet,fog,wind,cloudy,partly-cloudy-day,partly-cloudy-night}_v01.crn` | 10 | CRN 10/10, PNG 10/10 | CRN 10/10, PNG 10/10 |
| news category overlay | `news/categoryGradient_v01.crn` | 1 | CRN 1/1, PNG 1/1 | CRN 1/1, PNG 1/1 |
| commute traffic | `commute/traffic{Normal,Bad,Terrible}_v01.crn` | 3 | CRN 3/3, PNG 3/3 | CRN 3/3, PNG 3/3 |
| commute departure | no Nimbus asset; labels only | 0 | 0 | 0 |
| calendar cards | `calendar/cards/event{Morning,Afternoon,Night}_v01.crn` | 3 | CRN 3/3, PNG 3/3 | CRN 3/3, PNG 3/3 |
| calendar icons | `calendar/icons/{apple,airplane,ambulance,baby,bandaid,bank,barbell,baseball,basketball,bath,battery,beach,beer,bicycle,birthdaycake,book,breakfast,calendar,camera,camping,car,cat,chalkboard,christmas,cincodemayo,city,clock,coffee,computer,dinner,discoball,dog,earth,easter,factory,farm,firstaid,football,groceries,hamburger,hanukkah,heart,house,icecream,kwanzaa,laundry,lightning,mountains,movie,pizza,rainbow,school,sun,sushi,tree,valentine}_v01.crn` | 56 | CRN 55/56, PNG 55/56 | CRN 55/56, PNG 55/56 |

The exact missing archive members in both releases are:

```text
node_modules/@be/nimbus/assets/personal-report-skill/calendar/icons/tree_v01.crn
node_modules/@be/nimbus/assets/personal-report-skill/calendar/icons/tree_v01.png
```

`calendarIconWords.json` contains the `tree` key (`tree|park|nature`), and
the source `getIconImgName` returns that key when an event summary matches.
This is a source/package compatibility defect present in both archived
Nimbus releases. The candidate preserves the source key and path; it does
not invent a replacement asset. A calendar event mentioning a park, nature,
or tree therefore needs an explicit lead decision before claiming render
coverage.

The news headline's second image is different: the source assigns the AP
provider's `item.image.source` URL directly. It is not a Nimbus package
asset and is intentionally excluded from the archive inventory. The static
category gradient is the only local news asset.

## Original relative-root and view-loader behavior

The source behavior is source-backed in the archived BE maps and packages:

- `jibo-plugins/src/PathUtils.ts:105-150` defines `getAssetUri`. An
  `asset-pack://path` request selects that package; a specific asset pack is
  resolved through its `package.json`; otherwise the supplied resource root
  is used, then the current asset-pack/root. The function returns
  `path.join(resourceRoot, fileName)`, so a source value such as
  `assets/personal-report-skill/weather/bg/tempHot_v01.crn` is deliberately
  relative.
- `jibo-loader/src/loaders/LocalLoader.ts:34-49` sends relative requests
  through `PathUtils.getAssetUri(uri, undefined, this.basePath)` and then
  makes them absolute. `AssetManager.prepare` selects this local path for a
  non-URL; `RemoteLoader` is selected for an HTTP(S) URL.
- The BE skill switcher sets `jibo.loader.basePath` to the selected skill's
  `rootPath` and makes that skill's cache active (`be/src/SkillSwitchUtil.ts:131-138`).
  The Nimbus package declares `jibo.type: "asset-pack"`, so the archived
  `@be/nimbus` package root is the intended root for these relative paths.
- Original `jibo/src/bt/behaviors/Mim.ts:584-632` loads File GUI configs via
  `PathUtils.getAssetUri`, creates a view from `config.viewConfig`, and sends
  it through `views.changeView`. `jibo/src/rendering/gui/views/View.ts`
  applies upload/cache defaults to each descriptor (`1833-1847`), and
  `jibo/src/rendering/gui/components/Clip.ts:98-141` consumes the loaded
  asset by descriptor id and creates the sprite.
- `.crn` is an actual loader format, not an arbitrary filename:
  `jibo/src/rendering/tasks/CompressedImageTask.ts:33-65` recognizes it and
  `:82-109` sends the prepared path to the compressed-texture worker. The
  real renderer must provide that worker/decompression path and the local
  Nimbus root. Merely emitting the relative `src` is insufficient for a
  renderer whose base path is the Phoenix worktree or a generic process root.

For Moth, the lead render path must map the relative local `src` values to
the installed or archived `@be/nimbus` asset-pack root, keep CRN binary
loading/decompression available, and preserve the active skill cache. A
valid AP URL follows the remote loader/network path and may additionally
need provider reachability and the runtime's image-fetch policy. It must not
be replaced with a local placeholder.

## News fallback and helper differences

Normal AP-backed news remains source-compatible: when `image.source`,
`image.width`, and `image.height` are present, `newsViews` emits the local
category gradient plus the provider URL and uses the source portrait/wide
scaling and view ids. The AP URL is a provider dependency, not an archived
Nimbus asset. A later HTTP/CORS/image-load failure is a transport failure;
`newsImagesUnavailable` does not detect or repair it.

The candidate has two bounded but material differences from the frozen
source that should remain visible to lead review:

1. The frozen `NewsParse.ts:154-157` filters out entries without an image and
   drops the AP feed header with `.slice(1, 11)`. Candidate
   `packages/skills/src/report/news.js:84-86` filters only on headline and
   uses `.slice(0, 10)`, so an image-less RSS/AP-shim item reaches the view
   helper. This is why the candidate's `newsImagesUnavailable` path is
   exercised; it is a data-layer divergence, not a Nimbus asset match.
2. The frozen `NewsMimLogic.ts:46-47` awaits `newsViews` without a catch.
   Candidate `packages/skills/src/report/news.js:127-138` catches every
   error from the helper, inserts one `{}` slot per headline, and sets
   `newsImagesUnavailable`. This keeps `views.newsImages.shift()` defined
   for the Phoenix speech path, but it is not original behavior and the
   broad catch can also mask a template or helper defect. Phoenix Slimmer's
   `graph/mims/slimmer.js:119-125` rejects `{}` because it has no
   `viewConfig`, so the placeholder is not emitted as a valid JCP view; the
   original BE `Mim.openGUI` path would dereference `config.viewConfig.id`
   (`jibo/src/bt/behaviors/Mim.ts:614`) if it received a direct empty object.

The helper-level guards are similarly bounded: candidate news view creation
returns an empty list for an empty input and explicitly rejects missing or
non-positive AP dimensions, while the source assumes a valid AP item;
candidate calendar view creation guards missing session data before applying
`leaveEmpty`, while the source directly reads the report session. These
produce the same result for source-shaped inputs and differ only on malformed
or incomplete runtime data. They should not be presented as full source
error-path parity.

The missing `tree` archive asset, external AP image transport, and the
provider fallback remain open render/integration points. No hardware or
Moth rendering result is claimed by this audit.
