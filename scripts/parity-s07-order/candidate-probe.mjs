import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { getLibrary, MIM_DIRS } from '../../packages/skills/src/chitchat/library.js';
import { resolveSemiSpecificMim } from '../../packages/skills/src/chitchatSkill.js';

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
const stems = [
  'RI_JBO_HasOpinionAbout_SS',
  'RI_JBO_Is_SS',
  'RI_JBO_Likes_SS',
];
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fileDigest = file => fs.existsSync(file)
  ? crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') : null;

function matchingCategories(lib, stem, value) {
  return (lib.semiSpecificStems[stem] || []).filter(category =>
    (lib.semiSpecificCategories[category] || []).indexOf(value) !== -1);
}

function probeResult(lib, probe) {
  const entities = probe.entities || { value: probe.value };
  const perEntityMatches = Object.keys(entities).map(key => ({
    key,
    value: entities[key],
    categories: matchingCategories(lib, probe.stem, entities[key]),
  }));
  const possibleCategories = Object.keys(entities).reduce(
    (out, key) => out.concat(matchingCategories(lib, probe.stem, entities[key])), [],
  );
  const first = resolveSemiSpecificMim(probe.stem, entities, lib, () => 0);
  const last = resolveSemiSpecificMim(probe.stem, entities, lib, () => 0.999999999);
  const mimPath = id => id ? path.join(MIM_DIRS.SCRIPTED, `${id}.mim`) : null;
  return {
    id: probe.id,
    stem: probe.stem,
    entities,
    perEntityMatches,
    possibleCategories,
    first,
    last,
    firstMimSha256: fileDigest(mimPath(first)),
    lastMimSha256: fileDigest(mimPath(last)),
  };
}

function pairMembership(lib, pair) {
  const values = category => lib.semiSpecificCategories[category] || [];
  const leftValues = values(pair.left);
  const rightSet = new Set(values(pair.right));
  return {
    stem: pair.stem,
    left: pair.left,
    right: pair.right,
    leftCount: leftValues.length,
    rightCount: values(pair.right).length,
    intersection: leftValues.filter(value => rightSet.has(value)),
  };
}

function allPerValueMatchLists(lib) {
  const result = {};
  stems.forEach(stem => {
    const values = new Set();
    (lib.semiSpecificStems[stem] || []).forEach(category => {
      (lib.semiSpecificCategories[category] || []).forEach(value => values.add(value));
    });
    result[stem] = {};
    Array.from(values).sort().forEach(value => {
      result[stem][value] = matchingCategories(lib, stem, value);
    });
  });
  return result;
}

function verifyAllPerValueResolutions(lib, lists) {
  const rows = [];
  let mismatchCount = 0;
  stems.forEach(stem => {
    Object.keys(lists[stem]).sort().forEach(value => {
      const matches = lists[stem][value];
      const first = resolveSemiSpecificMim(stem, { value }, lib, () => 0);
      const last = resolveSemiSpecificMim(stem, { value }, lib, () => 0.999999999);
      const expectedFirst = matches.length ? `${stem}_${matches[0]}` : undefined;
      const expectedLast = matches.length ? `${stem}_${matches[matches.length - 1]}` : undefined;
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

const lib = getLibrary();
const selected = {};
stems.forEach(stem => { selected[stem] = lib.semiSpecificStems[stem]; });
let candidateRevision = 'unknown';
try {
  candidateRevision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: process.cwd(), encoding: 'utf8' }).trim();
} catch {}
const perValueMatchLists = allPerValueMatchLists(lib);
const result = {
  schemaVersion: 1,
  mode: 'candidate-library-order',
  candidateRevision,
  runtime: process.version,
  selected,
  selectedSha256: digest(selected),
  allStemSha256: digest(lib.semiSpecificStems),
  categoryKeySha256: digest(Object.keys(lib.semiSpecificCategories)),
  counts: {
    scripted: lib.scripted.size,
    emotion: lib.emotion.size,
    fallback: lib.fallback.size,
    categories: Object.keys(lib.semiSpecificCategories).length,
  },
  probes: probes.map(probe => probeResult(lib, probe)),
  multiProbes: multiProbes.map(probe => probeResult(lib, probe)),
  reportedPairs: reportedPairs.map(pair => pairMembership(lib, pair)),
  perValueMatchLists,
  perValueResolutionCheck: verifyAllPerValueResolutions(lib, perValueMatchLists),
};
const out = path.resolve(process.argv[2] || 'candidate-order.json');
fs.writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify({ mode: result.mode, out, candidateRevision, probes: result.probes.length }));
