A voice interaction with fixed ESML speech, one local listening request and a Home tile.
Tap Listen, wait for the prompt, then say hello. Only a successful final result changes the screen.
Silence, rejection and cancellation are not treated as answers. Swipe down or touch the head to close.
Like every skill, it runs with full access. No recordings or transcripts are saved by this starter.
Speech recognition uses Jibo's configured voice service and needs its normal connection.

```sh
node tools/skill-kit/cli.mjs new my-voice --template voice
node tools/skill-kit/cli.mjs check my-voice --syntax-node "$NODE_6_5"
node tools/skill-kit/cli.mjs pack my-voice --out my-voice/out
```

Turn on Allow test builds on Jibo, run install, review permissions and physically tap
Install full-access test. When it is running, open Home by touch and choose
LOCAL / Test — Voice demo.
launchNames is a declaration only: local test builds do not register voice aliases.
ESML is fixed author text; never insert unescaped transcripts into markup.
voice-input.js owns the request, including a request returned after close; stop cancels and awaits it.
The screen waits for owned speech before listening and invalidates late replies on close.
See the skill guide's SDK page for request event timing and its Workflow page for testing.
