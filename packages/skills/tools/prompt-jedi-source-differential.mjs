#!/usr/bin/env node

// Focused source control for the frozen compiled-corpus residual. The two
// implementations run in separate processes so their CommonJS/ESM runtimes
// cannot alter each other's module globals. No NLU service or live skill is
// contacted.

import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { chdir, cwd } from 'node:process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const clone = (value) => JSON.parse(JSON.stringify(value));
const seed = 2593396555;

function lcg(initial) {
  let state = initial >>> 0;
  let calls = 0;
  const random = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    calls++;
    return state / 0x100000000;
  };
  Object.defineProperty(random, 'calls', { get: () => calls });
  return random;
}

function playOf(response) {
  const root = response && response.data && response.data.action && response.data.action.config && response.data.action.config.jcp;
  const visit = (node) => {
    if (!node || typeof node !== 'object') return undefined;
    if (node.type === 'PLAY') return node;
    for (const value of Object.values(node)) {
      const found = visit(value);
      if (found) return found;
    }
    return undefined;
  };
  return visit(root);
}

function readTarget(residualPath, requestedID) {
  const residual = JSON.parse(readFileSync(residualPath, 'utf8'));
  const cases = Array.isArray(residual) ? residual : residual.cases;
  const target = cases.find((item) => item.id === requestedID);
  if (!target) throw new Error(`Residual case not found: ${requestedID}`);
  return target.turns[0].input.body.value;
}

const silentLog = {
  debug() {}, info() {}, warn() {}, error() {},
  createChild() { return this; },
};

async function sourceChild(referenceRoot, input) {
  const oldCwd = cwd();
  const oldRandom = Math.random;
  const oldLog = console.log;
  const oldStdoutWrite = process.stdout.write;
  const random = lcg(seed);
  const refSkillDir = resolve(referenceRoot, 'packages/chitchat-skill');
  chdir(refSkillDir);
  Math.random = random;
  // @jibo/utils emits a setup warning while the source package is loaded.
  console.log = () => {};
  process.stdout.write = () => true;
  try {
    const requireFromReference = createRequire(pathToFileURL(resolve(refSkillDir, 'package.json')));
    const { Chitchat } = requireFromReference('./lib/Chitchat');
    const skill = new Chitchat();
    await skill.init();
    const response = await skill.handle({ body: clone(input), log: silentLog });
    const play = playOf(response);
    return {
      runtime: process.version,
      randomCalls: random.calls,
      promptID: play && play.meta && play.meta.prompt_id,
      autoRuleConfig: play && play.autoRuleConfig,
      esml: play && play.esml,
    };
  } finally {
    console.log = oldLog;
    process.stdout.write = oldStdoutWrite;
    Math.random = oldRandom;
    chdir(oldCwd);
  }
}

async function candidateChild(input) {
  const random = lcg(seed);
  const { createChitchatSkill } = await import(pathToFileURL(resolve('packages/skills/src/chitchatSkill.js')).href);
  const skill = createChitchatSkill({ rng: random });
  const response = await skill(clone(input));
  const play = playOf(response);
  return {
    runtime: process.version,
    randomCalls: random.calls,
    promptID: play && play.meta && play.meta.prompt_id,
    autoRuleConfig: play && play.autoRuleConfig,
    esml: play && play.esml,
  };
}

async function childMain(mode, referenceRoot, residualPath, requestedID) {
  const input = readTarget(residualPath, requestedID);
  const value = mode === 'source'
    ? await sourceChild(referenceRoot, input)
    : await candidateChild(input);
  process.stdout.write(JSON.stringify(value));
}

const args = process.argv.slice(2);
if (args[0] === '--child') {
  const [, mode, referenceRoot, residualPath, requestedID = 'chitchat:2250:0:base'] = args;
  if (!mode || !referenceRoot || !residualPath) throw new Error('child usage: --child source|candidate REFERENCE_ROOT RESIDUAL_CASES_JSON [CASE_ID]');
  await childMain(mode, referenceRoot, residualPath, requestedID);
} else {
  const [referenceRoot, residualPath, requestedID = 'chitchat:2250:0:base'] = args;
  if (!referenceRoot || !residualPath) {
    console.error('usage: prompt-jedi-source-differential.mjs REFERENCE_ROOT RESIDUAL_CASES_JSON [CASE_ID]');
    process.exit(2);
  }
  const script = resolve(process.argv[1]);
  const sourceRun = spawnSync(process.execPath, [script, '--child', 'source', referenceRoot, residualPath, requestedID], { encoding: 'utf8' });
  if (sourceRun.status !== 0) {
    process.stderr.write(sourceRun.stderr || sourceRun.stdout);
    process.exit(sourceRun.status || 1);
  }
  const candidateRun = spawnSync(process.execPath, [script, '--child', 'candidate', referenceRoot, residualPath, requestedID], { encoding: 'utf8' });
  if (candidateRun.status !== 0) {
    process.stderr.write(candidateRun.stderr || candidateRun.stdout);
    process.exit(candidateRun.status || 1);
  }
  const source = JSON.parse(sourceRun.stdout);
  const candidate = JSON.parse(candidateRun.stdout);
  const comparable = ['promptID', 'autoRuleConfig', 'esml', 'randomCalls'];
  const equal = comparable.every((key) => JSON.stringify(source[key]) === JSON.stringify(candidate[key]));
  const sourceNode = resolve(referenceRoot, 'packages/chitchat-skill/lib/nodes/ProcessQueryNode.js');
  const sourceTypeScript = resolve(referenceRoot, 'packages/chitchat-skill/src/nodes/ProcessQueryNode.ts');
  const input = readTarget(residualPath, requestedID);
  const result = {
    schemaVersion: 1,
    caseID: requestedID,
    seed,
    inputSha256: sha256(JSON.stringify(input)),
    referenceRoot,
    referenceSource: {
      revision: '5c0a7390539663ba749d360de348a428c088505c',
      processQueryNodeSourceSha256: sha256(readFileSync(sourceTypeScript)),
      processQueryNodeCompiledSha256: sha256(readFileSync(sourceNode)),
    },
    source,
    candidate,
    comparable,
    equal,
  };
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  if (!equal) process.exitCode = 1;
}
