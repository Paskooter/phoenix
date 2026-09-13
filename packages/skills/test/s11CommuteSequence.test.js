import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DateTime } from '../src/report/dateTime.js';
import {
  commuteParse,
  CommuteMimLogic,
  getData,
} from '../src/report/commute.js';
import { trafficView, departView } from '../src/report/commuteViews.js';
import { generateSlimSequence } from '../src/graph/mims/slimmer.js';
import { loadMimFile } from '../src/graph/mims/promptData.js';

// Source basis: jiboV2/pegasus@5c0a7390539663ba749d360de348a428c088505c,
// packages/report-skill/src/subskills/commute/{CommuteViews,CommuteParse,
// CommuteMimLogic}.ts, packages/report-skill/resources/views/{commuteTraffic,
// commuteDepart}.json, packages/report-skill/mims/en-us/Commute*.mim, and
// packages/report-skill/tests/subskills/Commute.test.js.

const MIM_DIR = fileURLToPath(new URL('../resources/mims/report/en-us/', import.meta.url));
const VIEW_DIR = fileURLToPath(new URL('../resources/views/', import.meta.url));
const ISO = '2026-06-12T08:00:00-04:00';

const COMMUTE_MIMS = {
  CommuteAppSetup: { count: 2, ids: ['CommuteAppSetup_AN_01', 'CommuteAppSetup_AN_02'], gui: null },
  CommuteConfirmSpeaker: { count: 3, ids: ['CommuteConfirmSpeaker_AN_01', 'CommuteConfirmSpeaker_AN_02', 'CommuteConfirmSpeaker_AN_03'], gui: null },
  CommuteDepartTimeNormal: { count: 24, ids: Array.from({ length: 24 }, (_, i) => `CommuteDepartTimeNormal_AN_${String(i + 1).padStart(2, '0')}`), gui: { type: 'Javascript', data: 'views.commuteDepart', pause: true } },
  CommuteDepartTimeNotNormal: { count: 20, ids: Array.from({ length: 20 }, (_, i) => `CommuteDepartTimeNotNormal_AN_${String(i + 1).padStart(2, '0')}`), gui: { type: 'Javascript', data: 'views.commuteDepart', pause: true } },
  CommuteDriveHurry: { count: 21, ids: Array.from({ length: 21 }, (_, i) => `CommuteDriveHurry_AN_${String(i + 1).padStart(2, '0')}`), gui: null },
  CommuteDriveLate: { count: 18, ids: Array.from({ length: 18 }, (_, i) => `CommuteDriveLate_AN_${String(i + 1).padStart(2, '0')}`), gui: null },
  CommuteDriveNormal: { count: 11, ids: Array.from({ length: 11 }, (_, i) => `CommuteDriveNormal_AN_${String(i + 1).padStart(2, '0')}`), gui: { type: 'Javascript', data: 'views.commuteTraffic', pause: true } },
  CommuteDrivePoor: { count: 11, ids: Array.from({ length: 11 }, (_, i) => `CommuteDrivePoor_AN_${String(i + 1).padStart(2, '0')}`), gui: { type: 'Javascript', data: 'views.commuteTraffic', pause: true } },
  CommuteDriveTerrible: { count: 11, ids: Array.from({ length: 11 }, (_, i) => `CommuteDriveTerrible_AN_${String(i + 1).padStart(2, '0')}`), gui: { type: 'Javascript', data: 'views.commuteTraffic', pause: true } },
  CommuteMinutesLeft: { count: 13, ids: Array.from({ length: 13 }, (_, i) => `CommuteMinutesLeft_AN_${String(i + 1).padStart(2, '0')}`), gui: null },
  CommuteNow: { count: 10, ids: ['CommuteNow_AN_01', 'CommuteNow_AN_08', 'CommuteNow_AN_02', 'CommuteNow_AN_03', 'CommuteNow_AN_04', 'CommuteNow_AN_05', 'CommuteNow_AN_06', 'CommuteNow_AN_07', 'CommuteNow_AN_09', 'CommuteNow_AN_10'], gui: null },
  CommuteServiceDown: { count: 5, ids: Array.from({ length: 5 }, (_, i) => `CommuteServiceDown_AN_${String(i + 1).padStart(2, '0')}`), gui: null },
  CommuteTransportHurry: { count: 8, ids: Array.from({ length: 8 }, (_, i) => `CommuteTransportHurry_AN_${String(i + 1).padStart(2, '0')}`), gui: null },
  CommuteTransportLate: { count: 7, ids: Array.from({ length: 7 }, (_, i) => `CommuteTransportLate_AN_${String(i + 1).padStart(2, '0')}`), gui: null },
  CommuteTransportNormal: { count: 16, ids: Array.from({ length: 16 }, (_, i) => `CommuteTransportNormal_AN_${String(i + 1).padStart(2, '0')}`), gui: { type: 'Javascript', data: 'views.commuteTraffic', pause: true } },
};

const SOURCE_MIM_NAMES = [
  'CommuteAppSetup', 'CommuteConfirmSpeaker', 'CommuteDepartTimeNormal',
  'CommuteDepartTimeNotNormal', 'CommuteDriveHurry', 'CommuteDriveLate',
  'CommuteDriveNormal', 'CommuteDrivePoor', 'CommuteDriveTerrible',
  'CommuteMinutesLeft', 'CommuteNow', 'CommuteServiceDown',
  'CommuteTransportHurry', 'CommuteTransportLate', 'CommuteTransportNormal',
];

const log = {
  createChild: () => ({ debug() {}, info() {}, warn() {}, error() {} }),
  debug() {}, info() {}, warn() {}, error() {},
};

const prefs = (mode = 'driving', complete = true) => ({
  commute: {
    complete,
    mode,
    workTime: { hour: 9, min: 0 },
    origin: { lat: 42, lng: 24 },
    destination: { lat: 24, lng: 42 },
  },
});

const promptCommute = ({
  mode = 'driving',
  minsLeft = 35,
  extraMins = 0,
  eventIsEarly = false,
  durationMins = 25,
  departDT = new DateTime('2026-06-12T08:30:00-04:00'),
} = {}) => ({
  minsLeft,
  extraMins,
  modeIsDriving: mode === 'driving',
  eventIsEarly,
  durationMins,
  departDT,
  arriveDT: new DateTime('2026-06-12T09:00:00-04:00'),
});

function logicData({
  mode = 'driving',
  complete = true,
  commute,
  singleSkill = null,
  ...commuteOptions
} = {}) {
  return {
    local: {
      userPrefs: prefs(mode, complete),
      commute: commute === undefined ? promptCommute({ mode, ...commuteOptions }) : commute,
      views: {},
    },
    runtime: { location: { iso: ISO } },
    skill: { session: { data: { _personalReport: { singleSkill } } } },
    log,
  };
}

async function runLogic(options = {}) {
  const data = logicData(options);
  const result = await new CommuteMimLogic('Commute Mim Logic').exit(data);
  assert.equal(result.transition, 'Done');
  return data;
}

function mimIds(data) {
  return data.local.mimPaths.map((path) => basename(path, '.mim'));
}

test('S-11 inventories all source commute MIMs and their GUI bindings', () => {
  assert.deepEqual(Object.keys(COMMUTE_MIMS), SOURCE_MIM_NAMES);
  for (const [name, expected] of Object.entries(COMMUTE_MIMS)) {
    const mim = loadMimFile(join(MIM_DIR, `${name}.mim`));
    assert.equal(mim.mim_type, 'announcement', `${name}: MIM type`);
    assert.equal(mim.prompts.length, expected.count, `${name}: prompt count`);
    assert.deepEqual(mim.prompts.map((prompt) => prompt.prompt_id), expected.ids, `${name}: prompt IDs`);
    assert.deepEqual(mim.gui, expected.gui, `${name}: GUI binding`);
  }
});

test('S-11 source view templates retain static IDs, positions, and selection behavior', () => {
  const traffic = JSON.parse(readFileSync(join(VIEW_DIR, 'commuteTraffic.json'), 'utf8'));
  assert.deepEqual(traffic.viewConfig, { type: 'View', id: 'trafficView', category: 'gui' });
  assert.deepEqual(traffic.open, { transitionOpen: 'trans_in', removeAll: true });
  assert.equal(traffic.defaultSelect, 'remain');
  assert.deepEqual(traffic.componentConfigs[0], {
    id: 'trafficClip',
    type: 'Clip',
    assets: [{ id: 'trafficPng', src: '', type: 'texture' }],
    position: { x: 377, y: 97 },
  });

  const depart = JSON.parse(readFileSync(join(VIEW_DIR, 'commuteDepart.json'), 'utf8'));
  assert.deepEqual(depart.viewConfig, { type: 'View', id: 'departTimeView', category: 'gui' });
  assert.deepEqual(depart.open, { transitionOpen: 'trans_in' });
  assert.deepEqual(depart.defaultSelect, { transitionClose: 'trans_out', removeAll: true });
  assert.deepEqual(depart.componentConfigs.map((component) => component.id), [
    'departLabel', 'departTimeLabel', 'departAmPmLabel',
  ]);
  assert.deepEqual(depart.componentConfigs.map((component) => component.position), [
    { x: 640, y: 225 }, { x: 715, y: 458 }, { x: 720, y: 446 },
  ]);
});

test('S-11 archived view rows preserve traffic bands and departure labels', async () => {
  const expected = new Map([
    [0, 'trafficNormal_v01.crn'],
    [4, 'trafficNormal_v01.crn'],
    [5, 'trafficBad_v01.crn'],
    [14, 'trafficBad_v01.crn'],
    [15, 'trafficTerrible_v01.crn'],
  ]);
  for (const [extraMins, asset] of expected) {
    const view = await trafficView(extraMins);
    assert.equal(view.viewConfig.id, 'trafficView');
    assert.equal(view.componentConfigs[0].id, 'trafficClip');
    assert.equal(view.componentConfigs[0].assets[0].src,
      `assets/personal-report-skill/commute/${asset}`);
  }

  const view = await departView({ departDT: new DateTime('2026-06-12T08:30:00-04:00') });
  assert.equal(view.viewConfig.id, 'departTimeView');
  assert.deepEqual(view.componentConfigs.slice(1).map((component) => component.text), ['8:30', 'AM']);
});

test('S-11 CommuteMimLogic preserves full and single report sequence order', async () => {
  const fullNormal = await runLogic({ mode: 'driving', minsLeft: 35, extraMins: 0 });
  assert.deepEqual(mimIds(fullNormal), ['CommuteDriveNormal', 'CommuteDepartTimeNormal']);
  assert.equal(fullNormal.local.views.commuteTraffic.componentConfigs[0].assets[0].src,
    'assets/personal-report-skill/commute/trafficNormal_v01.crn');
  assert.equal(fullNormal.local.views.commuteDepart.componentConfigs[1].text, '8:30');

  const fullPoor = await runLogic({ mode: 'driving', minsLeft: 25, extraMins: 5 });
  assert.deepEqual(mimIds(fullPoor), [
    'CommuteDrivePoor', 'CommuteDepartTimeNotNormal', 'CommuteMinutesLeft',
  ]);

  const fullTerrible = await runLogic({ mode: 'driving', minsLeft: 45, extraMins: 15 });
  assert.deepEqual(mimIds(fullTerrible), ['CommuteDriveTerrible', 'CommuteDepartTimeNotNormal']);

  const single = await runLogic({ mode: 'driving', minsLeft: 25, extraMins: 5, singleSkill: 'commute' });
  assert.deepEqual(mimIds(single), [
    'CommuteConfirmSpeaker', 'CommuteDrivePoor', 'CommuteDepartTimeNotNormal', 'CommuteMinutesLeft',
  ]);
});

test('S-11 CommuteMimLogic prefixes all four modes and still builds both positive-time views', async () => {
  for (const mode of ['driving', 'walking', 'transit', 'bicycling']) {
    const data = await runLogic({ mode, minsLeft: 35, extraMins: mode === 'driving' ? 0 : 15 });
    assert.deepEqual(mimIds(data), mode === 'driving'
      ? ['CommuteDriveNormal', 'CommuteDepartTimeNormal']
      : ['CommuteTransportNormal', 'CommuteDepartTimeNormal'], mode);
    assert.ok(data.local.views.commuteTraffic, `${mode}: traffic view`);
    assert.ok(data.local.views.commuteDepart, `${mode}: departure view`);
  }
});

test('S-11 CommuteMimLogic preserves exact now, late, hurry, and MinutesLeft boundaries', async () => {
  const cases = [
    { minsLeft: 121, expected: ['CommuteNow'] },
    { minsLeft: 120, expected: ['CommuteDriveNormal', 'CommuteDepartTimeNormal'] },
    { minsLeft: 30, expected: ['CommuteDriveNormal', 'CommuteDepartTimeNormal'] },
    { minsLeft: 29, expected: ['CommuteDriveNormal', 'CommuteDepartTimeNormal', 'CommuteMinutesLeft'] },
    { minsLeft: 0, expected: ['CommuteDriveHurry'] },
    { minsLeft: -9, expected: ['CommuteDriveHurry'] },
    { minsLeft: -10, expected: ['CommuteDriveLate'] },
    { minsLeft: -30, expected: ['CommuteDriveLate'] },
    { minsLeft: -31, expected: ['CommuteNow'] },
  ];
  for (const { minsLeft, expected } of cases) {
    const data = await runLogic({ minsLeft });
    assert.deepEqual(mimIds(data), expected, `minsLeft=${minsLeft}`);
    if ((expected.length === 1 && expected[0] === 'CommuteNow')
      || expected[0]?.endsWith('Hurry') || expected[0]?.endsWith('Late')) {
      assert.deepEqual(data.local.views, {}, `minsLeft=${minsLeft}: no late/now views`);
    }
  }
});

test('S-11 missing commute data and incomplete settings choose source fallback MIMs', async () => {
  const serviceDown = await runLogic({ commute: null });
  assert.deepEqual(mimIds(serviceDown), ['CommuteServiceDown']);
  assert.deepEqual(serviceDown.local.views, {});

  const appSetup = await runLogic({ complete: false, commute: null });
  assert.deepEqual(mimIds(appSetup), ['CommuteAppSetup']);
  assert.deepEqual(appSetup.local.views, {});

  const parsed = await commuteParse(null, ISO, { userPrefs: prefs() });
  assert.equal(parsed, undefined, 'missing Maps routes are a source parse failure');

  const [name, empty] = await getData({ commute: { complete: false } }, { log });
  assert.equal(name, 'commute');
  assert.deepEqual(empty, { status: null, geocoded_waypoints: null, routes: null });
});

test('S-11 commuteParse catches malformed arrival-time inputs like the source', async () => {
  const maps = { routes: [{ legs: [{ duration: { value: 600 }, duration_in_traffic: { value: 600 } }] }] };
  const malformedPrefs = prefs();
  malformedPrefs.commute.workTime = null;
  mock.timers.enable({ apis: ['Date'], now: Date.parse(ISO) });
  try {
    const parsed = await commuteParse(maps, ISO, {
      userPrefs: malformedPrefs,
      calendar: {
        events: [{ isEarly: true, dateTime: new DateTime('2026-06-12T08:45:00-04:00') }],
      },
    });
    assert.equal(parsed, undefined);
  } finally {
    mock.timers.reset();
  }
});

function runtimeForSpeaker() {
  return {
    location: { iso: ISO },
    perception: { speaker: 'u1' },
    loop: { users: [{ id: 'u1', firstName: 'Alice', phoneticName: 'Alice', birthdate: Date.parse('1990-01-01T00:00:00Z') }] },
    character: { emotion: { name: 'NEUTRAL', valence: 0, confidence: 0 } },
    dialog: { referent: null },
  };
}

function promptData({ mode = 'driving', singleSkill = null, commute = promptCommute({ mode }) } = {}) {
  return {
    singleSkill,
    userPrefs: prefs(mode),
    commute,
  };
}

async function renderPaths(names, prompt, views = {}, runtime = { location: { iso: ISO } }) {
  const data = {
    runtime,
    local: views,
    skill: { session: { data: { _mim: { noMatch: 0, noInput: 0, noMatchMax: false, noInputMax: false } } } },
    log,
  };
  return generateSlimSequence(
    { category: 'Entry-Core', subCategory: 'AN', noMatch: 0, noInput: 0 },
    {
      mimDataProvider: names.map((name) => join(MIM_DIR, `${name}.mim`)),
      promptDataProvider: () => prompt,
      viewDataProvider: () => ({ views }),
    },
    data,
    { rng: () => 0 },
  );
}

function firstSlim(sequence) {
  return sequence.children[0];
}

test('S-11 rendered actions select the source mode-specific normal and Now prompts', async () => {
  const normalCases = [
    {
      mode: 'driving', name: 'CommuteDriveNormal', id: 'CommuteDriveNormal_AN_01',
      text: "<anim cat='commute' meta='commute-normal, no-eye-end' nonBlocking='true' />Traffic looks about normal today.",
    },
    {
      mode: 'walking', name: 'CommuteTransportNormal', id: 'CommuteTransportNormal_AN_01',
      text: "<anim cat='commute' meta='commute-normal, no-eye-end' nonBlocking='true' />Your walk should take about 25 minutes today.",
    },
    {
      mode: 'transit', name: 'CommuteTransportNormal', id: 'CommuteTransportNormal_AN_06',
      text: "<anim cat='commute' meta='commute-normal, no-eye-end' nonBlocking='true' />Your trip should take about 25 minutes today.",
    },
    {
      mode: 'bicycling', name: 'CommuteTransportNormal', id: 'CommuteTransportNormal_AN_11',
      text: "<anim cat='commute' meta='commute-normal, no-eye-end' nonBlocking='true' />Your ride should take about 25 minutes today.",
    },
  ];
  for (const expected of normalCases) {
    const commute = promptCommute({ mode: expected.mode });
    const views = {
      commuteTraffic: await trafficView(0),
      commuteDepart: await departView(commute),
    };
    const sequence = await renderPaths(
      [expected.name], promptData({ mode: expected.mode, commute }), views,
    );
    const slim = firstSlim(sequence);
    assert.equal(slim.config.play.meta.mim_id, expected.name, expected.mode);
    assert.equal(slim.config.play.meta.prompt_id, expected.id, expected.mode);
    assert.equal(slim.config.play.esml, expected.text, expected.mode);
    assert.equal(slim.config.display.view.type, 'SKILL', `${expected.mode}: display type`);
    assert.equal(slim.config.display.view.name, 'MIM_VIEW', `${expected.mode}: display name`);
    assert.equal(slim.config.display.view.context.type, 'Javascript', `${expected.mode}: display protocol`);
    assert.equal(slim.config.display.view.context.pause, true, `${expected.mode}: GUI pause`);
    assert.equal(slim.config.display.view.context.data.viewConfig.id, 'trafficView', `${expected.mode}: traffic view`);
  }

  const nowCases = [
    ['driving', 'CommuteNow_AN_01', 'If you drive to work now, it should take about 25 minutes.'],
    ['walking', 'CommuteNow_AN_04', 'It should take about 25 minutes to walk to work if you leave now.'],
    ['transit', 'CommuteNow_AN_06', "For your commute, if you left right now it'd take about 25 minutes to get to work on public transportation."],
    ['bicycling', 'CommuteNow_AN_09', "For your commute, if you left right now it'd take about 25 minutes to ride your bike to work."],
  ];
  for (const [mode, id, text] of nowCases) {
    const sequence = await renderPaths(['CommuteNow'], promptData({ mode }));
    const slim = firstSlim(sequence);
    assert.equal(slim.config.play.meta.prompt_id, id, mode);
    assert.equal(slim.config.play.esml, text, mode);
    assert.equal(slim.config.display, undefined, `${mode}: Now has no view`);
  }
});

test('S-11 rendered terminal commute branches keep one ordered action and no GUI view', async () => {
  const cases = [
    ['CommuteNow', 'driving'],
    ['CommuteDriveHurry', 'driving'],
    ['CommuteTransportLate', 'transit'],
    ['CommuteAppSetup', 'driving'],
    ['CommuteServiceDown', 'driving'],
  ];
  for (const [name, mode] of cases) {
    const sequence = await renderPaths([name], promptData({ mode }));
    assert.deepEqual(sequence.children.map((child) => child.config.play.meta.mim_id), [name], name);
    assert.equal(sequence.children[0].config.display, undefined, `${name}: no GUI view`);
  }
});

test('S-11 rendered sequence keeps full-report and single-commute MIM order plus views', async () => {
  const poorTraffic = await trafficView(5);
  const depart = await departView({ departDT: new DateTime('2026-06-12T08:15:00-04:00') });
  const views = { commuteTraffic: poorTraffic, commuteDepart: depart };
  const commute = promptCommute({ extraMins: 5, minsLeft: 25, departDT: new DateTime('2026-06-12T08:15:00-04:00') });

  const full = await renderPaths(
    ['CommuteDrivePoor', 'CommuteDepartTimeNotNormal', 'CommuteMinutesLeft'],
    promptData({ commute }), views,
  );
  assert.deepEqual(full.children.map((child) => child.config.play.meta.mim_id), [
    'CommuteDrivePoor', 'CommuteDepartTimeNotNormal', 'CommuteMinutesLeft',
  ]);
  assert.deepEqual(full.children[0].config.display.view.context.data, poorTraffic);
  assert.deepEqual(full.children[1].config.display.view.context.data, depart);
  assert.match(full.children[0].config.play.esml, /5 extra minutes/);
  assert.equal(full.children[1].config.play.esml,
    "I'd leave around 8:15 AM, to get to work on time.");
  assert.equal(full.children[2].config.play.esml, "That's in about 25 minutes.");

  const single = await renderPaths(
    ['CommuteConfirmSpeaker', 'CommuteDrivePoor', 'CommuteDepartTimeNotNormal', 'CommuteMinutesLeft'],
    promptData({ singleSkill: 'commute', commute }), views, runtimeForSpeaker(),
  );
  assert.deepEqual(single.children.map((child) => child.config.play.meta.mim_id), [
    'CommuteConfirmSpeaker', 'CommuteDrivePoor', 'CommuteDepartTimeNotNormal', 'CommuteMinutesLeft',
  ]);
  assert.equal(single.children[0].config.play.esml, "<pitch mult='1.1'>Well</pitch> Alice.");
});

test('S-11 rendered fallback actions keep AppSetup and ServiceDown source text', async () => {
  const app = await renderPaths(['CommuteAppSetup'], promptData());
  assert.equal(firstSlim(app).config.play.meta.prompt_id, 'CommuteAppSetup_AN_01');
  assert.equal(firstSlim(app).config.play.esml,
    "To <pitch mult='1.1'>get</pitch> your commute info, you need to have your commute settings completed in the Jibo <phoneme ph='a p p'> app </phoneme>. It's in the Personal Report settings.");

  const down = await renderPaths(['CommuteServiceDown'], promptData());
  assert.equal(firstSlim(down).config.play.meta.prompt_id, 'CommuteServiceDown_AN_01');
  assert.equal(firstSlim(down).config.play.esml, "Sorry, commute information isn't available right now.");
});
