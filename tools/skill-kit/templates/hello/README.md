Hello world: a Home menu tile, speech, a tap target and clean shutdown.

Like every skill, it runs inside Jibo's own software with full access. It writes
no saved data and opens no network listener. Edit entry.js and hello.js; list
every shipped file in skill.json. Use Node 6-compatible CommonJS.

Your project is already created. From the skill kit folder (the unzipped download
or a Phoenix checkout), run:

```sh
node tools/skill-kit/cli.mjs check {{project}}
node tools/skill-kit/cli.mjs pack {{project}} --out {{project}}/out
```

For the exact robot parser add `--syntax-node "$NODE_6_5"` to check and pack.
To try it on your Jibo, turn on Allow test builds on Jibo, then run install.
On Jibo, read every permission page and physically tap Install full-access test.
When it is running, open Home by touch and choose LOCAL / Test — Hello world.
Tap to greet; swipe down or touch his head to leave.
The skill guide's Workflow and App context pages explain installing and the lifecycle.
