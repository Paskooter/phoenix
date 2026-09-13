'use strict';

// Source-side branch oracle.  It uses the archived PromptData and the same
// vm condition evaluation as Slimmer, but does not select a prompt.  The host
// plan generator uses this compact receipt to place exact weighted boundaries
// only where a source condition makes a prompt eligible.

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const PromptData = require('@jibo/baseskill/lib/graph/mims/utils/slimmer/PromptData').PromptData;
const { FIXED_NOW } = require('./library-context.cjs');
const { runtimeFor } = require('./weighted-context.cjs');

const planPath = process.argv[2];
const outPath = process.argv[3];
if (!planPath || !outPath) throw new Error('usage: source-eligibility.cjs PLAN OUT');
const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
const sourceRoot = plan.sourceRoot || '/ref';
const mimRoot = path.join(sourceRoot, 'packages/chitchat-skill/mims');
const dirs = ['scripted-responses', 'emotion-responses', 'core-responses'];
const fileById = {};
dirs.forEach((dir) => {
  const absolute = path.join(mimRoot, dir);
  fs.readdirSync(absolute).filter((name) => /\.mim$/.test(name)).forEach((name) => {
    fileById[name.slice(0, -4)] = path.join(absolute, name);
  });
});

Date.now = () => FIXED_NOW;
const log = { info() {}, warn() {}, error() {}, debug() {} };
log.createChild = () => log;
const originalConsoleError = console.error;
let runtimeErrors = [];
console.error = (...args) => { runtimeErrors.push(args.map((item) => String(item && item.stack || item)).join(' ')); };

function effectiveWeight(prompt) { return prompt.weight || 1; }

function evaluate(row, mim) {
  const runtime = runtimeFor(row.profile);
  const skill = {
    dice: { a: row.diceA, b: row.diceB },
    coin: { a: row.coin || 'heads' },
    entities: row.entities || {},
    intent: row.memoType,
  };
  const promptData = new PromptData(runtime, log, skill);
  const vmValues = row.vmRngValues && row.vmRngValues.length ? row.vmRngValues : [0];
  let vmIndex = 0;
  const controlledMath = Object.create(Math);
  controlledMath.random = () => vmValues[vmIndex++ % vmValues.length];
  const context = vm.createContext(promptData);
  context.Math = controlledMath;
  const eligible = [];
  const conditions = [];
  const errors = [];
  const conditionErrors = [];
  const conditionRuntimeErrors = [];
  const resolutionErrors = [];
  const resolutionVmCalls = {};
  const prompts = (mim.prompts || []).filter((prompt) => prompt.prompt_category === 'Entry-Core' && prompt.prompt_sub_category === 'AN');
  const seen = {};
  const validPrompts = [];
  prompts.forEach((prompt) => {
    if (seen[prompt.prompt_id]) errors.push({ prompt: prompt.prompt_id, message: 'duplicate prompt_id' });
    seen[prompt.prompt_id] = true;
    let valid = true;
    if (prompt.condition) {
      const beforeRuntimeErrors = runtimeErrors.length;
      try { valid = !!vm.runInContext(prompt.condition, context); }
      catch (err) { valid = false; conditionErrors.push({ prompt: prompt.prompt_id, condition: prompt.condition, message: err.message }); }
      if (runtimeErrors.length > beforeRuntimeErrors) conditionRuntimeErrors.push({ prompt: prompt.prompt_id, condition: prompt.condition, messages: runtimeErrors.slice(beforeRuntimeErrors) });
    }
    if (prompt.condition) conditions.push({ prompt_id: prompt.prompt_id, condition: prompt.condition, valid, error: conditionErrors.length && conditionErrors[conditionErrors.length - 1].prompt === prompt.prompt_id ? conditionErrors[conditionErrors.length - 1].message : undefined });
    if (valid) validPrompts.push(prompt);
  });
  // Slimmer evaluates every condition before resolving the selected prompt.
  // Resolve each eligible prompt independently from this exact post-condition
  // cursor so interpolation never changes the condition oracle or the next
  // prompt's expected random state.
  const conditionVmCalls = vmIndex;
  validPrompts.forEach((prompt) => {
    vmIndex = conditionVmCalls;
    const beforeResolutionErrors = runtimeErrors.length;
    let esml = '';
    try { esml = vm.runInContext('`' + prompt.prompt + '`', context); }
    catch (err) { resolutionErrors.push({ prompt: prompt.prompt_id, message: err.message }); }
    resolutionVmCalls[prompt.prompt_id] = vmIndex - conditionVmCalls;
    if (runtimeErrors.length > beforeResolutionErrors) {
      resolutionErrors.push({ prompt: prompt.prompt_id, messages: runtimeErrors.slice(beforeResolutionErrors) });
    }
    const autoRuleConfig = (prompt.auto_rule_override !== null) ? prompt.auto_rule_override : mim.es_auto_tagging;
    const expected = {
      prompt_id: prompt.prompt_id,
      weight: effectiveWeight(prompt),
      esml,
      autoRuleConfigPresent: autoRuleConfig !== undefined,
    };
    if (autoRuleConfig !== undefined) expected.autoRuleConfig = autoRuleConfig;
    eligible.push(expected);
  });
  return { eligible, conditions, vmCalls: conditionVmCalls, conditionVmCalls, resolutionVmCalls, resolutionErrors, errors, conditionErrors, conditionRuntimeErrors };
}

const rows = [];
for (let i = 0; i < plan.cases.length; i += 1) {
  const row = plan.cases[i];
  const file = fileById[row.mim];
  if (!file) {
    rows.push({ id: row.id, mim: row.mim, profile: row.profile, error: 'missing source MIM' });
    continue;
  }
  const mim = JSON.parse(fs.readFileSync(file, 'utf8'));
  try {
    const result = evaluate(row, mim);
    rows.push(Object.assign({ id: row.id, mim: row.mim, expectedOutputMim: mim.mim_id || row.mim, profile: row.profile, diceA: row.diceA, diceB: row.diceB, coin: row.coin, vmRngValues: row.vmRngValues }, result));
  } catch (err) {
    rows.push({ id: row.id, mim: row.mim, profile: row.profile, error: { name: err.name, message: err.message } });
  }
  if ((i + 1) % 1000 === 0) process.stderr.write(`eligibility ${i + 1}/${plan.cases.length}\n`);
}
fs.writeFileSync(outPath, `${JSON.stringify({ schemaVersion: 1, sourceRevision: plan.sourceRevision, sourceRuntime: process.version, cases: plan.cases.length, rows }, null, 2)}\n`);
process.exit(0);
