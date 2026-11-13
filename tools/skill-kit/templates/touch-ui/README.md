Two touch screens in one owned view: Next opens a counter screen, Count updates it,
and Back returns to the welcome screen. The same hit target changes its action with the page.
Swipe down or touch Jibo's head to close. Like every skill, it runs with full access.
No network or saved data is used. When it is running on Jibo, open Home by touch
and choose LOCAL / Test — Touch demo.

Your project is already created. From the skill kit folder (the unzipped download
or a Phoenix checkout), run:

```sh
node tools/skill-kit/cli.mjs check {{project}}
node tools/skill-kit/cli.mjs pack {{project}} --out {{project}}/out
```

Use Node 20+ for the kit. NODE_6_5 is an optional trusted local Node 6.5.0 executable.
For the exact robot parser add `--syntax-node "$NODE_6_5"` to check and pack.
To try it on your Jibo, turn on Allow test builds on Jibo, run install,
and physically tap Install full-access test after reviewing the permissions.
Edit hello.js to add screens and buttons; edit entry.js to change menu placement.
See the skill guide's SDK and Cookbook pages. Kit tests use SDK doubles, not a physical screen.
