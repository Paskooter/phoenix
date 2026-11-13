# Hello Jibo: complete example

A working two-card touchscreen skill with speech, navigation and close. Download it, run its tests, then change the text and submit your own version.

[Download starter ZIP](/developers/downloads/hello-jibo.zip) · [Skill SDK walkthrough](/developers/skill-sdk) · [API reference](/developers/skill-api)

**Who this is for:** developers who want a complete, runnable first skill with no dependency install.

## Run it on your computer

Unzip the download and open the `hello-jibo` folder in a terminal. Node.js 20 or later is required. No dependency install, account or network service is needed:

```sh
node --test test.mjs
node index.js
```

The test exercises greeting, both cards and close. The preview prints events; it does not speak through a robot. `package.json` in the download only selects JavaScript modules for the computer preview.

## Pack and submit

Create your own app identity in [Publish](/apps#publisher), copy its exact app ID into `skill.json`, then use the kit from a Phoenix source checkout:

```sh
node tools/skill-kit/cli.mjs check ./hello-jibo
node tools/skill-kit/cli.mjs test ./hello-jibo
node tools/skill-kit/cli.mjs pack ./hello-jibo
```

Choose `hello-jibo.phskill` under your app's **Skill bundle** picker, or ZIP the folder and let the browser pack it. Review attachments are retained as text; only `skill.json` becomes robot data. Submission means pending review, not public installation.

The source below is read from the same files used by the kit and ZIP download. It is copyable text, never evaluated by this page.
