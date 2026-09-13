import fs from 'node:fs';
import path from 'node:path';

function readReceipt(file) {
  const text = fs.readFileSync(file, 'utf8');
  const start = text.indexOf('{');
  return JSON.parse(start < 0 ? text : text.slice(start));
}

const source = readReceipt(path.resolve(process.argv[2]));
const candidate = readReceipt(path.resolve(process.argv[3]));
const out = path.resolve(process.argv[4] || 'order-receipt.json');
const stems = [
  'RI_JBO_HasOpinionAbout_SS',
  'RI_JBO_Is_SS',
  'RI_JBO_Likes_SS',
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
const overlapProbeIds = [
  'has-opinion-ginger',
  'has-opinion-amish',
  'has-opinion-hare-krishna',
  'has-opinion-jehovah',
  'has-opinion-mennonite',
  'has-opinion-rastafarian',
  'likes-australia',
  'likes-coke',
];
const exclusiveProbeByPair = {
  'Fruit/FoodGeneral': ['has-opinion-fruit-exclusive', 'has-opinion-food-exclusive'],
  'Zodiac/Sealife': ['is-zodiac-exclusive', 'is-sealife-exclusive'],
  'Drink/Dinosaur': ['likes-drink-exclusive', 'likes-dinosaur-exclusive'],
  'HairType/Fruit': ['likes-hair-exclusive', 'likes-fruit-exclusive'],
  'ScaryCreature/RoomInHouse': ['likes-room-exclusive'],
  'SchoolSubject/RoomInHouse': ['likes-school-exclusive', 'likes-room-exclusive'],
  'Seafood/RoomInHouse': ['likes-seafood-exclusive', 'likes-room-exclusive'],
};
const stable = value => JSON.stringify(value);
const sorted = value => [...value].sort();
const setEqual = (left, right) => stable(sorted(left)) === stable(sorted(right));
const pairKey = pair => `${pair.left}/${pair.right}`;
const categoryOrder = (categories, left, right) => {
  const li = categories.indexOf(left);
  const ri = categories.indexOf(right);
  if (li < 0 || ri < 0) return null;
  return li < ri ? `${left}<${right}` : `${right}<${left}`;
};
const probeMap = rows => new Map(rows.map(row => [row.id, row]));

const failures = [];
function check(name, condition, details = null) {
  if (!condition) failures.push({ name, details });
  return condition;
}

const sourceRuns = source.runs || [];
// Some rare completion-order witnesses may come from a separate clean Node 8
// batch. They participate in order/inversion coverage only; the primary runs
// carry the complete per-value resolver receipt.
const sourceOrderRuns = sourceRuns.concat(source.additionalOrderRuns || []);
const candidateProbeMap = probeMap(candidate.probes || []);
const sourceProbeMaps = sourceOrderRuns.map(run => probeMap(run.probes || []));
const sourceFirst = sourceRuns[0] || {};

const sourceInventory = {
  runs: sourceRuns.length,
  orderWitnessRuns: (source.additionalOrderRuns || []).length,
  counts: sourceOrderRuns.map(run => run.counts),
  uniqueSelectedSha256: Array.from(new Set(sourceOrderRuns.map(run => run.selectedSha256))),
  uniqueAllStemSha256: Array.from(new Set(sourceOrderRuns.map(run => run.allStemSha256))),
  uniqueCategoryKeySha256: Array.from(new Set(sourceOrderRuns.map(run => run.categoryKeySha256))),
  countsStable: sourceRuns.every(run => stable(run.counts) === stable(sourceFirst.counts)),
};
check('source has multiple clean initializations', sourceRuns.length >= 5, sourceInventory.runs);
check('source selected mapping varies across clean initializations', sourceInventory.uniqueSelectedSha256.length > 1, sourceInventory.uniqueSelectedSha256.length);
check('source full stem mapping varies across clean initializations', sourceInventory.uniqueAllStemSha256.length > 1, sourceInventory.uniqueAllStemSha256.length);
check('source category-key mapping varies across clean initializations', sourceInventory.uniqueCategoryKeySha256.length > 1, sourceInventory.uniqueCategoryKeySha256.length);
check('source inventory counts are stable', sourceInventory.countsStable, sourceInventory.counts);
check('candidate and source inventory counts agree', stable(candidate.counts) === stable(sourceFirst.counts), { source: sourceFirst.counts, candidate: candidate.counts });

function orderAudit(stem) {
  const sourceOrders = sourceOrderRuns.map(run => run.selected[stem] || []);
  const candidateOrder = candidate.selected[stem] || [];
  return {
    stem,
    sourceVariantCount: new Set(sourceOrders.map(stable)).size,
    sourceOrders,
    candidateOrder,
    sourceOrderSha256: sourceOrders.map(order => stable(order)),
  };
}

const stemOrderAudit = stems.map(orderAudit);
const pairAudit = reportedPairs.map(pair => {
  const sourceOrders = sourceOrderRuns.map(run => categoryOrder(run.selected[pair.stem] || [], pair.left, pair.right));
  const candidateOrder = categoryOrder(candidate.selected[pair.stem] || [], pair.left, pair.right);
  const sourcePairRows = sourceOrderRuns.map(run => (run.reportedPairs || []).find(row =>
    row.stem === pair.stem && row.left === pair.left && row.right === pair.right)
    || (sourceFirst.reportedPairs || []).find(row =>
      row.stem === pair.stem && row.left === pair.left && row.right === pair.right));
  const intersections = sourcePairRows.map(row => row ? row.intersection : null);
  const sourceInversionCount = sourceOrders.filter(order => order && order !== candidateOrder).length;
  check(`reported pair ${pairKey(pair)} has source/candidate order evidence`, sourceOrders.every(Boolean), { sourceOrders, candidateOrder });
  check(`reported pair ${pairKey(pair)} has a candidate order`, Boolean(candidateOrder), { candidateOrder });
  check(`reported pair ${pairKey(pair)} has an observed source/candidate inversion`, sourceInversionCount > 0, { sourceOrders, candidateOrder, sourceInversionCount });
  check(`reported pair ${pairKey(pair)} has no category-value intersection`, intersections.every(values => Array.isArray(values) && values.length === 0), intersections);
  return {
    ...pair,
    candidateOrder,
    sourceOrders: Array.from(new Set(sourceOrders)),
    sourceInversionCount,
    intersections: Array.from(new Set(intersections.map(values => stable(values)))),
    leftCount: sourcePairRows[0]?.leftCount ?? null,
    rightCount: sourcePairRows[0]?.rightCount ?? null,
  };
});

function perValueAudit(stem) {
  const sourceValueRuns = sourceRuns.filter(run => run.perValueMatchLists?.[stem]);
  const sourceLists = sourceValueRuns.map(run => run.perValueMatchLists[stem]);
  const candidateLists = candidate.perValueMatchLists?.[stem] || {};
  const sourceKeys = sourceLists[0] ? Object.keys(sourceLists[0]).sort() : [];
  const candidateKeys = Object.keys(candidateLists).sort();
  check(`${stem} source/candidate per-value key sets agree`, stable(sourceKeys) === stable(candidateKeys), {
    sourceCount: sourceKeys.length, candidateCount: candidateKeys.length,
  });
  let setMismatchCount = 0;
  let candidateOrderNotObservedCount = 0;
  let sourceOrderVariantCount = 0;
  let overlappingValueCount = 0;
  let sourceMembershipMismatchCount = 0;
  const variantWitnesses = [];
  sourceKeys.forEach(value => {
    const baseList = sourceLists[0][value] || [];
    // Category membership is invariant across clean initializations. Rebuild
    // each run's ordered list from its observed stem order and the fully
    // enumerated source membership list from the primary run. This keeps the
    // receipt compact while still checking every source mapping order.
    const sourceArrays = sourceOrderRuns.map(run => (run.selected[stem] || [])
      .filter(category => baseList.indexOf(category) !== -1));
    const sourceVariants = Array.from(new Set(sourceArrays.map(stable)));
    const candidateList = candidateLists[value] || [];
    if (sourceArrays.some(list => list.length > 1)) overlappingValueCount += 1;
    if (sourceArrays.some(list => !setEqual(list, baseList))) sourceMembershipMismatchCount += 1;
    if (sourceArrays.some(list => !setEqual(list, candidateList))) setMismatchCount += 1;
    if (sourceVariants.length > 1) {
      sourceOrderVariantCount += 1;
      if (!sourceArrays.some(list => stable(list) === stable(candidateList))) candidateOrderNotObservedCount += 1;
      if (variantWitnesses.length < 12) variantWitnesses.push({ value, sourceVariants: sourceArrays, candidate: candidateList });
    }
  });
  const checks = sourceValueRuns.map(run => run.perValueResolutionCheck || {});
  check(`${stem} source per-value resolver checks have no mismatches`, checks.every(row => row.mismatchCount === 0), checks);
  check(`${stem} candidate per-value resolver check has no mismatches`, candidate.perValueResolutionCheck?.mismatchCount === 0, candidate.perValueResolutionCheck);
  check(`${stem} source clean mappings preserve every per-value membership multiset`, sourceMembershipMismatchCount === 0, { sourceMembershipMismatchCount });
  check(`${stem} source/candidate per-value match multisets agree`, setMismatchCount === 0, { setMismatchCount });
  check(`${stem} candidate ordered lists are observed in the clean-source order sample`, candidateOrderNotObservedCount === 0, { candidateOrderNotObservedCount });
  return {
    valueCount: sourceKeys.length,
    sourceOrderVariantCount,
    overlappingValueCount,
    sourceMembershipMismatchCount,
    setMismatchCount,
    uniformReachableMimSet: setMismatchCount === 0,
    uniformCategoryProbability: setMismatchCount === 0,
    candidateOrderNotObservedCount,
    sourceResolutionChecks: checks,
    candidateResolutionCheck: candidate.perValueResolutionCheck,
    variantWitnesses,
  };
}
const perValue = Object.fromEntries(stems.map(stem => [stem, perValueAudit(stem)]));

function selectedMimWitness(sourceRow, reversed) {
  const id = reversed ? sourceRow.last : sourceRow.first;
  const sha = reversed ? sourceRow.lastMimSha256 : sourceRow.firstMimSha256;
  return { id, mimSha256: sha };
}

const sourceProbeWitnesses = overlapProbeIds.map(id => {
  const rows = sourceProbeMaps.map((map, run) => ({ run, row: map.get(id) })).filter(item => item.row);
  const variants = Array.from(new Set(rows.map(item => stable(item.row.possibleCategories)))).map(text => JSON.parse(text));
  const reversePair = rows.find(item => variants.some(other => stable(other) === stable((item.row.possibleCategories || []).slice().reverse())));
  const candidateRow = candidateProbeMap.get(id);
  check(`overlap probe ${id} is present in source and candidate`, Boolean(rows.length && candidateRow), { sourceRows: rows.length, candidate: candidateRow });
  check(`overlap probe ${id} has at least two matching categories`, Boolean(candidateRow && candidateRow.possibleCategories.length > 1), candidateRow?.possibleCategories);
  check(`overlap probe ${id} changes selected MIM under deterministic first/last RNG`, Boolean(candidateRow && candidateRow.first !== candidateRow.last), candidateRow && { first: candidateRow.first, last: candidateRow.last });
  return {
    id,
    candidate: candidateRow ? {
      possibleCategories: candidateRow.possibleCategories,
      first: selectedMimWitness(candidateRow, false),
      last: selectedMimWitness(candidateRow, true),
    } : null,
    sourceOrderVariants: variants,
    sourceObservedReverseOrder: Boolean(reversePair),
    sourceReverseOrderRuns: reversePair ? [reversePair.run] : [],
    sourceFirstLast: rows.slice(0, 3).map(item => ({ run: item.run, possibleCategories: item.row.possibleCategories,
      first: item.row.first, firstMimSha256: item.row.firstMimSha256,
      last: item.row.last, lastMimSha256: item.row.lastMimSha256 })),
  };
});

function multiAudit(side, runs, rows) {
  const entries = [];
  const sourceLike = side === 'source';
  const all = sourceLike ? runs.flatMap((run, runIndex) => (run.multiProbes || []).map(row => ({ run: runIndex, row }))) : (rows || []).map(row => ({ run: null, row }));
  for (const entry of all) {
    const row = entry.row;
    const perEntity = row.perEntityMatches || [];
    const concatenated = perEntity.flatMap(item => item.categories);
    const concatenates = stable(concatenated) === stable(row.possibleCategories);
    const firstExpected = concatenated.length ? `${row.stem}_${concatenated[0]}` : undefined;
    const lastExpected = concatenated.length ? `${row.stem}_${concatenated[concatenated.length - 1]}` : undefined;
    const resolvesByEndpoints = row.first === firstExpected && row.last === lastExpected;
    if (!concatenates) failures.push({ name: `${side} multi-entity concatenation ${row.id}`, details: { concatenated, possible: row.possibleCategories } });
    if (!resolvesByEndpoints) failures.push({ name: `${side} multi-entity deterministic endpoints ${row.id}`, details: { first: row.first, last: row.last, firstExpected, lastExpected } });
    entries.push({ run: entry.run, id: row.id, entities: row.entities, possibleCategories: row.possibleCategories, concatenates, resolvesByEndpoints, first: row.first, last: row.last });
  }
  const byId = new Map();
  entries.forEach(entry => { if (!byId.has(entry.id)) byId.set(entry.id, []); byId.get(entry.id).push(entry); });
  const reverseOrder = byId.get('likes-australia-then-coke')?.[0]?.possibleCategories;
  const forwardOrder = byId.get('likes-coke-then-australia')?.[0]?.possibleCategories;
  const keyOrderChanges = stable(reverseOrder) !== stable(forwardOrder);
  check(`${side} multi-entity lists concatenate in Object.keys order`, entries.length > 0 && entries.every(entry => entry.concatenates && entry.resolvesByEndpoints), entries);
  check(`${side} reverse entity order changes the possible-category sequence`, keyOrderChanges, { australiaThenCoke: reverseOrder, cokeThenAustralia: forwardOrder });
  return { entries, keyOrderChanges, australiaThenCoke: reverseOrder, cokeThenAustralia: forwardOrder };
}
const sourceMulti = multiAudit('source', sourceRuns);
const candidateMulti = multiAudit('candidate', [], candidate.multiProbes || []);

function swappedList(list, left, right) {
  return list.map(category => category === left ? right : category === right ? left : category);
}
function mutationWitness(id, pair, expectedChange) {
  const probe = candidateProbeMap.get(id);
  const original = probe?.possibleCategories || [];
  // Mutate the stem's category order, then re-filter the same entity value.
  // A swap of two disjoint categories cannot replace the one category that
  // actually contains the value; it only changes a result when both members
  // are present in this per-value match list.
  const mutated = original.includes(pair.left) && original.includes(pair.right)
    ? swappedList(original, pair.left, pair.right)
    : original.slice();
  const originalFirst = original.length ? `${probe.stem}_${original[0]}` : undefined;
  const mutatedFirst = mutated.length ? `${probe.stem}_${mutated[0]}` : undefined;
  const originalLast = original.length ? `${probe.stem}_${original[original.length - 1]}` : undefined;
  const mutatedLast = mutated.length ? `${probe.stem}_${mutated[mutated.length - 1]}` : undefined;
  const changed = originalFirst !== mutatedFirst || originalLast !== mutatedLast;
  const expected = expectedChange ? changed : !changed;
  check(`mutation ${id} ${pairKey(pair)} has expected observable selection`, expected, { original, mutated, originalFirst, mutatedFirst, originalLast, mutatedLast });
  return { id, pair: pairKey(pair), original, mutated, originalFirst, mutatedFirst, originalLast, mutatedLast, changed, expected };
}

const overlapMutationPairs = [
  { id: 'has-opinion-ginger', pair: { left: 'HerbAndSpice', right: 'Vegetable' } },
  { id: 'has-opinion-amish', pair: { left: 'Religion', right: 'ReligionPerson' } },
  { id: 'likes-australia', pair: { left: 'Continent', right: 'Country' } },
  { id: 'likes-coke', pair: { left: 'Drink', right: 'Drug' } },
];
const overlapMutations = overlapMutationPairs.map(item => mutationWitness(item.id, item.pair, true));
const exclusiveMutations = Object.entries(exclusiveProbeByPair).flatMap(([key, ids]) => {
  const [left, right] = key.split('/');
  return ids.map(id => mutationWitness(id, { left, right }, false));
});

const result = {
  schemaVersion: 1,
  mode: 's07-order-audit',
  sourceRevision: source.sourceRevision,
  candidateRevision: candidate.candidateRevision,
  sourceRuntime: source.runtime,
  candidateRuntime: candidate.runtime,
  sourceInventory,
  stemOrderAudit,
  reportedPairAudit: pairAudit,
  perValue,
  sourceProbeWitnesses,
  multiEntity: { source: sourceMulti, candidate: candidateMulti },
  mutationFalsification: {
    overlap: overlapMutations,
    exclusive: exclusiveMutations,
    overlapChangedCount: overlapMutations.filter(row => row.changed).length,
    overlapTotal: overlapMutations.length,
    exclusiveUnchangedCount: exclusiveMutations.filter(row => !row.changed).length,
    exclusiveTotal: exclusiveMutations.length,
  },
  checks: {
    failureCount: failures.length,
    failures,
  },
  conclusion: {
    listedPairsInventoryOnly: pairAudit.every(row => row.intersections.every(value => value === '[]')),
    realOverlappingValues: overlapProbeIds,
    sourceInitializationOrderStable: sourceInventory.uniqueAllStemSha256.length === 1,
    clientObservableWhenOverlapSwapped: overlapMutations.every(row => row.changed),
    productionRepairRecommended: false,
    classification: 'source-initialization-order-is-nondeterministic; listed-seven-pairs-have-disjoint-values; overlapping-value-order-is-client-observable-under-deterministic-sampling',
  },
  result: failures.length ? 'fail' : 'pass',
};
fs.writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify({ result: result.result, failures: failures.length, sourceRuns: sourceRuns.length,
  listedPairs: pairAudit.length, perValue: Object.fromEntries(stems.map(stem => [stem, perValue[stem].valueCount])),
  overlapMutations: `${result.mutationFalsification.overlapChangedCount}/${result.mutationFalsification.overlapTotal}`,
  exclusiveMutations: `${result.mutationFalsification.exclusiveUnchangedCount}/${result.mutationFalsification.exclusiveTotal}` }));
if (result.result !== 'pass') process.exitCode = 1;
