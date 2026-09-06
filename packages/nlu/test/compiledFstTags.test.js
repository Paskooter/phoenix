import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ConnectedFstExecutor } from '../src/connectedFst.js';
import { VectorStandardFst, compiledFstConstants } from '../src/compiledFst.js';
import { interpretOutputSymbols, pairCompilerMarkers } from '../src/compiledFstInterpreter.js';

const {
  CHARACTER_START,
} = compiledFstConstants;

const referenceRoot = process.env.N08_REFERENCE_ROOT
  || '/home/shell/work/phoenix/.parity/reference/5c0a7390539663ba749d360de348a428c088505c';
const launchPath = `${referenceRoot}/packages/parser/robust-parser/rules_fst/launch.fst`;
const factoryDir = `${referenceRoot}/packages/parser/robust-parser/build/data/en-us/factory_rules`;

function writeString(chunks, value) {
  const bytes = Buffer.from(value, 'utf8');
  const length = Buffer.alloc(4);
  length.writeInt32LE(bytes.length);
  chunks.push(length, bytes);
}

function writeSymbols(chunks, entries) {
  const magic = Buffer.alloc(4);
  magic.writeInt32LE(0x7eb2fb74);
  chunks.push(magic);
  writeString(chunks, '');
  const available = Buffer.alloc(8); available.writeBigInt64LE(1_000_000_000n); chunks.push(available);
  const count = Buffer.alloc(8); count.writeBigInt64LE(BigInt(entries.length)); chunks.push(count);
  for (const [label, symbol] of entries) {
    writeString(chunks, symbol);
    const key = Buffer.alloc(8); key.writeBigInt64LE(BigInt(label)); chunks.push(key);
  }
}

function fixtureFst(states, outputSymbols = []) {
  const chunks = [];
  const magic = Buffer.alloc(4); magic.writeInt32LE(0x7eb2fdd6); chunks.push(magic);
  writeString(chunks, 'vector'); writeString(chunks, 'standard');
  const version = Buffer.alloc(4); version.writeInt32LE(2); chunks.push(version);
  const flags = Buffer.alloc(4); flags.writeInt32LE(3); chunks.push(flags);
  const properties = Buffer.alloc(8); properties.writeBigUInt64LE(0n); chunks.push(properties);
  const start = Buffer.alloc(8); start.writeBigInt64LE(0n); chunks.push(start);
  const stateCount = Buffer.alloc(8); stateCount.writeBigInt64LE(BigInt(states.length)); chunks.push(stateCount);
  const ignoredArcs = Buffer.alloc(8); ignoredArcs.writeBigInt64LE(0n); chunks.push(ignoredArcs);
  writeSymbols(chunks, [[0, 'ε'], [1, 'σ']]);
  writeSymbols(chunks, [[0, 'ε'], ...outputSymbols]);
  for (const state of states) {
    const final = Buffer.alloc(4); final.writeFloatLE(state.final === undefined ? Infinity : state.final); chunks.push(final);
    const count = Buffer.alloc(8); count.writeBigInt64LE(BigInt(state.arcs.length)); chunks.push(count);
    for (const arc of state.arcs) {
      const bytes = Buffer.alloc(16);
      bytes.writeInt32LE(arc.ilabel, 0); bytes.writeInt32LE(arc.olabel, 4);
      bytes.writeFloatLE(arc.weight || 0, 8); bytes.writeInt32LE(arc.nextstate, 12);
      chunks.push(bytes);
    }
  }
  return Buffer.concat(chunks);
}

test('pairs source rule and parsed-variable markers in reverse order', () => {
  assert.deepEqual(pairCompilerMarkers([
    'P:',
    'S:',
    'E:{outer} factory:first_name',
    'Q:{outer} ',
  ]), [
    'P:{outer} ',
    'S:{outer} factory:first_name',
    'E:{outer} factory:first_name',
    'Q:{outer} ',
  ]);
});

test('preserves the source empty parsed wrapper around a connected factory', () => {
  assert.deepEqual(pairCompilerMarkers([
    'P:',
    'S:',
    'P:',
    'Q:{first_name} ',
    'E:{ENTITY} factory:first_name',
  ]), [
    'P:',
    'S:{ENTITY} factory:first_name',
    'P:{first_name} ',
    'Q:{first_name} ',
    'E:{ENTITY} factory:first_name',
  ]);
  assert.deepEqual(interpretOutputSymbols([
    'P:',
    'S:',
    'P:',
    'C:195',
    'C:169',
    'Q:{first_name} ',
    'E:{ENTITY} factory:first_name',
    'N:{} {% GivenName = this._parsed %}',
    "N:{} intent = 'factoryWrapper'",
  ]), {
    GivenName: 'é',
    intent: 'factoryWrapper',
  });
});

test('interprets empty entities, UTF-8 parsed bytes, references, and factory cleanup', () => {
  const symbols = [
    'P:', 'S:', 'P:',
    'C:195', 'C:169',
    'N:{first_name} _nl = _parsed',
    'Q:{first_name} ',
    'N:{} _first_name = first_name._nl',
    'N:{} {%delete this.first_name%}',
    'E:{ENTITY} factory:first_name',
    'N:{ENTITY} {% GivenName = this._parsed %}',
    'Q:{ENTITY} ',
    "N:{ROOT} {% Empty='' %}",
    "N:{} {% lowercaseMetadata='value'; _internalMetadata='hidden' %}",
    "N:{} {% intent='tagProbe' %}",
  ];
  assert.deepEqual(interpretOutputSymbols(symbols), {
    GivenName: 'é',
    Empty: '',
    lowercaseMetadata: 'value',
    _internalMetadata: 'hidden',
    intent: 'tagProbe',
  });
});

test('connected executor preserves first equal-cost arc and wildcard/UTF-8 bytes', () => {
  const equalCost = new VectorStandardFst(fixtureFst([
    { arcs: [
      { ilabel: CHARACTER_START + 97, olabel: 2000, nextstate: 1 },
      { ilabel: CHARACTER_START + 97, olabel: 2001, nextstate: 2 },
    ] },
    { arcs: [{ ilabel: CHARACTER_START + 32, olabel: 0, nextstate: 3 }] },
    { arcs: [{ ilabel: CHARACTER_START + 32, olabel: 0, nextstate: 3 }] },
    { final: 0, arcs: [] },
  ], [[2000, "N:{} intent = 'first'"], [2001, "N:{} intent = 'second'"]]));
  const equal = new ConnectedFstExecutor(equalCost, { strictFactories: false }).parse('a').results[0];
  assert.equal(interpretOutputSymbols(equal.outputSymbols).intent, 'first');
  assert.equal(equal.score, 2);
  assert.deepEqual(new ConnectedFstExecutor(equalCost, { strictFactories: false })._inputBytes('a\u00a0b'), [97, 194, 160, 98, 32]);

  const utf8 = new VectorStandardFst(fixtureFst([
    { arcs: [{ ilabel: CHARACTER_START + 195, olabel: 0, nextstate: 1 }] },
    { arcs: [{ ilabel: CHARACTER_START + 169, olabel: 0, nextstate: 2 }] },
    { arcs: [{ ilabel: CHARACTER_START + 32, olabel: 2000, nextstate: 3 }] },
    { final: 0, arcs: [] },
  ], [[2000, "N:{} intent = 'utf8'" ]]));
  const utf8Result = new ConnectedFstExecutor(utf8, { strictFactories: false }).parse('é').results[0];
  assert.equal(interpretOutputSymbols(utf8Result.outputSymbols).intent, 'utf8');
});

test('connected factory graphs are distinct per parent call site', () => {
  const directory = mkdtempSync(join(tmpdir(), 'phoenix-fst-callsite-'));
  try {
    writeFileSync(join(directory, 'same.fst'), fixtureFst([{ final: 0, arcs: [] }]));
    const top = new VectorStandardFst(fixtureFst([{ final: 0, arcs: [] }]));
    const executor = new ConnectedFstExecutor(top, { factoryDir: directory });

    // The native connected_fst cache key is parent node + factory symbol. A
    // repeated arc at one site reuses its child, while another site gets a
    // separate return-arc set even when the factory filename is identical.
    const first = executor._loadFactory('same', 0, 7);
    assert.equal(executor._loadFactory('same', 0, 7), first);
    const second = executor._loadFactory('same', 0, 8);
    assert.notEqual(second, first);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('pinned launch union follows connected factory links and retains complete tags', { skip: !existsSync(launchPath) }, () => {
  const executor = ConnectedFstExecutor.fromFile(launchPath, { factoryDir });
  const controls = [
    ['can you feed george', { GivenName: 'george', Action: 'DoHouseholdChore', intent: 'canJiboAction', priority: 'HIGH', union_original_fst_name: 'handle:chitchat/launch' }, 19.3008],
    ['who is jane jetson', { GivenName: 'jane', intent: 'whoIsPerson', priority: 'HIGH', union_original_fst_name: 'handle:chitchat/launch' }, 7.50098],
    ['have you met darth vader', { GivenName: '', intent: 'hasJiboMetPerson', priority: 'HIGH', union_original_fst_name: 'handle:chitchat/launch' }, 9],
    ['how do you feel about the national debt', { GivenName: '', intent: 'doesJiboHaveOpinionAboutThing', priority: 'HIGH', union_original_fst_name: 'handle:chitchat/launch' }, 22],
    ['what should i get for my birthday', { Holiday: 'SpeakerBirthday', intent: 'whatGiftShouldUserReceive', priority: 'HIGH', union_original_fst_name: 'handle:chitchat/launch' }, 30],
    ["what should i get dad for father's day", { FamilyMember: 'SomeFamilyMember', GivenName: '', Holiday: 'FathersDay', intent: 'whatGiftShouldUserGiveHoliday', priority: 'HIGH', union_original_fst_name: 'handle:chitchat/launch' }, 32],
    ['what time is it', { domain: 'clock', intent: 'askForTime', country: 'null', state: 'null', city: 'null', day_of_week: 'null', skill: '@be/clock', priority: 'HIGH', union_original_fst_name: 'handle:clock/launch' }, 16],
    ['did you like christmas', { Holiday: 'Christmas', intent: 'didJiboLikeThing', priority: 'HIGH', union_original_fst_name: 'handle:chitchat/launch' }, 23],
    ['are you getting any present for christmas from santa', { Holiday: 'Christmas', intent: 'didJiboReceiveThing', Objects: 'Gift', Person: 'Santa', priority: 'HIGH', union_original_fst_name: 'handle:chitchat/launch' }, 53],
    ['do you celebrate george birthday', { GivenName: 'george', Holiday: 'PersonBirthday', intent: 'doesJiboCelebrateHoliday', priority: 'HIGH', union_original_fst_name: 'handle:chitchat/launch' }, 32.3008],
    ['what should i get for george birthday', { GivenName: 'george', Holiday: 'PersonBirthday', intent: 'whatGiftShouldUserReceive', priority: 'HIGH', union_original_fst_name: 'handle:chitchat/launch' }, 33.3008],
    ['set a timer for five minutes', { domain: 'timer', intent: 'start', hours: 'null', minutes: '5', seconds: 'null', skill: '@be/clock', priority: 'HIGH', union_original_fst_name: 'handle:clock/launch' }, 27],
    ['play jazz', { intent: 'play', station: 'Jazz', domain: 'radio', skill: '@be/radio', priority: 'HIGH', union_original_fst_name: 'handle:radio/launch' }, 10],
    ['turn on the lights', { intent: 'lightsOn', domain: 'hue-control', skill: '@be/hue-control', priority: 'HIGH', union_original_fst_name: 'handle:hue-control/launch' }, 15],
    ['check my personal report', { intent: 'launchPersonalReport', priority: 'high', union_original_fst_name: 'handle:personal-report/launch' }, 25],
    ["what's on my schedule", { intent: 'requestCalendar', priority: 'high', union_original_fst_name: 'handle:personal-report/launch' }, 16],
    ['launch the news skill', { intent: 'requestNews', priority: 'high', union_original_fst_name: 'handle:personal-report/launch' }, 18],
    ['check the weather', { intent: 'requestWeatherPR', priority: 'high', union_original_fst_name: 'handle:personal-report/launch' }, 14],
  ];
  for (const [text, expected, score] of controls) {
    const result = executor.parse(text);
    assert.equal(result.accepted, true, text);
    assert.deepEqual(interpretOutputSymbols(result.results[0].outputSymbols), expected, text);
    assert.equal(result.results[0].score, score, text);
  }
  for (const text of ['', 'garbage bananas']) {
    const result = executor.parse(text);
    assert.equal(result.accepted, false, text);
    assert.deepEqual(result.results, [], text);
  }
});
