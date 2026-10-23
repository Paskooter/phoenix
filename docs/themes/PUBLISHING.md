# Publish a theme and release updates

[Theme guide](../THEMES.md) · [API fields](REFERENCE.md) · [Surfaces](SURFACES.md) · [Testing](TESTING.md)

## Before you upload

1. Scaffold a copy; do not edit Ember or Orbit in place. Replace author
   placeholders, description, release notes and the unregistered local app ID.
2. Sign in at <https://jibo.io/apps#publisher>, open **Publish**, and obtain
   publisher approval. Use **Create an app identity** for this theme. The ID must
   belong to the account that submits it. An existing app listing cannot switch
   between a theme and a declarative app.
3. Keep the assigned `appId` stable for updates. Set a new increasing plain
   `X.Y.Z` version. Published versions are immutable: even an identical upload
   cannot reuse one. Fix a mistake with a new version, not replacement bytes.
4. Choose the correct API and a tested minimum software release. Complete the
   [testing checklist](TESTING.md), including native fallbacks and Default.
5. Check licences and attribution for every image. Do not use copyrighted art
   without permission, copied native assets, bundled font files or Jibo drawings.
   Use original abstract art or properly licensed photos without personal data.

```sh
node tools/theme-kit/cli.mjs check my-theme
node tools/theme-kit/cli.mjs pack my-theme --out out/my-theme-v1
```

The `.phtheme` is unsigned author input. The accompanying `.manifest.json` is a
canonical inspection aid, **not** a substitute upload. A `.preview.png` appears
only if the manifest references a preview image. README, AUTHOR and LICENSE files
are not packed; ship attribution/licence notices alongside redistributed packs.

## Publish desk

Under **Publish a theme**, choose or drop one `.phtheme` file. The page checks it
locally and shows **Check before publishing**: identity, version, target listing,
appearance changes, image count and preview. Review the changes, then choose
**Publish version …**. The server validates every image again, normalizes bytes,
checks ownership/version/storage and creates an immutable pending submission. An
operator reviews the exact version and hashes of the source and normalized
material before signing and publication.
No author signing key, cookie export or browser-console script is needed.

The desk also accepts one ordinary ZIP containing `theme.json` beside `assets/`,
optionally inside a single enclosing folder. It accepts stored/deflate ZIPs, not
encryption or ZIP64. ZIP input is capped at 16,777,216 bytes; the resulting theme
still must fit the 8,388,608-byte pack cap and every image/pixel limit. Multiple
theme folders, missing referenced images and unsafe paths are refused. Use the
CLI pack when the browser cannot decode or pack the source ZIP. The CLI itself
does not accept ZIP input.

Publishing is distinct from visibility. Read back the returned app ID, version,
submission ID and material hashes, then refresh **Your apps**. Wait for operator
publication and check the exact listing before using **List publicly**. An upload
does not install anything on Jibo. A public listing does not apply a theme. Draft/unlisted/public visibility,
release integrity and per-Jibo approval are separate decisions.

Publisher identity approval and exact-bundle approval are separate.
Each new third-party version requires operator review.
Pending, rejected and changes-requested submissions are not signed, listed or
installable. Their versions and evidence remain immutable and count toward
storage; corrected material needs a higher version and fresh review. A review or
signature is not a rights clearance, accessibility audit or hardware test.
Before listing, review the art, honest change summary, native status meanings,
readability, licensing and recovery. Do not describe a palette-only theme as
changing the eye or promise universal animation coverage. Do not infer hardware
acceptance from a signed descriptor.

## API and budgets

For tooling that already runs in an authenticated same-origin publisher context:

```text
POST /api/skill-store/publisher/theme-releases
Content-Type: application/vnd.phoenix.menu-theme
Body: raw .phtheme bytes
```

This is not JSON, base64, multipart, a generic archive endpoint or an anonymous
upload. Send no content encoding. The same-origin session, CSRF/origin policy,
approved publisher and owned identity remain required. Do not embed credentials
in build tools or source control.

| Limit | Default maximum |
| --- | --- |
| Raw and normalized theme artifact | 8,388,608 bytes |
| Upload idle / absolute deadline | 8 / 90 seconds |
| Concurrent uploads per publisher | 2 |
| Theme upload admissions per hour | 6, including invalid submissions |
| Accepted submissions per hour | 6 |
| Publisher stored release and submission bytes | 33,554,432 bytes (32 MiB) |
| Publisher app identities/listings | 10 |
| App identity creations per day | 12 |

The server may tighten quotas. Image, pixel, manifest, role and JSON caps in the
[base guide](../THEMES.md#images-paths-and-budgets) and
[eye reference](REFERENCE.md#eye-and-face-asset-rules) apply independently; a small
compressed file can still exceed decoded-pixel limits. Installed themes share
the overall app inventory limit, with at most 8 themes and an 80 MiB theme disk
allocation including retained/candidate data. Recipient storage may be tighter.

Server normalization can change image/container hashes. The signed descriptor
and stored normalized artifact, not a guessed source-pack hash, identify the
release Jibo will install. Never edit the normalized manifest or signature.

## Refusals and interrupted uploads

The desk explains **Where**, **What’s wrong**, **Limit or fix** and a code.
Fix the named source field, check/pack again, and choose the new file. Common
refusals include a wrong app identity, reused/non-increasing version, listing-kind
mismatch, unsupported API, low contrast, wrong image role/format, eye coverage,
unsafe paths, upload rate, storage and size limits.

A connection failure is not proof that nothing was submitted. Refresh **Your
apps** and look for the exact app ID/version before retrying; versions cannot be
reused. Sign in again when asked, without pasting session details into reports.
Do not hide a refusal by changing API numbers, renaming `.phtheme` to `.json`,
dropping signature checks or bypassing native consent.

## Updating, unlisting and removal

- A new release retains `appId`, increases `version`, and sets release notes and
  compatibility for its actual features. Old release bytes remain immutable.
- Installing an update does not silently change active visuals. The owner chooses
  the new release for each Jibo. Verify the reported result, not just **Waiting**.
- Unlisting removes public discovery; it is not a remote uninstall or an active
  theme change. Do not use visibility as a substitute for a robot removal request.
- Removing an active theme or revoking its owner authorization restores Default.
  Default and picker controls are not replaceable theme assets.

For help, open a support ticket in **#help on the Phoenix Discord**:
<https://discord.gg/FyDVYQ6FfV>. Include a neutral error code, theme version and
failed stage. Keep account data, cookies, keys and private images out of reports.
