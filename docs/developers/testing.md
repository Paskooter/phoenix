# Test on your own Jibo

Try your work on a Jibo you own before you share it, and get back to the way he looked before at any time.

**Who this is for:** theme and skill authors who own a compatible Jibo linked to their account.

## Before you test

Check your project on your computer first. The local check needs no robot and no account, and it writes nothing:

```sh
node tools/theme-kit/cli.mjs check copper
```

Then confirm what your Jibo supports. A compatible Jibo advertises the theme runtime and the theme API your pack uses. A software version number alone does not prove support.

[Software and API versions](/developers/versions)

## Themes: try it from the Skill Store

Themes reach your Jibo through the Skill Store. There is no direct copy to the robot and nothing to sign on your computer.

1. Submit a version from the publisher dashboard. An operator reviews those exact bytes before they are signed and published.
2. After publication, choose **List publicly**. A theme appears in the Skill Store, for you as for every owner, once it is listed publicly, so finish the local check and the checklist below first.
3. Install it on your own Jibo from its Skill Store page, after reading the appearance consent. Installing does not apply it.
4. Choose it for that Jibo in **Settings → Themes** on Jibo, or under **Installed → Appearance** in the Skill Store. Jibo shows a short trial with **Keep** and **Undo**.
5. Check every menu, long labels and both layouts. Use the full [theme testing checklist](/developers/themes/testing).

**Waiting** in the console is not a result. Wait until Jibo reports **Applied**, **Reverted to Default**, **Failed** or **Conflict**.

## Get back to Default

**Default theme** is built into Jibo. It needs no download and works offline. Choose it in **Settings → Themes** whenever something is hard to read. Removing an active theme also returns that Jibo to Default.

## Skills: local test builds

Jibo's current software already supports native local test builds (sideloading); no later update is needed. On Jibo, turn on **Allow test builds** in **Settings → Developer testing** and confirm it. Each install then needs your physical approval on his screen: read the full-access warning, then tap **Install full-access test**. The native skill guide and its starters are not published on this site yet.

Skill SDK bundles are a different, data-only format: they are reviewed and installed through the Skill Store, and **Allow test builds** does not install them. The theme upload form is not a way to install a native skill.

[Skill SDK](/developers/skill-sdk) · [Software and API versions](/developers/versions#skill-authoring)

## When something goes wrong

Keep the exact version, the error code and the step that failed. Then [open a support ticket](/developers/support). Never share tokens, keys, account details or personal images.
