// External-agent (Dialogflow) contract for the Pegasus NLU parser.
//
// Pinned source, read through the Jibo archive MCP this session:
//   jiboV2/pegasus@5c0a7390539663ba749d360de348a428c088505c
//     packages/parser/src/dialogflow/DialogflowClient.ts
//     packages/parser/src/handlers/ParseRequestHandler.ts
//     packages/parser/src/ParserService.ts
//
// Dialogflow (API.ai) is dead, so the only outcome this candidate can observe
// from the default provider is the original disabled-client boundary: a truthy
// `data.external` request dereferences the null Dialogflow result at
// ParseRequestHandler.ts:70-71 and throws the Node 8 TypeError. That boundary
// is kept exactly, but it is now PROVIDER-DRIVEN so the archived external
// result structure ({ [agent]: AgentResult }) can be preserved and replayed
// through a replaceable provider instead of one hard-coded outcome.
//
// N-07-D2 — the two source revisions disagree about this block and the union is
// made explicit here rather than implicit:
//
//   * 5c0a739 (live era, last revision that implements the external contract),
//     ParseRequestHandler.ts:67-72:
//         if (result && data.external) {
//             const dialogflowResult = await dialogflowPromise;
//             result.external = dialogflowResult.external;
//         }
//     A truthy `data.external` attaches the {[agent]: AgentResult} map; with the
//     disabled Dialogflow client the null result dereferences and throws.
//
//   * 715e0dd0 (2026 restoration "replacing dead Dialogflow" with the LLM
//     fallback), same method: the whole `if (result && data.external)` block is
//     GONE. Its ParserService.ts:54,121-123 still constructs a DialogflowClient
//     and still exposes getDialogflowNLUResult, but the restored handler never
//     calls it — so a truthy `external` request returns a plain result with no
//     `external` key and no error.
//
// Ratified pin: ATTACH (5c0a739) is the default. The external-agent request and
// response shapes are a client-visible live-era contract; 715e0dd0's omission
// is an incomplete restoration of a handler that dropped the block, not a
// deliberate redaction (its own service still wires the client). Real robot
// clients that send `external` would silently lose the map under OMIT, so the
// union keeps the last live handler's contract while adopting 715e0dd0's
// fallback (N-07-D3). OMIT stays selectable so root can flip the pin without a
// code change if the omission is ever ratified instead.

// The two ratified readings of ParseRequestHandler.getNLUResult's external block.
export const EXTERNAL_ATTACHMENT_REVISION = Object.freeze({
  ATTACH: 'attach', // 5c0a739: attach result.external; disabled client -> Node 8 TypeError
  OMIT: 'omit',     // 715e0dd0: restored handler has no external block at all
});
export const DEFAULT_EXTERNAL_ATTACHMENT_REVISION = EXTERNAL_ATTACHMENT_REVISION.ATTACH;

export function resolveExternalAttachmentRevision(value) {
  if (value == null) return DEFAULT_EXTERNAL_ATTACHMENT_REVISION;
  if (value === EXTERNAL_ATTACHMENT_REVISION.ATTACH || value === EXTERNAL_ATTACHMENT_REVISION.OMIT) return value;
  throw new Error(`Unsupported external-agent attachment revision: ${value}`);
}

// AgentResult shape (DialogflowClient.ts:100-104, 69-74):
//   { rules: <agent.rules>, intent: <intentName>, entities: <parameters> }
// and, on a per-agent failure:
//   { rules: <agent.rules>, intent: '', entities: {}, error: <message> }

// DialogflowClient.ts:13
export const DECOY_INTENT = 'decoyIntent';

// DialogflowClient.ts:28 / states.ts — the client starts DISABLED and only
// becomes READY after init() (DialogflowClient.ts:32-34), which the service
// runs only when config.dialogflow.enabled (ParserService.ts:132-135).
export const EXTERNAL_STATE = Object.freeze({
  NOT_READY: 'NOT_READY',
  READY: 'READY',
  DISABLED: 'DISABLED',
});

// The Node 8 wire message the source produced when a truthy external request
// reached the disabled Dialogflow result (ParseRequestHandler.ts:70-71 on the
// Node 8.9.4 reference runtime pinned by V-01).
export const DISABLED_EXTERNAL_ERROR = "Cannot read property 'external' of null";

function resolveAgent(text, name, agent, agents) {
  const resolver = agents[name];
  if (!resolver) {
    // DialogflowClient.ts:106-108 — a failed agent access rejects, which the
    // handler's .catch turns into a null dialogflowResult.
    throw new Error(`Error accessing Dialogflow agent '${name}': no archived agent available`);
  }
  const out = typeof resolver === 'function' ? resolver(text, agent) : resolver;
  if (!out || typeof out !== 'object' || !out.intent) {
    throw new Error(`Error accessing Dialogflow agent '${name}': no intent`);
  }
  // DialogflowClient.ts:100-104
  return { rules: agent.rules, intent: out.intent, entities: out.entities };
}

function otherResults(request, agents) {
  // DialogflowClient.ts:59-78
  if (!request.external) return null;
  const agentResults = {};
  for (const name of Object.keys(request.external)) {
    const agent = request.external[name];
    try {
      agentResults[name] = resolveAgent(request.text, name, agent, agents);
    } catch (error) {
      // DialogflowClient.ts:68-75 — the archived error record.
      agentResults[name] = { rules: agent.rules, intent: '', entities: {}, error: error.message };
    }
  }
  return agentResults;
}

/**
 * Replaceable external-agent provider implementing DialogflowClient.handleNLU.
 *
 * config.agents maps an agent name to a recorded output ({ intent, entities })
 * or a resolver function. The source returns a Promise; this seam is
 * synchronous because ParseRequestHandler already awaits the settled
 * dialogflowPromise before dereferencing it (ParseRequestHandler.ts:70-71), so
 * the synchronous result is the observable contract. A missing provider entry
 * throws exactly like a failed agent access.
 *
 * @param {{enabled?:boolean, accessToken?:string, agents?:object}} [config]
 */
export function createExternalAgentProvider(config = {}) {
  const state = config.enabled ? EXTERNAL_STATE.READY : EXTERNAL_STATE.DISABLED;
  const agents = config.agents || {};
  return {
    state,
    get enabled() { return state === EXTERNAL_STATE.READY; },
    // DialogflowClient.ts:39-57
    handleNLU(request) {
      if (state !== EXTERNAL_STATE.READY) return null;
      const result = { ...resolveAgent(request.text, 'default', { accessToken: config.accessToken, rules: request.rules }, agents) };
      if (request.external) result.external = otherResults(request, agents);
      return result;
    },
  };
}

// The default provider: Dialogflow disabled, exactly as the dead service is
// configured in this candidate.
export function createDisabledExternalAgentProvider() {
  return createExternalAgentProvider({ enabled: false });
}

/**
 * ParseRequestHandler.ts@5c0a739:69-72, provider-driven:
 *
 *   if (result && data.external) {
 *       const dialogflowResult = await dialogflowPromise;  // .catch -> null
 *       result.external = dialogflowResult.external;        // TypeError on null
 *   }
 *
 * getDialogflowNLUResult's .catch(() => null) (ParseRequestHandler.ts:59-63) is
 * reproduced by swallowing a provider throw. When the provider yields a result
 * the archived `external` map is preserved on the response.
 *
 * `revision` selects the ratified reading of that block (N-07-D2):
 *   - ATTACH (default, 5c0a739): as above.
 *   - OMIT (715e0dd0): the restored handler has no external block, so the
 *     request's `external` key is ignored and the selected result is returned
 *     unchanged — no attachment, no boundary error.
 *
 * @param {object} request
 * @param {object} result
 * @param {{handleNLU:Function}} provider
 * @param {'attach'|'omit'} [revision]
 */
export function attachExternalResult(request, result, provider, revision = DEFAULT_EXTERNAL_ATTACHMENT_REVISION) {
  const mode = resolveExternalAttachmentRevision(revision);
  // ParseRequestHandler.ts@715e0dd0:50-83 — no `if (result && data.external)` block
  // exists at that revision, so the external request is inert.
  if (mode === EXTERNAL_ATTACHMENT_REVISION.OMIT) return result;
  if (!request.external) return result;
  let dialogflowResult = null;
  try { dialogflowResult = provider.handleNLU(request); } catch { dialogflowResult = null; }
  if (!dialogflowResult) throw new Error(DISABLED_EXTERNAL_ERROR);
  result.external = dialogflowResult.external;
  return result;
}
