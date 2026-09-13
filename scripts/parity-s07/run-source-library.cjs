'use strict';

// Run the pinned original Chitchat GraphSkill against the source-derived plan.
// This file is executed inside node:8.9.4-slim with the archived tree mounted
// at /ref. It calls the real source GraphSkill directly; the graph, MIM loader,
// PromptData, Slimmer and analytics are all original code. Avoiding an HTTP
// round-trip keeps the 24k-row matrix bounded while retaining the source graph
// boundary under review.

const fs = require('fs');
const { Chitchat } = require('@jibo/chitchat-skill');
const { FIXED_NOW, runtimeFor, rngValues } = require('./library-context.cjs');

const planPath = process.argv[2];
const outPath = process.argv[3];
if (!planPath || !outPath) throw new Error('usage: run-source-library.cjs PLAN OUT');
const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));

Date.now = () => FIXED_NOW;
const originalRandom = Math.random;
let randomValues = [];
let randomIndex = 0;
Math.random = () => randomValues[randomIndex++ % randomValues.length];

const GENERATED_ACTION_ID_PATHS = new Set(['config.jcp.id', 'config.jcp.config.play.id']);

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
    randomValues = rngValues(row.rngSeed);
    randomIndex = 0;
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
        result: normalizeResponse(response),
      });
    } catch (err) {
      rows.push({ id: row.id, family: row.family, mim: row.mim, memoType: row.memoType, profile: row.profile, error: { name: err.name, message: err.message } });
    }
    if ((index + 1) % 500 === 0) process.stderr.write(`source ${index + 1}/${plan.cases.length}\n`);
  }
  Math.random = originalRandom;
  const report = {
    schemaVersion: 1,
    task: 'S-07',
    runtime: process.version,
    sourceRevision: plan.sourceRevision,
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
