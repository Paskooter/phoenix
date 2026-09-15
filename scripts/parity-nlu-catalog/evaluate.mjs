#!/usr/bin/env node
// Measure the intent catalogs against Jibo's REAL intent names.
//
// The bar is not "did the model pick something". It is "did the model emit a
// name a Jibo handler actually answers to". By that bar the hand-written
// 15-tool catalog cannot score at all on most utterances: 10 of its 15 names
// (whatTimeIsIt, whoAmI, tellAJoke, launchSkill, ...) are invented and appear
// in neither the rule sources nor the Dialogflow agent.
//
// Three arms:
//   hand15    the catalog Phoenix shipped
//   flat      every intent reachable from idle in one call (531 tools)
//   tiered    the runtime's own cascade: the high-priority utility/launch set
//             first, falling through to the open-domain chitchat set, which is
//             exactly the job Dialogflow's ML did behind the rules
//
// Usage: node scripts/parity-nlu-catalog/evaluate.mjs [--arms hand15,flat,tiered]

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveLlmProvider, llmRequestHeaders, llmCompletionsUrl } from '../../packages/contracts/src/llmProvider.js';
import { LLM_INTENT_TOOLS } from '../../packages/nlu/src/llmFallback.js';
import { fullParse } from '../../packages/nlu/src/fullGrammar.js';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../..');

// Everyday utterances, each labelled with what the real Jibo would have
// produced FROM IDLE, with no skill running.
//
// Context is part of the label, not a detail. The same words resolve to
// different intents depending on what is loaded: from idle "set a timer for
// five minutes" is the clock skill's `start`, because `timerValue` only exists
// once clock is running and its timer_set_value rule set is loaded. An earlier
// version of this file labelled the in-skill intent and so scored every arm
// against an answer none of them could correctly give.
//
// `accept` lists every intent that is genuinely right here. Some utterances
// have two: the globals rule set and chitchat both stay live at idle and both
// define a form of thanks / repeat / weather, and which one wins is the rule
// engine's priority arbitration, not a fact about the utterance.
const LABELLED = [
  // clock
  { text: 'what time is it', accept: ['askForTime'] },
  { text: "what's the date today", accept: ['askForDate'] },
  { text: 'set a timer for five minutes', accept: ['start', 'set'], note: 'timerValue is in-skill only' },
  { text: 'set an alarm for seven a m', accept: ['set'] },
  { text: 'when is christmas', accept: ['whenIsHoliday'] },
  // globals
  { text: 'turn up the volume', accept: ['volumeUp'] },
  { text: 'turn it down a bit', accept: ['volumeDown'] },
  { text: 'set the volume to five', accept: ['volumeToValue'] },
  { text: 'go to the main menu', accept: ['launchMainMenu', 'mainMenu'] },
  { text: 'what can you do', accept: ['whatCanIDo'] },
  { text: 'thank you', accept: ['thanks', 'thankJiboForAction'] },
  { text: 'say that again', accept: ['repeat', 'requestRepeat'] },
  { text: 'go to sleep', accept: ['sleep'] },
  // hue-control
  { text: 'turn on the lights', accept: ['lightsOn'] },
  { text: 'turn off the lights', accept: ['lightsOff'] },
  { text: 'make the lights warmer', accept: ['lightsWarm'] },
  { text: 'dim the lights', accept: ['lightsDown'] },
  // radio: showStations launches the skill; get_track needs it already running
  { text: 'what stations do you have', accept: ['showStations'] },
  { text: 'what song is this', accept: ['unknown'], note: 'get_track is in-skill only' },
  // report
  { text: 'how is my commute', accept: ['requestCommute'] },
  { text: "what's on my calendar", accept: ['requestCalendar'] },
  { text: "what's in the news", accept: ['requestNews'] },
  // create / gallery
  { text: 'take a picture', accept: ['createOnePhoto'] },
  { text: 'record a video', accept: ['requestRecordVideo', 'createVideo'] },
  { text: 'open the gallery', accept: ['galleryOpen'] },
  // who-am-i, greetings, settings
  { text: 'who am i', accept: ['launchWhoAmI'] },
  { text: 'good morning', accept: ['goodMorning'] },
  { text: 'goodbye', accept: ['goodBye'] },
  { text: 'hey jibo', accept: ['heyJibo'] },
  { text: 'how much battery do you have', accept: ['battery'] },
  { text: 'are you connected to wifi', accept: ['wifiStatus'] },
  // chitchat
  { text: 'tell me a knock knock joke', accept: ['jokeKnockKnock'] },
  { text: "what's the weather tomorrow", accept: ['requestWeather', 'requestWeatherPR'] },
  { text: 'do you like pizza', accept: ['doesJiboLikeThing'] },
  { text: 'tell me about yourself', accept: ['requestTellAboutYourself'] },
  { text: 'dance for me', accept: ['requestDance'] },
  { text: 'tell me a story', accept: ['requestStory'] },
  { text: 'who is alexa', accept: ['whoIsPerson'] },
  { text: 'sing me a song', accept: ['requestSingSong'] },
  // nothing should claim this
  { text: 'asdfgh qwerty zxcvb', accept: ['unknown'] },
];

function toolsFrom(catalog) {
  return catalog.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.entities || { type: 'object', properties: {} },
    },
  }));
}

const CLASSIFY = 'Classify the user utterance into exactly one tool. If none fits, call unknown.';
// The utility tier is the runtime's HIGH-priority stage: it only matches device
// and skill commands, and everything else is the open-domain stage's job. Told
// only to "pick one", it reaches for the nearest utility tool instead of
// deferring, which is how requestWeatherPR, `like` and selfID beat the correct
// chitchat intents in the first measured run.
const CLASSIFY_UTILITY = [
  'These tools are device and skill commands only.',
  'Call one ONLY if the utterance is clearly such a command.',
  'Conversation, questions, opinions, greetings, jokes and small talk are handled elsewhere:',
  'for those, call unknown. When in doubt, call unknown.',
].join(' ');

async function classify(provider, tools, text, system = CLASSIFY) {
  const res = await fetch(llmCompletionsUrl(provider), {
    method: 'POST',
    headers: llmRequestHeaders(provider),
    body: JSON.stringify({
      model: provider.model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: `Utterance: "${text}"` },
      ],
      tools,
      tool_choice: 'auto',
      temperature: 0,
    }),
  });
  if (!res.ok) return { error: `${res.status} ${(await res.text()).slice(0, 160)}` };
  const body = await res.json();
  const call = body?.choices?.[0]?.message?.tool_calls?.[0];
  if (!call?.function?.name) return { intent: 'unknown' };
  let entities = {};
  try { entities = JSON.parse(call.function.arguments || '{}'); } catch { /* keep empty */ }
  return { intent: call.function.name, entities };
}

/** Bounded concurrency, so a 40-utterance arm does not take 40 round trips. */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next;
      next += 1;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  }));
  return out;
}

async function main() {
  const provider = resolveLlmProvider('parser', { defaultModel: 'gemma-3' });
  if (!provider.configured) {
    console.error('no LLM configured: set PHOENIX_LLM_URL / PHOENIX_LLM_MODEL / PHOENIX_LLM_API_KEY');
    process.exit(2);
  }

  const generated = JSON.parse(
    readFileSync(join(repo, 'packages/nlu/src/generatedIntentCatalog.json'), 'utf8'),
  ).tools;

  // Always-live set: every launch.rule intent plus globals, which has no
  // launch.rule of its own because it is never launched into -- it is simply
  // always loaded. Filtering on `launch` alone silently drops volumeUp,
  // volumeDown, volumeToValue, thanks, repeat, sleep and mainMenu.
  const idle = generated.filter((tool) => tool.launch || tool.scope === 'global');
  const utility = idle.filter((tool) => tool.scope !== 'chitchat');
  const chitchat = idle.filter((tool) => tool.scope === 'chitchat' || tool.name === 'unknown');

  const arms = {
    grammar: { size: 'rules' },
    hand15: { tools: toolsFrom(LLM_INTENT_TOOLS), size: LLM_INTENT_TOOLS.length },
    flat: { tools: toolsFrom(idle), size: idle.length },
    tiered: {
      tools: toolsFrom(utility),
      system: CLASSIFY_UTILITY,
      fallback: toolsFrom(chitchat),
      size: utility.length,
      fallbackSize: chitchat.length,
    },
  };

  const wanted = (process.argv.includes('--arms')
    ? process.argv[process.argv.indexOf('--arms') + 1].split(',')
    : Object.keys(arms)).filter((name) => arms[name]);

  console.log(`model: ${provider.model}`);
  console.log(`arms: ${wanted.map((n) => `${n} (${arms[n].size}${arms[n].fallbackSize ? `+${arms[n].fallbackSize}` : ''}${n === 'grammar' ? '' : ' tools'})`).join(', ')}\n`);

  const results = {};
  if (wanted.includes('grammar')) {
    // Phoenix's existing rule engine, offline. This is the stage the LLM only
    // ever backs up, so its score is the bar any catalog has to clear.
    results.grammar = LABELLED.map(({ text }) => {
      try {
        const parsed = fullParse(text);
        return { intent: parsed?.intent ?? parsed?.nlu?.intent ?? 'unknown' };
      } catch (error) { return { error: error.message }; }
    });
  }
  for (const name of wanted.filter((n) => n !== 'grammar')) {
    const arm = arms[name];
    results[name] = await mapLimit(LABELLED, 6, async ({ text }) => {
      let got = await classify(provider, arm.tools, text, arm.system);
      if (arm.fallback && (got.intent === 'unknown' || got.error)) {
        const second = await classify(provider, arm.fallback, text);
        if (!second.error) got = second;
      }
      return got;
    });
  }

  const score = Object.fromEntries(wanted.map((n) => [n, 0]));
  const width = Math.max(...wanted.map((n) => n.length));
  for (let i = 0; i < LABELLED.length; i += 1) {
    const { text, accept, note } = LABELLED[i];
    console.log(`${text}\n   want     ${accept.join(' | ')}${note ? `   (${note})` : ''}`);
    for (const name of wanted) {
      const got = results[name][i];
      const hit = accept.includes(got.intent);
      if (hit) score[name] += 1;
      const ents = got.entities && Object.keys(got.entities).length ? ` ${JSON.stringify(got.entities)}` : '';
      console.log(`   ${name.padEnd(width)} ${hit ? '✓' : '✗'} ${got.error || got.intent}${ents}`);
    }
  }

  console.log('\ncorrect intent name:');
  for (const name of wanted) {
    console.log(`   ${name.padEnd(width)} ${score[name]}/${LABELLED.length}`);
  }

  const out = join(here, 'results.json');
  writeFileSync(out, `${JSON.stringify({
    model: provider.model,
    arms: Object.fromEntries(wanted.map((n) => [n, {
      tools: arms[n].size, fallbackTools: arms[n].fallbackSize || 0, correct: score[n], of: LABELLED.length,
    }])),
    utterances: LABELLED.map(({ text, accept }, i) => ({
      text,
      accept,
      got: Object.fromEntries(wanted.map((n) => [n, results[n][i].error || results[n][i].intent])),
    })),
  }, null, 2)}\n`);
  console.log(`\nwrote ${out}`);
}

main().catch((error) => { console.error(error.message); process.exit(1); });
