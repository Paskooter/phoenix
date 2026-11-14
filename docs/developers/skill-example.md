# Hello Jibo: complete example

A working two-card touchscreen skill with speech, navigation and close. Download it, run its tests, then change the text and make your own version.

[Download starter ZIP](/developers/downloads/hello-jibo.zip) · [Skill SDK walkthrough](/developers/skill-sdk) · [API reference](/developers/skill-api)

**Who this is for:** developers who want a complete, runnable first skill with no dependency install.

## Run it on your computer

Unzip the download and open the `hello-jibo` folder in a terminal. Node.js 20 or later is required. No dependency install, account or network service is needed:

```sh
node --test test.mjs
node index.js
```

The test exercises greeting, both cards and close. The preview prints events; it does not speak through a robot. `package.json` in the download only selects JavaScript modules for the computer preview.

## Submit the declarative package

This example's `skill.json` describes the declarative runtime. It is not a project for the skill kit (`tools/skill-kit/cli.mjs`), which builds only single JavaScript apps for local test builds; see [the skill kit](/developers/skill-sdk#the-skill-kit-builds-javascript-test-builds) and the [native skill workflow](/developers/skills/workflow). Declarative `.phskill` submission is API-only through the authenticated [Skill API](/developers/skill-api); the browser uploader accepts theme packs only and has no skill picker.

Review attachments are retained as text; only `skill.json` becomes robot data. A successful API submission creates an unsigned pending review, not a signature, publication or public listing.

The source below matches the Hello Jibo starter ZIP. It is copyable text, separate from the skill kit's starters, and never evaluated by this page.
