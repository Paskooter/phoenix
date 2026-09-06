// Source-backed audit observations, using only temporary local service instances.
// These probes expose known gaps; they do not certify the unexecuted Pegasus runtime.
// Usage: node scripts/parity-probes.mjs [--out /path/to/probes.json]
import { writeFileSync } from 'node:fs';
import { once } from 'node:events';

// Keep the audit independent of configured live providers and registries.
process.env.ETCO_parser_llmUrl = '';
process.env.ETCO_answer_llmUrl = '';
process.env.ETCO_hub_skillsConfig = 'skills-local.json';
const [{ start: startNlu }, { createGateway }, { createHistoryService, HistoryStore },
  { createDataService }, { IntentRouter }, { validate, schemas }, { start: startSkills }, { LassoClient }] = await Promise.all([
  import('../packages/nlu/src/index.js'),
  import('../packages/gateway/src/index.js'),
  import('../packages/history/src/index.js'),
  import('../packages/data/src/index.js'),
  import('../packages/gateway/src/intentRouter.js'),
  import('../packages/contracts/src/index.js'),
  import('../packages/skills/src/index.js'),
  import('../packages/skills/src/report/lassoClient.js'),
]);

const observations = [];
const servers = [];
let gateway;
const record = (id, expected, actual, reference) => observations.push({ id, expected, actual, reference });
async function request(server, path, body, method = body === undefined ? 'GET' : 'POST') {
  const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
  const text = await response.text();
  let parsed; try { parsed = JSON.parse(text); } catch { parsed = text; }
  // IDs and timestamps are irrelevant to these observations.
  if (parsed && typeof parsed === 'object') { delete parsed.msgID; delete parsed.ts; }
  return { status: response.status, body: parsed };
}

try {
  const nlu = await startNlu(0); servers.push(nlu);
  const parse = (text, rules) => request(nlu, '/v1/parse', { type: 'NLU', data: { text, rules } });
  record('P01-empty-nlu', { intent: null, entities: null, rules: [] },
    (await parse('   ', ['launch'])).body.data,
    'pegasus/packages/parser/src/handlers/ParseRequestHandler.ts: EMPTY_NLU');
  record('P02-requested-rules', 'An unknown rule cannot activate the launch grammar when fallback is disabled.',
    { unknownRule: await parse('tell me a joke', ['audit/nonexistent']), launchRule: await parse('tell me a joke', ['launch']) },
    'pegasus/packages/parser/src/robustparser/RobustParserClient.ts: handleNLU filters request.rules');

  gateway = await createGateway({ skills: [{ id: 'audit-skill', URL: '', onRobot: true, intents: [], settings: { view: { type: 'group', index: 0 }, audit: true } }],
    disableAuth: true, parserURL: 'http://127.0.0.1:1', historyURL: 'http://127.0.0.1:1', recordLaunchHistory: false });
  const hub = await gateway.service.listen(0); servers.push(hub);
  const lists = {};
  for (const path of ['/skills/audit-robot', '/v1/skills/audit-robot', '/skills/settings/audit-robot', '/v1/skills/settings/audit-robot']) {
    lists[path] = await request(hub, path);
  }
  record('P03-skill-list-routes', 'All four routes return 200 and the matching full skill configurations.', lists,
    'pegasus/packages/hub/src/HubService.ts + skill-list/SkillListGetHttpRequestsHandler.ts');

  const history = await createHistoryService().listen(0); servers.push(history);
  record('P04-history-empty', { status: 200, body: null },
    await request(history, '/v1/skill/launch/latest', { robotID: 'audit-robot' }),
    'pegasus/packages/history/src/skilllaunch/db/SkillLaunchCollection.ts: documentToJSON(null); utils BaseHttpHandler json(result)');
  record('P05-history-get', { status: 200, body: { count: 0 } },
    await request(history, '/v1/skill/launch/count?robotID=audit-robot'),
    'pegasus/packages/history/src/skilllaunch/SkillLaunchRequestsHandler.ts: GET /count');
  record('P06-history-write-validation', 'Missing robotID, sessionID and skillID must be rejected.',
    await request(history, '/v1/skill/launch', {}),
    'pegasus/packages/history/src/skilllaunch/validators/event.ts');
  record('P07-history-write-shape', 'Return the full saved SkillLaunchRecord, including robotID, sessionID and skillID.',
    await request(history, '/v1/skill/launch', { robotID: 'audit-robot', sessionID: 'audit-session', skillID: 'audit-skill' }),
    'pegasus/packages/history/src/skilllaunch/SkillLaunchRequestsHandler.ts: saveSkillLaunch + SkillLaunchCollection.documentToJSON');

  const data = await createDataService({ googleCalendarProvider: async () => [], outlookCalendarProvider: async () => [] }).listen(0);
  servers.push(data);
  record('P08-calendar-envelope', 'Calendar data must be inside relayData, with cache metadata, even for an empty event list.',
    await request(data, '/v1/google_calendar?skillId=report-skill&accountId=audit-account&calendar=workCalendar'),
    'pegasus/packages/lasso/src/relay/GoogleCalendarHandler.ts extends AbstractRelayRequestHandler');
  record('P09-calendar-head', 'HEAD shares the calendar relay prefetch contract.',
    await request(data, '/v1/google_calendar?skillId=report-skill&accountId=audit-account&calendar=workCalendar', undefined, 'HEAD'),
    'pegasus/packages/lasso/src/relay/AbstractRelayRequestHandler.ts: router.head and router.get');

  const router = new IntentRouter([{ id: '@be/audit', intents: [] }]);
  record('P10-intentless-launch', 'No launch decision (undefined in the reference implementation).',
    router.getSkillIDFromNLU({ intent: null, rules: ['launch'], entities: { skill: '@be/audit' } }),
    'pegasus/packages/hub/src/intent/IntentRouter.ts: routing requires a nonempty intent and a registered decision');
  record('P11-reference-nlu-schema', 'Reference empty NLU must be accepted by the contract validator.',
    validate(schemas.nluResponse, { type: 'NLU', data: { intent: null, entities: null, rules: [] } }),
    'pegasus/packages/parser/src/handlers/ParseRequestHandler.ts: EMPTY_NLU');

  const store = new HistoryStore();
  store.addSkillLaunch({ robotID: 'audit-robot', skillID: 'audit-skill', sessionID: 'recent' });
  store.addSkillLaunch({ robotID: 'audit-robot', skillID: 'audit-skill', sessionID: 'expired', timestamp: Date.now() - 15 * 86400000 });
  record('P12-retention-order', 'Once retention has run, expired records must not survive just because they were inserted after a recent record.',
    { countAfterPrune: store.getCount({ robotID: 'audit-robot' }), sessions: store.skillLaunches.map(r => r.sessionID) },
    'pegasus/packages/history/src/skilllaunch/schema/SkillLaunchSchema.ts: timestamp TTL index (eventual cleanup)');

  const skills = await startSkills(0); servers.push(skills);
  const defaultSkillResponse = await request(skills, '/v1/main', { type: 'LISTEN_LAUNCH', data: {
    general: {}, runtime: {}, skill: { id: 'report-skill' }, result: { nlu: { intent: 'launchPersonalReport', entities: {} } },
  } });
  record('P13-default-skill-route', 'The reference report-skill process handles report requests at /v1/main.',
    { status: defaultSkillResponse.status, responseType: defaultSkillResponse.body.type, skill: defaultSkillResponse.body.data?.skill?.id },
    'pegasus/packages/baseskill/src/SkillService.ts; Phoenix compose starts the same skills index for every skill process');

  delete process.env.NET_data;
  process.env.NET_lasso = '127.0.0.1:1';
  let discoveryResult;
  try { await LassoClient.fetchDarkSky({ runtime: { location: { lat: 0, lng: 0 } } }); discoveryResult = 'unexpected success'; }
  catch (error) { discoveryResult = error.message; }
  record('P14-lasso-discovery', 'The report client recognizes NET_lasso; it must not require a Phoenix-only NET_data variable.',
    discoveryResult, 'pegasus/packages/report-skill/src/EnvVars.ts: NET_lasso');
} finally {
  gateway?.wss.close();
  for (const server of servers.reverse()) {
    server.closeAllConnections?.();
    const closed = once(server, 'close');
    server.close();
    await closed;
  }
}

const report = { capturedAt: new Date().toISOString(), node: process.version,
  evidenceKind: 'Phoenix observations compared with inspected reference source; reference services were not executed', observations };
const outIndex = process.argv.indexOf('--out');
if (outIndex >= 0) {
  if (!process.argv[outIndex + 1]) throw new Error('--out requires a path');
  writeFileSync(process.argv[outIndex + 1], JSON.stringify(report, null, 2) + '\n');
} else console.log(JSON.stringify(report, null, 2));
console.error(`Recorded ${observations.length} audit probes. This command records observations; it is not a passing parity gate.`);
