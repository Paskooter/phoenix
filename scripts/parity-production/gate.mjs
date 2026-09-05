// Conventional npm test/CI entry point. Every mismatch remains a nonzero exit.
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
const root = fileURLToPath(new URL('../../', import.meta.url));
const args = process.argv.slice(2);
if (args.length && !(args.length === 2 && args[0] === '--out')) {
  console.error('Usage: npm run parity:gate -- [--out EMPTY_DIRECTORY]');
  process.exitCode = 2;
} else {
  const out = args.length ? resolve(args[1]) : resolve(root, '.parity/runs/ci-production-' + randomUUID());
  const suite = JSON.parse(readFileSync(resolve(root, 'packages/harness/resources/goldens/production-smoke/suite.json'), 'utf8'));
  console.log(`Strict production smoke gate (${suite.cases.length} cases; full corpus remains separately tracked). Evidence: ${out}`);
  const child = spawnSync('python3', [resolve(root, 'scripts/parity-production/run.py'), '--golden', resolve(root, 'packages/harness/resources/goldens/production-smoke'), '--out', out], { stdio: 'inherit', cwd: root });
  if (child.error) console.error(child.error.message);
  process.exitCode = child.status ?? 2;
}
