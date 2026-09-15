// The generated intent catalog must keep describing Jibo's real intent surface.
//
// These assert facts about the reference tree, not about the generator's taste,
// so a regression in the extractor fails a named test rather than quietly
// shrinking the catalog.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFstIntents, renderExample } from './fstIntents.mjs';
import { buildCatalog } from './build.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../..');
const RULES = join(
  repo,
  '.parity/reference/5c0a7390539663ba749d360de348a428c088505c',
  'packages/parser/robust-parser/rules_src',
);

const fst = readFstIntents(RULES);
const catalog = buildCatalog();
const byName = new Map(catalog.map((tool) => [tool.name, tool]));

test('the rule sources carry the intent surface, not the Dialogflow agent', () => {
  // 611 by a raw grep of intent literals; the parse keeps essentially all of
  // them. A big drop means the production splitter broke.
  assert.ok(fst.size > 580, `expected >580 rule intents, got ${fst.size}`);
  // The Dialogflow agent has 99 intents and no utility among them.
  assert.ok(catalog.length > 600, `expected >600 catalog tools, got ${catalog.length}`);
});

test('every utility the Dialogflow-only catalog lost is present under its real name', () => {
  for (const name of [
    'askForTime', 'askForDate', 'timerValue', 'alarmValue',
    'volumeUp', 'volumeDown', 'volumeToValue',
    'lightsOn', 'lightsOff', 'lightsWarm', 'lightsDown',
    'get_track', 'showStations',
    'createOnePhoto', 'createVideo', 'galleryOpen',
    'requestCommute', 'requestCalendar', 'requestNews',
    'launchWhoAmI', 'goodBye', 'goodMorning', 'heyJibo',
    'battery', 'wifiStatus',
    'jokeKnockKnock', 'jokeChickenCrossRoad', 'jokeDentistTime',
  ]) {
    assert.ok(byName.has(name), `${name} missing from the catalog`);
  }
});

test('the hand-written catalog\'s invented names are not real Jibo intents', () => {
  // Ten of its fifteen. Keeping this as a test stops anyone reintroducing them.
  for (const invented of [
    'whatTimeIsIt', 'whoAmI', 'tellAJoke', 'launchSkill', 'tellMeAboutYourself',
    'doYouLike', 'tellMeATip', 'goodbye', 'chitchat',
  ]) {
    assert.ok(!byName.has(invented), `${invented} is not a real intent but is in the catalog`);
  }
  // The five that are real.
  for (const real of ['whatsUp', 'thanks', 'cancel', 'yes', 'no']) {
    assert.ok(byName.has(real), `${real} is a real intent and should be present`);
  }
});

test('slots stay attached to the intent that fills them', () => {
  // askForTime and timerValue are declared in the same rule set. Reading slots
  // from the whole production instead of the intent's own semantic-action
  // cluster smears one onto the other.
  const time = Object.keys(byName.get('askForTime').entities.properties).sort();
  assert.deepEqual(time, ['city', 'country', 'day_of_week', 'state']);

  const timer = Object.keys(byName.get('timerValue').entities.properties).sort();
  assert.deepEqual(timer, ['hours', 'minutes', 'seconds']);

  assert.deepEqual(Object.keys(byName.get('volumeToValue').entities.properties), ['volumeLevel']);
});

test('launch reachability separates idle intents from in-skill ones', () => {
  // From idle Jibo hears the union of every launch.rule, plus globals. A timer
  // value or a track query only exists once that skill is running, which is why
  // "set a timer for five minutes" resolves to the clock skill's `start`.
  assert.equal(byName.get('timerValue').launch, false);
  assert.equal(byName.get('get_track').launch, false);
  assert.equal(byName.get('createVideo').launch, false);

  assert.equal(byName.get('start').launch, true);
  assert.equal(byName.get('showStations').launch, true);
  assert.equal(byName.get('askForTime').launch, true);

  // globals has no launch.rule because it is never launched into; it is simply
  // always loaded, so scope carries it instead.
  assert.equal(byName.get('volumeUp').scope, 'global');

  const idle = catalog.filter((tool) => tool.launch || tool.scope === 'global');
  assert.ok(idle.length > 520, `expected >520 idle-reachable intents, got ${idle.length}`);
});

test('a tool carries a usable description', () => {
  const described = catalog.filter((tool) => tool.description.startsWith('e.g.'));
  assert.ok(
    described.length / catalog.length > 0.9,
    `only ${described.length}/${catalog.length} tools have an example`,
  );
  // Dialogflow training phrases are verbatim human text and win over anything
  // rendered out of the grammar.
  assert.match(byName.get('requestWeather').description, /e\.g\. "/);
});

test('renderExample reads the grammar rather than echoing it', () => {
  assert.equal(renderExample('($SOMETHING $w03)'), null, 'references alone are not speech');
  assert.equal(renderExample('RULE = (knock knock)'), 'knock knock', 'the rule name is not speech');
  // A word-form bracket is one word, not two.
  assert.equal(renderExample('([present?s])'), 'presents');
  assert.equal(renderExample('([mak(e|(ing))] a cake)'), 'making a cake');
  // The richest branch of an alternation reads best.
  assert.equal(renderExample('(hi | (good morning to you))'), 'good morning to you');
});

test('provenance is recorded for every tool', () => {
  for (const tool of catalog) {
    assert.equal(tool.source.reference, '5c0a7390539663ba749d360de348a428c088505c');
    assert.ok(
      tool.source.fst.length > 0 || tool.source.dialogflow,
      `${tool.name} claims neither a rule file nor a Dialogflow intent`,
    );
  }
});
