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

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveLlmProvider, llmRequestHeaders, llmCompletionsUrl } from '../../packages/contracts/src/llmProvider.js';
import { LLM_INTENT_TOOLS } from '../../packages/nlu/src/llmFallback.js';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../..');

// Everyday utterances, each labelled with the intent the real Jibo would have
// produced. Names verified present in the rule sources / Dialogflow agent.
const LABELLED = [
  // clock
  ['what time is it', 'askForTime'],
  ["what's the date today", 'askForDate'],
  ['set a timer for five minutes', 'timerValue'],
  ['set an alarm for seven a m', 'set'],
  ['when is christmas', 'whenIsHoliday'],
  // globals
  ['turn up the volume', 'volumeUp'],
  ['turn it down a bit', 'volumeDown'],
  ['set the volume to five', 'volumeToValue'],
  ['go to the main menu', 'mainMenu'],
  ['what can you do', 'whatCanIDo'],
  ['thank you', 'thanks'],
  ['say that again', 'repeat'],
  ['go to sleep', 'sleep'],
  // hue-control
  ['turn on the lights', 'lightsOn'],
  ['turn off the lights', 'lightsOff'],
  ['make the lights warmer', 'lightsWarm'],
  ['dim the lights', 'lightsDown'],
  // radio
  ['what song is this', 'get_track'],
  ['what stations do you have', 'showStations'],
  // report
  ['how is my commute', 'requestCommute'],
  ["what's on my calendar", 'requestCalendar'],
  ["what's in the news", 'requestNews'],
  // create / gallery
  ['take a picture', 'createOnePhoto'],
  ['record a video', 'createVideo'],
  ['open the gallery', 'galleryOpen'],
  // who-am-i, greetings, settings
  ['who am i', 'launchWhoAmI'],
  ['good morning', 'goodMorning'],
  ['goodbye', 'goodBye'],
  ['hey jibo', 'heyJibo'],
  ['how much battery do you have', 'battery'],
  ['are you connected to wifi', 'wifiStatus'],
  // chitchat
  ['tell me a knock knock joke', 'jokeKnockKnock'],
  ["what's the weather tomorrow", 'requestWeather'],
  ['do you like pizza', 'doesJiboLikeThing'],
  ['tell me about yourself', 'requestTellAboutYourself'],
  ['dance for me', 'requestDance'],
  ['tell me a story', 'requestStory'],
  ['who is alexa', 'whoIsPerson'],
  ['sing me a song', 'requestSingSong'],
  // nothing should claim this
  ['asdfgh qwerty zxcvb', 'unknown'],
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

async function classify(provider, tools, text) {
  const res = await fetch(llmCompletionsUrl(provider), {
    method: 'POST',
    headers: llmRequestHeaders(provider),
    body: JSON.stringify({
      model: provider.model,
      messages: [
        { role: 'system', content: 'Classify the user utterance into exactly one tool. If none fits, call unknown.' },
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

  const idle = generated.filter((tool) => tool.launch);
  const utility = idle.filter((tool) => tool.scope !== 'chitchat');
  const chitchat = idle.filter((tool) => tool.scope === 'chitchat' || tool.name === 'unknown');

  const arms = {
    hand15: { tools: toolsFrom(LLM_INTENT_TOOLS), size: LLM_INTENT_TOOLS.length },
    flat: { tools: toolsFrom(idle), size: idle.length },
    tiered: { tools: toolsFrom(utility), fallback: toolsFrom(chitchat), size: utility.length, fallbackSize: chitchat.length },
  };

  const wanted = (process.argv.includes('--arms')
    ? process.argv[process.argv.indexOf('--arms') + 1].split(',')
    : Object.keys(arms)).filter((name) => arms[name]);

  console.log(`model: ${provider.model}`);
  console.log(`arms: ${wanted.map((n) => `${n} (${arms[n].size}${arms[n].fallbackSize ? `+${arms[n].fallbackSize}` : ''} tools)`).join(', ')}\n`);

  const results = {};
  for (const name of wanted) {
    const arm = arms[name];
    results[name] = await mapLimit(LABELLED, 6, async ([text]) => {
      let got = await classify(provider, arm.tools, text);
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
    const [text, want] = LABELLED[i];
    console.log(`${text}\n   want     ${want}`);
    for (const name of wanted) {
      const got = results[name][i];
      const hit = got.intent === want;
      if (hit) score[name] += 1;
      const ents = got.entities && Object.keys(got.entities).length ? ` ${JSON.stringify(got.entities)}` : '';
      console.log(`   ${name.padEnd(width)} ${hit ? '✓' : '✗'} ${got.error || got.intent}${ents}`);
    }
  }

  console.log('\ncorrect intent name:');
  for (const name of wanted) {
    console.log(`   ${name.padEnd(width)} ${score[name]}/${LABELLED.length}`);
  }
}

main().catch((error) => { console.error(error.message); process.exit(1); });
