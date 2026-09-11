// S-05 live-entrypoint smoke.
//
// Drives a REAL vendored seasonal MIM through the runtime entrypoint the skill
// service uses (`generateSlimFromMim`), with PromptData built from a live
// runtime context whose only variation is the location ISO.  This shows the
// seasonal window, the date phrasing and the location city reaching rendered
// ESML, not just unit-level helpers.
//
// usage: S05_CANDIDATE_ROOT=/path/to/phoenix node s05-runtime-smoke.mjs
import { readFileSync } from 'node:fs';

const root = process.env.S05_CANDIDATE_ROOT || '/phoenix';
const { buildPromptData, generateSlimFromMim, PromptCategory, PromptSubCategory } = await import(`${root}/packages/skills/src/index.js`);

const MIM = JSON.parse(readFileSync(
  `${root}/packages/skills/resources/mims/chitchat/scripted-responses/RI_USR_WhatShouldDoForThanksgiving.mim`, 'utf8'));

const runtime = (iso) => ({
  location: { iso, city: 'boston', state: 'Massachusetts', stateAbbr: 'ma', country: 'usa', countryCode: 'US', lat: 42.313352, lng: -71.1273681 },
  loop: {
    owner: 'owner',
    jibo: { id: 'jibo', birthdate: Date.parse('2017-05-19T20:27:05.271Z'), color: 'WHITE' },
    users: [
      { id: 'owner', birthdate: Date.parse('1980-05-22T00:00:00.000Z'), gender: 'male', phoneticName: 'George', firstName: 'George', lastName: 'Jetson' },
      { id: 'speaker', birthdate: Date.parse('1984-02-02T00:00:00.000Z'), gender: 'female', phoneticName: 'Jane', firstName: 'Jane', lastName: 'Jetson' },
    ],
  },
  perception: { peoplePresent: [], speaker: 'speaker' },
  character: { emotion: { confidence: 0.2, valence: 0.45, name: 'NEUTRAL' } },
  dialog: { referent: null },
});

const probes = [
  ['2020-11-01T18:00:00.000-05:00', '2020-11-01T23:00:00.000Z', 'in season window 9/1-11/23'],
  ['2020-12-05T18:00:00.000-05:00', '2020-12-05T23:00:00.000Z', 'in season window 11/24-1/31'],
  ['2020-06-15T18:00:00.000-05:00', '2020-06-15T22:00:00.000Z', 'outside both windows'],
  ['2020-11-01T00:05:00.000+05:30', '2020-10-31T18:35:00.000Z', 'wall clock 00:05 on Nov 1 (+05:30 offset)'],
  ['2020-12-05T00:05:00.000+09:00', '2020-12-04T15:05:00.000Z', 'wall clock 00:05 on Dec 5 (+09:00 offset)'],
];

const results = [];
for (const [iso, now, label] of probes) {
  const originalNow = Date.now;
  Date.now = () => Date.parse(now);
  try {
    const promptData = buildPromptData(runtime(iso));
    const slim = generateSlimFromMim(
      MIM,
      { category: PromptCategory.ENTRY, subCategory: PromptSubCategory.AN },
      promptData,
      { rng: () => 0 },
    );
    results.push({
      label, iso, now,
      dt: { date: promptData.dt.date, day: promptData.dt.day, weekOfYear: promptData.dt.weekOfYear, now: String(promptData.dt.now) },
      seasonal1: promptData.dt.now.isInRange('9/1', '11/23'),
      seasonal2: promptData.dt.now.isInRange('11/24', '1/31'),
      esml: slim && slim.play && slim.play.esml,
      promptId: slim && slim.play && slim.play.promptId,
    });
  } finally {
    Date.now = originalNow;
  }
}
process.stdout.write(`${JSON.stringify({ mim: 'RI_USR_WhatShouldDoForThanksgiving', results }, null, 1)}\n`);
