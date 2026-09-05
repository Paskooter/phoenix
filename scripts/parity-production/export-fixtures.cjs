// Export deterministic original test-data values, not service-response goldens.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const ref = path.resolve(process.argv[2]), out = path.resolve(process.argv[3]);
const hash = data => crypto.createHash('sha256').update(data).digest('hex');
const { mockRuntimeData } = require(path.join(ref, 'packages/test-utils/lib/mockRuntimeData'));
const { darkSkyTodayData } = require(path.join(ref, 'packages/test-utils/lib/lasso-test/DarkSkyTestData'));
const fixtures = {
  'context.json': { general: { accountID: 'fixture-account', robotID: 'fixture-robot', lang: 'en-US', release: '8.67.5309' },
    runtime: mockRuntimeData(true, false, '2018-05-30T12:00:00+00:00') },
  'weather.json': darkSkyTodayData
};
const sources = ['packages/test-utils/src/mockRuntimeData.ts', 'packages/test-utils/src/lasso-test/DarkSkyTestData.ts',
  'packages/test-utils/lib/mockRuntimeData.js', 'packages/test-utils/lib/lasso-test/DarkSkyTestData.js'];
fs.mkdirSync(out, { recursive: true });
const manifest = { schemaVersion: 1, referenceRevision: JSON.parse(fs.readFileSync(path.join(ref, 'parity-compiled.json'))).referenceRevision,
  sources: sources.map(file => ({ path: file, sha256: hash(fs.readFileSync(path.join(ref, file))) })), files: {},
  derivation: { context: 'Original mockRuntimeData(true, false, 2018-05-30T12:00:00+00:00), with explicitly synthetic general account/robot IDs.',
    weather: 'Unchanged exported darkSkyTodayData object; historical weather dates are intentionally retained.' } };
for (const name of Object.keys(fixtures)) {
  const raw = JSON.stringify(fixtures[name], null, 2) + '\n';
  fs.writeFileSync(path.join(out, name), raw); manifest.files[name] = hash(raw);
}
fs.writeFileSync(path.join(out, 'sources.json'), JSON.stringify(manifest, null, 2) + '\n');
