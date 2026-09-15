// Emit a Phoenix skills registry from the suite's OWN TEST_SKILL_CONFIG.
//
// Transcribing the config by hand would let the substituted hub be tested
// against a different skill definition than the original hub sees, which is
// exactly the kind of difference a substitution run must not introduce. This
// imports the same exported constant the tests use.
require('ts-node/register');
const { TEST_SKILL_CONFIG } = require('./packages/integration-tests-int/src/utils/listen-helpers');
const { writeFileSync, mkdirSync } = require('fs');
const { join } = require('path');

const outDir = process.argv[2];
const skillPort = process.env.R01_SKILL_PORT || '8080';
mkdirSync(outDir, { recursive: true });

const index = { skills: [] };
TEST_SKILL_CONFIG.forEach((skill) => {
  const manifest = Object.assign({}, skill);
  // Phoenix's registry composes baseURL + basePath + /v1/main, as Pegasus does,
  // so the entry carries the origin and the manifest drops the full URL.
  delete manifest.URL;
  const file = `${skill.id}_manifest.json`;
  writeFileSync(join(outDir, file), JSON.stringify(manifest, null, 2));
  index.skills.push({ baseURL: `http://127.0.0.1:${skillPort}`, configPath: file });
});
writeFileSync(join(outDir, 'skills-r01.json'), JSON.stringify(index, null, 2));
console.log(JSON.stringify({ wrote: outDir, skills: index.skills.length, intents: TEST_SKILL_CONFIG[0].intents.map(i => i.name) }));
