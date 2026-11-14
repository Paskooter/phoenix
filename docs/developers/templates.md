# A working place to start

Use the original source to learn the format, then give your project its own name, images and app identity.

**Who this is for:** new theme authors who would rather change working source than start from a blank manifest.

## Ember

**API1 · native menu buttons**

A warm menu palette with original menu artwork. Choose Ember when you want to work with Jibo's paged-button layout.

```sh
node tools/theme-kit/cli.mjs check themes/ember
node tools/theme-kit/cli.mjs new copper --from ember --author "Your name"
```

[View Ember source](https://github.com/Paskooter/phoenix/tree/main/themes/ember)

## Orbit

**API1 · sliding cards**

A cool menu palette with original menu artwork. Choose Orbit for the sliding-card layout. Layout motion is provided by Jibo's software, not by executable theme assets.

```sh
node tools/theme-kit/cli.mjs check themes/orbit
node tools/theme-kit/cli.mjs new starlight --from orbit --author "Your name"
```

[View Orbit source](https://github.com/Paskooter/phoenix/tree/main/themes/orbit)

## Make the project yours

Keep the copied license and original credits. Replace the author placeholders, edit the theme name and use a publisher-assigned app ID before submission. The kit's generated ID is not a registered Skill Store identity.

The template's source `README.md`, `AUTHOR.md` and `LICENSE.md` stay on your computer; the pack contains only the manifest and its listed assets. Keep any required credits available with your published source and listing.

[Theme walkthrough](/developers/themes) · [Publishing guide](/developers/publishing)

## Declarative skill starter

[Hello Jibo](/developers/skill-example) includes the full manifest, a computer preview and a runnable test. It needs no dependency install. [Download the starter ZIP](/developers/downloads/hello-jibo.zip), unzip it, and in its `hello-jibo` folder run:

```sh
node --test test.mjs
node index.js
```

The skill kit does not make this declarative project. It makes one kind of project: a JavaScript app that you check and pack on your computer, then install as a local test build on your own Jibo. JavaScript apps cannot be submitted to the Skill Store yet. From the root of a Phoenix source checkout:

```sh
node tools/skill-kit/cli.mjs new my-skill
node tools/skill-kit/cli.mjs check my-skill
node tools/skill-kit/cli.mjs pack my-skill --out out
node tools/skill-kit/cli.mjs check out/my-skill-1.0.0.phnative
```

[How the skill kit works](/developers/skill-sdk#the-skill-kit-builds-javascript-test-builds)

## Skill templates

Native skill templates are not published on this site yet. Jibo's current software already supports native local test builds; [Test on your Jibo](/developers/test#skills-local-test-builds) explains what they need. The Hello Jibo starter above is a declarative Skill SDK project, reviewed and installed through the Skill Store. These theme templates contain no skill code.

[Check software and API versions](/developers/versions)
