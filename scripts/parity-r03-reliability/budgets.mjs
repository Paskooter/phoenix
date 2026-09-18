#!/usr/bin/env node
/**
 * The two long budgets nobody had driven, measured on the real transaction class.
 *
 * R-03 clause 1 asks for latency/throughput "against pinned reference budgets".
 * The short ones (parser 10 s, skill 10 s, context 5 s) were measured on real HTTP
 * peers; this covers the long ones, which need wall-clock minutes and so had been
 * left as an assumption:
 *
 *   transaction 60 s  (packages/contracts Timeouts.transaction; the reference's
 *                      TransactionHandler wraps its handle in a timeout promise)
 *   asr         40 s  (Timeouts.asr; ListenTransactionHandler TIMEOUT_ASR)
 *
 * It also records why the websocket budget needs no such drive: Timeouts.wsMax maps
 * to TIMEOUT_MAX_DURATION, and ResponseWrapper documents that neither it nor
 * closeAfterFinal can close a socket in the reference either, because `closed`
 * starts true. That is pinned by a test in the gateway suite, not by a 180 s wait.
 *
 * usage: budgets.mjs [output.json]
 */
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

const { ListenTransaction } = await import('../../packages/gateway/src/listenTransaction.js');
const { Timeouts, HubErrorCode } = await import('../../packages/contracts/src/constants.js');

const quiet = { debug() {}, info() {}, warn() {}, error() {} };

function transaction({ id }) {
  const frames = [];
  const tx = new ListenTransaction(
    { _jiboHeaders: { 'x-jibo-transid': `budget-${id}` }, _auth: { id: 'acct-budget', friendlyId: 'robot-budget' }, _remoteAddress: '127.0.0.1' },
    {
      config: { recordLaunchHistory: false, recordSpeechHistory: false, maxSpeechTimeout: Timeouts.asr },
      skillConfigManager: { isOnRobotSkill: () => true },
      intentRouter: { getSkillIDFromNLU: () => null },
      // A parser that never answers: the turn must be ended by a budget, not by a peer.
      parser: { handleNLU: () => new Promise(() => {}) },
      skillClient: { launchOrUpdate: () => new Promise(() => {}) },
    },
    { write: (frame) => frames.push(frame) },
    quiet,
  );
  const startedAt = performance.now();
  const done = tx.done.then(
    () => ({ ok: true, elapsedMs: performance.now() - startedAt }),
    (error) => ({ ok: false, code: error.code ?? null, error: error.message, elapsedMs: performance.now() - startedAt }),
  );
  return { tx, frames, done };
}

/** The transaction's own budget: a turn that never receives what it is waiting for. */
async function driveTransactionBudget() {
  const { tx, done } = transaction({ id: 'transaction' });
  // A client-ASR turn that announces itself and then never supplies the result:
  // every phase budget is a no-op here, so only the transaction timer can end it.
  tx.handleMessage({ json: { type: 'LISTEN', data: { lang: 'en-US', mode: 'CLIENT_ASR', hotphrase: false, rules: ['launch'] } } });
  const outcome = await done;
  return { budgetMs: Timeouts.transaction, advertisedMs: 60000, outcome };
}

/**
 * The ASR budget: a server-ASR phase whose session never supplies a result.
 *
 * Driven with NO audio. Feeding continuous speech instead does not reach the 40 s
 * ceiling at all -- the session's own MAX_BUFFER_MS (30 s) fires an end-of-speech
 * first, and at 5x realtime it did so in a fraction of that, which is a flaw in the
 * probe rather than a property of the product. A session with no input has neither
 * an endpoint nor a buffer to fill, so the phase budget is the only thing that can
 * end the turn.
 */
async function driveAsrBudget() {
  const { tx, frames, done } = transaction({ id: 'asr' });
  tx.handleMessage({ json: { type: 'LISTEN', data: { lang: 'en-US', hotphrase: false, rules: ['launch'] } } });
  tx.handleMessage({ json: { type: 'CONTEXT', data: { general: {}, runtime: { loop: {} } } } });
  const outcome = await done;
  return { budgetMs: Timeouts.asr, advertisedMs: 40000, outcome, frames: frames.map((f) => f.type) };
}

async function main() {
  const output = process.argv[2];
  const keepAlive = setInterval(() => {}, 1000); // both budget timers are unref'd
  try {
    const report = {
      schemaVersion: 1,
      task: 'R-03',
      measuredAt: new Date().toISOString(),
      phoenixRevision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: fileURLToPath(new URL('../../', import.meta.url)), encoding: 'utf8' }).trim(),
      measurement: 'real ListenTransaction, wall-clock budgets, unresponsive peers',
      undrivenByDesign: {
        wsMaxMs: Timeouts.wsMax,
        closeAfterFinalMs: Timeouts.closeAfterFinal,
        reason: 'Timeouts.wsMax maps to ResponseWrapper TIMEOUT_MAX_DURATION and closeAfterFinal to TIMEOUT_CLOSE_AFTER_FINAL; both are documented dead code in the reference because `closed` starts true, and the client closes on the final frame. Pinned by a gateway test rather than a 180s wait.',
      },
      transaction: await driveTransactionBudget(),
      asr: await driveAsrBudget(),
    };
    // Capture the report before asserting, so a surprising outcome is still
    // recorded rather than only raising.
    if (output) writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify({
      transaction: { ms: Math.round(report.transaction.outcome.elapsedMs), code: report.transaction.outcome.code, error: report.transaction.outcome.error },
      asr: { ms: Math.round(report.asr.outcome.elapsedMs), code: report.asr.outcome.code, error: report.asr.outcome.error, frames: report.asr.frames },
    }, null, 1));
    for (const [name, row] of [['transaction', report.transaction], ['asr', report.asr]]) {
      assert.equal(row.outcome.ok, false, `${name}: the budget must end the turn`);
      assert.ok(row.outcome.elapsedMs >= row.budgetMs - 100, `${name}: fired no earlier than its budget`);
      assert.ok(row.outcome.elapsedMs < row.budgetMs + 3000, `${name}: fired within scheduling tolerance`);
    }
  } finally { clearInterval(keepAlive); }
}

await main();
