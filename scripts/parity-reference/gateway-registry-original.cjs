// Run with the pinned Node 8 image and the prepared, transpiled source tree.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const ref = path.resolve(process.argv[2]);
const proof = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
if (proof.revision !== '5c0a7390539663ba749d360de348a428c088505c') throw new Error('Wrong source pin');
if (process.version !== 'v8.9.4') throw new Error('Expected original Node 8.9.4 runtime');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
let complete = false;
process.on('exit', () => { if (!complete) { console.error('Incomplete original probe'); process.exitCode = 2; } });
for (const item of proof.files) {
  if (item.compiledPath) {
    if (sha(fs.readFileSync(path.join(ref, item.path))) !== item.sha256) throw new Error('Source changed: ' + item.path);
    if (sha(fs.readFileSync(path.join(ref, item.compiledPath))) !== item.compiledSha256) throw new Error('Compiled source changed: ' + item.compiledPath);
  } else if (sha(fs.readFileSync(path.join(ref, item.installedSource))) !== item.sha256) throw new Error('Dependency source mismatch: ' + item.path);
}
for (const item of [...proof.resources, ...proof.runtimeFiles]) {
  if (sha(fs.readFileSync(path.join(ref, item.path))) !== item.sha256) throw new Error('Resource/runtime mismatch: ' + item.path);
}
const hub = path.join(ref, 'packages/hub/lib');
console.error('Loading original modules');
const Manager = require(path.join(hub, 'config/SkillConfigManager.js')).SkillConfigManager;
const Parser = require(path.join(hub, 'config/ConfigFileParser.js')).ConfigFileParser;
const Utils = require(path.join(hub, 'skill/SkillUtils.js')).SkillUtils;
const Hub = require(path.join(hub, 'HubService.js')).HubService;
const Provider = require(path.join(hub, 'config/HubConfigProvider.js')).HubConfigProvider;
console.error('Original modules loaded');
require('./gateway-registry-probe.cjs')({
  name: 'original-HubService-Node8',
  progress: stage => console.error('Probe stage: ' + stage),
  manager: configs => new Manager(configs),
  registry: async (root, filename) => {
    const index = await Parser.parseSkillsConfig(path.join(root, 'resources/skills', filename));
    return Utils.buildSkillConfig(index.skills, root);
  },
  config: async env => {
    const keys = require('./gateway-registry-cases.cjs').configKeys;
    const previous = {};
    for (const key of keys) { previous[key] = process.env[key]; delete process.env[key]; }
    Object.assign(process.env, env);
    try {
      const config = await Provider.getConfig();
      return { disableAuth: config.disableAuth, parserURL: config.parser.baseURL, historyURL: config.history.baseURL, settingsURL: config.settings.baseURL, recordLaunchHistory: config.hubSettings.recordLaunchHistory, recordSpeechHistory: config.hubSettings.recordSpeechHistory };
    } finally {
      for (const key of keys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
    }
  },
  server: async skills => {
    const service = new Hub({ disableAuth: false, parser: { baseURL: 'http://127.0.0.1:9' }, history: { baseURL: 'http://127.0.0.1:9' }, settings: { baseURL: 'http://127.0.0.1:9' }, skills });
    await service.init(0);
    return { port: service.server.address().port, close: () => service.close() };
  },
}, path.join(ref, 'packages/hub')).then(result => {
  fs.writeFileSync(process.argv[4], JSON.stringify(result, null, 2) + '\n');
  complete = true;
  console.log(JSON.stringify({ validations: result.validations.length, registries: result.registries.length, http: result.http.length, originalSkills: result.originalIndex.skills.length }));
}).catch(error => { console.error(error.stack); process.exitCode = 1; });
