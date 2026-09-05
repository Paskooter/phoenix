'use strict';
const path = require('path');
const Module = require('module');
const driver = require('./driver.cjs');
driver.installClock();
const ref = process.argv[2], out = process.argv[3], manifest = process.argv[4];
process.env.ETCO_server_hubTokenSecret = driver.suite.secret;
process.env.ETCO_server_logLevel = 'error';
process.env.ETCO_server_structuredLogs = 'true';
process.env.ETCO_server_name = 'original-compare-fixture';
const load = Module._load;
Module._load = function(name, parent, isMain) {
  if (name === '@google-cloud/speech') return { SpeechClient: class { streamingRecognize() { throw new Error('Live ASR disabled in comparison fixture'); } } };
  if (name === 'grpc') return { credentials: { createInsecure: () => ({ fixture: true }) } };
  return load.call(this, name, parent, isMain);
};
const utils = require(path.join(ref, 'packages/utils'));
const HubService = require(path.join(ref, 'packages/hub/lib/HubService')).HubService;
driver.run({
  name: 'original', WebSocket: require(path.join(ref, 'node_modules/ws')),
  async start(config) {
    class Handler extends utils.service.BaseHttpHandler {
      constructor() {
        super();
        this.addGetHandler('/null', async () => null);
        this.addGetHandler('/undefined', async () => undefined);
        this.addGetHandler('/array', async () => [null, false, 0, '']);
        this.addPostHandler('/echo', async body => body);
        this.addGetHandler('/error', async () => { const error = new Error('fixture teapot'); error.statusCode = 418; throw error; });
      }
    }
    const base = new utils.service.BaseService('fixture');
    base.addHttpHandler('/fixture', { handler: new Handler() });
    base.addHttpHandler('/protected', { handler: new Handler(), authenticationRequired: true });
    const hub = new HubService({ disableAuth: false, skills: config.skills, parser: { baseURL: config.peerURL },
      history: { baseURL: config.peerURL }, settings: { baseURL: config.peerURL }, hubSettings: { recordLaunchHistory: true } });
    await base.init(0); await hub.init(0);
    return { basePort: base.server.address().port, hubPort: hub.server.address().port, close: async () => { await hub.close(); await base.close(); } };
  },
}, out, manifest).catch(error => { console.error(error.stack); process.exitCode = 1; });
