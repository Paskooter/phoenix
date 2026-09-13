// S-11 — report commute language/resources against the pinned Pegasus source.
// Source: jiboV2/pegasus@5c0a7390539663ba749d360de348a428c088505c
//   packages/report-skill/src/subskills/commute/{CommuteParse,CommuteMimLogic,CommuteViews}.ts
//   packages/report-skill/mims/en-us/Commute*.mim
//   packages/report-skill/resources/{mimPromptText.json,views/commuteDepart.json,views/commuteTraffic.json}
//
// The byte/hash inventory was captured from the Jibo/Gebo MCP at the source revision above.
// Keeping it beside executable Slimmer coverage makes the re-homed commute language auditable
// without requiring a live source checkout at test time.

import vm from 'node:vm';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  generateSlimFromMim,
  generateSlimSequence,
  loadMims,
  newMimState,
  PromptCategory,
  PromptSubCategory,
} from '../src/index.js';
import { DateTime } from '../src/report/dateTime.js';
import { commuteParse, CommuteMimLogic } from '../src/report/commute.js';
import { departView, trafficView } from '../src/report/commuteViews.js';

const SOURCE_REVISION = '5c0a7390539663ba749d360de348a428c088505c';
const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const SKILLS = resolve(TEST_DIR, '..');
const COMMUTE_MIM_DIR = join(SKILLS, 'resources', 'mims', 'report', 'en-us');
const COMMUTE_RESOURCE_DIR = join(SKILLS, 'resources');

const INVENTORY = Object.freeze({
  'CommuteAppSetup.mim': {
    bytes: 1196,
    sha256: '00093958338185fbea74fcf32aeca3495f5fee0332972d71d182f1860edea432',
    prompts: 2,
    promptRefs: [],
    conditionRefs: [],
    guiRefs: [],
  },
  'CommuteConfirmSpeaker.mim': {
    bytes: 1130,
    sha256: '272d4c9bdd232b66fc888ce80e96f7dce8c29aa15cec6ff49ec2a3be67c5c923',
    prompts: 3,
    promptRefs: ['speaker'],
    conditionRefs: [],
    guiRefs: [],
  },
  'CommuteDepartTimeNormal.mim': {
    bytes: 9926,
    sha256: '433062726724589cf611641cbe98871cad6c685da47d5e075d855a2e17d649b0',
    prompts: 24,
    promptRefs: ['skill.commute.departDT.toString({timeOnly: true})'],
    conditionRefs: [
      '!skill.commute.eventIsEarly',
      '!!skill.commute.eventIsEarly && !skill.singleSkill',
      '!!skill.commute.eventIsEarly && !!skill.singleSkill',
    ],
    guiRefs: ['views.commuteDepart'],
  },
  'CommuteDepartTimeNotNormal.mim': {
    bytes: 8501,
    sha256: '4969c1c1f0dafdf7b1cdd3938b04c8c513fff155b8c05463a681c6d5587168ee',
    prompts: 20,
    promptRefs: ['skill.commute.departDT.toString({timeOnly: true})'],
    conditionRefs: [
      '!skill.commute.eventIsEarly',
      '!!skill.commute.eventIsEarly && !skill.singleSkill',
      '!!skill.commute.eventIsEarly && !!skill.singleSkill',
    ],
    guiRefs: ['views.commuteDepart'],
  },
  'CommuteDriveHurry.mim': {
    bytes: 12839,
    sha256: '3ec01f71e59faec704041ba414a59a78357c170f15f666d4fe17d520ef469625',
    prompts: 21,
    promptRefs: ['skill.commute.durationMins', 'speaker'],
    conditionRefs: [
      '!!speaker && !skill.commute.eventIsEarly',
      '!skill.commute.eventIsEarly',
      '!!speaker && !!skill.commute.eventIsEarly && !skill.singleSkill',
      '!!skill.commute.eventIsEarly && !skill.singleSkill',
      '!!speaker && !!skill.commute.eventIsEarly && !!skill.singleSkill',
      '!!skill.commute.eventIsEarly && !!skill.singleSkill',
    ],
    guiRefs: [],
  },
  'CommuteDriveLate.mim': {
    bytes: 9130,
    sha256: '4584dde764f85ff8f5b481a39f6931b06516aa3f949eab35f129b3140c8e226b',
    prompts: 18,
    promptRefs: ['skill.commute.durationMins'],
    conditionRefs: [
      '!skill.commute.eventIsEarly',
      '!!skill.commute.eventIsEarly && !skill.singleSkill',
      '!!skill.commute.eventIsEarly && !!skill.singleSkill',
    ],
    guiRefs: [],
  },
  'CommuteDriveNormal.mim': {
    bytes: 4306,
    sha256: '2df5fd5f487c45985f5b2c4953f7d7409980dbb9a1d078076f7f367eceb8ccbd',
    prompts: 11,
    promptRefs: [],
    conditionRefs: [],
    guiRefs: ['views.commuteTraffic'],
  },
  'CommuteDrivePoor.mim': {
    bytes: 4538,
    sha256: 'b866578e85b33a5f8d07814e62b7bd195074eed0c096976806c71373a62e1b38',
    prompts: 11,
    promptRefs: ['skill.commute.extraMins'],
    conditionRefs: [],
    guiRefs: ['views.commuteTraffic'],
  },
  'CommuteDriveTerrible.mim': {
    bytes: 4709,
    sha256: '33a9f35ad99cb2c4202c0a97d39a5279eea25cd658abb392103c56a957107161',
    prompts: 11,
    promptRefs: ['skill.commute.extraMins'],
    conditionRefs: [],
    guiRefs: ['views.commuteTraffic'],
  },
  'CommuteMinutesLeft.mim': {
    bytes: 4213,
    sha256: '51e6550854c4752fb2c85fa873941df14416dd76c031d8b1092546564731a0e9',
    prompts: 13,
    promptRefs: ['skill.commute.minsLeft'],
    conditionRefs: [
      'skill.commute.minsLeft > 1',
      'skill.commute.minsLeft === 1',
      'skill.commute.minsLeft < 1',
    ],
    guiRefs: [],
  },
  'CommuteNow.mim': {
    bytes: 4101,
    sha256: '23c63ad3c7ef31f7462667bca049412e47c2b936beaba4e69ebaf0d19c3e9317',
    prompts: 10,
    promptRefs: ['skill.commute.durationMins'],
    conditionRefs: [
      'skill.commute.modeIsDriving',
      "skill.userPrefs.commute.mode === 'walking'",
      "skill.userPrefs.commute.mode === 'transit'",
      "skill.userPrefs.commute.mode === 'bicycling'",
    ],
    guiRefs: [],
  },
  'CommuteServiceDown.mim': {
    bytes: 1831,
    sha256: '71393524d35ad44ae4d407a936ec735ead30fb63e981687d675f81a6c10d2070',
    prompts: 5,
    promptRefs: [],
    conditionRefs: [],
    guiRefs: [],
  },
  'CommuteTransportHurry.mim': {
    bytes: 3644,
    sha256: '910349f7ee2bc2f76163aa6dd3dea481de49676319d0398182a7e537bd78396d',
    prompts: 8,
    promptRefs: ['dt.now', 'speaker'],
    conditionRefs: ['!!speaker'],
    guiRefs: [],
  },
  'CommuteTransportLate.mim': {
    bytes: 2849,
    sha256: '3a47400781e7d5bb48f440615426e72554a7a2986dfe2c58e93d1c5d10304fc1',
    prompts: 7,
    promptRefs: ['dt.now', 'skill.commute.arriveDT.toString({timeOnly: true})'],
    conditionRefs: [],
    guiRefs: [],
  },
  'CommuteTransportNormal.mim': {
    bytes: 7698,
    sha256: '940ef3369c0b1cc80c4116c7a77f41af02a1e5101b771d04a1f564af0bc80307',
    prompts: 16,
    promptRefs: ['skill.commute.durationMins'],
    conditionRefs: [
      "skill.userPrefs.commute.mode === 'walking'",
      "skill.userPrefs.commute.mode === 'transit'",
      "skill.userPrefs.commute.mode === 'bicycling'",
    ],
    guiRefs: ['views.commuteTraffic'],
  },
});

const RESOURCE_INVENTORY = Object.freeze({
  'report-mimPromptText.json': {
    bytes: 514,
    sha256: '1b987df35fd07a0094e502898071ac066544798c955f44b862cadb115cc61f71',
  },
  'views/commuteDepart.json': {
    bytes: 1841,
    sha256: 'b57b7d1188a27231d60bb24f99392882fb24796a005c74fd031b41ffec0995e5',
  },
  'views/commuteTraffic.json': {
    bytes: 612,
    sha256: 'dd91bbd037f4b6493a979c55af3f0337bdda5f8c76883747aaffbf379dcd910e',
  },
});

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const files = () => readdirSync(COMMUTE_MIM_DIR).filter((name) => name.startsWith('Commute')).sort();
const mimIds = (paths) => paths.map((path) => basename(path, '.mim'));

/** Extract `${...}` expressions while preserving object literals inside a call. */
function templateRefs(value) {
  const refs = [];
  for (let index = 0; index < value.length - 1; index += 1) {
    if (value[index] !== '$' || value[index + 1] !== '{') continue;
    let cursor = index + 2;
    let depth = 1;
    let quote;
    let escaped = false;
    for (; cursor < value.length; cursor += 1) {
      const char = value[cursor];
      if (quote) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === quote) quote = undefined;
      } else if (char === '"' || char === "'" || char === '`') {
        quote = char;
      } else if (char === '{') {
        depth += 1;
      } else if (char === '}' && --depth === 0) {
        refs.push(value.slice(index + 2, cursor));
        break;
      }
    }
    index = cursor;
  }
  return [...new Set(refs)].sort();
}

const promptRefs = (mim) => [...new Set(mim.prompts.flatMap((prompt) => templateRefs(prompt.prompt)))].sort();
const conditionRefs = (mim) => [...new Set(mim.prompts.map((prompt) => prompt.condition).filter(Boolean))].sort();
const guiRefs = (mim) => mim.gui?.data ? [mim.gui.data] : [];

function entryConfig() {
  return {
    category: PromptCategory.ENTRY,
    subCategory: PromptSubCategory.ANNOUNCEMENT,
    index: 1,
    noMatch: 0,
    noInput: 0,
  };
}

const SPEAKER = { firstName: 'George', toString: () => 'George' };
const DEPART_DT = new DateTime('2026-06-12T08:30:00-04:00');
const ARRIVE_DT = new DateTime('2026-06-12T09:00:00-04:00');
const NOW_DT = new DateTime('2026-06-12T08:40:00-04:00');

function promptData(overrides = {}) {
  const commute = {
    departDT: DEPART_DT,
    arriveDT: ARRIVE_DT,
    durationMins: 25,
    extraMins: 5,
    minsLeft: 29,
    eventIsEarly: false,
    modeIsDriving: true,
    ...overrides.commute,
  };
  const userPrefs = { commute: { mode: 'driving' }, ...overrides.userPrefs };
  const skill = {
    singleSkill: false,
    userPrefs,
    commute,
    ...overrides.skill,
  };
  return {
    speaker: SPEAKER,
    dt: { now: NOW_DT },
    skill,
    ...overrides,
  };
}

function contextForCondition(condition) {
  const context = promptData();
  const expression = condition || '';
  if (expression.includes('eventIsEarly')) context.skill.commute.eventIsEarly = expression.includes('!!skill.commute.eventIsEarly');
  if (expression.includes('singleSkill')) context.skill.singleSkill = expression.includes('!!skill.singleSkill');
  if (expression.includes('!!speaker')) context.speaker = SPEAKER;
  if (expression.includes('minsLeft > 1')) context.skill.commute.minsLeft = 2;
  if (expression.includes('minsLeft === 1')) context.skill.commute.minsLeft = 1;
  if (expression.includes('minsLeft < 1')) context.skill.commute.minsLeft = 0;
  if (expression.includes('modeIsDriving')) {
    context.skill.commute.modeIsDriving = true;
    context.skill.userPrefs.commute.mode = 'driving';
  }
  for (const mode of ['walking', 'transit', 'bicycling']) {
    if (expression.includes(`'${mode}'`)) {
      context.skill.commute.modeIsDriving = false;
      context.skill.userPrefs.commute.mode = mode;
    }
  }
  return context;
}

function rngForPrompt(mim, targetIndex, context) {
  const eligible = mim.prompts
    .map((prompt, index) => ({ prompt, index }))
    .filter(({ prompt }) => !prompt.condition || !!vm.runInNewContext(prompt.condition, context));
  const targetPosition = eligible.findIndex(({ index }) => index === targetIndex);
  assert.ok(targetPosition >= 0, `${mim.mim_id}/${mim.prompts[targetIndex].prompt_id}: condition is satisfiable`);
  const weights = eligible.map(({ prompt }) => prompt.weight || 1);
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  const before = weights.slice(0, targetPosition).reduce((sum, weight) => sum + weight, 0);
  return () => (before + weights[targetPosition] / 2) / total;
}

function renderExpected(template, context) {
  const commute = context.skill.commute;
  return template
    .replaceAll('${speaker}', String(context.speaker))
    .replaceAll('${dt.now}', String(context.dt.now))
    .replaceAll('${skill.commute.durationMins}', String(commute.durationMins))
    .replaceAll('${skill.commute.extraMins}', String(commute.extraMins))
    .replaceAll('${skill.commute.minsLeft}', String(commute.minsLeft))
    .replaceAll('${skill.commute.departDT.toString({timeOnly: true})}', commute.departDT.toString({ timeOnly: true }))
    .replaceAll('${skill.commute.arriveDT.toString({timeOnly: true})}', commute.arriveDT.toString({ timeOnly: true }));
}

function logicData({ complete = true, commute = null, mode = 'driving', singleSkill = null } = {}) {
  return {
    local: {
      userPrefs: { commute: { complete, mode, workTime: { hour: 9, min: 0 } } },
      commute,
      views: {},
    },
    runtime: { location: { iso: '2026-06-12T08:00:00-04:00' } },
    skill: { session: { data: { _personalReport: { singleSkill, _mim: newMimState() } } } },
  };
}

function parsedCommute({ minsLeft = 29, extraMins = 5, modeIsDriving = true, eventIsEarly = false } = {}) {
  return {
    departDT: DEPART_DT,
    arriveDT: ARRIVE_DT,
    minsLeft,
    modeIsDriving,
    eventIsEarly,
    durationMins: 25,
    extraMins,
  };
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

test('S-11 inventory: all fifteen Commute MIMs and three resources match MCP bytes', () => {
  assert.equal(SOURCE_REVISION, '5c0a7390539663ba749d360de348a428c088505c');
  assert.deepEqual(files(), Object.keys(INVENTORY).sort());

  for (const name of files()) {
    const raw = readFileSync(join(COMMUTE_MIM_DIR, name), 'utf8');
    const mim = JSON.parse(raw);
    const expected = INVENTORY[name];
    assert.equal(Buffer.byteLength(raw), expected.bytes, `${name}: byte length`);
    assert.equal(sha256(raw), expected.sha256, `${name}: SHA-256`);
    assert.equal(mim.mim_id, undefined, `${name}: source relies on filename ID fallback`);
    assert.equal(mim.mim_type, 'announcement', `${name}: MIM type`);
    assert.equal(mim.prompts.length, expected.prompts, `${name}: prompt count`);
    assert.deepEqual(promptRefs(mim), [...expected.promptRefs].sort(), `${name}: prompt dynamic refs`);
    assert.deepEqual(conditionRefs(mim), [...expected.conditionRefs].sort(), `${name}: condition refs`);
    assert.deepEqual(guiRefs(mim), [...expected.guiRefs].sort(), `${name}: GUI refs`);
  }

  for (const [name, expected] of Object.entries(RESOURCE_INVENTORY)) {
    const raw = readFileSync(join(COMMUTE_RESOURCE_DIR, name), 'utf8');
    assert.equal(Buffer.byteLength(raw), expected.bytes, `${name}: byte length`);
    assert.equal(sha256(raw), expected.sha256, `${name}: SHA-256`);
  }
});

test('S-11 loader: every source Commute MIM receives its Phoenix filename ID and announcement type', async () => {
  const paths = files().map((name) => join(COMMUTE_MIM_DIR, name));
  const loaded = await loadMims(paths, {});
  assert.equal(loaded.length, 15);
  assert.deepEqual(loaded.map((mim) => mim.mim_id).sort(), mimIds(paths));
  assert.ok(loaded.every((mim) => mim.mim_type === 'announcement'));
  assert.ok(loaded.every((mim) => mim.prompts.length > 0));
});

test('S-11 prompt rendering: every source commute prompt resolves exact dynamic values through Slimmer', async () => {
  const paths = files().map((name) => join(COMMUTE_MIM_DIR, name));
  const loaded = await loadMims(paths, {});

  for (const mim of loaded) {
    for (const [index, prompt] of mim.prompts.entries()) {
      const context = contextForCondition(prompt.condition);
      const slim = generateSlimFromMim(mim, entryConfig(), context, {
        rng: rngForPrompt(mim, index, context),
      });
      assert.ok(slim?.play, `${mim.mim_id}/${prompt.prompt_id}: selected prompt`);
      assert.equal(slim.play.meta.mim_id, mim.mim_id);
      assert.equal(slim.play.meta.prompt_id, prompt.prompt_id);
      assert.equal(slim.play.esml, renderExpected(prompt.prompt, context), `${mim.mim_id}/${prompt.prompt_id}: exact ESML`);
      assert.equal(slim.play.esml.includes('${'), false, `${mim.mim_id}/${prompt.prompt_id}: no unresolved template`);
    }
  }
});

test('S-11 parser: driving uses traffic duration, transit uses baseline, and early events replace normal arrival', async () => {
  const date = todayISO();
  const prefs = { commute: { complete: true, mode: 'driving', workTime: { hour: 9, min: 0 } } };
  const maps = { routes: [{ legs: [{ duration: { value: 1500 }, duration_in_traffic: { value: 1800 } }] }] };
  const parsed = await commuteParse(maps, `${date}T08:00:00Z`, {
    userPrefs: prefs,
    calendar: { events: [] },
  });
  assert.equal(parsed.arriveDT.toString({ timeOnly: true }), '9:00 AM');
  assert.equal(parsed.departDT.toString({ timeOnly: true }), '8:30 AM');
  assert.equal(parsed.durationMins, 30);
  assert.equal(parsed.extraMins, 5);
  assert.equal(parsed.minsLeft, 30);
  assert.equal(parsed.modeIsDriving, true);
  assert.equal(parsed.eventIsEarly, false);

  const early = await commuteParse(maps, `${date}T06:00:00Z`, {
    userPrefs: prefs,
    calendar: { events: [{ isEarly: true, dateTime: new DateTime(`${date}T07:00:00Z`) }] },
  });
  assert.equal(early.arriveDT.toString({ timeOnly: true }), '7:00 AM');
  assert.equal(early.departDT.toString({ timeOnly: true }), '6:30 AM');
  assert.equal(early.eventIsEarly, true);

  const transit = await commuteParse(maps, `${date}T08:00:00Z`, {
    userPrefs: { commute: { complete: true, mode: 'transit', workTime: { hour: 9, min: 0 } } },
    calendar: { events: [] },
  });
  assert.equal(transit.durationMins, 25, 'non-driving uses baseline duration');
  assert.equal(transit.extraMins, 5, 'extra traffic remains provider delta');
  assert.equal(transit.modeIsDriving, false);

  const negativeDelta = await commuteParse(
    { routes: [{ legs: [{ duration: { value: 1800 }, duration_in_traffic: { value: 1500 } }] }] },
    `${date}T08:00:00Z`,
    { userPrefs: prefs, calendar: { events: [] } },
  );
  assert.equal(negativeDelta.extraMins, 0, 'negative traffic delta clamps at zero');

  assert.equal(await commuteParse(null, `${date}T08:00:00Z`, { userPrefs: prefs }), undefined);
  assert.equal(await commuteParse(maps, `${date}T08:00:00Z`, { userPrefs: { commute: { complete: false } } }), undefined);
});

test('S-11 parse units: secondsToMinutes preserves source floor and sub-minute zero behavior', async () => {
  const date = todayISO();
  const prefs = { commute: { complete: true, mode: 'driving', workTime: { hour: 9, min: 0 } } };
  const underMinute = await commuteParse(
    { routes: [{ legs: [{ duration: { value: 59 }, duration_in_traffic: { value: 59 } }] }] },
    `${date}T08:00:00Z`,
    { userPrefs: prefs, calendar: { events: [] } },
  );
  assert.equal(underMinute.durationMins, 0);
  const exactMinute = await commuteParse(
    { routes: [{ legs: [{ duration: { value: 60 }, duration_in_traffic: { value: 120 } }] }] },
    `${date}T08:00:00Z`,
    { userPrefs: prefs, calendar: { events: [] } },
  );
  assert.equal(exactMinute.durationMins, 2);
  assert.equal(exactMinute.extraMins, 1);
});

test('S-11 logic: source timing/traffic table produces exact MIM order, prefixes, and view data', async () => {
  const cases = [
    [
      'normal driving at exactly thirty minutes',
      logicData({ commute: parsedCommute({ minsLeft: 30, extraMins: 4 }), mode: 'driving' }),
      ['CommuteDriveNormal', 'CommuteDepartTimeNormal'],
    ],
    [
      'poor driving with fewer than thirty minutes left',
      logicData({ commute: parsedCommute({ minsLeft: 29, extraMins: 5 }), mode: 'driving' }),
      ['CommuteDrivePoor', 'CommuteDepartTimeNotNormal', 'CommuteMinutesLeft'],
    ],
    [
      'terrible driving at fifteen extra minutes',
      logicData({ commute: parsedCommute({ minsLeft: 1, extraMins: 15 }), mode: 'driving' }),
      ['CommuteDriveTerrible', 'CommuteDepartTimeNotNormal', 'CommuteMinutesLeft'],
    ],
    [
      'transport ignores traffic band and uses normal language',
      logicData({ commute: parsedCommute({ minsLeft: 30, extraMins: 20, modeIsDriving: false }), mode: 'transit' }),
      ['CommuteTransportNormal', 'CommuteDepartTimeNormal'],
    ],
    [
      'just late is hurry',
      logicData({ commute: parsedCommute({ minsLeft: -9, extraMins: 0 }), mode: 'driving' }),
      ['CommuteDriveHurry'],
    ],
    [
      'ten minutes late is late',
      logicData({ commute: parsedCommute({ minsLeft: -10, extraMins: 0 }), mode: 'driving' }),
      ['CommuteDriveLate'],
    ],
    [
      'more than thirty minutes late says now',
      logicData({ commute: parsedCommute({ minsLeft: -31, extraMins: 0 }), mode: 'driving' }),
      ['CommuteNow'],
    ],
    [
      'more than two hours ahead says now',
      logicData({ commute: parsedCommute({ minsLeft: 121, extraMins: 0 }), mode: 'transit' }),
      ['CommuteNow'],
    ],
  ];

  for (const [label, data, expected] of cases) {
    await new CommuteMimLogic('Commute Mim Logic').exit(data);
    assert.deepEqual(mimIds(data.local.mimPaths), expected, label);
    if (data.local.commute.minsLeft > 0 && data.local.commute.minsLeft <= 120) {
      assert.ok(data.local.views.commuteTraffic, `${label}: traffic view`);
      assert.ok(data.local.views.commuteDepart, `${label}: departure view`);
    } else {
      assert.deepEqual(data.local.views, {}, `${label}: no views on Now/late branch`);
    }
  }

  const incomplete = logicData({ complete: false });
  await new CommuteMimLogic('Commute Mim Logic').exit(incomplete);
  assert.deepEqual(mimIds(incomplete.local.mimPaths), ['CommuteAppSetup']);

  const down = logicData({ commute: null });
  await new CommuteMimLogic('Commute Mim Logic').exit(down);
  assert.deepEqual(mimIds(down.local.mimPaths), ['CommuteServiceDown']);

  const single = logicData({
    commute: parsedCommute({ minsLeft: 30, extraMins: 0 }),
    mode: 'driving',
    singleSkill: 'commute',
  });
  await new CommuteMimLogic('Commute Mim Logic').exit(single);
  assert.deepEqual(mimIds(single.local.mimPaths), ['CommuteConfirmSpeaker', 'CommuteDriveNormal', 'CommuteDepartTimeNormal']);
});

test('S-11 sequence: exact commute language, traffic texture, departure time, and view wrappers survive Slimmer', async () => {
  const data = logicData({ commute: parsedCommute({ minsLeft: 29, extraMins: 5 }), mode: 'driving' });
  await new CommuteMimLogic('Commute Mim Logic').exit(data);
  const sequence = await generateSlimSequence(entryConfig(), {
    mimDataProvider: data.local.mimPaths,
    promptDataProvider: () => ({ singleSkill: null, ...data.local }),
    viewDataProvider: () => data.local,
  }, data, { rng: () => 0 });

  assert.deepEqual(sequence.children.map((slim) => slim.config.play.meta.mim_id), [
    'CommuteDrivePoor', 'CommuteDepartTimeNotNormal', 'CommuteMinutesLeft',
  ]);
  assert.match(sequence.children[0].config.play.esml, /5 extra minutes/);
  assert.match(sequence.children[1].config.play.esml, /8:30 AM/);
  assert.match(sequence.children[2].config.play.esml, /29 minutes/);
  assert.equal(sequence.children[0].config.display.view.context.data.viewConfig.id, 'trafficView');
  assert.equal(sequence.children[0].config.display.view.context.data.componentConfigs[0].assets[0].src, 'assets/personal-report-skill/commute/trafficBad_v01.crn');
  assert.equal(sequence.children[1].config.display.view.context.data.viewConfig.id, 'departTimeView');
  assert.equal(sequence.children[1].config.display.view.context.data.componentConfigs[1].text, '8:30');
  assert.equal(sequence.children[1].config.display.view.context.data.componentConfigs[2].text, 'AM');
});

test('S-11 views: traffic thresholds and departure labels preserve source assets and geometry', async () => {
  const normal = await trafficView(4);
  const poor = await trafficView(5);
  const terrible = await trafficView(15);
  const src = (view) => view.componentConfigs[0].assets[0].src;
  assert.equal(src(normal), 'assets/personal-report-skill/commute/trafficNormal_v01.crn');
  assert.equal(src(poor), 'assets/personal-report-skill/commute/trafficBad_v01.crn');
  assert.equal(src(terrible), 'assets/personal-report-skill/commute/trafficTerrible_v01.crn');
  assert.equal(normal.viewConfig.id, 'trafficView');
  assert.deepEqual(normal.componentConfigs[0].position, { x: 377, y: 97 });

  const depart = await departView({ departDT: new DateTime('2026-06-12T17:05:00-04:00') });
  assert.equal(depart.viewConfig.id, 'departTimeView');
  assert.equal(depart.componentConfigs[0].text, 'Depart');
  assert.equal(depart.componentConfigs[1].text, '5:05');
  assert.equal(depart.componentConfigs[2].text, 'PM');
  assert.deepEqual(depart.componentConfigs[1].position, { x: 715, y: 458 });
});
