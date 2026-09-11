// S-04 focused contracts: MIM rendering/selection and JCP output against the pinned requester.
//
// Source control: Pegasus 5c0a7390539663ba749d360de348a428c088505c
//   packages/baseskill/src/graph/mims/utils/slimmer/Slimmer.ts  (generateSlim/generatePlay/
//     generateListen/generateDisplay, generateSlimSequence)
//   packages/baseskill/src/graph/mims/utils/slimmer/Utils.ts    (isBirthday, makePronounceable)
//   packages/baseskill/src/graph/mims/utils/unify/Unify.ts      (unifyMims)
//   packages/baseskill/src/graph/Utils.ts:28-36                 (generateJCPAction)
//   packages/chitchat-skill/src/utils/FunAndGamesUtils.ts       (Dice, Coin)
//   node_modules/jibo-command-requester/lib/jibo-command-requester.js (4.0.6-home)
//     Display :1654, Listen :1675, Play :1692, SLIM :1709, Parallel :1792, Sequence :1808
//   node_modules/jibo-cai-utils/lib/jibo-cai-utils.js:1183-1201 (weightedRandomSample)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import {
  generateSlimFromMim, generateDisplay, generateSlimSequence, weightedSample, newMimState,
  buildPromptData, PromptCategory, PromptSubCategory,
} from '../src/index.js';
import { generateJCPAction, sequenceProtocol, parallelProtocol } from '../src/graph/nodes.js';
import { playProtocol, listenProtocol, displayProtocol, slimProtocol } from '../src/graph/mims/protocol.js';
import { unifyMims } from '../src/graph/mims/unify.js';
import { loadMims } from '../src/graph/mims/utils.js';
import { Dice, Coin } from '../src/chitchat/funAndGames.js';
import { escapeForEsml } from '../src/jcp.js';

const JCP_ID = /^[0-9a-f]{32}$/;

/** Replace every command `id` with a placeholder so two protocol trees can be compared. */
function maskIds(value) {
  if (Array.isArray(value)) return value.map(maskIds);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = k === 'id' ? '<id>' : maskIds(v);
    return out;
  }
  return value;
}

/** The captured reference production-smoke document (real Jibo responses). */
function goldenDoc() {
  const path = new URL('../../harness/resources/goldens/production-smoke/reference.json.gz', import.meta.url);
  return JSON.parse(gunzipSync(readFileSync(path)));
}

/** The captured reference response for one golden case. */
function goldenAction(caseId) {
  const found = goldenDoc().cases.find((c) => c.id === caseId);
  assert.ok(found, `golden case ${caseId} is present`);
  return found.turns[0].response.body.value.data.action;
}

/** The first captured reference protocol node of a given type. */
function firstGoldenNode(type) {
  const walk = function* (value) {
    if (Array.isArray(value)) { for (const v of value) yield* walk(v); return; }
    if (value && typeof value === 'object') {
      yield value;
      for (const v of Object.values(value)) yield* walk(v);
    }
  };
  for (const node of walk(goldenDoc())) if (node.type === type) return node;
  throw new Error(`no captured ${type} node in the production smoke corpus`);
}

const AN_MIM = {
  mim_id: 'TestAN', mim_type: 'announcement', es_auto_tagging: true,
  prompts: [{ prompt_category: 'Entry-Core', prompt_sub_category: 'AN', index: 0, condition: '', prompt: 'plain', weight: 1, prompt_id: 'an-plain' }],
};

// ---------------------------------------------------------------------------
// Requester protocol builders (JCP output shape)

test('protocol builders reproduce the pinned requester key sets, order and ID format', () => {
  const play = playProtocol('hi', true);
  assert.deepEqual(Object.keys(play), ['id', 'type', 'autoRuleConfig', 'speakOptions', 'esml']);
  assert.match(play.id, JCP_ID);
  assert.equal(play.speakOptions, undefined, 'requester leaves speakOptions present-but-undefined');
  assert.equal(JSON.stringify(play), `{"id":"${play.id}","type":"PLAY","autoRuleConfig":true,"esml":"hi"}`);

  const listen = listenProtocol('rules/en-us/global.fst');
  assert.deepEqual(Object.keys(listen), ['id', 'type', 'contexts', 'intents']);
  assert.deepEqual(listen.contexts, ['rules/en-us/global.fst']);
  assert.deepEqual(Object.keys(listenProtocol(['a', 'b'])), ['id', 'type', 'contexts', 'intents']);
  assert.deepEqual(listenProtocol(['a', 'b']).contexts, ['a', 'b'], 'array rules are passed through, not re-wrapped');

  const display = displayProtocol('PEGASUS_VIEW', { type: 'SKILL', name: 'MIM_VIEW', context: null }, 0, true, false, [{ type: 'HIDE_DISPLAY', name: 'HIDE_MIM_VIEW' }]);
  assert.deepEqual(Object.keys(display), ['id', 'type', 'name', 'view', 'layer', 'overlay', 'visible', 'keepDisplay', 'onCancel']);
  assert.equal(display.overlay, undefined);

  const slim = slimProtocol({ play }, undefined);
  assert.deepEqual(Object.keys(slim), ['id', 'type', 'config', 'options']);
  assert.match(slim.id, JCP_ID);

  assert.deepEqual(Object.keys(sequenceProtocol([])), ['id', 'type', 'children']);
  const parallel = parallelProtocol([]);
  assert.deepEqual(Object.keys(parallel), ['id', 'type', 'children', 'succeedOnFirst']);
  assert.equal(parallel.succeedOnFirst, false, 'Parallel defaults succeedOnFirst to false');
});

test('generateJCPAction wraps the behavior itself — no extra SEQUENCE layer', () => {
  const slim = slimProtocol({ play: playProtocol('hi', true) });
  const single = generateJCPAction(slim);
  assert.deepEqual(Object.keys(single), ['type', 'config']);
  assert.deepEqual(Object.keys(single.config), ['version', 'jcp']);
  assert.equal(single.config.version, '2.0');
  assert.equal(single.config.jcp, slim, 'the behavior is placed directly at config.jcp');
  assert.equal(single.config.jcp.type, 'SLIM');

  const sequence = generateJCPAction(sequenceProtocol([slim]));
  assert.equal(sequence.config.jcp.type, 'SEQUENCE');
  assert.equal(sequence.config.jcp.children.length, 1);
});

test('Slimmer PLAY/SLIM in-memory trees equal the captured reference case boundary:launch', () => {
  const golden = goldenAction('boundary:launch');
  const goldenPlay = maskIds(golden.config.jcp.config.play);

  // Phoenix's Slimmer emits the requester PLAY node and appends meta afterwards (Slimmer.ts:159-166).
  const built = playProtocol(goldenPlay.esml, goldenPlay.autoRuleConfig);
  built.meta = goldenPlay.meta;
  assert.deepEqual(Object.keys(built), ['id', 'type', 'autoRuleConfig', 'speakOptions', 'esml', 'meta']);
  assert.deepEqual(maskIds(JSON.parse(JSON.stringify(built))), goldenPlay, 'wire PLAY equals the captured reference node');
  assert.equal(Object.hasOwn(built, 'speakOptions'), true, 'in-memory key set matches the requester');
  assert.equal(built.speakOptions, undefined);

  // Slimmer keeps all three config slots in memory; listen/display are absent from the wire.
  const slim = slimProtocol({ play: built, listen: undefined, display: undefined });
  assert.deepEqual(Object.keys(slim.config), ['play', 'listen', 'display']);
  assert.deepEqual(maskIds(JSON.parse(JSON.stringify(slim))), maskIds(golden.config.jcp));
  assert.deepEqual(maskIds(JSON.parse(JSON.stringify(built))), goldenPlay, 'in-memory PLAY matches the reference node');
});

// ---------------------------------------------------------------------------
// Selection (weighted variants)

test('weightedSample reproduces RandomUtils.weightedRandomSample at its boundaries', () => {
  // Expected values were produced by executing the pinned jibo-cai-utils 1183-1201 implementation
  // with Math.random() pinned to the given value.
  const vectors = [
    { weights: [1, 3], r: 0.0, expect: 'd0' },
    { weights: [1, 3], r: 0.5, expect: 'd1' },
    { weights: [1, 3], r: 1, expect: {} },
    { weights: [0, 0], r: 0.5, expect: {} },
    { weights: [-1, -1], r: 0.5, expect: {} },
    { weights: [0, 1], r: 0.5, expect: 'd1' },
    { weights: [1, 0], r: 0.99, expect: 'd0' },
    { weights: [-2, 3], r: 0.1, expect: 'd1' },
    { weights: [1, 1, 1], r: 0.999999, expect: 'd2' },
  ];
  for (const { weights, r, expect } of vectors) {
    const items = weights.map((w, i) => ({ data: 'd' + i, weight: w }));
    const actual = weightedSample(items, () => r);
    assert.deepEqual(actual, expect, `weights ${JSON.stringify(weights)} at r=${r}`);
  }
});

test('weightedSample chooses the identical index as the source sampler across a fixed sweep', () => {
  // Same cumulative-"<" rule the source uses: element i is chosen when rng()*total falls strictly
  // inside the running total of positive weights.
  const weights = [2, 0, 3, -1, 4];
  const items = weights.map((w, i) => ({ data: i, weight: w }));
  const total = weights.reduce((a, b) => a + b, 0); // 8
  for (let step = 0; step <= 100; step++) {
    const r = step / 101; // strictly inside [0, 1)
    const expected = (() => {
      const rand = r * total;
      let ongoing = 0;
      for (const it of items) { if (it.weight > 0) { ongoing += it.weight; if (rand < ongoing) return it.data; } }
      return {};
    })();
    assert.deepEqual(weightedSample(items, () => r), expected, `r=${r}`);
  }
});

// ---------------------------------------------------------------------------
// MIM loading/merging

test('unifyMims injects skill prompts into the base MIM and keeps base identity', async () => {
  const data = { log: null, skill: { session: { data: {} } } };
  const base = () => ({ mim_id: 'base', mim_type: 'question', rule_name: 'base/rule', prompts: [{ prompt_id: 'base-p' }] });

  const merged = await unifyMims({ baseProvider: base, mimProvider: { prompts: [{ prompt_id: 'skill-p' }] } }, data);
  assert.equal(merged.mim_id, 'base');
  assert.deepEqual(merged.prompts, [{ prompt_id: 'skill-p' }]);

  const kept = await unifyMims({ baseProvider: base, mimProvider: { mim_id: 'skill' } }, data);
  assert.deepEqual(kept.prompts, [{ prompt_id: 'base-p' }], 'skill MIM without prompts keeps base defaults');

  const transformed = await unifyMims({ baseProvider: base, mimProvider: { prompts: [] }, transform: (d, s, b) => ({ ...b, mim_id: 'custom' }) }, data);
  assert.equal(transformed.mim_id, 'custom');

  await assert.rejects(() => unifyMims({ mimProvider: { prompts: [] } }, data), /Missing base MIM for unification\./);
  const fellBack = await unifyMims({ baseProvider: base, mimProvider: { prompts: [{ prompt_id: 'skill-p' }] }, transform: () => { throw new Error('boom'); } }, data);
  assert.deepEqual(fellBack.prompts, [{ prompt_id: 'skill-p' }], 'throwing transform falls back to the default merge');
});

// ---------------------------------------------------------------------------
// Conditions

test('conditions filter prompts in the PromptData sandbox', () => {
  const mim = {
    mim_id: 'cond', mim_type: 'announcement',
    prompts: [
      { prompt_category: 'Entry-Core', prompt_sub_category: 'AN', index: 0, condition: '', prompt: 'always', weight: 1, prompt_id: 'p-always' },
      { prompt_category: 'Entry-Core', prompt_sub_category: 'AN', index: 0, condition: 'false', prompt: 'never', weight: 1, prompt_id: 'p-never' },
      { prompt_category: 'Entry-Core', prompt_sub_category: 'AN', index: 0, condition: 'missingThing.value', prompt: 'throws', weight: 1, prompt_id: 'p-throws' },
    ],
  };
  const render = (rng) => generateSlimFromMim(mim, { category: PromptCategory.ENTRY, subCategory: PromptSubCategory.AN, index: 0 }, buildPromptData({}), { rng });
  // Only the empty condition survives; the false one fails and the throwing one is excluded and logged.
  const slim = render(() => 0);
  assert.equal(slim.play.esml, 'always');
  assert.equal(slim.play.meta.prompt_id, 'p-always');
});

test('condition and template failures log at error level and are excluded, not thrown', () => {
  const seen = [];
  const log = { error: (...a) => seen.push(a), warn: () => {}, info: () => {}, debug: () => {} };
  const mim = {
    mim_id: 'err', mim_type: 'announcement',
    prompts: [
      { prompt_category: 'Entry-Core', prompt_sub_category: 'AN', index: 0, condition: 'undefinedGlobal.x', prompt: 'a', weight: 1, prompt_id: 'bad-cond' },
      { prompt_category: 'Entry-Core', prompt_sub_category: 'AN', index: 0, condition: '', prompt: '${missing.deep}', weight: 1, prompt_id: 'bad-template' },
    ],
  };
  const data = { skill: { session: { data: { _mim: newMimState() } } } };
  const slim = generateSlimFromMim(mim, { category: PromptCategory.ENTRY, subCategory: PromptSubCategory.AN, index: 0 }, buildPromptData({}), { rng: () => 0, data, log });
  assert.equal(slim.play.meta.prompt_id, 'bad-template', 'the throwing condition is excluded, the next prompt is used');
  assert.equal(slim.play.esml, '', 'a throwing template leaves the empty resolved prompt');
  assert.deepEqual(seen.map((a) => a[0]), ['Error evaluating prompt condition', 'Error resolving prompt text']);
});

// ---------------------------------------------------------------------------
// Template expansion + ESML pass-through

test('templates resolve PromptData members and ESML passes through unescaped', () => {
  const runtime = {
    location: { iso: '2020-01-15T12:00:00.000Z' },
    perception: { speaker: 'u1' },
    loop: { users: [{ id: 'u1', firstName: 'Pat', lastName: 'X', gender: 'unknown', phoneticName: 'Pat', birthdate: Date.parse('1990-01-01T00:00:00.000Z') }] },
    character: { emotion: { name: 'NEUTRAL', valence: 0, confidence: 0 } },
    dialog: { referent: null },
  };
  const mim = {
    mim_id: 'tmpl', mim_type: 'question', rule_name: 'shared/generic',
    prompts: [{ prompt_category: 'Entry-Core', prompt_sub_category: 'Q', index: 0, condition: '', prompt: '<break size=\'0.7\'/> Hi ${speaker.firstName}, dice ${dice.a}.', weight: 1, prompt_id: 't1' }],
  };
  const promptData = buildPromptData(runtime, { dice: { a: 4, b: 6 } });
  const slim = generateSlimFromMim(mim, { category: PromptCategory.ENTRY, subCategory: PromptSubCategory.Q, index: 0 }, promptData, { rng: () => 0 });
  assert.equal(slim.play.esml, "<break size='0.7'/> Hi Pat, dice 4.");
  assert.deepEqual(slim.listen.contexts, ['shared/generic']);
  // The MIM path never escapes: Slimmer.ts hands the resolved string straight to Play.generateProtocol.
  assert.match(slim.play.esml, /<break size='0\.7'\/>/);

  // The answer-skill builder is the escaping path (answer-skill/server.js:188-200).
  assert.equal(escapeForEsml('a <rule> {x} "q" & b'), 'a &lt;rule&gt; x &quot;q&quot; &amp; b');
  assert.equal(escapeForEsml(''), '');
});

test('loadMims resolves paths, defaults a missing mim_id to the filename and rejects bad paths', async () => {
  // utils/Utils.ts:29-56 — `.mim` extension gate, existence gate, parse gate, filename fallback.
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 's04-mim-'));
  const named = join(dir, 'MyPrompt.mim');
  writeFileSync(named, JSON.stringify({ mim_type: 'announcement', prompts: [] }));
  const bad = join(dir, 'notamim.json');
  writeFileSync(bad, '{}');
  const broken = join(dir, 'broken.mim');
  writeFileSync(broken, '{oops');

  const loaded = await loadMims(named, {});
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].mim_id, 'MyPrompt', 'a MIM without an ID takes its filename');
  assert.equal((await loadMims({ mim_id: 'inline', prompts: [] }, {})).length, 1, 'objects pass through');
  assert.equal((await loadMims(() => ({ mim_id: 'fn', prompts: [] }), {})).length, 1, 'providers are called');

  await assert.rejects(() => loadMims(bad, {}), /File at requested path is not a MIM/);
  await assert.rejects(() => loadMims(join(dir, 'missing.mim'), {}), /MIM not found at requested path/);
  await assert.rejects(() => loadMims(broken, {}), /Unable to parse provided MIM at path/);
});

// ---------------------------------------------------------------------------
// GUI thresholds, cancellation and the tracking-error contract

test('DISPLAY escalation honors no_matches_for_gui/no_inputs_for_gui and ships the cancel action', () => {
  const mim = { mim_id: 'gui', no_matches_for_gui: 2, no_inputs_for_gui: 3, gui: { type: 'Javascript', data: 'viewData' } };
  assert.equal(generateDisplay(mim, { noMatch: 1, noInput: 1 }, null, null), undefined, 'below both thresholds');
  const shown = generateDisplay(mim, { noMatch: 2, noInput: 0 }, { viewConfig: { type: 'x' } }, null);
  assert.ok(shown, 'noMatch at the threshold shows the view');
  assert.deepEqual(Object.keys(shown), ['id', 'type', 'name', 'view', 'layer', 'overlay', 'visible', 'keepDisplay', 'onCancel']);
  assert.equal(shown.name, 'PEGASUS_VIEW');
  // resolveView merges the evaluated skill view data over mim.gui (Slimmer.ts:236-276).
  assert.deepEqual(shown.view, { type: 'SKILL', name: 'MIM_VIEW', context: { type: 'Javascript', data: { viewConfig: { type: 'x' } } } });
  assert.deepEqual(shown.onCancel, [{ type: 'HIDE_DISPLAY', name: 'HIDE_MIM_VIEW' }]);
  const noInput = generateDisplay(mim, { noMatch: 0, noInput: 3 }, { viewConfig: {} }, null);
  assert.ok(noInput, 'noInput at the threshold shows the view');
  assert.equal(generateDisplay({ mim_id: 'nogui' }, { noMatch: 9, noInput: 9 }, null, null), undefined, 'no gui block -> no DISPLAY');
});

test('uninitialized MIM session state raises the source tracking error', () => {
  const mim = { mim_id: 'x', mim_type: 'announcement', prompts: [] };
  assert.throws(
    () => generateSlimFromMim(mim, { category: PromptCategory.ERROR, subCategory: PromptSubCategory.NO_MATCH, index: 1 }, buildPromptData({}), { data: { skill: { session: { data: {} } } } }),
    /Skill data MIM state tracking has not been initialized; cannot track state\./,
  );
  // With initialized state the same call flips the max flag instead (Slimmer.ts:170-176).
  const state = newMimState();
  const slim = generateSlimFromMim(mim, { category: PromptCategory.ERROR, subCategory: PromptSubCategory.NO_MATCH, index: 1 }, buildPromptData({}), { data: { skill: { session: { data: { _mim: state } } } } });
  assert.equal(slim, null);
  assert.equal(state.noMatchMax, true);
});

test('generateSlimSequence emits a SEQUENCE of announcement SLIMs and rejects non-announcements', async () => {
  const providers = { mimDataProvider: [{ ...AN_MIM, mim_id: 'a1' }, { ...AN_MIM, mim_id: 'a2' }] };
  const data = { skill: { session: { data: { _mim: newMimState() } } } };
  const seq = await generateSlimSequence({ category: PromptCategory.ENTRY, subCategory: PromptSubCategory.ANNOUNCEMENT, index: 0, noMatch: 0, noInput: 0 }, providers, data, { rng: () => 0 });
  assert.deepEqual(Object.keys(seq), ['id', 'type', 'children']);
  assert.equal(seq.type, 'SEQUENCE');
  assert.equal(seq.children.length, 2);
  assert.deepEqual(seq.children.map((c) => c.type), ['SLIM', 'SLIM']);
  assert.deepEqual(seq.children.map((c) => c.config.play.meta.mim_id), ['a1', 'a2']);

  await assert.rejects(
    () => generateSlimSequence({ category: PromptCategory.ENTRY, subCategory: PromptSubCategory.ANNOUNCEMENT }, { mimDataProvider: [{ ...AN_MIM, mim_type: 'question' }] }, data, { rng: () => 0 }),
    /SlimSequences can only contain Announcements/,
  );
});

test('captured reference DISPLAY and LISTEN nodes rebuild exactly from the pinned builders', () => {
  // These nodes come from the production-smoke capture of the real cloud, so they pin the
  // display/cancellation and listen trees against reference output rather than a hand-written shape.
  const display = firstGoldenNode('DISPLAY');
  assert.deepEqual(Object.keys(display), ['id', 'type', 'name', 'view', 'layer', 'visible', 'keepDisplay', 'onCancel']);
  const rebuiltDisplay = displayProtocol(display.name, display.view, display.layer, display.visible, display.keepDisplay, display.onCancel);
  assert.deepEqual(Object.keys(rebuiltDisplay), ['id', 'type', 'name', 'view', 'layer', 'overlay', 'visible', 'keepDisplay', 'onCancel']);
  assert.deepEqual(maskIds(JSON.parse(JSON.stringify(rebuiltDisplay))), maskIds(display));
  assert.deepEqual(rebuiltDisplay.onCancel, [{ type: 'HIDE_DISPLAY', name: 'HIDE_MIM_VIEW' }]);
  assert.equal(rebuiltDisplay.view.name, 'MIM_VIEW');
  assert.equal(rebuiltDisplay.view.type, 'SKILL');
  assert.equal(rebuiltDisplay.view.context.type, 'Javascript');
  assert.ok(rebuiltDisplay.view.context.data.viewConfig, 'skill view data is carried as context.data');

  const listen = firstGoldenNode('LISTEN');
  assert.deepEqual(Object.keys(listen), ['id', 'type', 'contexts']);
  const rebuiltListen = listenProtocol(listen.contexts);
  assert.deepEqual(Object.keys(rebuiltListen), ['id', 'type', 'contexts', 'intents']);
  assert.deepEqual(maskIds(JSON.parse(JSON.stringify(rebuiltListen))), maskIds(listen));
});

// ---------------------------------------------------------------------------
// Dice/Coin prompt data

test('Dice and Coin reproduce the source constructors under an injected rng', () => {
  const zero = new Dice(6, () => 0);
  assert.deepEqual([zero.a, zero.b], [1, 1]);
  const top = new Dice(20, () => 0.999999);
  assert.deepEqual([top.a, top.b], [20, 20]);
  assert.deepEqual(Object.keys(zero), ['a', 'b']);

  assert.equal(new Coin(() => 0.49).a, 'tails');
  assert.equal(new Coin(() => 0.5).a, 'heads');
  assert.equal(new Coin(() => 0.999).a, 'heads');
  assert.deepEqual(Object.keys(new Coin(() => 0)), ['a']);
});
