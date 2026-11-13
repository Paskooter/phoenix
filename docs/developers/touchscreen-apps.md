# Touchscreen apps

A declarative skill is a touchscreen app: a small graph of cards, buttons and optional speech. It needs no native JavaScript runtime or external service.

**Who this is for:** developers designing their first data-only touchscreen experience for Jibo.

## Design for a small screen

Use one clear title and a short paragraph per card. Keep at most three buttons and labels under 28 characters. Give every branch a way back or a **Close** action. Text is plain text, not HTML or Markdown. Do not draw a robot or eye as interface decoration.

## Make navigation explicit

Use a `show` action to move between page IDs. All referenced pages must exist, and `startPage` selects the first one. Speech does not navigate; a **Say hello** button leaves the current card visible. A `close` action hands control back to the manager.

[Build the Hello Jibo example](/developers/skill-example) · [Exact fields and limits](/developers/skill-api)

## Test before review

Run the computer preview and check all paths. It reports intended actions, not physical rendering, microphone behavior or robot performance. Review does not certify hardware behavior. Test the reviewed release on your own compatible Jibo through the Skill Store before recommending it broadly.

If your idea needs custom canvas/HTML, listening, storage, motion or network access, this format cannot implement it. Native local tests are a separate device capability, not an exception to third-party publication rules.
