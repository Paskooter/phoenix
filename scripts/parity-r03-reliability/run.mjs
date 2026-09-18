// Bounded R-03 transaction probe. Uses real ListenTransaction with controlled
// in-process peers and real wall-clock deadlines; NOT a complete release gate.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { ListenTransaction } from '../../packages/gateway/src/listenTransaction.js';
import { Timeouts } from '../../packages/contracts/src/constants.js';
import { makeParser, makeSkill, percentiles } from './peers.mjs';

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

export function startTurn({ id = 'fixture', parser = makeParser(), skill = makeSkill(), onRobot = false } = {}) {
  const frames = [];
  const logs = [];
  const started = performance.now();
  const robotID = `robot-${id}`;
  const accountID = `account-${id}`;
  const log = Object.fromEntries(['debug', 'info', 'warn', 'error'].map(level => [
    level, (message, fields) => logs.push({ level, message, fields }),
  ]));
  const tx = new ListenTransaction({
    _auth: { id: accountID, friendlyId: robotID },
    _remoteAddress: '192.0.2.1',
    _jiboHeaders: { 'x-jibo-transid': `turn-${id}`, 'x-jibo-robotid': robotID },
  }, {
    parser,
    skillClient: skill,
    config: { recordLaunchHistory: false, recordSpeechHistory: false },
    skillConfigManager: { isOnRobotSkill() { return onRobot; } },
    intentRouter: { getSkillIDFromNLU() { return { skillID: 'fixture-skill' }; } },
  }, { write(frame) { frames.push(structuredClone(frame)); } }, log);
  // Observe rejection immediately, before injecting messages.
  const done = tx.done.then(
    () => ({ ok: true, elapsedMs: performance.now() - started, completedAt: Date.now() }),
    error => ({ ok: false, code: error.code ?? null, error: error.message,
      elapsedMs: performance.now() - started, completedAt: Date.now() }),
  );
  tx.handleMessage({ json: { type: 'LISTEN', data: { mode: 'CLIENT_ASR', rules: ['launch'], hotphrase: false } } });
  tx.handleMessage({ json: { type: 'CONTEXT', data: {
    general: { accountID, robotID },
    runtime: { loop: { users: [{ id, firstName: id, lastName: 'Fixture' }] } },
  } } });
  tx.handleMessage({ json: { type: 'CLIENT_ASR', data: { text: `fixture ${id}` } } });
  return { tx, done, parser, skill, frames, logs };
}

export async function measureConcurrency({ concurrency = 8, rounds = 3 } = {}) {
  assert.ok(Number.isInteger(concurrency) && concurrency > 0 && concurrency <= 32);
  assert.ok(Number.isInteger(rounds) && rounds > 0 && rounds <= 10);
  const samples = [];
  const memory = [process.memoryUsage()];
  const started = performance.now();
  let isolated = true;
  for (let round = 0; round < rounds; round++) {
    const parser = makeParser({ delayMs: 5 });
    const skill = makeSkill({ delayMs: 5 });
    const turns = Array.from({ length: concurrency }, (_, i) => startTurn({ id: `${round}-${i}`, parser, skill }));
    const results = await Promise.all(turns.map(turn => turn.done));
    for (const result of results) assert.equal(result.ok, true, result.error);
    for (let i = 0; i < concurrency; i++) {
      const id = `${round}-${i}`;
      const parserCall = parser.calls.find(call => call.trace.transId === `turn-${id}`);
      const skillCall = skill.calls.find(call => call.trace.transId === `turn-${id}`);
      isolated &&= parserCall?.input.text === `fixture ${id}` &&
        parserCall?.input.loop.users[0].id === id &&
        skillCall?.input.context.general.robotID === `robot-${id}` &&
        skillCall?.trace.robotId === `robot-${id}`;
      assert.equal(turns[i].frames.at(-1).type, 'SKILL_ACTION');
      assert.equal(turns[i].frames.at(-1).final, true);
    }
    assert.equal(parser.calls.filter(call => call.settledAt === null).length, 0);
    assert.equal(skill.calls.filter(call => call.settledAt === null).length, 0);
    samples.push(...results.map(result => result.elapsedMs));
    memory.push(process.memoryUsage());
  }
  assert.equal(isolated, true, 'cross-robot identity/trace isolation');
  const elapsedMs = performance.now() - started;
  return { concurrency, rounds, turns: samples.length, elapsedMs,
    throughputPerSecond: samples.length * 1000 / elapsedMs,
    latencyMs: percentiles(samples), isolated, memory,
    memoryConclusion: 'samples only; not proof of bounded long-running memory' };
}

export async function measureTimeout(kind) {
  assert.ok(['parser', 'skill'].includes(kind));
  const budgetMs = Timeouts[kind];
  const options = { delayMs: budgetMs + 300 };
  const turn = startTurn({
    id: `timeout-${kind}`,
    parser: makeParser(kind === 'parser' ? options : {}),
    skill: makeSkill(kind === 'skill' ? options : {}),
  });
  const outcome = await turn.done;
  const peer = turn[kind];
  assert.equal(outcome.ok, false, 'budget expires before peer settles');
  assert.equal(outcome.code, kind === 'parser' ? 'PARSER' : 'TIMEOUT_SKILL');
  assert.ok(outcome.elapsedMs >= budgetMs - 50, 'not an early synthetic timeout');
  assert.ok(outcome.elapsedMs < budgetMs + 2500, 'timeout scheduling tolerance');
  const pendingAtTimeout = peer.calls.filter(call => call.settledAt === null).length;
  const frameCount = turn.frames.length;
  await sleep(500);
  const lateSettlements = peer.calls.filter(call => call.settledAt > outcome.completedAt).length;
  assert.equal(pendingAtTimeout, 1, 'observe outstanding work, not an inert aborted flag');
  assert.equal(lateSettlements, 1, 'source-faithful peer work continues after timeout');
  assert.equal(turn.frames.length, frameCount, 'late settlement emits no additional frame');
  return { kind, budgetMs, outcome, pendingAtTimeout, lateSettlements,
    cancellation: false, lateFrames: turn.frames.length - frameCount,
    scope: 'in-process peer; HTTP connection cancellation not measured' };
}

export async function runProbe() {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim() !== '';
  const report = { schemaVersion: 1, task: 'R-03', acceptance: 'incomplete',
    referenceRevision: '5c0a7390539663ba749d360de348a428c088505c',
    phoenixRevision: revision, dirty, capturedAt: new Date().toISOString(),
    measurement: 'real transaction class, controlled in-process parser/skill peers, wall-clock deadlines',
    concurrency: await measureConcurrency(), timeouts: [], unavailable: [],
    remaining: ['HTTP/ASR disconnects', 'service restarts', 'queue and sustained memory limits',
      'readiness versus liveness', 'metrics/configuration', 'pinned reference runtime differential'],
  };
  for (const kind of ['parser', 'skill']) report.timeouts.push(await measureTimeout(kind));
  for (const kind of ['parser', 'skill']) {
    const turn = startTurn({ id: `unavailable-${kind}`,
      parser: makeParser(kind === 'parser' ? { fail: { message: 'fixture unavailable' } } : {}),
      skill: makeSkill(kind === 'skill' ? { fail: { message: 'fixture unavailable' } } : {}),
    });
    const outcome = await turn.done;
    assert.equal(outcome.ok, false);
    assert.match(outcome.error, /fixture unavailable/);
    report.unavailable.push({ kind, outcome });
  }
  return report;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const output = process.argv[2];
  if (!output) throw new Error('Usage: node scripts/parity-r03-reliability/run.mjs OUTPUT.json');
  // Production timeout timers are unref'd; keep this measurement alive explicitly.
  const keepAlive = setInterval(() => {}, 1000);
  try {
    const report = await runProbe();
    writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify({ output, acceptance: report.acceptance,
      turns: report.concurrency.turns, timeouts: report.timeouts.map(row => ({
        kind: row.kind, elapsedMs: row.outcome.elapsedMs, lateSettlements: row.lateSettlements,
      })) }));
  } finally { clearInterval(keepAlive); }
}
