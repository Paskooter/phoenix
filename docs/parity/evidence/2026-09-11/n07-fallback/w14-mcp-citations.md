# N-07 (w14) — Jibo archive MCP citations

All calls made this session against `https://pvindex.org/mcp` (server `jibo-archive`),
tools `jibo_search` / `jibo_read` / `gitea_read_file`, plus the Gitea REST API at
`https://pvindex.org/gitea/api/v1`. Repo `jiboV2/pegasus`.

## Repository identity

```
GET /gitea/api/v1/repos/jiboV2/pegasus
  default_branch: "phoenix"   full_name: "jiboV2/pegasus"
```

## Revision pins

```
GET /gitea/api/v1/repos/jiboV2/pegasus/commits?path=packages/parser/src/llm/LLMClient.ts&limit=5
  715e0dd071  Add LLM fallback NLU client (LM Studio + Gemma) replacing dead Dialogflow
  (exactly one commit returned — the file does not exist before the 2026 restoration)

GET /gitea/api/v1/repos/jiboV2/pegasus/commits?path=packages/parser/src/dialogflow/DialogflowClient.ts&limit=5
  218a4c0c77e3  Fixed issue where contexts were bleeding between dialogflow requests   2018-03-05
  45494f1213bd  final docs                                                            2018-02-23
  ... (all live-era 2017-2018)
  => the external-agent client was NOT touched by the 2026 restoration.

GET /gitea/api/v1/repos/jiboV2/pegasus/git/commits/5c0a7390539663ba749d360de348a428c088505c
  5c0a7390539663ba749d360de348a428c088505c | Merge pull request #671 from jiboV2/fix/stout/fix-linter-errors
```

## N-07-D2 — the two handler revisions (quoted)

`gitea_read_file repo=jiboV2/pegasus ref=5c0a7390539663ba749d360de348a428c088505c
 path=packages/parser/src/handlers/ParseRequestHandler.ts` — **has the external block**:

```
67:        // if external agents were provided
68:        // add external response to the result
69:        if (result && data.external) {
70:            const dialogflowResult = await dialogflowPromise;
71:            result.external = dialogflowResult.external;
72:        }
```

`gitea_read_file repo=jiboV2/pegasus ref=715e0dd0719ecca5164959d713862a1402430623
 path=packages/parser/src/handlers/ParseRequestHandler.ts` — **no external handling at all**:

```
82:        return this.selectValidResult(parserResult, llmResult, log);
```
`grep -n "external\|dialogflowPromise\|isDialogflowResultValid"` over that file returns
only the `DECOY_INTENT` import at line 9 and comments — the whole block and
`isDialogflowResultValid` are gone. `getNLUResult` returns
`this.selectValidResult(parserResult, llmResult, log)`.

`gitea_read_file repo=jiboV2/pegasus ref=715e0dd0 path=packages/parser/src/ParserService.ts`
— the restored service **still wires the Dialogflow client**:

```
54:        this.dialogflowClient = new DialogflowClient(this.config.dialogflow.config);
121:    public async getDialogflowNLUResult(request: nlu.NLURequestData): Promise<nlu.NLUResult> {
122:        return this.dialogflowClient.handleNLU(request);
123:    }
```

So 715e0dd0 kept the Dialogflow client and its accessor but dropped the only caller —
the omission is an incomplete restoration of the handler, not a deliberate redaction.
That is the justification for pinning ATTACH (5c0a739) as the default and keeping OMIT
selectable.

## Restored fallback contract (quoted)

`gitea_read_file ref=715e0dd0 path=packages/parser/src/llm/LLMClient.ts`:

```
18:const DEFAULT_TIMEOUT_MS = 8000;
118:                tool_choice: 'auto',
119:                temperature: this.config.temperature != null ? this.config.temperature : 0
181:        if (intent === 'unknown') {
199:            rules: request.rules || []
```

## Documentation

`jibo_read url=/confluence/display/SDK/How+to+use+Dialogflow+for+NLU+Rules`:

> "In Pegasus, NLU is handled by the Parser Service, which uses a hybrid of two NLU
> strategies: a rule based Robust Parser and a statistical based Dialogflow agent."

> "the user utterance \"do you like penguins\" becomes the intent *doesJiboLikeThing*,
> the entity category *GeneralLikes*, and the entity value *Penguin*."

> "Skill developers have the choice of whether to implement new intents in Robust Parser
> rule files, in the Dialogflow agent, or using some combination of the two."

This is the archived spec for the two-stage hybrid: it confirms the Dialogflow agent is a
first-class intent source (not dead weight), it names the exact
doesJiboLikeThing/GeneralLikes/Penguin example the recordings use, and it confirms both
stages feed the same intent/entity decision tree.

## Integrity check

`gitea_read_file` copies of `ParseRequestHandler.ts` (both revisions),
`ParserService.ts` (715e0dd0) and `llm/LLMClient.ts` (715e0dd0) were diffed against the
committed `source/` copies in this directory: content-identical (the committed files add
only the provenance header line and a trailing newline).
