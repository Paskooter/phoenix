Two touch screens in one owned view: Next opens a counter screen, Count updates it,
and Back returns to the welcome screen. The same hit target changes its action with the page.
Swipe down or touch Jibo's head to close. Like every skill, it runs with full access.
No network or saved data is used. When it is running on Jibo, open Home by touch
and choose LOCAL / Test — Touch demo.

```sh
node tools/skill-kit/cli.mjs new my-touch --template touch-ui
node tools/skill-kit/cli.mjs check my-touch --syntax-node "$NODE_6_5"
node tools/skill-kit/cli.mjs pack my-touch --out my-touch/out
```

Use Node 20+ for the kit. NODE_6_5 is an optional trusted local Node 6.5.0 executable.
To try it on your Jibo, turn on Allow test builds on Jibo, run install,
and physically tap Install full-access test after reviewing the permissions.
Edit hello.js to add screens and buttons; edit entry.js to change menu placement.
See the skill guide's SDK and Cookbook pages. Kit tests use SDK doubles, not a physical screen.
