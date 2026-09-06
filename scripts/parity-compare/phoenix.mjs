import driver from './driver.cjs';
import { pathToFileURL } from 'node:url';
driver.installClock();
const [root, out, manifest] = process.argv.slice(2);
delete process.env.ETCO_parser_llmUrl;
delete process.env.ETCO_hub_skillsConfig;
const { createService } = await import(pathToFileURL(`${root}/packages/common/src/service.js`));
const { createGateway } = await import(pathToFileURL(`${root}/packages/gateway/src/index.js`));
const { default: WebSocket } = await import(pathToFileURL(`${root}/node_modules/ws/wrapper.mjs`));
await driver.run({
  name: 'phoenix', WebSocket,
  async start(config) {
    const routes = {};
    for (const prefix of ['/fixture', '/protected']) {
      routes[`GET ${prefix}/null`] = async () => null;
      routes[`GET ${prefix}/undefined`] = async () => undefined;
      routes[`GET ${prefix}/array`] = async () => [null, false, 0, ''];
      routes[`POST ${prefix}/echo`] = async ({ body }) => body;
      routes[`GET ${prefix}/error`] = async () => { const error = new Error('fixture teapot'); error.statusCode = 418; throw error; };
    }
    // The original shared runner has a built-in authenticationRequired option;
    // Phoenix currently has no equivalent. Do not add authentication in this
    // adapter and accidentally hide that missing production behavior.
    const base = createService({ name: 'fixture', routes });
    const hub = await createGateway({ disableAuth: false, hubTokenSecret: config.secret, accountUrl: '', skills: config.skills,
      parserURL: config.peerURL, historyURL: config.peerURL, recordLaunchHistory: true });
    await base.listen(0); await hub.service.listen(0);
    return { basePort: base.server.address().port, hubPort: hub.service.server.address().port,
      close: async () => { hub.wss.close(); await new Promise(resolve => hub.service.server.close(resolve)); await new Promise(resolve => base.server.close(resolve)); } };
  },
}, out, manifest);
