import { readFileSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import driver from './driver.cjs';
driver.installClock();
const root = process.argv[2], suite = JSON.parse(readFileSync(process.argv[3], 'utf8')), out = process.argv[4];
const moduleAt = path => import(pathToFileURL(resolve(root, path)).href);
const adapter = {
  name: 'phoenix',
  moduleFile: fileURLToPath(import.meta.url),
  async start({ peerURL }) {
    process.env.NET_data = peerURL; process.env.NET_settings = peerURL.replace('http://', '');
    process.env.ETCO_report_prefsFromConfig = 'false';
    process.env.ETCO_parser_llmUrl = '';
    process.env.ETCO_hub_skillsConfig = 'skills-local.json';
    process.env.LOG_LEVEL = 'error';
    const { start } = await moduleAt('packages/nlu/src/index.js');
    const { loadRegistry } = await moduleAt('packages/gateway/src/registry.js');
    const { IntentRouter } = await moduleAt('packages/gateway/src/intentRouter.js');
    const { SkillClient, SkillConfigManager } = await moduleAt('packages/gateway/src/skillClient.js');
    const { createSkillService } = await moduleAt('packages/skills/src/skillService.js');
    const { chitchatSkill } = await moduleAt('packages/skills/src/chitchatSkill.js');
    const { reportSkill } = await moduleAt('packages/skills/src/reportSkill.js');
    const servers = [], skillPorts = {}, configs = await loadRegistry({}), router = new IntentRouter(configs);
    // The public client methods execute the production request builders. Only
    // their final transport seam is replaced; the shared driver captures the
    // emitted request and sends those exact bytes to the real skill service.
    class CapturingSkillClient extends SkillClient { async _send(_skillID, request) { return request; } }
    const skillClient = new CapturingSkillClient(new SkillConfigManager(configs));
    const buildSkillRequest = ({ type, skillID, input }) => {
      if (type === 'LISTEN_LAUNCH') return skillClient.launch(skillID, input);
      if (type === 'LISTEN_UPDATE') return skillClient.launchOrUpdate(skillID, input, undefined, true);
      if (type === 'PROACTIVE_LAUNCH') return skillClient.proactiveLaunch(skillID, input);
      throw new Error('Unsupported skill request type: ' + type);
    };
    const close = async () => { for (const server of servers) await new Promise((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeIdleConnections?.(); }); };
    try {
      const parser = await start(0); servers.push(parser);
      for (const [id, handler] of [['chitchat-skill', chitchatSkill], ['report-skill', reportSkill]]) {
        const server = await createSkillService({ name: id, skillId: id, handler }).listen(0); servers.push(server); skillPorts[id] = server.address().port;
      }
      return { parserPort: parser.address().port, skillPorts, buildSkillRequest, route: data => router.getSkillIDFromNLU(data), onRobot: id => !!configs.find(c => c.id === id)?.onRobot, close,
        metadata: { parserMode: 'Production POST /v1/parse with LLM provider disabled', requestBuilder: 'Production SkillClient public methods; final transport captured and sent by shared HTTP driver', registryProfile: 'Production loadRegistry skills-local.json', configIDs: configs.map(c => c.id) } };
    } catch (error) { await close(); throw error; }
  }
};
const report = await driver.run(adapter, suite, out);
if (!report.captureComplete || report.cases.some(c => c.failure)) process.exitCode = 2;
