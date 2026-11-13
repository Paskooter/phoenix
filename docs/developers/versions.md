# Software and API versions

Your computer's authoring tools, the pack format and Jibo's installed software are different parts of compatibility.

**Who this is for:** authors choosing which theme API to target and which Jibo software a pack needs.

## Theme APIs

| API | Scope | Starting point |
| --- | --- | --- |
| API1 | Menu palette, background, bundled fonts, supported icons and native or slide layout | Ember and Orbit |
| API2–4 | Additional eye-asset, face-state or menu-geometry fields, according to the API | A pack targeting the advertised API |

Ember and Orbit are API1 examples. Advanced fields need the corresponding API support from Jibo; adding them to an API1 manifest does not enable them. Use the reference that matches your pack’s API.

## Check the installed capabilities

A theme uses the `phoenix-menu-theme-v1` runtime and declares its `themeApi` and `minFirmware` fields. A robot must advertise support for that API and meet the minimum software version. A version number alone is not a capability check.

The Skill Store checks compatibility before offering a release. A newer version in the update catalog does not mean it is installed on every Jibo.

## Author on your computer

The public theme authoring kit requires Node.js 20 or newer on your computer. That requirement is not the JavaScript version available to native code on Jibo. Themes contain no executable JavaScript.

## Skill authoring

The [Skill SDK](/developers/skill-sdk) and [Hello Jibo starter](/developers/skill-example) cover the data-only `phoenix-declarative-v1` runtime today. `phoenix-skill-v1` names its reviewable source container, not a JavaScript runtime. Native local-test templates remain separate and need the matching advertised robot support. Do not upload a native bundle through either the skill or theme picker.

## Follow changes

The reference and examples are versioned with the [Phoenix source](https://github.com/Paskooter/phoenix). Use the source revision that matches the authoring tools you run, and record the API and software floor in every release.

[Theme reference](/developers/themes/reference) · [Publishing guide](/developers/publishing)
