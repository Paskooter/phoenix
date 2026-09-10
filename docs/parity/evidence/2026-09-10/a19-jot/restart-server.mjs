// Child helper for restart-process.mjs: start the real classic entrypoint on an ephemeral port
// (so parallel worktrees can never collide) and print the chosen port as one JSON line on stdout.
// The Jot store is the file named by ETCO_classic_jotFile (read by JotStore's constructor), which is
// exactly what the process restart is about: the entrypoint's own default wiring, no test seams.
import { createClassicEntrypoint } from '../../../../../packages/classic/src/index.js';

const service = await createClassicEntrypoint().listen(0);
// Distinct prefix: the entrypoint's own logger already prints JSON (including a "listening" line
// with port 0) to stdout, so a bare JSON line is ambiguous.
process.stdout.write(`A19PORT ${JSON.stringify({ port: service.address().port })}\n`);
