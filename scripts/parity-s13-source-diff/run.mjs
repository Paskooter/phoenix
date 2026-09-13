#!/usr/bin/env node

// Public entrypoint.  Keeping orchestration separate makes the comparator
// usable in receipt-only falsification mode while this command always runs
// both isolated runtimes when receipts are absent.

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const result = spawnSync(process.execPath, [path.join(here, 'compare.mjs'), ...process.argv.slice(2)], { stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status === null ? 1 : result.status;
