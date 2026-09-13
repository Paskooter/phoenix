'use strict';

const crypto = require('crypto');
const path = require('path');
const { spawnSync } = require('child_process');

const ref = path.resolve(process.argv[2]);
const repeats = Number(process.argv[3] || 5);
const { Chitchat } = require(path.join(ref, 'packages/chitchat-skill/lib/Chitchat.js'));
Chitchat.SEMI_SPECIFIC_LOCATION = path.join(ref, 'packages/chitchat-skill/res/semi_specific_categories');
const { ProcessQueryNode } = require(path.join(ref, 'packages/chitchat-skill/lib/nodes/ProcessQueryNode.js'));

const stems = [
  'RI_JBO_HasOpinionAbout_SS',
  'RI_JBO_Is_SS',
  'RI_JBO_Likes_SS',
];
// These values exercise real overlapping category memberships.  The final six
// pairs in the order receipt are the pairs called out by the S-07 order audit;
// they are retained separately because their CSV value sets are disjoint.
const probes = [
  { id: 'has-opinion-ginger', stem: 'RI_JBO_HasOpinionAbout_SS', value: 'Ginger' },
  { id: 'has-opinion-amish', stem: 'RI_JBO_HasOpinionAbout_SS', value: 'Amish' },
  { id: 'has-opinion-hare-krishna', stem: 'RI_JBO_HasOpinionAbout_SS', value: 'HareKrishna' },
  { id: 'has-opinion-jehovah', stem: 'RI_JBO_HasOpinionAbout_SS', value: 'JehovahSWitnesses' },
  { id: 'has-opinion-mennonite', stem: 'RI_JBO_HasOpinionAbout_SS', value: 'Mennonite' },
  { id: 'has-opinion-rastafarian', stem: 'RI_JBO_HasOpinionAbout_SS', value: 'Rastafarian' },
  { id: 'is-zodiac-exclusive', stem: 'RI_JBO_Is_SS', value: 'Virgo' },
  { id: 'likes-australia', stem: 'RI_JBO_Likes_SS', value: 'Australia' },
  { id: 'likes-coke', stem: 'RI_JBO_Likes_SS', value: 'Coke' },
  { id: 'likes-drink-exclusive', stem: 'RI_JBO_Likes_SS', value: 'Juice' },
  { id: 'has-opinion-fruit-exclusive', stem: 'RI_JBO_HasOpinionAbout_SS', value: 'Boysenberry' },
  { id: 'has-opinion-food-exclusive', stem: 'RI_JBO_HasOpinionAbout_SS', value: 'RoastChicken' },
  { id: 'is-sealife-exclusive', stem: 'RI_JBO_Is_SS', value: 'VioletSeaSnail' },
  { id: 'likes-dinosaur-exclusive', stem: 'RI_JBO_Likes_SS', value: 'Pachycephalosaurus' },
  { id: 'likes-hair-exclusive', stem: 'RI_JBO_Likes_SS', value: 'EtonCrop' },
  { id: 'likes-fruit-exclusive', stem: 'RI_JBO_Likes_SS', value: 'Boysenberry' },
  { id: 'likes-school-exclusive', stem: 'RI_JBO_Likes_SS', value: 'Algebra' },
  { id: 'likes-seafood-exclusive', stem: 'RI_JBO_Likes_SS', value: 'Crab' },
  { id: 'likes-room-exclusive', stem: 'RI_JBO_Likes_SS', value: 'Kitchen' },
];
const reportedPairs = [
  { stem: 'RI_JBO_HasOpinionAbout_SS', left: 'Fruit', right: 'FoodGeneral' },
  { stem: 'RI_JBO_Is_SS', left: 'Zodiac', right: 'Sealife' },
  { stem: 'RI_JBO_Likes_SS', left: 'Drink', right: 'Dinosaur' },
  { stem: 'RI_JBO_Likes_SS', left: 'HairType', right: 'Fruit' },
  { stem: 'RI_JBO_Likes_SS', left: 'ScaryCreature', right: 'RoomInHouse' },
  { stem: 'RI_JBO_Likes_SS', left: 'SchoolSubject', right: 'RoomInHouse' },
  { stem: 'RI_JBO_Likes_SS', left: 'Seafood', right: 'RoomInHouse' },
];
const multiProbes = [
  {
    id: 'likes-australia-then-coke',
    stem: 'RI_JBO_Likes_SS',
    entities: { first: 'Australia', second: 'Coke' },
  },
  {
    id: 'likes-coke-then-australia',
    stem: 'RI_JBO_Likes_SS',
    entities: { first: 'Coke', second: 'Australia' },
  },
];
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');

function matchingCategories(skill, stem, value) {
  const categories = skill.semiSpecificStemMapping[stem] || [];
  return categories.filter(category => {
    const values = skill.semiSpecificCategoryMapping[category];
    return values ? values.indexOf(value) !== -1 : false;
  });
}

function mimDigest(mimID) {
  if (!mimID) return null;
  const file = path.join(ref, 'packages/chitchat-skill/mims/scripted-responses', `${mimID}.mim`);
  return require('fs').existsSync(file)
    ? crypto.createHash('sha256').update(require('fs').readFileSync(file)).digest('hex') : null;
}

function sourceResolve(skill, stem, entities, randomValue) {
  const originalRandom = Math.random;
  Math.random = () => randomValue;
  try {
    // Calling the pinned ProcessQueryNode method itself keeps this probe on the
    // source resolver, including its Object.keys/entity concatenation order and
    // Utils.sample choice, instead of reimplementing those semantics here.
    return ProcessQueryNode.prototype.resolveSemiSpecificMim.call(
      { chitchat: skill }, stem, entities, { warn() {} },
    );
  } finally {
    Math.random = originalRandom;
  }
}

function probeResult(skill, probe) {
  const entities = probe.entities || { value: probe.value };
  const perEntityMatches = Object.keys(entities).map(key => ({
    key,
    value: entities[key],
    categories: matchingCategories(skill, probe.stem, entities[key]),
  }));
  const possible = Object.keys(entities).reduce(
    (out, key) => out.concat(matchingCategories(skill, probe.stem, entities[key])), [],
  );
  return {
    id: probe.id,
    stem: probe.stem,
    entities,
    perEntityMatches,
    possibleCategories: possible,
    first: sourceResolve(skill, probe.stem, entities, 0),
    last: sourceResolve(skill, probe.stem, entities, 0.999999999),
    firstMimSha256: mimDigest(sourceResolve(skill, probe.stem, entities, 0)),
    lastMimSha256: mimDigest(sourceResolve(skill, probe.stem, entities, 0.999999999)),
  };
}

function pairMembership(skill, pair) {
  const values = category => skill.semiSpecificCategoryMapping[category] || [];
  const leftValues = values(pair.left);
  const rightValues = values(pair.right);
  const rightSet = new Set(rightValues);
  return {
    stem: pair.stem,
    left: pair.left,
    right: pair.right,
    leftCount: leftValues.length,
    rightCount: rightValues.length,
    intersection: leftValues.filter(value => rightSet.has(value)),
  };
}

function allPerValueMatchLists(skill) {
  const result = {};
  stems.forEach(stem => {
    const values = new Set();
    (skill.semiSpecificStemMapping[stem] || []).forEach(category => {
      (skill.semiSpecificCategoryMapping[category] || []).forEach(value => values.add(value));
    });
    result[stem] = {};
    Array.from(values).sort().forEach(value => {
      result[stem][value] = matchingCategories(skill, stem, value);
    });
  });
  return result;
}

function verifyAllPerValueResolutions(skill, lists) {
  const rows = [];
  let mismatchCount = 0;
  stems.forEach(stem => {
    Object.keys(lists[stem]).sort().forEach(value => {
      const matches = lists[stem][value];
      const first = sourceResolve(skill, stem, { value }, 0);
      const last = sourceResolve(skill, stem, { value }, 0.999999999);
      const expectedFirst = matches.length ? [stem, matches[0]].join('_') : undefined;
      const expectedLast = matches.length ? [stem, matches[matches.length - 1]].join('_') : undefined;
      if (first !== expectedFirst || last !== expectedLast) mismatchCount += 1;
      rows.push({ stem, value, first, last });
    });
  });
  return {
    total: rows.length,
    mismatchCount,
    firstSha256: digest(rows.map(row => [row.stem, row.value, row.first])),
    lastSha256: digest(rows.map(row => [row.stem, row.value, row.last])),
  };
}

async function initOnce() {
  const skill = new Chitchat();
  await skill.init();
  const selected = {};
  stems.forEach(stem => { selected[stem] = skill.semiSpecificStemMapping[stem]; });
  const perValueMatchLists = allPerValueMatchLists(skill);
  return {
    selected,
    selectedSha256: digest(selected),
    allStemSha256: digest(skill.semiSpecificStemMapping),
    categoryKeySha256: digest(Object.keys(skill.semiSpecificCategoryMapping)),
    counts: {
      scripted: skill.scriptedResponseMiMSet.size,
      emotion: skill.emotionResponseMiMSet.size,
      fallback: skill.fallbackResponseMiMSet.size,
      categories: Object.keys(skill.semiSpecificCategoryMapping).length,
    },
    probes: probes.map(probe => probeResult(skill, probe)),
    multiProbes: multiProbes.map(probe => probeResult(skill, probe)),
    reportedPairs: reportedPairs.map(pair => pairMembership(skill, pair)),
    perValueMatchLists,
    perValueResolutionCheck: verifyAllPerValueResolutions(skill, perValueMatchLists),
  };
}

(async () => {
  if (process.argv[4] === 'clean-child') {
    console.log(`RESULT ${JSON.stringify(await initOnce())}`);
    return;
  }
  const clean = [];
  for (let i = 0; i < repeats; i += 1) {
    const child = spawnSync(process.execPath, [__filename, ref, '1', 'clean-child'], { encoding: 'utf8' });
    if (child.status !== 0) throw new Error(child.stderr || `clean child exited ${child.status}`);
    const line = child.stdout.split(/\r?\n/).find(value => value.indexOf('RESULT ') === 0);
    if (!line) throw new Error(`clean child produced no result: ${child.stdout}`);
    clean.push(JSON.parse(line.slice('RESULT '.length)));
  }
  const runs = clean;
  console.log(JSON.stringify({
    schemaVersion: 1,
    mode: 'source-clean-init',
    sourceRevision: '5c0a7390539663ba749d360de348a428c088505c',
    runtime: process.version,
    repeats,
    runs,
    uniqueSelectedSha256: Array.from(new Set(runs.map(run => run.selectedSha256))),
    uniqueAllStemSha256: Array.from(new Set(runs.map(run => run.allStemSha256))),
    uniqueCategoryKeySha256: Array.from(new Set(runs.map(run => run.categoryKeySha256))),
  }, null, 2));
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
