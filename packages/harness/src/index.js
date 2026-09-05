import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { compareTraces } from './parityCompare.js';

export { normalizeStream, normalizeMessage } from './normalize.js';
export { diffStreams } from './diff.js';
export { compareTraces, diffValues, validateTrace } from './parityCompare.js';
export { SkillConversation } from './skillConversation.js';
export { mockRuntimeData, LOOP_ID, LOOP_OWNER_ID, DEFAULT_REFERENT_ID, DEFAULT_SPEAKER, FROZEN_ISO } from './mockRuntimeData.js';

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
  const args = process.argv.slice(2);
  if (args[0] === 'compare') {
    const options = {};
    try {
      for (let i = 1; i < args.length; i += 2) {
        if (!['--reference', '--candidate', '--suite', '--out'].includes(args[i]) || !args[i + 1] || options[args[i]]) throw new Error('Invalid comparison arguments');
        options[args[i]] = args[i + 1];
      }
      if (!options['--reference'] || !options['--candidate'] || !options['--out']) throw new Error('Usage: harness compare --reference FILE --candidate FILE --out FILE [--suite FILE]');
      const read = file => JSON.parse(readFileSync(file, 'utf8'));
      const report = compareTraces(read(options['--reference']), read(options['--candidate']), read(options['--suite'] || resolve(root, 'scripts/parity-compare/suite.json')));
      writeFileSync(options['--out'], JSON.stringify(report, null, 2) + '\n');
      console.log(JSON.stringify({ pass: report.pass, cases: report.cases, differences: report.differences.length, invariantFailures: report.invariants.length }));
      process.exitCode = report.pass ? 0 : 1;
    } catch (error) { console.error(error.message); process.exitCode = 2; }
  } else if (args.includes('--help')) {
    console.log('npm run harness -- [--out DIR] [--candidate phoenix|original] [--source PEGASUS]');
    console.log('npm run harness -- compare --reference FILE --candidate FILE --out FILE');
  } else {
    const result = spawnSync('python3', [resolve(root, 'scripts/parity-compare/run.py'), ...args], { stdio: 'inherit' });
    if (result.error) console.error(result.error.message);
    process.exitCode = result.status ?? 2;
  }
}
