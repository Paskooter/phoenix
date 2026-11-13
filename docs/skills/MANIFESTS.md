# Skill manifests and package formats

[Developer guide](../SKILLS.md) · [Host API](CONTEXT.md) · [SDK](SDK.md) · [Workflow](WORKFLOW.md)

There are three different documents in a skill project. Do not interchange them:

1. `skill.json` tells the computer-side kit what to build.
2. `app.json` is shipped inside the archive. The kit reads its author settings.
3. The `.phnative` **test container** that `pack` and `install` build carries
   unsigned test metadata. A local build cannot supply its own approval, Store
   identity or signing key.

Unknown fields are rejected where a format defines an exact set. All examples use
synthetic identities. Let `new` allocate fresh placeholders and `install` obtain
Jibo's local project identity; do not reuse these examples as published identities.

## `skill.json`: author project

| Field | Type / requirement / limit | Example |
| --- | --- | --- |
| `schema` | Required integer, exactly `1` | `1` |
| `kind` | Required string, always `native` | `"native"` |
| `name` | Required nonblank string, at most 60 characters; no U+0000–U+001F or `<` / `>`. Also avoid DEL (U+007F), which local transfer rejects. For `new` and output filenames use a 1–40-character lowercase slug starting with a letter | `"my-counter"` |
| `files` | Required: 2–64 unique relative file paths in this kit project, including `app.json` and the entry. The container format itself permits 4,096 files | `["app.json","entry.js","screen.js"]` |

The kit reads `skill.json` as strict JSON, at most 65,536 bytes, depth 12 and
64 members per object/array. This makes 64 the effective project-file-list
ceiling even though test container metadata supports 4,096.

Only the listed `files` are packed. No dependency discovery, recursive folder inclusion,
`npm install` or build scripts run on Jibo. Include every JavaScript dependency,
JSON configuration and asset your app needs. README and local state stay outside
the package unless you explicitly list them.

A path is at most 200 UTF-8 bytes. Each nonempty component uses letters, digits,
`_`, `@`, `.`, `+` or `-`; `/` separates components. Absolute paths, `.` / `..`
components, spaces, links, hardlinks, devices and FIFOs are forbidden. USTAR
names also have to fit the 100-byte filename and 155-byte prefix fields.

## `app.json`: author settings

These are **all** the fields accepted by the project builder. Required means
required by the resulting test metadata, even when the check happens after packing.

| Field | Type / requirement / limit | Example |
| --- | --- | --- |
| `appId` | Required string: `app-` plus lowercase UUID, 8-4-4-4-12 hex groups. `install` substitutes its allocated local identity in the built bytes without editing source | `"app-10000000-0000-4000-8000-000000000001"` |
| `name` | Required scoped namespace matching `@[a-z0-9-]+/[a-z0-9-]+` | `"@example/counter"` |
| `version` | Required plain `X.Y.Z`; each part a nonnegative safe integer with no leading zeros; no prerelease or build suffix | `"1.0.0"` |
| `minFirmware` | Required version in the same grammar; minimum Jibo software, not an install capability declaration | `"13.7.1"` |
| `hostAbi` | Required integer, exactly `1` | `1` |
| `entry` | Required listed relative `.js` file exporting `create(context)` | `"entry.js"` |
| `permissions` | Required array of 0–32 unique strings; each matches `[a-z][a-z0-9-]{0,63}` | `["display","speech"]` |
| `optionalPermissions` | Required array, same grammar/count; must not overlap required permissions | `[]` |
| `launchNames` | Required array of 0–16 unique 1–64-character lowercase letters/digits/spaces/hyphens, first character a letter or digit. Also trim ends and avoid double spaces | `["my counter"]` |
| `skills` | Optional array of declared global skill names, strings or objects with string `name` | `["@example/counter"]` |
| `plugins` | Optional array with the same shape, for global plugin claims | `[]` |
| `menuEntries` | Optional array with the same shape, for menu claims | `["My counter"]` |
| `incomingPorts` | Optional array of collision claims, compared by canonical JSON equality. Use port numbers consistently across cooperating packages; no separate item schema is imposed by this kit | `[8897]` |
| `iconApi` | Optional only with `icon` and `iconImage`; exactly `1`, selects local schema 2 | `1` |
| `icon` | With `iconApi`: null, supported builtin, or image reference; see [v2 icon rules](#v2-icon-rules) | `{"type":"image","asset":"app-icon"}` |
| `iconImage` | With `iconApi`: exact PNG metadata for an image; otherwise null | `null` |

`skills`, `plugins`, `menuEntries` and `incomingPorts` are declarations, **not**
registration calls or grants. The author manifest does not impose a separate
item-count limit on them beyond the strict JSON bounds and package limits. A
runtime-computed name or undeclared socket cannot be inferred from JavaScript.
Use unique namespaces even when the local app ID is different.

`launchNames` does not install a hotword or ASR grammar. **Local protocol 1 does
not register voice aliases.** Use the [local-test opening path](WORKFLOW.md#opening-a-local-test)
for a local voice test.

The plain version minimum is checked separately from support. A project with
`minFirmware: "13.7.1"` still needs Jibo software that advertises the local
test protocol, as 13.8.0 does. Always inspect `info.localKinds` and `managerReady`.

### Permissions and what the owner sees

Permission labels describe behavior. **They do not sandbox your code.**
A skill can reach whatever BE's account and process can reach, including
files, accounts, network and system services, even if it omits a label. Declare
all behavior truthfully and check optional grants before offering optional
features. All required labels must be granted; grants must be unique and belong
to required or optional labels. A grant does not automatically start a feature. Local protocol 1 grants only
required permissions; optional labels remain ungranted. There is no kit flag or
local review toggle to grant them. Keep optional features off in that path.

The format accepts labels in the grammar above, not a closed capability
enum. The following is the complete built-in wording map:

| Label | Meaning to the developer | Exact owner explanation |
| --- | --- | --- |
| `display` | Draw screens/views | Show things on Jibo’s screen |
| `speech` | Embodied speech / TTS | Speak out loud |
| `audio` | Play sound | Play sound through Jibo’s speaker |
| `network` | Outgoing connections or services | Connect to the internet |
| `attention` | Listening/attention behavior | Listen for your requests and turn toward you |
| `listen`, `microphone` | Microphone listening | Listen through Jibo’s microphones |
| `local-control` | Home-network device control | Control devices on your home network |
| `camera`, `photo`, `photos` | Camera/photo behavior | Take photos with Jibo’s camera |
| `motion`, `move` | Body/head movement | Move Jibo’s head and body |
| `notifications` | Notifications | Show notifications |
| Any other valid label | Custom declared behavior; explain it in your skill's own description | Use “label” |

Local review prefixes each item with `Required`, `Optional, allowed`, or
`Optional, not allowed`. Newly granted update permissions add `· new`.
Jibo shows at most four permission items per page. `What it can do` leads through
`Continue` to **Full access to Jibo’s software**, then the physical
**Install full-access test** button. See [the complete approval flow](WORKFLOW.md).

## `.phnative`: the test container

The byte layout is `PHXNAT1\n`, a four-byte big-endian metadata length,
canonical UTF-8 JSON metadata, then a single gzip-compressed USTAR archive.
Metadata is 1–49,152 bytes. It has **exactly**:

| Field | Contract / example |
| --- | --- |
| `schema` | Integer `1` (legacy) or `2` (declared icon fields) |
| `kind` | `"native"` |
| `appId`, `version`, `minFirmware`, `hostAbi`, `entry` | Same value types as `app.json` above |
| `permissions`, `optionalPermissions`, `launchNames` | Same arrays as `app.json` above |
| `fileManifest` | Sorted file records, described below |

Schema 2 adds exactly `iconApi`, `icon`, and `iconImage` with the v2 icon rules
below, including an explicit null fallback or builtin. The robot projects it as
`phoenix-native-v2`; schema 1 still projects as `phoenix-native-v1`. The canonical
`app.json` must carry the same three values. Image hashes, dimensions, file mode,
PNG CRCs, bounded decode, filter bytes and exact zlib consumption are checked.

There is no `name`, `releaseId`, signature, publisher or approval bit in this
outer metadata. Names and resource claims remain inside `app.json`. Artwork
does not replace the LOCAL / Test label or robot-issued app identity.

Before allocation or upload, `install` requires `info.nativeContainerSchemas`
to include `2` for schema-2 projects, including saved-project retries; Jibo
13.8.0 advertises `[1, 2]`. Older
firmware without that capability receives `unsupported_native_icons` with an
update instruction; the kit never silently strips artwork. Schema-1 projects
remain usable on older native-capable firmware. Low-level `ssh.mjs check` and
`queue` also refuse schema 2 before upload. Do not infer this capability from
an app's `minFirmware`.
The kit emits regular files only, at most 32 MiB compressed and 128 MiB total
file contents; there are no directory/link entries. The robot separately parses
every `.js` with its legacy runtime and refuses binary `.node` / `.so` modules
and nonempty `package.json` scripts.

Each `fileManifest` item has exactly:

| Field | Type / limit | Example |
| --- | --- | --- |
| `path` | Relative path, <=200 UTF-8 bytes; follow the stricter kit path rules above | `"entry.js"` |
| `length` | Integer 0–33,554,432 bytes | `123` |
| `sha256` | 64 lowercase hex characters | Generated from that file |
| `mode` | Decimal `420` (0644) or `493` (0755) | `420` |

Paths sort strictly ascending; duplicates fail. The entry must be present. The
archive is gzip-compressed USTAR with verified header checksums, file contents,
mode, lengths and padding. Extraction has a separate 136 MiB expansion ceiling;
installation reserves an additional 8 MiB of storage. Do not budget right up to
the format ceilings on a resource-limited robot.

### v2 icon rules

The test container's metadata and the canonical shipped `app.json` must
contain identical `iconApi`, `icon` and `iconImage` values. `app.json` is a regular 0644 file of
1–65,536 bytes. The project builder accepts the three v2 fields together and
emits local container schema 2; omitting all three retains legacy schema 1.
This local format does not grant Store trust or approval.

| `icon` | `iconImage` |
| --- | --- |
| `null` | Must be `null`; host uses its fallback |
| `{"type":"builtin","catalog":"jibo-menu-v1","name":"…"}` | Must be `null`; name must be in the supported menu catalog |
| `{"type":"image","asset":"app-icon"}` | Required image metadata below |

The `jibo-menu-v1` builtin names are: `calendar`, `circuit-saver`, `clock`, `commute`, `create`, `dance`, `exercise`, `full-report`, `fun-stuff`, `introduction`, `joke`, `news`, `personal-report`, `photobooth`, `radio`, `settings`, `surprise`, `things-to-do`, `tips`, `weather`, `word-of-the-day`, `wifi`, `volume`, `battery`, `themes`, `mode`, `help`, `updates`, `storage`, `padlock`, `app-store-grid`.

An image metadata object has exactly `mediaType: "image/png"`, integer `width`
32–330, integer `height` 32–300, integer `bytes` 57–262,144, and a lowercase
64-hex `sha256`. Pixel count must be <=99,000. Put that exact PNG at
`assets/app-icon.png`, listed once in the manifest with matching length/hash and
mode 0644. That reserved path is forbidden when not using an image icon.

Only static 8-bit RGB or RGBA, noninterlaced PNG is accepted. The checked chunk
sequence is IHDR, nonempty contiguous IDAT chunks, then terminal IEND, with at
most 128 chunks total; ancillary
chunks, palette PNG, APNG, JPEG and SVG are not accepted. Chunk CRCs, exact zlib
consumption and decoded size are checked. Export a clean PNG rather than merely
renaming an image. Use an abstract skill glyph or real licensed photo, never a
drawing of Jibo. This is the Home menu icon on Jibo, not Skill Store listing
artwork.
