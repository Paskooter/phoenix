// Child helper for restart-process.mjs: start the real classic entrypoint on an ephemeral port
// (so parallel worktrees can never collide) and print the chosen port as one JSON line on stdout.
// A15_FIXED_NOW freezes the Person clock so the pinned 2016..2020 holiday table is in range (the
// deployed entrypoint uses the wall clock; the store itself is what durability is about).
import { createClassicEntrypoint } from '../../../../../packages/classic/src/index.js';

const fixedNow = Number(process.env.A15_FIXED_NOW);
const person = Number.isFinite(fixedNow) ? { now: () => fixedNow } : undefined;
const service = await createClassicEntrypoint({ person }).listen(0);
// Distinct prefix: the entrypoint's own logger already prints JSON (including a "listening" line
// with port 0) to stdout, so a bare JSON line is ambiguous.
process.stdout.write(`A15PORT ${JSON.stringify({ port: service.address().port })}\n`);
