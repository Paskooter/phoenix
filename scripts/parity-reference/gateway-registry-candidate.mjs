import fs from 'node:fs';
import path from 'node:path';
import run from './gateway-registry-probe.cjs';
import { loadRegistry } from '../../packages/gateway/src/registry.js';
import { loadConfig } from '../../packages/gateway/src/config.js';
import { SkillConfigManager } from '../../packages/gateway/src/skillClient.js';
import { createGateway } from '../../packages/gateway/src/index.js';

const result = await run({
  name: 'Phoenix-createGateway-Node22',
  manager: configs => new SkillConfigManager(configs),
  registry: (rootPath, indexFile) => loadRegistry({ rootPath, indexFile }),
  config: async env => {
    const { disableAuth, parserURL, historyURL, settingsURL, recordLaunchHistory, recordSpeechHistory } = await loadConfig(env);
    return { disableAuth, parserURL, historyURL, settingsURL, recordLaunchHistory, recordSpeechHistory };
  },
  server: async skills => {
    const gateway = await createGateway({ disableAuth: false, hubTokenSecret: '', parserURL: 'http://127.0.0.1:9', historyURL: 'http://127.0.0.1:9', skills });
    await gateway.service.listen(0);
    return { port: gateway.service.server.address().port, close: () => new Promise(resolve => gateway.service.server.close(resolve)) };
  },
}, path.join(path.resolve(process.argv[2]), 'packages/hub'));
fs.writeFileSync(process.argv[3], JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ validations: result.validations.length, registries: result.registries.length, http: result.http.length, originalSkills: result.originalIndex.skills.length }));
