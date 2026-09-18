import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runLane } from './real-lane.mjs';

const output = process.argv[2];
if (!output) throw new Error('Usage: node scripts/parity-r03-reliability/real-run.mjs OUTPUT.json');
const keepAlive = setInterval(() => {}, 1000);
try {
  const report = await runLane();
  writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({
    output,
    acceptance: report.acceptance,
    elapsedMs: Math.round(report.elapsedMs),
    httpTimeouts: report.httpTimeouts.map(({ kind, timeoutElapsedMs, errorCode, peerOpenAtTimeout, lateFrames }) => ({
      kind, timeoutElapsedMs, errorCode, peerOpenAtTimeout, lateFrames,
    })),
    contextTimeout: {
      timeoutElapsedMs: report.contextTimeout.timeoutElapsedMs,
      errorCode: report.contextTimeout.errorCode,
    },
    disconnect: {
      peerOpenAfterDisconnect: report.disconnect.peerOpenAfterDisconnect,
      lateSettlementObserved: report.disconnect.lateSettlementObserved,
      lateFrames: report.disconnect.lateFrames,
    },
    asrCancellation: {
      stopped: report.asrCancellation.session.stopped,
      aborted: report.asrCancellation.session.aborted,
      transcribeRequests: report.asrCancellation.transcribeRequests,
    },
    asrAbandonment: {
      aborted: report.asrAbandonment.session.aborted,
      totalBytesAfterAbort: report.asrAbandonment.session.totalBytes,
      transcribeRequests: report.asrAbandonment.transcribeRequests,
    },
    falsification: report.falsification,
  }));
} finally {
  clearInterval(keepAlive);
}
