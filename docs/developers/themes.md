# Make your first theme

Start with working source, not a blank manifest. Ember and Orbit are original API1 menu themes that you can adapt.

**Who this is for:** first-time theme authors. You need a computer with Node.js; no robot or account is needed until you test or publish.

## Before you begin

Use Node.js 20 or newer on your computer and a copy of the [Phoenix source](https://github.com/Paskooter/phoenix). Run the commands below from that checkout. PNG authoring uses Node's built-in tools. JPEG input also needs Python 3 and Pillow.

A compatible Jibo must advertise the theme runtime and API your pack uses. A minimum software version alone does not establish support.

## Start with a template

Check the example, then make your own copy:

```sh
node tools/theme-kit/cli.mjs check themes/ember
node tools/theme-kit/cli.mjs new copper --from ember --author "Your name"
```

For a sliding-card starting point, use `--from orbit`. The command creates a new folder and does not overwrite an existing project.

[Compare the templates](/developers/templates)

## Change the menus

Edit `copper/theme.json` and its listed images. API1 themes can change the menu palette, background, bundled-font choices and supported menu icons. Choose native buttons or sliding cards.

Themes are data, not executable code. They do not change actions, permissions, safety controls or menu labels. Do not include JavaScript, HTML, SVG, external URLs or images depicting Jibo.

[Read the theme reference](/developers/themes/reference)

## Check and pack

```sh
node tools/theme-kit/cli.mjs check copper
node tools/theme-kit/cli.mjs pack copper --out theme-output
```

The output is an unsigned author pack. The server repeats its checks and signs an accepted release. Never put signing keys in your project.

## Share your work

Apply for a publisher identity and create an app in the publisher dashboard. Replace the generated app ID with that registered ID before the final pack. The generated ID is only a local placeholder.

[Test on your Jibo](/developers/test) · [Continue to publishing](/developers/publishing)
