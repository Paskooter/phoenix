// Run on Node 8.9.4: corrupt expected hashes, never the original source tree.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const spawnSync = require('child_process').spawnSync;
const ref = path.resolve(process.argv[2]);
const proofFile = path.resolve(process.argv[3]);
const outputDir = path.resolve(process.argv[4]);
if (process.version !== 'v8.9.4') throw new Error('Expected Node 8.9.4');
if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir);
const proof = JSON.parse(fs.readFileSync(proofFile, 'utf8'));
const runner = path.join(__dirname, 'gateway-registry-original.cjs');
const wrongHash = '0'.repeat(64);
const mutations = [
  ['source-revision', value => { value.revision = wrongHash.slice(0, 40); }, 'Wrong source pin'],
  ['source-bytes', value => { value.files[0].sha256 = wrongHash; }, 'Source changed:'],
  ['compiled-bytes', value => { value.files[0].compiledSha256 = wrongHash; }, 'Compiled source changed:'],
  ['registry-resource', value => { value.resources[0].sha256 = wrongHash; }, 'Resource/runtime mismatch:'],
  ['native-runtime', value => { value.runtimeFiles[0].sha256 = wrongHash; }, 'Resource/runtime mismatch:'],
];
const rows = mutations.map(([id, mutate, expectedError]) => {
  const value = JSON.parse(JSON.stringify(proof));
  mutate(value);
  const input = path.join(outputDir, id + '.proof.json');
  const capture = path.join(outputDir, id + '.capture.json');
  if (fs.existsSync(capture)) throw new Error('Use a fresh output directory: ' + capture);
  fs.writeFileSync(input, JSON.stringify(value, null, 2) + '\n');
  const result = spawnSync(process.execPath, [runner, ref, input, capture], { encoding: 'utf8', timeout: 30000 });
  fs.writeFileSync(path.join(outputDir, id + '.log'), result.stdout + result.stderr);
  const rejected = (result.status === 1 || result.status === 2) && result.stderr.indexOf(expectedError) >= 0 && !fs.existsSync(capture);
  return { id, rejected, exitCode: result.status, expectedError, emittedCapture: fs.existsSync(capture) };
});
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const report = { runtime: process.version, proofSha256: sha(proofFile), runnerSha256: sha(runner), total: rows.length, rejected: rows.filter(row => row.rejected).length, controls: rows };
fs.writeFileSync(path.join(outputDir, 'summary.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ total: report.total, rejected: report.rejected }));
if (report.rejected !== report.total) process.exitCode = 1;
