# From your project to the Skill Store

Publishing a release and listing it publicly are separate choices. You can prepare your project before you apply.

**Who this is for:** authors who are ready to share a theme or declarative app with other Jibo owners through the Skill Store.

## 1. Apply once

Open the publisher dashboard, choose a display name and tell us what you want to build. An operator reviews the publisher identity. Publisher approval permits submissions within account limits; every third-party submitted version also needs a separate exact-bundle operator review before it can be signed and published.

[Open the publisher dashboard](/developers/console)

If you are signed out, the console asks you to sign in and brings you back to Publish. Your publisher status and current limits appear there.

## 2. Create an app identity

Choose **Create an app identity**. Copy its `app-…` ID into your manifest. Each identity belongs to the publisher who created it. Never submit an example using its original app ID or assume a locally generated ID is registered.

## 3. Check the pack

Use the theme kit to validate and pack your source. Set a plain `X.Y.Z` version and accurate release notes. For updates, keep the app ID and increase the version. Submitted and published versions cannot be overwritten. A corrected pack uses a higher version and receives fresh review.

Check your asset rights, text contrast, minimum software version and required theme API. Describe what the theme changes, not capabilities it does not have.

[Theme reference](/developers/themes/reference) · [Release checklist](/developers/policies) · [Test on your Jibo](/developers/test)

## 4. Upload a skill or theme

For a skill, open its card under **Your apps**. Choose a `.phskill`, a legacy declarative `.json`, or a `.zip` of one skill folder with `skill.json`. The browser packs ZIP source locally. Its preview lists the exact name, version, requested permissions and included source files. Choose **Submit skill for review**; nothing is signed or made public yet.

Read status and feedback on that app's card. **Request changes** includes the review reason and test summary. Fix the source, increment the version (for example `1.0.0` → `1.0.1`) and submit again. Even rejected versions remain immutable. Host-only `index.js` and tests are retained as inert inspection material; they are not a JavaScript execution channel.

[Skill SDK](/developers/skill-sdk) · [Complete runnable example](/developers/skill-example) · [Skill API](/developers/skill-api)

For a theme:

In **Publish a theme**, choose a `.phtheme` file, or a `.zip` containing one theme folder with `theme.json` and its listed images. Check the name, version, preview and **What it changes** before publishing.

The server validates the pack, normalizes the images and keeps an immutable pending submission outside public releases. An operator inspects the source and normalized bytes and records approval, rejection or requested changes. Only approved exact bytes can be signed and published. A rejected upload shows what needs fixing. Do not repeatedly retry the same rejected pack; uploads count toward the account's rate limit.

[How review works](/developers/review)

If ZIP support is unavailable in your browser, pack locally and choose the `.phtheme` instead. The skill picker is not the theme picker. Native execution bundles do not use either picker.

## 5. Choose when to list it

Read the submission state under **Your apps**. Pending, rejected and changes-requested versions are not public releases. After operator publication, choose **List publicly** when you want owners to find it. A pending update leaves the prior public version available. Publishing alone does not apply a theme to a Jibo.

Owners choose their own Jibos. They install a theme, try it, then choose **Keep** or **Undo**. Themes do not require an on-robot approval tap. Native app installation, updates and removal require physical approval on Jibo.

## Testing and owner-only scope

Run the starter's tests and preview before upload. A compatible Jibo can install a reviewed public skill through the Skill Store; robot approval and installed status are separate steps. The local **Allow test builds** switch does not enable this declarative format. Native local tests require a separately advertised device capability and physical approval; this kit does not install them.

`owner-test` is not a publisher bypass. The existing owner-test publication path is operator-controlled and limited to supported formats and allowed owners. A private review cannot be broadened into a public release without a new public-scope review. Ask the operator about a private test when you need one; do not label a pending submission as installed or tested on hardware.

## Administrator review queue

Administrators see **Admin Review Queue** from Publish and the Review tab. First approve or reject the publisher application. Then filter submissions by state and kind, choose **Inspect**, and read the manifest, permissions, changed fields and every source file. These are inert inspection views; never execute attachments with administrator credentials.

Choose **Approve & Publish**, **Request Changes** or **Reject**, enter a review reason and test summary, then record the decision. The page rechecks exact state and material before saving, reads the target back and shows the saved outcome. A publication signs the normalized artifact; listing it publicly remains the publisher's separate choice. Review is not hardware certification.

[Open Admin Review Queue](/apps#operator)

## Updates and removal

Use **Upload a new version** on your theme's card to return to the theme upload form. Increase the version and include release notes. Release updates do not use another app slot.

Unlisting hides the listing from browsing; it does not remove existing installations. Withdrawal and archiving are separate controls. Read their current state in the publisher dashboard before changing availability.

[Open the publisher dashboard](/developers/console)
