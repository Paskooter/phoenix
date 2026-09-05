import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadCorpora, expandCorpus } from '../../packages/harness/src/corpusManifest.js';
const revision = '5c0a7390539663ba749d360de348a428c088505c';
const clock = '2018-05-30T12:00:00.000Z';
const resources = new URL('./resources/', import.meta.url);
const source = JSON.parse(readFileSync(new URL('sources.json', resources), 'utf8'));
const has = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
function resource(name) {
  const bytes = readFileSync(new URL(name, resources));
  if (createHash('sha256').update(bytes).digest('hex') !== source.files[name]) throw new Error('Fixture source bytes changed: ' + name);
  return JSON.parse(bytes);
}
const baseContext = resource('context.json');
const weather = resource('weather.json');

function newsFixture() {
  const media = '<content><nitf><body><body.content><media><media-reference source="https://fixture.invalid/full.jpg" width="640" height="480"/><media-reference source="https://fixture.invalid/preview.jpg" width="320" height="240"/></media></body.content></body></nitf></content>';
  const entry = n => `<entry><summary>A fictional community science event.</summary><apcm:ContentMetadata><apcm:ExtendedHeadLine>Fixture category FIXTURE_CATEGORY headline ${n}</apcm:ExtendedHeadLine></apcm:ContentMetadata>${media}</entry>`;
  return `<feed xmlns:apcm="http://ap.org/schemas/03/2005/apcm">${[0, 1, 2].map(entry).join('')}</feed>`;
}

export function makeSuite({ selection = 'smoke', corpus, offset = 0, limit = 0 } = {}) {
  if (!['smoke', 'all', 'corpus'].includes(selection)) throw new Error('Unknown production fixture selection');
  if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 0) throw new Error('Offset and limit must be nonnegative integers');
  if (selection !== 'corpus' && (corpus || offset || limit)) throw new Error('Corpus/offset/limit options require the corpus selection');
  if (selection === 'corpus' && !corpus) throw new Error('The corpus selection requires a named corpus');
  if (source.referenceRevision !== revision) throw new Error('Fixture reference revision changed');
  const contexts = { known: structuredClone(baseContext), unknown: structuredClone(baseContext), identified: structuredClone(baseContext) };
  contexts.unknown.runtime.perception.speaker = null;
  // The historical conditional only specifies uid0001. Reuse the original mock
  // speaker's remaining fields and explicitly record this synthetic assignment.
  const speaker = contexts.identified.runtime.perception.speaker;
  contexts.identified.runtime.loop.users.find(u => u.id === speaker).id = 'uid0001';
  contexts.identified.runtime.perception.speaker = 'uid0001';
  const cases = [];
  function add(def) {
    def.clock ||= clock; def.context ||= 'known';
    def.seed = createHash('sha256').update(def.id).digest().readUInt32BE(0);
    cases.push(def);
  }
  if (selection !== 'corpus') {
    const parserCases = [
      ['launch', { text: 'tell me a joke', rules: ['launch'] }],
      ['case-trim', { text: '  TELL ME A JOKE  ', rules: ['launch'] }],
      ['unknown-rule', { text: 'tell me a joke', rules: ['audit/nonexistent'] }],
      ['known-and-unknown-rule', { text: 'tell me a joke', rules: ['audit/nonexistent', 'launch'] }],
      ['empty-rules', { text: 'tell me a joke', rules: [] }],
      ['missing-rules', { text: 'tell me a joke' }],
      ['timer-local', { text: 'five minutes', rules: ['clock/timer_set_value'] }],
      ['timer-local-cancel', { text: 'cancel', rules: ['clock/timer_set_value', 'globals/gui_nav', 'globals/mim_repeat'] }],
      ['timer-and-launch', { text: 'five minutes', rules: ['launch', 'clock/timer_set_value'] }],
      ['duplicate-rule', { text: 'five minutes', rules: ['clock/timer_set_value', 'clock/timer_set_value'] }],
      ['global-yes', { text: 'yes', rules: ['globals/yes_no'] }],
      ['empty-text', { text: '', rules: ['launch'] }],
      ['whitespace', { text: '   ', rules: ['launch'] }],
      ['no-match', { text: 'zxqvtr pzzzq', rules: ['launch'] }],
      ['loop-full-name', { text: 'who is jane jetson', rules: ['launch'] }],
      ['external-disabled', { text: 'tell me a joke', rules: ['launch'], external: {} }],
      ['rules-null', { text: 'tell me a joke', rules: null }],
      ['rules-string', { text: 'tell me a joke', rules: 'launch' }],
    ];
    for (const [id, parserData] of parserCases) add({ id: 'boundary:' + id, group: 'parser-boundary', parserData, includeLoop: true, route: true, actions: true });
    for (const [id, parserRequest] of [['body-null', null], ['missing-data', {}], ['text-number', { data: { text: 12, rules: ['launch'] } }]]) add({ id: 'boundary:' + id, group: 'parser-boundary', parserRequest, route: true, actions: true });
    const nlu = { intent: 'requestTellJiboContent', entities: { JiboContent: 'Joke' }, rules: ['launch'] };
    add({ id: 'skill:chitchat-joke', group: 'direct-skill', directSkill: { id: 'chitchat-skill', result: { nlu, asr: { text: 'tell me a joke', confidence: 1 }, memo: { mim: 'RA_JBO_TellAJoke', type: 'ScriptedResponse' } } }, actions: true });
    add({ id: 'skill:chitchat-missing-memo', group: 'direct-skill', directSkill: { id: 'chitchat-skill', result: { nlu, asr: { text: 'tell me a joke', confidence: 1 } } }, actions: true });
    const reportResult = { nlu: { intent: 'launchPersonalReport', entities: {}, rules: ['launch'] }, asr: { text: 'personal report', confidence: 1 }, memo: 'Reactive' };
    for (const context of ['known', 'unknown']) add({ id: 'skill:report-' + context, group: 'direct-skill', context, directSkill: { id: 'report-skill', result: structuredClone(reportResult) }, actions: true });
    add({ id: 'skill:report-provider-failure', group: 'direct-skill', directSkill: { id: 'report-skill', result: structuredClone(reportResult) }, actions: true, providerFailure: true });
    add({ id: 'skill:report-identification-continuation', group: 'direct-skill', context: 'unknown', directSkill: { id: 'report-skill', result: structuredClone(reportResult) }, actions: true,
      updates: [{ nlu: { intent: 'givenName', entities: { loopMemberReferent: 'test-looper-id-3', 'given-name': 'Jane', 'last-name': 'Jetson' }, rules: ['shared/wrong_id'] }, asr: { text: 'jane', confidence: 1 } }] });
  }
  const corpora = loadCorpora();
  if (corpus && !corpora.some(c => c.id === corpus)) throw new Error('Unknown corpus: ' + corpus);
  const denominators = [];
  for (const c of corpora) {
    const all = expandCorpus(c);
    denominators.push({ corpus: c.id, entries: c.tests.length, baseOccurrences: all.filter(c => c.variant === 'base').length,
      conditionalOccurrences: all.filter(c => c.variant === 'conditional').length, sha256: c.sha256 });
    if (corpus && corpus !== c.id) continue;
    let selected = all;
    if (selection === 'smoke') {
      // Explicit discovery sample, never labeled as the complete corpus.
      selected = all.filter(c => c.entryIndex < 3 && c.commandIndex < 2);
      const conditional = all.find(c => c.variant === 'conditional');
      if (conditional && !selected.some(c => c.id === conditional.id)) selected.push(conditional);
      // The original WhoMadeYou MIM has a Math.random condition in a VM. Keep
      // its two corpus occurrences in the smoke control to detect an unseeded
      // prompt-evaluation context as well as ordinary prompt selection drift.
      const vmRandomCase = all.find(c => c.command === 'what company made you');
      if (vmRandomCase && !selected.some(c => c.id === vmRandomCase.id)) selected.push(vmRandomCase);
    } else if (selection === 'corpus') selected = all.slice(offset, limit ? offset + limit : undefined);
    for (const instance of selected) {
      const condition = instance.conditional?.condition;
      if (condition && Object.keys(condition).some(k => !['date', 'loopMemberId'].includes(k))) throw new Error('Unimplemented conditional fixture: ' + instance.id);
      let context = condition?.loopMemberId ? 'identified' : 'known';
      if (condition?.loopMemberId && condition.loopMemberId !== 'uid0001') throw new Error('Unimplemented conditional loop identity');
      let at = clock;
      if (condition?.date) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(condition.date)) throw new Error('Unimplemented conditional date');
        at = condition.date + 'T12:00:00.000Z';
        const key = context + ':' + condition.date;
        if (!contexts[key]) { contexts[key] = structuredClone(contexts[context]); contexts[key].runtime.location.iso = at; }
        context = key;
      }
      add({ id: instance.id, group: 'corpus', corpus: c.id, entryIndex: instance.entryIndex, commandIndex: instance.commandIndex,
        variant: instance.variant, ...(instance.conditionIndex !== undefined ? { conditionIndex: instance.conditionIndex } : {}),
        context, clock: at, parserData: { text: instance.command, rules: ['launch'] }, includeLoop: true, route: true, actions: true });
    }
  }
  if (new Set(cases.map(c => c.id)).size !== cases.length) throw new Error('Duplicate production fixture IDs');
  return { schemaVersion: 2, id: 'production-v2', referenceRevision: revision, profile: 'original-nlu-2.8.3-serial-rpc-no-dialogflow-production-skill-builders-seeded-mim-vm',
    selection: { name: selection, corpus: corpus || null, offset, limit }, requestTimeoutMs: 10000, caseTimeoutMs: 35000, effectDrainMs: 30,
    resourceSources: source, denominators, contexts, cases,
    providers: { settings: [{ skillId: 'report-skill', data: {} }], weather, news: newsFixture(), calendar: { events: [] }, maps: { status: 'ZERO_RESULTS', geocoded_waypoints: [], routes: [] } },
    limitations: [
      'Original production ParserService/RobustParserClient and native 2.8.3 FSTs; Dialogflow is explicitly disabled. Native process clock is not faked.',
      'Native RPC uses the supported maxConcurrentRequests=1 setting and a localhost performance sink. This component profile does not verify concurrent parser load or native telemetry parity.',
      'Production IntentRouter uses each implementation\'s actual skills-local registry. Cloud actions are hosted only for original chitchat/report in this profile; unhosted targets are reported as coverage gaps.',
      'Production skill request builders execute dialog-reference injection and launch/update/proactive envelope construction. The shared driver supplies transport; full HubService orchestration is outside this component profile.',
      'Node Math.random and VM intrinsic Math.random use separate case-seeded streams. MIM conditions and prompt selection are unmodified; native parser and VM Date clocks remain host clocks.',
      'Original test-runtime context is synthetic; uid0001 is assigned to its default mock speaker. Dates use noon UTC. Historical conditional person details were not recovered.',
      'Provider replies are frozen test weather and synthetic settings/news/calendar/maps; no current-provider availability or hardware rendering is claimed.',
      'Every selected occurrence is executed separately. Scores retain corpus/conditional denominators, duplicates and absent manifest expectations.'
    ] };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const allowed = new Set(['--selection', '--corpus', '--offset', '--limit', '--out']);
  const seen = new Set();
  for (let i = 0; i < args.length; i += 2) {
    if (!allowed.has(args[i]) || !args[i + 1] || args[i + 1].startsWith('--') || seen.has(args[i])) throw new Error('Invalid production fixture arguments');
    seen.add(args[i]);
  }
  const value = (name, fallback) => { const index = args.indexOf('--' + name); return index < 0 ? fallback : args[index + 1]; };
  const suite = makeSuite({ selection: value('selection', 'smoke'), corpus: value('corpus'), offset: Number(value('offset', 0)), limit: Number(value('limit', 0)) });
  writeFileSync(value('out', '.parity/production-suite.json'), JSON.stringify(suite) + '\n');
  console.log(JSON.stringify({ selection: suite.selection, cases: suite.cases.length, denominators: suite.denominators }));
}
