#!/usr/bin/env node

// Build the weighted/conditional S-07 closure plan in two stages:
//   contexts  -> source-eligibility.cjs -> branches
// The condition stage is source-oracle based.  The branch stage places exact
// weighted lower-bound, interior, and upper-bound values against each source
// eligible set, including the source `weight || 1` zero-weight behavior.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { runtimeFor: weightedRuntimeFor } = require('./weighted-context.cjs');

const args = process.argv.slice(2);
function arg(name, fallback) { const i = args.indexOf(name); return i === -1 ? fallback : args[i + 1]; }
const stage = arg('--stage', 'contexts');
const sourceRoot = path.resolve(arg('--source-root', '/home/shell/work/phoenix/.parity/reference/5c0a7390539663ba749d360de348a428c088505c'));
const sourceRevision = arg('--source-revision', '5c0a7390539663ba749d360de348a428c088505c');
const candidateRevision = arg('--candidate-revision', 'dd2199d0b7f5bff6a5bf799b7e2a115e8e0385ec');
const outPath = path.resolve(arg('--out', stage === 'contexts' ? '/tmp/s07-weighted-contexts.json' : '/tmp/s07-weighted-plan.json'));
const inputPath = path.resolve(arg('--input', '/tmp/s07-weighted-contexts.json'));
const eligibilityPath = path.resolve(arg('--eligibility', '/tmp/s07-weighted-eligibility.json'));
const contextStart = Math.max(0, Number(arg('--context-start', '0')) || 0);
const contextCountArg = arg('--context-count', null);
const mimRoot = path.join(sourceRoot, 'packages/chitchat-skill/mims');
const dirs = ['scripted-responses', 'emotion-responses', 'core-responses'];

function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function sha256(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
function treeDigest(dir) {
  const files = [];
  function walk(current) {
    for (const name of fs.readdirSync(current).sort()) {
      const file = path.join(current, name);
      if (fs.statSync(file).isDirectory()) walk(file);
      else files.push([path.relative(dir, file).replaceAll(path.sep, '/'), sha256(file)]);
    }
  }
  walk(dir);
  return crypto.createHash('sha256').update(JSON.stringify(files)).digest('hex');
}
function listMims(dir) { return fs.readdirSync(dir).filter((name) => name.endsWith('.mim')).sort().map((name) => name.slice(0, -4)); }
function readMim(dir, id) { return readJson(path.join(dir, `${id}.mim`)); }

const scripted = listMims(path.join(mimRoot, 'scripted-responses'));
const emotion = listMims(path.join(mimRoot, 'emotion-responses'));
const fallback = listMims(path.join(mimRoot, 'core-responses'));
const allMims = [...new Set([...scripted, ...emotion, ...fallback])].sort();

const monthDays = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
function dateString(month, day) { return `2018-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`; }
function shiftDate(month, day, amount) {
  const date = new Date(Date.UTC(2018, month - 1, day));
  date.setUTCDate(date.getUTCDate() + amount);
  return dateString(date.getUTCMonth() + 1, date.getUTCDate());
}
function datesFor(text) {
  const dates = new Set();
  const re = /(?:'|")([0-9]{1,2})\/([0-9]{1,2})(?:'|")/g;
  let match;
  while ((match = re.exec(text))) {
    let month = Number(match[1]); let day = Number(match[2]);
    if (month < 1 || month > 12) continue;
    // DateTime's range parser accepts a few impossible dates by rolling them;
    // keep the nearest valid representative for source evaluation.
    day = Math.max(1, Math.min(monthDays[month - 1], day));
    dates.add(dateString(month, day));
    dates.add(shiftDate(month, day, -1));
    dates.add(shiftDate(month, day, 1));
  }
  ['2018-01-01', '2018-02-28', '2018-03-01', '2018-05-30', '2018-06-30', '2018-09-30', '2018-10-31', '2018-12-31'].forEach((date) => dates.add(date));
  return [...dates].sort();
}

function product(axes) {
  let rows = [{}];
  for (const [key, values] of axes) {
    const next = [];
    for (const row of rows) for (const value of values) next.push({ ...row, [key]: value });
    rows = next;
  }
  return rows;
}

function profileFor(values) {
  const order = ['date', 'hour', 'speaker', 'referent', 'loop', 'jibo', 'emotion', 'city', 'region'];
  const parts = ['weighted'];
  for (const key of order) if (values[key] !== undefined) parts.push(`${key}=${values[key]}`);
  return parts.join('|');
}

// These profiles exercise the values which are easy for a context generator
// to spell but easy for a fixture implementation to silently ignore.  Keep
// this executable assertion beside the plan so a receipt cannot claim branch
// coverage after a profile-state regression.
function profileSelfTest() {
  const failures = [];
  const check = (name, ok, detail) => { if (!ok) failures.push({ name, detail }); };
  const find = (runtime, id) => runtime.loop.users.find((item) => item.id === id);
  const baseline = weightedRuntimeFor('baseline');

  const maleAge10 = weightedRuntimeFor('weighted|referent=male-age10');
  const maleAge10User = find(maleAge10, 'test-looper-id-5');
  check('referent=male-age10', maleAge10.dialog.referent === 'test-looper-id-5'
    && maleAge10User && maleAge10User.gender === 'male'
    && new Date(maleAge10User.birthdate).getUTCFullYear() === 2008, {
      referent: maleAge10.dialog.referent,
      user: maleAge10User,
    });

  const oneReferent = weightedRuntimeFor('weighted|referent=male-age10|loop=one-referent');
  check('loop=one-referent', oneReferent.loop.users.length === 1
    && oneReferent.loop.users[0].id === 'test-looper-id-5'
    && oneReferent.loop.owner === 'test-looper-id-5'
    && oneReferent.perception.speaker === null, {
      users: oneReferent.loop.users.map((item) => item.id),
      owner: oneReferent.loop.owner,
      speaker: oneReferent.perception.speaker,
    });

  const oneReferentSpeaker = weightedRuntimeFor('weighted|referent=male-age10|loop=one-referent-speaker');
  check('loop=one-referent-speaker', oneReferentSpeaker.loop.users.length === 1
    && oneReferentSpeaker.loop.users[0].id === 'test-looper-id-5'
    && oneReferentSpeaker.loop.owner === 'test-looper-id-5'
    && oneReferentSpeaker.perception.speaker === 'test-looper-id-5', {
      users: oneReferentSpeaker.loop.users.map((item) => item.id),
      owner: oneReferentSpeaker.loop.owner,
      speaker: oneReferentSpeaker.perception.speaker,
    });

  const present = weightedRuntimeFor('weighted|loop=present');
  check('loop=present', JSON.stringify(present) === JSON.stringify(baseline), {
    changed: JSON.stringify(present) !== JSON.stringify(baseline),
  });

  const jiboWhite = weightedRuntimeFor('weighted|jibo=white');
  const jiboBlack = weightedRuntimeFor('weighted|jibo=black');
  check('jibo color white', jiboWhite.loop.jibo.color === 'WHITE', jiboWhite.loop.jibo);
  check('jibo color black', jiboBlack.loop.jibo.color === 'BLACK', jiboBlack.loop.jibo);

  let unknownValueRejected = false;
  try { weightedRuntimeFor('weighted|referent=not-a-real-value'); } catch (err) { unknownValueRejected = true; }
  check('unknown profile value rejects', unknownValueRejected, null);
  let unknownKeyRejected = false;
  try { weightedRuntimeFor('weighted|not-a-real-key=value'); } catch (err) { unknownKeyRejected = true; }
  check('unknown profile key rejects', unknownKeyRejected, null);

  return { result: failures.length ? 'fail' : 'pass', checks: 8, failures };
}

function contextsForMim(id, mim) {
  const prompts = (mim.prompts || []).filter((prompt) => prompt.prompt_category === 'Entry-Core' && prompt.prompt_sub_category === 'AN');
  const text = JSON.stringify(prompts);
  const conditions = prompts.map((prompt) => prompt.condition || '').filter(Boolean);
  const conditionText = conditions.join('\n');
  const axes = [];
  if (/\bspeaker\b/.test(conditionText)) {
    const speakerValues = /isBirthday/.test(conditionText) ? ['present', 'none', 'birthday', 'nonbirthday'] : ['present', 'none'];
    if (/speaker\.age\.value/.test(conditionText)) speakerValues.push('age40');
    axes.push(['speaker', [...new Set(speakerValues)] ]);
  }
  if (/\breferent\b/.test(conditionText)) {
    const values = ['none'];
    if (/gender/.test(conditionText)) values.push('male', 'female');
    if (/age\.value/.test(conditionText)) values.push('age10', 'male-age10', 'age11', 'age12', 'age13', 'female-adult');
    if (/isBirthday/.test(conditionText)) values.push('birthday', 'nonbirthday');
    if (values.length === 1) values.push('male-adult');
    axes.push(['referent', [...new Set(values)]]);
  }
  if (/loop\./.test(conditionText)) {
    const values = [];
    if (/count/.test(conditionText)) {
      values.push('one', 'two', 'owner-other');
      if (/referent/.test(conditionText)) values.push('one-referent', 'one-referent-speaker');
    }
    if (/owner/.test(conditionText)) values.push('owner-speaker', 'owner-other', 'no-owner');
    if (/list/.test(conditionText)) values.push('present', 'empty');
    if (!values.length) values.push('owner-other');
    axes.push(['loop', [...new Set(values)]]);
  }
  if (/jibo\.emotion/.test(conditionText)) axes.push(['emotion', ['JOYFUL', 'PLEASED', 'DETERMINED', 'CONFIDENT', 'NEUTRAL', 'INSECURE', 'HOPEFUL', 'SAD', 'FRUSTRATED', 'undefined']]);
  if (/(?:^|[!&| (])!!jibo(?:$|[\s)&|])|(?:^|[!&| (])!jibo(?:$|[\s)&|])/.test(conditionText)) axes.push(['jibo', ['none', 'birthday-zero', 'birthday-adult', 'nonbirthday']]);
  if (/jibo\.color/.test(conditionText)) axes.push(['jibo', ['white', 'black']]);
  if (/location\.home\.isInRegion/.test(conditionText)) axes.push(['region', ['US', 'CA']]);
  if (/location\.city/.test(conditionText)) axes.push(['city', ['boston', 'none']]);
  if (/dt\./.test(conditionText)) axes.push(['date', datesFor(conditionText)]);
  if (/getLocalTime\(\)\.hour/.test(conditionText)) axes.push(['hour', ['04', '05', '12', '15', '16']]);
  if (/!!dt\.|!dt\./.test(conditionText)) axes.push(['location', ['present', 'none']]);

  // A MIM can mention both jibo existence and a jibo property.  Treat the
  // repeated key as one deliberate value set; otherwise the later axis would
  // overwrite the earlier one in the product object and silently lose cases.
  const merged = new Map();
  for (const [key, values] of axes) {
    const current = merged.get(key) || [];
    merged.set(key, [...new Set([...current, ...values])]);
  }
  const mergedAxes = [...merged.entries()];

  // `location=none` is handled as a separate profile axis because it clears
  // all PromptData date/loop fields.  It is only needed for explicit dt
  // existence tests; ordinary date windows need a populated location.
  const normalizedAxes = mergedAxes.filter(([key]) => key !== 'location');
  const profiles = new Set();
  const baseRows = product(normalizedAxes);
  for (const values of baseRows) {
    profiles.add(profileFor(values));
    if (values.date && values.hour) profiles.add(profileFor(values));
  }
  if (/!!dt\.|!dt\./.test(conditionText)) profiles.add('weighted|location=none');
  if (!profiles.size) profiles.add('weighted');

  const dice = /skill\.dice/.test(text) ? [...Array(6)].flatMap((_, a) => [...Array(6)].map((__, b) => ({ diceA: a + 1, diceB: b + 1 }))) : [{ diceA: 1, diceB: 1 }];
  const coins = /skill\.coin/.test(text) ? ['heads', 'tails'] : ['heads'];
  const vmValues = /Math\.random/.test(text) ? [[0], [0.2]] : [[0]];
  const rows = [];
  let n = 0;
  for (const profile of profiles) for (const die of dice) for (const coin of coins) for (const vmRngValues of vmValues) {
    rows.push({ id: `context:${id}:${n++}`, mim: id, expectedOutputMim: mim.mim_id || id, memoType: emotion.includes(id) ? 'EmotionQuery' : 'ScriptedResponse', profile, diceA: die.diceA, diceB: die.diceB, coin, vmRngValues });
  }
  return rows;
}

function effectiveWeight(weight) { return weight || 1; }
function malformedDateCondition(condition) {
  const matches = [...condition.matchAll(/isInRange\((['"])([^'"]*)\1\s*,\s*(['"])([^'"]*)\3\)/g)];
  return matches.length > 0 && matches.some((match) => !/^\d{1,2}\/\d{1,2}$/.test(match[2]) || !/^\d{1,2}\/\d{1,2}$/.test(match[4]));
}

function auditEligibility(eligibility) {
  const topLevelErrors = eligibility.rows.filter((row) => row.error || (row.errors && row.errors.length));
  const conditionErrorGroups = {};
  const runtimeErrorGroups = {};
  const resolutionErrorGroups = {};
  const allowedResolutionErrors = {
    'OI_USR_DislikesLoopMemberAskedAboutBirthday|OI_USR_DislikesLoopMemberAskedAboutBirthday_AN_03|loopMember is not defined': 2,
    'OI_USR_DislikesSpeakerBirthday|OI_USR_DislikesSpeakerBirthday_AN_03|loopMember is not defined': 2,
    'OI_USR_DislikesSummerSolstice|OI_USR_DislikesSummerSolstice_AN_03_FnL|loopMember is not defined': 18,
    'OI_USR_DislikesWinterSolstice|OI_USR_DislikesWinterSolstice_AN_03_FnL|loopMember is not defined': 18,
    'RI_JBO_Is_SS_Zodiac|RI_JBO_Is_SS_Zodiac_AN_01|jiboNLBirthdate is not defined': 3,
    'RI_JBO_Is_SS_Zodiac|RI_JBO_Is_SS_Zodiac_AN_02|jiboNLBirthdate is not defined': 3,
  };
  const unclassified = [];
  for (const row of eligibility.rows) {
    for (const error of row.conditionErrors || []) {
      const key = `${error.condition}|${error.message}`;
      conditionErrorGroups[key] = (conditionErrorGroups[key] || 0) + 1;
      if (!/^Cannot read property '(gender|isBirthday)' of null$/.test(error.message)) unclassified.push({ id: row.id, type: 'condition', ...error });
    }
    for (const error of row.conditionRuntimeErrors || []) {
      const key = `${error.condition}|${error.messages.join('\n')}`;
      runtimeErrorGroups[key] = (runtimeErrorGroups[key] || 0) + 1;
      if (!malformedDateCondition(error.condition)) unclassified.push({ id: row.id, type: 'runtime', ...error });
    }
    for (const error of row.resolutionErrors || []) {
      const message = error.message || (error.messages && error.messages.join('\n')) || 'unknown';
      const key = `${row.mim}|${error.prompt || ''}|${message}`;
      resolutionErrorGroups[key] = (resolutionErrorGroups[key] || 0) + 1;
      if (!Object.prototype.hasOwnProperty.call(allowedResolutionErrors, key) || resolutionErrorGroups[key] > allowedResolutionErrors[key]) unclassified.push({ id: row.id, type: 'prompt-resolution', ...error });
    }
  }
  for (const key of Object.keys(allowedResolutionErrors)) {
    if (resolutionErrorGroups[key] !== allowedResolutionErrors[key]) unclassified.push({ type: 'prompt-resolution-count', key, expected: allowedResolutionErrors[key], actual: resolutionErrorGroups[key] || 0 });
  }
  return {
    rows: eligibility.rows.length,
    topLevelErrors: topLevelErrors.length,
    conditionErrorGroups,
    runtimeErrorGroups,
    resolutionErrorGroups,
    unclassified,
    result: topLevelErrors.length === 0 && unclassified.length === 0 ? 'pass' : 'fail',
  };
}
function hashSeed(text) {
  let h = 2166136261;
  for (const c of text) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function rngFor(mim, diceA, diceB, coin, unit) {
  // ProcessQueryNode deliberately does not construct Dice/Coin on the
  // invalid memo path; CC_Fallback therefore consumes the first value as its
  // weighted sampler input, while every accepted source MIM consumes three
  // fun-and-games values before sampling.
  if (mim === 'CC_Fallback') return [unit];
  const dieValue = (side) => (side - 1 + 0.125) / 6;
  return [dieValue(diceA), dieValue(diceB), coin === 'heads' ? 1 : 0, unit];
}
function sampledPrompt(eligible, unit) {
  const total = eligible.reduce((sum, item) => sum + item.weight, 0);
  const rand = unit * total;
  let ongoing = 0;
  for (const item of eligible) {
    if (item.weight > 0) {
      ongoing += item.weight;
      if (rand < ongoing) return item.prompt_id;
    }
  }
  return null;
}
function branchCases(plan, eligibility, start = 0, count = null) {
  const byId = new Map(eligibility.rows.map((row) => [row.id, row]));
  const cases = [];
  const promptExpectations = {};
  const seen = new Set();
  const conditionCoverage = {};

  // Condition coverage is audited over every source-derived context even when
  // branch execution is split into bounded ranges.  Generation below still
  // visits every selected context; no profile may be represented by another
  // profile merely because its eligible prompt set happens to match.
  for (const context of plan.cases) {
    const oracle = byId.get(context.id);
    if (!oracle || oracle.error || oracle.errors?.length) continue;
    for (const condition of oracle.conditions || []) {
      const key = `${context.mim}:${condition.prompt_id}:${condition.condition}`;
      const entry = conditionCoverage[key] || { prompt_id: condition.prompt_id, condition: condition.condition, true: 0, false: 0 };
      entry[condition.valid ? 'true' : 'false'] += 1;
      conditionCoverage[key] = entry;
    }
  }

  const selected = count === null ? plan.cases.slice(start) : plan.cases.slice(start, start + count);
  for (const context of selected) {
    const oracle = byId.get(context.id);
    if (!oracle || oracle.error || oracle.errors?.length) continue;
    promptExpectations[context.id] = (oracle.eligible || []).map((item) => ({ ...item }));
    const eligible = (oracle.eligible || []).map((item) => ({ prompt_id: item.prompt_id, weight: item.weight }));
    const expectedOutputs = (oracle.eligible || []).map((item) => ({ ...item }));
    const total = eligible.reduce((sum, item) => sum + item.weight, 0);
    const cumulative = [];
    let sum = 0;
    for (const item of eligible) { sum += item.weight; cumulative.push(sum); }
    const units = new Map();
    const addUnit = (label, unit, expectedPrompt, boundary = null) => {
      const key = `${context.id}:${label}`;
      if (seen.has(key)) return;
      seen.add(key);
      const row = {
        ...context,
        id: `weighted:${key}`,
        contextId: context.id,
        family: 'weighted-branch',
        expectedOutputMim: oracle.expectedOutputMim || context.expectedOutputMim || context.mim,
        expectedPrompt,
        expectedEligible: eligible,
        expectedPromptOutput: expectedPrompt ? expectedOutputs.find((item) => item.prompt_id === expectedPrompt) || null : null,
        expectedWeightTotal: total,
        expectedVmCalls: (oracle.conditionVmCalls || oracle.vmCalls || 0) + (expectedPrompt ? (oracle.resolutionVmCalls && oracle.resolutionVmCalls[expectedPrompt] || 0) : 0),
        expectedRngCalls: context.mim === 'CC_Fallback' ? 1 : eligible.length ? 4 : 3,
        boundary,
        rngValues: rngFor(context.mim, context.diceA, context.diceB, context.coin, unit),
        rngSeed: hashSeed(key),
      };
      cases.push(row);
    };
    // Preserve no-eligible contexts as an exact-total control.  The source
    // sampler returns an empty selection at total zero; dropping these rows
    // would hide fallback/condition regressions.
    if (!eligible.length) {
      addUnit('exact-total', 1, null, { kind: 'exact-total', lower: 0, upper: 0 });
      continue;
    }
    // Every eligible prompt gets an interior point.  The source's strict
    // lower-bound behavior is exercised separately at every cumulative edge.
    let previous = 0;
    eligible.forEach((item, index) => {
      const lower = previous;
      const upper = cumulative[index];
      const interior = (lower + upper) / 2 / total;
      addUnit(`prompt:${item.prompt_id}:interior`, interior, item.prompt_id, { kind: 'interior', prompt_id: item.prompt_id, lower, upper });
      // The source sampler uses a strict `<` comparison.  At a cumulative
      // lower boundary, index zero selects the first prompt; every later
      // boundary selects the preceding prompt.  One row per boundary is
      // sufficient: a separately named exact-lower row would be byte-for-byte
      // redundant with this same input and expected selection.
      const boundaryPrompt = sampledPrompt(eligible, lower / total);
      addUnit(`prompt:${item.prompt_id}:lower`, lower / total, boundaryPrompt, { kind: 'lower', prompt_id: boundaryPrompt, lower, upper });
      previous = upper;
    });
    addUnit('exact-total', 1, null, { kind: 'exact-total', lower: total, upper: total });
  }
  return { cases, conditionCoverage, promptExpectations };
}

if (stage === 'contexts') {
  const cases = [];
  for (const id of allMims) {
    const dir = emotion.includes(id) ? 'emotion-responses' : scripted.includes(id) ? 'scripted-responses' : 'core-responses';
    cases.push(...contextsForMim(id, readMim(path.join(mimRoot, dir), id)));
  }
  const output = {
    schemaVersion: 1,
    task: 'S-07',
    stage: 'contexts',
    sourceRoot: '/ref',
    sourceRevision,
    candidateRevision,
    inventory: { scripted: scripted.length, emotion: emotion.length, fallback: fallback.length, total: allMims.length, promptSourceTreeSha256: treeDigest(mimRoot), profileSelfTest: profileSelfTest() },
    cases,
  };
  if (output.inventory.profileSelfTest.result !== 'pass') throw new Error(`weighted context profile self-test failed: ${JSON.stringify(output.inventory.profileSelfTest.failures)}`);
  fs.writeFileSync(outPath, `${JSON.stringify(output)}\n`);
  console.log(JSON.stringify({ outPath, mims: allMims.length, cases: cases.length }, null, 2));
} else if (stage === 'branches') {
  const contextPlan = readJson(inputPath);
  const eligibility = readJson(eligibilityPath);
  if (!contextPlan.inventory || !contextPlan.inventory.profileSelfTest || contextPlan.inventory.profileSelfTest.result !== 'pass') throw new Error('weighted context profile self-test receipt missing or failed');
  const selectedCount = contextCountArg === null
    ? Math.max(0, contextPlan.cases.length - contextStart)
    : Math.max(0, Number(contextCountArg) || 0);
  const branched = branchCases(contextPlan, eligibility, contextStart, selectedCount);
  const eligibilityAudit = auditEligibility(eligibility);
  if (eligibilityAudit.result !== 'pass') throw new Error(`source eligibility audit failed: ${JSON.stringify(eligibilityAudit.unclassified.slice(0, 3))}`);
  const conditionCoverage = Object.values(branched.conditionCoverage);
  const neverTrue = conditionCoverage.filter((entry) => entry.true === 0);
  const neverTrueClassification = neverTrue.map((entry) => {
    let classification = 'unclassified';
    if (/^false(?:\s|\/\*)/.test(entry.condition) || entry.condition.trim() === 'false') classification = 'source-literal-false';
    else if (!entry.condition.trim()) classification = 'source-blank-condition';
    else if (entry.condition === 'speaker==true') classification = 'source-object-vs-boolean';
    else if (entry.condition.includes('loop.owner === speaker')) classification = 'source-distinct-wrapper-identity';
    else if (malformedDateCondition(entry.condition)) classification = 'source-malformed-date-label';
    return { prompt_id: entry.prompt_id, condition: entry.condition, classification };
  });
  if (neverTrueClassification.some((entry) => entry.classification === 'unclassified')) throw new Error(`unclassified never-true condition: ${JSON.stringify(neverTrueClassification)}`);
  const sourcePromptMap = new Map();
  for (const id of allMims) {
    const dir = emotion.includes(id) ? 'emotion-responses' : scripted.includes(id) ? 'scripted-responses' : 'core-responses';
    for (const prompt of readMim(path.join(mimRoot, dir), id).prompts || []) {
      if (prompt.prompt_category === 'Entry-Core' && prompt.prompt_sub_category === 'AN') sourcePromptMap.set(prompt.prompt_id, { mim: id, condition: prompt.condition || '' });
    }
  }
  // Prompt coverage is an oracle property over all source eligibility rows,
  // independent of which bounded context range is being executed.  Using the
  // selected branch rows here would falsely report every other batch as
  // missing the prompts it has not been asked to run yet.
  const selectedPromptIds = new Set(eligibility.rows.flatMap((row) => (row.eligible || []).map((item) => item.prompt_id)));
  const missingPromptIds = [...sourcePromptMap.keys()].filter((id) => !selectedPromptIds.has(id));
  const neverTrueIds = new Set(neverTrueClassification.map((entry) => entry.prompt_id));
  const unclassifiedMissing = missingPromptIds.filter((id) => !neverTrueIds.has(id));
  if (unclassifiedMissing.length) throw new Error(`unclassified missing source prompts: ${unclassifiedMissing.join(',')}`);
  const output = {
    schemaVersion: 1,
    task: 'S-07',
    stage: 'branches',
    sourceRoot: '/ref',
    sourceRevision,
    candidateRevision: contextPlan.candidateRevision || candidateRevision,
    contextCases: contextPlan.cases.length,
    contextRange: { start: contextStart, count: selectedCount, total: contextPlan.cases.length },
    sourceEligibilityRows: eligibility.rows.length,
    inventory: contextPlan.inventory,
    conditionCoverage,
    conditionAudit: {
      entries: conditionCoverage.length,
      everyEntryObserved: conditionCoverage.every((entry) => entry.true > 0 || entry.false > 0),
      bothOutcomesObserved: conditionCoverage.filter((entry) => entry.true > 0 && entry.false > 0).length,
      neverTrue: neverTrueClassification,
    },
    promptAudit: {
      sourcePromptIds: sourcePromptMap.size,
      selectedPromptIds: selectedPromptIds.size,
      missingPromptIds,
      missingAreOnlyNeverTrue: unclassifiedMissing.length === 0,
    },
    eligibilityAudit,
    promptExpectations: branched.promptExpectations,
    cases: branched.cases,
  };
  fs.writeFileSync(outPath, `${JSON.stringify(output)}\n`);
  console.log(JSON.stringify({ outPath, contextCases: contextPlan.cases.length, branchCases: branched.cases.length, conditions: output.conditionCoverage.length }, null, 2));
}
