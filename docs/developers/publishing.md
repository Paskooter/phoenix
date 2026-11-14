# From your project to the Skill Store

Publishing a release and listing it publicly are separate choices. You can prepare your project before you apply.

**Who this is for:** theme authors using Publish, declarative skill authors using the separate API, and JavaScript app authors who want to know where their app fits.

**What you can publish:** themes, through the theme uploader in the publisher dashboard, and declarative `.phskill` packages, through the API-only [Skill API](/developers/skill-api). There is no declarative `.phskill` browser picker or skill ZIP packer. JavaScript apps can't be published to the Skill Store. The Store does not sign, list or install them; you try them as local test builds on your own Jibo.

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

## 4. Upload a theme in the browser

In **Publish a theme**, choose a `.phtheme` pack made with the theme kit, or a `.zip` containing one theme folder with `theme.json` and its listed images. Check the name, version, preview and **What it changes** before submitting it for review. This browser picker accepts theme packs only; it does not accept `.phskill`, declarative JSON, skill ZIPs or JavaScript app bundles.

A successful upload is a private, unsigned pending submission. The operator inspects the exact source and normalized bytes and records approval, rejection or requested changes. Only approved exact bytes can be signed and published; publication and public listing are separate decisions. A rejected upload shows what needs fixing. Do not repeatedly retry the same rejected pack; uploads count toward the account's rate limit.

### Skills and native JavaScript apps

The [Skill SDK](/developers/skill-sdk) and [Hello Jibo example](/developers/skill-example) cover authoring, checking and packing declarative, data-only `.phskill` packages. Optional JavaScript files in those source bundles are computer-only preview or inert review material, not code that runs as a native app. The [Skill API](/developers/skill-api) separately documents an authenticated, API-only `.phskill` submission endpoint; that route is not a browser picker.

For a native JavaScript app, use the single existing [JavaScript kit workflow](/developers/skills/workflow): check the project and pack it with the kit's explicit `--out` destination. JavaScript apps can't be published to the Skill Store. The Store does not sign, list or install them, and the server refuses to publish them.

Try your app as a local test build instead. See [Test on your own Jibo](/developers/test) for **Allow test builds** and the install approval you give on Jibo's screen. A local test build is not Store publication, review or hardware certification.

[How review works](/developers/review)

## 5. Choose when to list it

For supported declarative/theme publication, read the submission state under **Your apps**. Pending, rejected and changes-requested versions are not public releases. After operator publication, choose **List publicly** when you want owners to find it. A pending update leaves the prior public version available. Publishing alone does not apply a theme to a Jibo. This step is not available for JavaScript apps.

Owners choose their own Jibos. They install a theme, try it, then choose **Keep** or **Undo**. Themes do not require an on-robot approval tap. Native app installation, updates and removal require physical approval on Jibo.

## Testing and owner-only scope

Run the starter's tests and preview before upload. A compatible Jibo can install a reviewed public skill through the Skill Store; robot approval and installed status are separate steps. The local **Allow test builds** switch does not enable this declarative format. Native local tests require a separately advertised device capability and physical approval; this kit does not install them.

`owner-test` is not a publisher bypass. The existing owner-test publication path is operator-controlled and limited to supported formats and allowed owners. A private review cannot be broadened into a public release without a new public-scope review. Ask the operator about a private test when you need one; do not label a pending submission as installed or tested on hardware.

## Administrator review queue

Administrators see **Admin Review Queue** from Publish and the Review tab. First approve or reject the publisher application. Then filter submissions by state and kind, choose **Inspect**, and read the manifest, permissions, changed fields and every source file. These are inert inspection views; never execute attachments with administrator credentials.

For declarative/theme material, choose **Approve only**, **Approve & Publish**, **Request Changes** or **Reject**, enter a review reason and test summary, then record the decision. With **Approve only**, publication remains a separate **Publish approved bytes** decision. An explicit **Approve & Publish** decision signs the exact reviewed normalized artifact, but neither action makes the app publicly listed: after publication, the publisher separately chooses **List publicly**. The page rechecks exact state, material and current principal before saving, reads the target back and shows the saved outcome. Review is not hardware certification.

[Open Admin Review Queue](/apps#operator)

## Updates and removal

Use **Upload a new version** on your theme's card to return to the theme upload form. Increase the version and include release notes. Release updates do not use another app slot.

Unlisting hides the listing from browsing; it does not remove existing installations. Withdrawal and archiving are separate controls. Read their current state in the publisher dashboard before changing availability.

[Open the publisher dashboard](/developers/console)
