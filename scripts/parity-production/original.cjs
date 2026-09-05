'use strict';
const fs = require('fs');
const path = require('path');
const net = require('net');
const http = require('http');
const driver = require('./driver.cjs');
driver.installClock();
const ref = process.argv[2], suite = JSON.parse(fs.readFileSync(process.argv[3])), out = process.argv[4];
process.env.ETCO_server_logLevel = 'error';
process.env.ETCO_server_structuredLogs = 'true';
process.env.ETCO_server_name = 'parity-production-original';
process.chdir(path.join(ref, 'packages/chitchat-skill'));

function waitForNativePort() {
  const started = process.hrtime();
  return new Promise((resolve, reject) => {
    function attempt() {
      const socket = net.connect({ host: '127.0.0.1', port: 8787 });
      socket.setTimeout(500, () => socket.destroy(new Error('Native readiness connection timed out')));
      socket.once('connect', () => { socket.end(); resolve(); });
      socket.once('error', error => {
        socket.destroy();
        const d = process.hrtime(started);
        if (d[0] >= 10) reject(error); else setTimeout(attempt, 100);
      });
    }
    attempt();
  });
}

const adapter = {
  name: 'original',
  moduleFile: __filename,
  async start({ peerURL }) {
    const authority = peerURL.replace('http://', '');
    process.env.NET_lasso = authority; process.env.NET_settings = authority; process.env.prefsFromConfig = 'false';
    const { ParserService } = require(path.join(ref, 'packages/parser/lib/ParserService'));
    const { RobustParserProcess } = require(path.join(ref, 'packages/parser/lib/robustparser/RobustParserProcess'));
    const { HubConfigProvider } = require(path.join(ref, 'packages/hub/lib/config/HubConfigProvider'));
    const { SkillConfigManager } = require(path.join(ref, 'packages/hub/lib/config/SkillConfigManager'));
    const { IntentRouter } = require(path.join(ref, 'packages/hub/lib/intent/IntentRouter'));
    const { SkillRequestHelper } = require(path.join(ref, 'packages/hub/lib/skill/SkillRequestHelper'));
    const { SkillService } = require(path.join(ref, 'packages/baseskill/lib/SkillService'));
    const { Chitchat } = require(path.join(ref, 'packages/chitchat-skill/lib/Chitchat'));
    const { PersonalReport } = require(path.join(ref, 'packages/report-skill/lib/PersonalReport'));
    const axios = require(path.join(ref, 'node_modules/axios'));
    const performance = { endpoint: 'http://localhost:10003/log', counts: {}, unexpected: [] };
    const nativeDiagnostics = { loads: [], parseResponses: 0, errors: [], performance };
    // The frozen native config enables a localhost performance sink. Its
    // asynchronous Poco tasks share a bounded thread pool; leaving the sink
    // absent can make rapid COMPILE requests fail with No thread available.
    // Host that dependency without changing native config, code or results.
    const performancePeer = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', chunk => chunks.push(chunk));
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let body; try { body = JSON.parse(raw); } catch (_) {}
        if (req.method !== 'POST' || req.url !== '/log' || !body || body.type !== 'NLU' || !/^(COMPILE|UNION|PARSE_FROM_URI)_(RECEIVED|COMPLETE)$/.test(body.description)) performance.unexpected.push({ method: req.method, path: req.url, raw });
        else performance.counts[body.description] = (performance.counts[body.description] || 0) + 1;
        res.setHeader('Connection', 'close'); res.end('{}');
      });
    });
    const interceptor = axios.interceptors.response.use(response => {
      if (response.config.url === 'http://127.0.0.1:8787/nlu_interface') {
        const req = JSON.parse(response.config.data);
        if (req.REQ_TYPE === 'COMPILE') nativeDiagnostics.loads.push({ request: req, status: response.status, body: response.data });
        else nativeDiagnostics.parseResponses++;
      }
      return response;
    }, error => {
      if (error.config && error.config.url === 'http://127.0.0.1:8787/nlu_interface') nativeDiagnostics.errors.push({ request: error.config.data, error: driver.serializeError(error), status: error.response && error.response.status, body: error.response && error.response.data });
      return Promise.reject(error);
    });
    const native = new RobustParserProcess(), services = [];
    let parser;
    async function close() {
      for (const service of services) await service.close();
      if (parser) await parser.close();
      native.stop('Isolated production parity capture finished');
      axios.interceptors.response.eject(interceptor);
      if (performancePeer.listening) await new Promise(resolve => performancePeer.close(resolve));
    }
    try {
      await new Promise((resolve, reject) => { performancePeer.once('error', reject); performancePeer.listen(10003, resolve); });
      await native.start();
      // Supported externally managed parser mode. Verify its listener after the
      // original readiness marker; no parser result or service method is patched.
      await waitForNativePort();
      const parserConfig = { robustParser: { enabled: true, startProcess: false, config: {
        host: '127.0.0.1', port: 8787, maxConcurrentRequests: 1, connectToLogs: false, loadFSTs: true,
        fstDirectories: [path.join(ref, 'packages/parser/robust-parser/rules_fst')] } },
        dialogflow: { enabled: false, config: { accessToken: 'disabled-fixture-token' } } };
      parser = new ParserService(parserConfig); await parser.init(0);
      if (nativeDiagnostics.loads.length !== 98 || nativeDiagnostics.loads.some(r => r.status !== 200 || r.body.Status !== 'OK')) throw new Error('All 98 frozen native grammars must load successfully');
      const configs = await HubConfigProvider.getSkillConfigs('skills-local.json');
      const manager = new SkillConfigManager(configs), router = new IntentRouter(manager), skillPorts = {};
      for (const skill of [new Chitchat(), new PersonalReport()]) {
        const service = new SkillService(skill); services.push(service); await service.init(0); skillPorts[skill.name] = service.server.address().port;
      }
      const builders = { LISTEN_LAUNCH: 'buildListenLaunchRequest', LISTEN_UPDATE: 'buildListenUpdateRequest', PROACTIVE_LAUNCH: 'buildProactiveLaunchRequest' };
      const buildSkillRequest = ({ type, skillID, input }) => {
        if (!builders[type]) throw new Error('Unsupported skill request type: ' + type);
        return SkillRequestHelper[builders[type]](skillID, input);
      };
      return { parserPort: parser.server.address().port, skillPorts, buildSkillRequest, route: data => router.getSkillIDFromNLU(data), onRobot: id => manager.isOnRobotSkill(id), close,
        metadata: { referenceRevision: suite.referenceRevision, parserConfig, parserState: parser.getServiceState(), nativeDiagnostics,
          nativeProcessMode: 'Original RobustParserProcess externally managed; original ParserService startProcess=false',
          nativeClock: 'Native C++/V8 process uses host time; Node service and skill clocks are fixture controlled. Control runs must agree.',
          nativePerformanceSink: 'Original enabled localhost:10003/log dependency receives immediate fixture responses; counts are setup diagnostics, not Phoenix telemetry parity.',
          binarySha256: driver.sha(fs.readFileSync(path.join(ref, 'packages/parser/robust-parser/build/bin/jibo-nlu-service'))),
          emissionRecordSha256: driver.sha(fs.readFileSync(path.join(ref, 'parity-compiled.json'))),
          requestBuilder: 'Original SkillRequestHelper; complete input and emitted HTTP request retained',
          registryProfile: 'Original HubConfigProvider skills-local.json', configIDs: configs.map(c => c.id) } };
    } catch (error) { await close(); error.parityDiagnostics = nativeDiagnostics; throw error; }
  }
};
driver.run(adapter, suite, out).then(report => { if (!report.captureComplete || report.cases.some(c => c.failure)) process.exitCode = 2; }, error => { console.error(error); process.exitCode = 2; });
