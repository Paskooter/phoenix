// N-07 runtime demonstration: fallback arbitration + external-agent behavior.
//
// Drives the REAL nlu service (HTTP /v1/parse) and the REAL LLM fallback client
// against a local OpenAI-compatible mock provider and the recorded provider
// outputs in test/fixtures/fallback-provider-recordings.json.
//
// Usage: node packages/nlu/tools/replayFallbackHttp.mjs [--out <path>]
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import http from 'node:http';
import { start } from '../src/index.js';
import { parseRequest } from '../src/requestParser.js';
import { createLLMClient } from '../src/llmFallback.js';
import { resolveHybridNLU, EMPTY_NLU, isFallbackResultValid } from '../src/fallbackArbitration.js';
import { createExternalAgentProvider, createDisabledExternalAgentProvider, EXTERNAL_ATTACHMENT_REVISION } from '../src/externalAgents.js';
import { defaultParserProfile, compiledFstRuntimeConfig } from '../src/compiledFstRuntime.js';

const fixtureBytes = readFileSync(new URL('../test/fixtures/fallback-provider-recordings.json', import.meta.url));
const fixture = JSON.parse(fixtureBytes.toString('utf8'));
const fixtureSha256 = createHash('sha256').update(fixtureBytes).digest('hex');
const archivedBytes = readFileSync(new URL('../test/fixtures/dialogflow-archived-agent.json', import.meta.url));
const archived = JSON.parse(archivedBytes.toString('utf8'));
const archivedSha256 = createHash('sha256').update(archivedBytes).digest('hex');

// --- recorded provider: a real HTTP /chat/completions server ---------------
function startProvider() {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      const parsed = JSON.parse(body);
      seen.push(parsed);
      const utterance = (parsed.messages.find(m => m.role === 'user') || {}).content || '';
      const match = Object.values(fixture.fallbackResponses).find(r => utterance.includes(r.utterance));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(match ? match.response : { choices: [] }));
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({
    server, seen, url: `http://127.0.0.1:${server.address().port}/v1`,
  })));
}

const PARSER_HIGH = { nlu: { intent: 'timerValue', entities: { minutes: '5' }, rules: ['clock/timer_set_value'] }, priority: 'HIGH' };
const PARSER_LOW = { nlu: { intent: 'requestTellJiboContent', entities: { JiboContent: 'Joke' }, rules: ['launch'] }, priority: 'LOW' };
const PARSER_SKIP = { nlu: { intent: 'right', entities: { domain: 'gui_command' }, rules: ['globals/gui_nav'] }, priority: 'SKIP' };

const provider = await startProvider();
const client = createLLMClient({ enabled: true, url: provider.url, model: 'google/gemma-4-e4b' });
client.init();

async function fallbackFor(utterance, rules = []) {
  return client.handleNLU({ text: utterance, rules });
}

const rows = [];
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.keys(value).sort().reduce((acc, k) => { acc[k] = canonical(value[k]); return acc; }, {});
  }
  return value;
}
function record(id, group, expected, got, extra = {}) {
  rows.push({ id, group, expected, got, match: JSON.stringify(canonical(expected)) === JSON.stringify(canonical(got)), ...extra });
}

async function arbitrationCases() {
  const entityProvider = await fallbackFor('do you like penguins', ['launch']);
  const noTool = await fallbackFor('hmm');
  const unknown = await fallbackFor('flurble gax wibble');

  // 1. HIGH short-circuits (fallback callback must not run).
  let highFallbackCalls = 0;
  const high = await resolveHybridNLU(PARSER_HIGH, () => { highFallbackCalls += 1; return entityProvider; });
  record('n07:arb-01', 'arbitration', { intent: 'timerValue', fallbackCalls: 0 }, { intent: high.intent, fallbackCalls: highFallbackCalls });

  // 2. LOW + valid fallback -> fallback wins.
  const lowFallback = await resolveHybridNLU(PARSER_LOW, () => entityProvider);
  record('n07:arb-02', 'arbitration', { intent: 'doYouLike', entities: { thing: 'Penguins' }, rules: ['launch'] }, lowFallback);

  // 3. LOW + absent fallback -> parser survives.
  const lowNoFallback = await resolveHybridNLU(PARSER_LOW, () => null);
  record('n07:arb-03', 'arbitration', PARSER_LOW.nlu, lowNoFallback);

  // 4. LOW + decoy fallback -> parser survives.
  const lowDecoy = await resolveHybridNLU(PARSER_LOW, () => fixture.fallbackResults.decoy);
  record('n07:arb-04', 'arbitration', PARSER_LOW.nlu, lowDecoy);

  // 5. LOW + invalid (no tool -> null) fallback -> parser survives.
  const lowNoTool = await resolveHybridNLU(PARSER_LOW, () => noTool);
  record('n07:arb-05', 'arbitration', PARSER_LOW.nlu, lowNoTool);

  // 6. miss + valid fallback -> fallback.
  const missFallback = await resolveHybridNLU(null, () => entityProvider);
  record('n07:arb-06', 'arbitration', entityProvider, missFallback);

  // 7. miss + unknown tool -> EMPTY.
  const missUnknown = await resolveHybridNLU(null, () => unknown);
  record('n07:arb-07', 'arbitration', EMPTY_NLU, missUnknown);

  // 8. SKIP + valid fallback -> fallback.
  const skipFallback = await resolveHybridNLU(PARSER_SKIP, () => entityProvider);
  record('n07:arb-08', 'arbitration', entityProvider, skipFallback);

  // 9. miss + unavailable provider -> EMPTY.
  const down = createLLMClient({ enabled: true, url: 'http://127.0.0.1:1/v1', model: 'm' });
  down.init();
  const missDown = await resolveHybridNLU(null, () => down.handleNLU({ text: 'do you like penguins' }));
  record('n07:arb-09', 'arbitration', EMPTY_NLU, missDown);
}

async function externalCases() {
  // HTTP: default disabled provider -> the original boundary.
  const server = await start(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const post = async data => {
      const res = await fetch(`${base}/v1/parse`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'NLU', data }) });
      return { status: res.status, json: await res.json() };
    };

    const boundary = await post({ text: 'five minutes', rules: ['clock/timer_set_value'], external: {} });
    record('n07:ext-01', 'external', { status: 500, message: "Cannot read property 'external' of null" },
      { status: boundary.status, message: boundary.json?.data?.message }, { http: true });

    const blank = await post({ text: ' ', rules: ['launch'], external: {} });
    record('n07:ext-02', 'external', { status: 200, data: { rules: [], intent: null, entities: null } },
      { status: blank.status, data: blank.json?.data }, { http: true });

    const normal = await post({ text: 'five minutes', rules: ['clock/timer_set_value'] });
    record('n07:ext-03', 'external', { status: 200, intent: 'timerValue' }, { status: normal.status, intent: normal.json?.data?.intent }, { http: true });
  } finally {
    await new Promise(r => server.close(r));
  }

  // In-process: replaceable provider preserves the archived external structure.
  const extProvider = createExternalAgentProvider({
    enabled: true,
    accessToken: 'recorded-token-0',
    agents: {
      default: () => fixture.external.defaultAgentRecording,
      agent_one: () => fixture.external.agentRecordings.agent_one,
      agent_two: () => fixture.external.agentRecordings.agent_two,
    },
  });
  const replaced = parseRequest(
    { text: 'five minutes', rules: ['clock/timer_set_value'], external: fixture.external.request.external },
    { externalProvider: extProvider },
  );
  record('n07:ext-04', 'external', { intent: 'timerValue', external: fixture.external.expectedExternal },
    { intent: replaced.intent, external: replaced.external });

  // The default disabled provider still reproduces the boundary in-process.
  let inProcError = null;
  try { parseRequest({ text: 'five minutes', rules: ['clock/timer_set_value'], external: {} }, { externalProvider: createDisabledExternalAgentProvider() }); }
  catch (error) { inProcError = error.message; }
  record('n07:ext-05', 'external', "Cannot read property 'external' of null", inProcError);

  // N-07-D2: the ratified 715e0dd0 reading omits the external block entirely.
  const omitted = parseRequest(
    { text: 'five minutes', rules: ['clock/timer_set_value'], external: {} },
    { externalAttachmentRevision: EXTERNAL_ATTACHMENT_REVISION.OMIT },
  );
  record('n07:ext-06', 'external', { intent: 'timerValue', hasExternal: false },
    { intent: omitted.intent, hasExternal: 'external' in omitted });
}

async function catalogCases() {
  // N-07 gap 2/3: the whole archived 99-intent / 89-entity Dialogflow catalog,
  // exercised through the preserved external envelope in ONE provider call.
  const agents = { default: () => ({ intent: 'doesJiboLikeThing', entities: { GeneralLikes: 'Penguin' } }) };
  for (const intent of archived.intents) agents[intent.name] = () => ({ intent: intent.name, entities: intent.derivedResponse.entities });
  const provider = createExternalAgentProvider({ enabled: true, accessToken: 'archived-token', agents });
  const external = {};
  for (const intent of archived.intents) external[intent.name] = { accessToken: `t-${intent.name}`, rules: [intent.name] };
  const envelope = provider.handleNLU({ text: 'do you like penguins', rules: ['launch'], external });
  const preserved = Object.entries(envelope.external)
    .every(([name, r]) => r.intent === name && r.rules[0] === name
      && JSON.stringify(r.entities) === JSON.stringify(archived.intents.find(i => i.name === name).derivedResponse.entities));
  record('n07:cat-01', 'catalog', { agents: 99, allPreserved: true },
    { agents: Object.keys(envelope.external).length, allPreserved: preserved });

  // The archived decoyIntent is the one name the fallback arbitration rejects.
  const rows = archived.intents.map(i => ({ intent: i.name, entities: i.derivedResponse.entities, rules: ['launch'] }));
  const valid = rows.filter(isFallbackResultValid).length;
  record('n07:cat-02', 'catalog', { valid: 98, rejected: 1 }, { valid, rejected: rows.length - valid });

  // Archived entity coverage: 34 custom definitions + 8 system entities.
  record('n07:cat-03', 'catalog', { entities: 89, custom: 34, system: 8 },
    { entities: archived.entities.length, custom: archived.annotatedCustomEntities.length, system: archived.annotatedSystemEntities.length });
}

try {
  await arbitrationCases();
  await externalCases();
  await catalogCases();
} finally {
  await new Promise(r => provider.server.close(r));
}

const mismatches = rows.filter(r => !r.match).map(r => r.id);
const profile = defaultParserProfile();
const runtime = compiledFstRuntimeConfig();
const out = {
  schema: 'phoenix.nlu.n07-fallback-http-replay',
  profile,
  profileRuleCount: runtime ? runtime.ruleCount : 0,
  profileLoadedRuleCount: runtime ? runtime.loadedRuleCount : 0,
  fixtureSha256,
  archivedAgentSha256: archivedSha256,
  providerRequests: provider.seen.length,
  cases: rows.length,
  matches: rows.length - mismatches.length,
  mismatches,
  rows,
};

const outIndex = process.argv.indexOf('--out');
if (outIndex !== -1 && process.argv[outIndex + 1]) {
  const target = process.argv[outIndex + 1];
  if (existsSync(target) && !process.env.N07_ALLOW_OVERWRITE) throw new Error(`refusing to overwrite existing ${target}`);
  writeFileSync(target, `${JSON.stringify(out, null, 1)}\n`);
}

console.log(`profile          : ${profile}`);
console.log(`fixture          : ${fixtureSha256}`);
console.log(`archived agent   : ${archivedSha256}`);
console.log(`provider requests: ${out.providerRequests}`);
console.log(`cases            : ${out.cases}`);
console.log(`matches          : ${out.matches}`);
console.log(`mismatches       : ${mismatches.length ? mismatches.join(', ') : 'none'}`);
for (const r of rows.filter(x => !x.match)) {
  console.log(`  ${r.id}\n    expected ${JSON.stringify(r.expected)}\n    got      ${JSON.stringify(r.got)}`);
}
process.exitCode = mismatches.length ? 1 : 0;
