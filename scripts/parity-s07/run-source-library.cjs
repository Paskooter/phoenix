'use strict';

// Run the pinned original Chitchat GraphSkill against the source-derived plan.
// This file is executed inside node:8.9.4-slim with the archived tree mounted
// at /ref. It calls the real source GraphSkill directly; the graph, MIM loader,
// PromptData, Slimmer and analytics are all original code. Avoiding an HTTP
// round-trip keeps the 24k-row matrix bounded while retaining the source graph
// boundary under review.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const vm = require('vm');
const { Chitchat } = require('@jibo/chitchat-skill');
const { FIXED_NOW, rngValues } = require('./library-context.cjs');
const { runtimeFor } = require('./weighted-context.cjs');

const planPath = process.argv[2];
const outPath = process.argv[3];
if (!planPath || !outPath) throw new Error('usage: run-source-library.cjs PLAN OUT');
const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));

Date.now = () => FIXED_NOW;
const originalRandom = Math.random;
let randomValues = [];
let randomIndex = 0;
Math.random = () => randomValues[randomIndex++ % randomValues.length];
let vmRandomValues = [];
let vmRandomIndex = 0;
const controlVmRandom = process.env.S07_CONTROL_VM_RANDOM === '1';
const originalCreateContext = vm.createContext;
if (controlVmRandom) {
  vm.createContext = function controlledCreateContext(sandbox, options) {
    const target = sandbox || {};
    const controlledMath = Object.create(Math);
    controlledMath.random = () => vmRandomValues[vmRandomIndex++ % vmRandomValues.length];
    target.Math = controlledMath;
    return originalCreateContext.call(vm, target, options);
  };
}

const GENERATED_ACTION_ID_PATHS = new Set(['config.jcp.id', 'config.jcp.config.play.id']);

function mimInventory(skill, root) {
  const sets = {
    scripted: [...skill.scriptedResponseMiMSet].sort(),
    emotion: [...skill.emotionResponseMiMSet].sort(),
    fallback: [...skill.fallbackResponseMiMSet].sort(),
  };
  const hashIds = (ids) => crypto.createHash('sha256').update(JSON.stringify(ids)).digest('hex');
  const files = [];
  function walk(current) {
    fs.readdirSync(current).sort().forEach((name) => {
      const file = path.join(current, name);
      if (fs.statSync(file).isDirectory()) walk(file);
      else files.push([path.relative(root, file).replace(/\\/g, '/'), crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')]);
    });
  }
  ['scripted-responses', 'emotion-responses', 'core-responses'].forEach((dir) => walk(path.join(root, dir)));
  files.sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
  return {
    treeSha256: crypto.createHash('sha256').update(JSON.stringify(files)).digest('hex'),
    counts: { scripted: sets.scripted.length, emotion: sets.emotion.length, fallback: sets.fallback.length },
    idsSha256: { scripted: hashIds(sets.scripted), emotion: hashIds(sets.emotion), fallback: hashIds(sets.fallback) },
    allIdsSha256: hashIds([...new Set([...sets.scripted, ...sets.emotion, ...sets.fallback])].sort()),
  };
}

function stripGeneratedIds(value, prefix = '') {
  if (Array.isArray(value)) return value.map((item, index) => stripGeneratedIds(item, `${prefix}[${index}]`));
  if (!value || typeof value !== 'object') return value;
  const out = {};
  Object.keys(value).sort().forEach((key) => {
    const current = prefix ? `${prefix}.${key}` : key;
    if (key === 'id' && GENERATED_ACTION_ID_PATHS.has(current)) return;
    out[key] = stripGeneratedIds(value[key], current);
  });
  return out;
}

function idPaths(value, prefix = '') {
  const out = [];
  if (Array.isArray(value)) {
    value.forEach((item, index) => out.push(...idPaths(item, `${prefix}[${index}]`)));
  } else if (value && typeof value === 'object') {
    Object.keys(value).forEach((key) => {
      const current = prefix ? `${prefix}.${key}` : key;
      if (key === 'id') out.push(current);
      out.push(...idPaths(value[key], current));
    });
  }
  return out.sort();
}

function normalizeResponse(response) {
  if (!response) return { responseType: null };
  const data = response.data || {};
  const action = data.action;
  const normalized = {
    responseType: response.type,
    final: data.final,
    fireAndForget: data.fireAndForget,
    analytics: data.analytics || {},
    action: action ? stripGeneratedIds(action) : null,
    actionIdPaths: action ? idPaths(action) : [],
  };
  if (action && action.config && action.config.jcp) {
    const jcp = action.config.jcp;
    const slims = [];
    function walk(node) {
      if (!node || typeof node !== 'object') return;
      if (node.type === 'SLIM') {
        const config = node.config || {};
        const play = config.play || {};
        slims.push({
          play: {
            type: play.type,
            autoRuleConfig: play.autoRuleConfig,
            esml: play.esml,
            meta: play.meta,
          },
          listen: config.listen || null,
          display: config.display || null,
        });
      }
      (node.children || []).forEach(walk);
    }
    walk(jcp);
    normalized.jcpType = jcp.type;
    normalized.slims = slims;
    normalized.mims = slims.map((slim) => slim.play.meta && slim.play.meta.mim_id).filter(Boolean);
    normalized.prompts = slims.map((slim) => slim.play.meta && slim.play.meta.prompt_id).filter(Boolean);
    normalized.esml = slims.map((slim) => slim.play.esml);
  }
  return normalized;
}

function requestBody(row) {
  return {
    type: 'LISTEN_LAUNCH',
    msgID: `s07:${row.id}`,
    ts: FIXED_NOW,
    data: {
      general: { accountID: 's07-fixture-account', robotID: 's07-fixture-robot', lang: 'en' },
      runtime: runtimeFor(row.profile),
      skill: { id: 'chitchat-skill' },
      result: {
        nlu: { rules: [], intent: `s07:${row.family}`, entities: row.entities || {} },
        asr: { text: '', confidence: 1 },
        memo: { type: row.memoType, mim: row.mim },
      },
    },
  };
}

function rowRandomValues(row) {
  return Array.isArray(row.rngValues) && row.rngValues.length
    ? row.rngValues
    : rngValues(row.rngSeed);
}

function rowVmRandomValues(row) {
  return Array.isArray(row.vmRngValues) && row.vmRngValues.length ? row.vmRngValues : [0];
}

async function main() {
  const skill = new Chitchat();
  await skill.init();
  // Logging is not part of the Chitchat wire contract. A no-op source-shaped
  // logger avoids 24k rows of archived logger I/O without changing graph code.
  const log = { info() {}, warn() {}, error() {}, debug() {} };
  log.createChild = () => log;
  const rows = [];
  for (let index = 0; index < plan.cases.length; index += 1) {
    const row = plan.cases[index];
    randomValues = rowRandomValues(row);
    randomIndex = 0;
    vmRandomValues = rowVmRandomValues(row);
    vmRandomIndex = 0;
    try {
      const response = await skill.handle({ body: requestBody(row), log });
      rows.push({
        id: row.id,
        family: row.family,
        mim: row.mim,
        memoType: row.memoType,
        profile: row.profile,
        entities: row.entities || {},
        expectedCategory: row.expectedCategory,
        expectedCategories: row.expectedCategories,
        rngInput: randomValues,
        rngCalls: randomIndex,
        vmRngInput: vmRandomValues,
        vmRngCalls: vmRandomIndex,
        result: normalizeResponse(response),
      });
    } catch (err) {
      rows.push({ id: row.id, family: row.family, mim: row.mim, memoType: row.memoType, profile: row.profile, rngInput: randomValues, rngCalls: randomIndex, vmRngInput: vmRandomValues, vmRngCalls: vmRandomIndex, error: { name: err.name, message: err.message } });
    }
    if ((index + 1) % 500 === 0) process.stderr.write(`source ${index + 1}/${plan.cases.length}\n`);
  }
  Math.random = originalRandom;
  const report = {
    schemaVersion: 1,
    task: 'S-07',
    runtime: process.version,
    vmRandomControlled: controlVmRandom,
    sourceRevision: plan.sourceRevision,
    mimInventory: mimInventory(skill, path.join(plan.sourceRoot || '/ref', 'packages/chitchat-skill/mims')),
    sourceMappings: {
      stemMapping: skill.semiSpecificStemMapping,
      categoryNames: Object.keys(skill.semiSpecificCategoryMapping),
    },
    planCases: plan.cases.length,
    rows,
  };
  fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
  // The archived logger/graph host leaves process-level handles open after a
  // direct (non-HTTP) graph run. The receipt is complete at this point.
  process.exit(0);
}

main().catch((err) => { console.error(err && err.stack || err); process.exit(2); });
