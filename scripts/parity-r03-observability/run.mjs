// R-03 observability lane: real HTTP trace sinks, logger capture, health fault injection,
// and explicit configuration probes. This lane does not edit packages/*/src.
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { logger } from '../../packages/common/src/log.js';
import { readTrace, writeTrace } from '../../packages/common/src/headers.js';
import { readEnvVars } from '../../packages/common/src/env.js';
import { parseServicePort, serviceCliPort } from '../../packages/common/src/cli.js';
import { resolveLlmProvider } from '../../packages/contracts/src/llmProvider.js';
import { DefaultPort } from '../../packages/contracts/src/constants.js';
import { accountVerifyTimeout, loadConfig } from '../../packages/gateway/src/config.js';
import { ParserClient } from '../../packages/gateway/src/parserClient.js';
import { HistoryClient } from '../../packages/gateway/src/historyClient.js';
import { SkillClient, SkillConfigManager } from '../../packages/gateway/src/skillClient.js';
import { createHistoryService } from '../../packages/history/src/index.js';
import { HistoryStore } from '../../packages/history/src/store.js';
import { resolveNewsPolling, NEWS_POLL_INTERVAL_MS } from '../../packages/data/src/news.js';

const TRACE = Object.freeze({
  transId: 'r03-trace-001',
  robotId: 'r03-robot-001',
  loggingConfig: '{"gateway":"debug","history":"info"}',
});

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
}

async function closeServer(server) {
  if (!server || !server.listening) return;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function withSuppressedServiceLogs(fn) {
  const oldStdout = process.stdout.write;
  const oldStderr = process.stderr.write;
  process.stdout.write = () => true;
  process.stderr.write = () => true;
  try {
    return await fn();
  } finally {
    process.stdout.write = oldStdout;
    process.stderr.write = oldStderr;
  }
}

async function startTraceSink() {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    requests.push({
      method: req.method,
      url: req.url,
      headers: { ...req.headers },
      body: raw ? JSON.parse(raw) : null,
    });
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    if (req.url === '/v1/parse') {
      res.end(JSON.stringify({ data: { rules: [], intent: null, entities: {} } }));
    } else if (req.url === '/v1/speech') {
      res.end(JSON.stringify({ id: 'speech-r03' }));
    } else {
      res.end(JSON.stringify({ type: 'SKILL_ACTION', data: { fixture: true } }));
    }
  });
  const url = await listen(server);
  return { server, url, requests };
}

export async function measureTracePropagation() {
  const sink = await startTraceSink();
  try {
    const parser = new ParserClient(sink.url);
    const history = new HistoryClient(sink.url);
    const skill = new SkillClient(new SkillConfigManager([
      { id: 'r03-skill', URL: sink.url, intents: [] },
    ]));

    assert.deepEqual(readTrace({ headers: {
      'x-jibo-transid': TRACE.transId,
      'x-jibo-robotid': TRACE.robotId,
      'x-jibo-logging-config': TRACE.loggingConfig,
    } }), TRACE);
    assert.deepEqual(writeTrace(TRACE), {
      'x-jibo-transid': TRACE.transId,
      'x-jibo-robotid': TRACE.robotId,
      'x-jibo-logging-config': TRACE.loggingConfig,
    });

    await parser.handleNLU({ text: 'trace fixture', rules: [] }, TRACE);
    await history.createSpeechRecord({ robotID: TRACE.robotId }, TRACE);
    await skill.launchOrUpdate('r03-skill', {
      context: { general: {}, runtime: {}, skill: {} },
      nlu: null,
      asr: null,
    }, TRACE);

    assert.equal(sink.requests.length, 3);
    const observed = sink.requests.map((request) => ({
      method: request.method,
      url: request.url,
      trace: {
        transId: request.headers['x-jibo-transid'],
        robotId: request.headers['x-jibo-robotid'],
        loggingConfig: request.headers['x-jibo-logging-config'],
      },
    }));
    for (const request of observed) assert.deepEqual(request.trace, TRACE);
    return {
      calls: observed,
      propagatedVerbatim: true,
      paths: observed.map(({ method, url }) => `${method} ${url}`),
    };
  } finally {
    await closeServer(sink.server);
  }
}

export function measureLogging() {
  const stdout = [];
  const stderr = [];
  const oldStdout = process.stdout.write;
  const oldStderr = process.stderr.write;
  process.stdout.write = (chunk) => { stdout.push(String(chunk)); return true; };
  process.stderr.write = (chunk) => { stderr.push(String(chunk)); return true; };
  try {
    logger('r03.probe', { transId: TRACE.transId, robotId: TRACE.robotId, loggingConfig: '{"r03.probe":"debug"}' })
      .debug('debug fixture');
    logger('r03.probe', { transId: TRACE.transId }).info('info fixture');
    logger('r03.probe', { transId: TRACE.transId, loggingConfig: '{not-json' }).info('malformed-config fixture');
  } finally {
    process.stdout.write = oldStdout;
    process.stderr.write = oldStderr;
  }
  const records = [...stdout, ...stderr]
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
  assert.equal(records.length, 3);
  for (const record of records) {
    for (const field of ['t', 'level', 'ns', 'msg']) assert.ok(Object.hasOwn(record, field), field);
    assert.ok(!Number.isNaN(Date.parse(record.t)), record.t);
  }
  assert.equal(records[0].level, 'debug');
  assert.equal(records[0].transId, TRACE.transId);
  assert.equal(records[0].robotId, undefined, 'robotId is not automatically emitted by Phoenix logger');
  assert.equal(records[2].msg, 'malformed-config fixture');
  return {
    records,
    alwaysFields: ['t', 'level', 'ns', 'msg'],
    conditionalFields: ['transId'],
    notAutomaticallyEmitted: ['robotId', 'loggingConfig'],
    malformedLoggingConfig: 'ignored; global threshold remains active',
  };
}

class ToggleHistoryStore extends HistoryStore {
  constructor() {
    super();
    this.down = false;
  }

  addSkillLaunch(data) {
    if (this.down) throw new Error('fixture history store unavailable');
    return super.addSkillLaunch(data);
  }
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  let body = text;
  try { body = JSON.parse(text); } catch { /* healthcheck is text */ }
  return { status: response.status, body };
}

export async function measureHistoryHealthcheck() {
  const store = new ToggleHistoryStore();
  const service = createHistoryService(store);
  await withSuppressedServiceLogs(() => service.listen(0));
  const base = `http://127.0.0.1:${service.server.address().port}`;
  try {
    const observed = await withSuppressedServiceLogs(async () => {
      const before = await requestJson(`${base}/healthcheck`);
      const writeBefore = await requestJson(`${base}/v1/skill/launch`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ timestamp: Date.now(), sessionID: 'r03', robotID: TRACE.robotId, skillID: 'r03-skill' }),
      });
      store.down = true;
      const writeAfter = await requestJson(`${base}/v1/skill/launch`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ timestamp: Date.now(), sessionID: 'r03-down', robotID: TRACE.robotId, skillID: 'r03-skill' }),
      });
      const after = await requestJson(`${base}/healthcheck`);
      return { before, writeBefore, writeAfter, after };
    });
    const { before, writeBefore, writeAfter, after } = observed;
    assert.deepEqual(before, { status: 200, body: 'ok' });
    assert.equal(writeBefore.status, 200);
    assert.equal(writeAfter.status, 500);
    assert.deepEqual(after, { status: 200, body: 'ok' });
    return {
      endpoint: 'GET /healthcheck',
      baseline: before,
      storeOperationBeforeFault: { status: writeBefore.status },
      injectedStoreFault: 'addSkillLaunch throws fixture history store unavailable',
      storeOperationAfterFault: { status: writeAfter.status },
      afterFault: after,
      falselyHealthy: after.status === 200 && writeAfter.status >= 500,
      classification: 'Phoenix endpoint is liveness-only; reference HistoryService makes this path dependency-aware.',
    };
  } finally {
    await closeServer(service.server);
  }
}

async function measureServiceHealthSourceInventory() {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const services = ['gateway', 'nlu', 'data', 'history', 'skills', 'account', 'classic', 'ota'];
  const rows = [];
  for (const name of services) {
    const path = join(root, 'packages', name, 'src', 'index.js');
    const source = await (await import('node:fs/promises')).readFile(path, 'utf8');
    rows.push({
      service: name,
      createServiceCalls: (source.match(/createService\s*\(/g) || []).length,
      wrapperFactory: name === 'skills' ? 'createSkillsService' : name === 'ota' ? 'createOtaService' : null,
      suppliesHealthcheckOverride: /healthcheckBody|healthcheck\s*:/i.test(source),
      defaultPort: DefaultPort[name],
    });
  }
  assert.equal(rows.length, Object.keys(DefaultPort).length);
  assert.ok(rows.every((row) => row.createServiceCalls >= 1 || row.wrapperFactory));
  assert.ok(rows.every((row) => row.suppliesHealthcheckOverride === false));
  return rows;
}

export async function measureConfiguration() {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const envPrecedence = readEnvVars({ ETCO_probe_value: 'default', ETCO_probe_empty: 'default-empty' }, {
    ETCO_probe_value: 'explicit',
    ETCO_probe_empty: '',
  });
  assert.deepEqual(envPrecedence, { ETCO_probe_value: 'explicit', ETCO_probe_empty: 'default-empty' });

  const malformedEtcoValue = parseServicePort([], { ETCO_server_port: 'not-a-port' });
  const ports = {
    defaultSource: parseServicePort([], {}),
    etco: parseServicePort([], { ETCO_server_port: '8123' }),
    argvWins: parseServicePort(['--port', '8124'], { ETCO_server_port: '8123' }),
    malformedEtco: Number.isNaN(malformedEtcoValue) ? 'NaN' : malformedEtcoValue,
    malformedEtcoIsNaN: Number.isNaN(malformedEtcoValue),
    phoenixPortAlias: serviceCliPort({ args: [], env: { PORT: '8125' }, fallback: '7010' }),
  };
  assert.equal(ports.defaultSource, 8080);
  assert.equal(ports.etco, 8123);
  assert.equal(ports.argvWins, 8124);
  assert.ok(ports.malformedEtcoIsNaN);
  assert.equal(ports.phoenixPortAlias, 8125);

  const llm = resolveLlmProvider('parser', {
    env: {
      ETCO_parser_llmUrl: 'http://scoped.invalid/v1',
      PHOENIX_LLM_URL: 'http://shared.invalid/v1',
      ETCO_parser_llmModel: 'scoped-model',
      PHOENIX_LLM_MODEL: 'shared-model',
      ETCO_parser_llmTimeoutMs: 'not-a-number',
      PHOENIX_LLM_TIMEOUT_MS: '6000',
      ETCO_parser_llmHeaders: '{"X-Scoped":"yes"}',
      PHOENIX_LLM_HEADERS: '{"X-Shared":"yes"}',
    },
    defaultModel: 'default-model',
    defaultTimeoutMs: 10000,
  });
  assert.equal(llm.url, 'http://scoped.invalid/v1');
  assert.equal(llm.model, 'scoped-model');
  assert.equal(llm.timeoutMs, 10000, 'malformed scoped timeout silently falls to default, not shared timeout');
  assert.deepEqual(llm.headers, { 'X-Shared': 'yes', 'X-Scoped': 'yes' });

  const timeout = {
    accountDefault: accountVerifyTimeout(undefined),
    accountEmpty: accountVerifyTimeout(''),
    accountMalformed: 'throws',
  };
  assert.throws(() => accountVerifyTimeout('bad-timeout'), TypeError);
  const polling = {
    defaultEnabled: resolveNewsPolling({}),
    malformedInterval: resolveNewsPolling({ ETCO_lasso_apNewsPollingEnabled: 'true', ETCO_lasso_apNewsPollIntervalMS: 'bad' }),
  };
  assert.equal(polling.defaultEnabled.pollingEnabled, false);
  assert.equal(polling.defaultEnabled.pollIntervalMS, NEWS_POLL_INTERVAL_MS);
  assert.deepEqual(polling.malformedInterval, { pollingEnabled: true, pollIntervalMS: NEWS_POLL_INTERVAL_MS });

  const gatewayDefaults = await loadConfig({
    ETCO_hub_disableAuth: '',
    ETCO_hub_skillsConfig: 'skills-local.json',
    ETCO_hub_speechConfig: 'google-speech.json',
    ETCO_hub_recordSpeechHistory: '',
    ETCO_hub_recordLaunchHistory: '',
    NET_parser: 'parser:9005',
    NET_history: 'history:9006',
    NET_settings: 'settings:9007',
  }, { resourcesDir: join(root, 'packages', 'gateway', 'resources', 'skills') });
  assert.equal(gatewayDefaults.disableAuth, false);
  assert.equal(gatewayDefaults.parserURL, 'http://parser:9005');
  return {
    envPrecedence,
    ports,
    llm: {
      url: llm.url,
      model: llm.model,
      timeoutMs: llm.timeoutMs,
      headers: Object.keys(llm.headers).sort(),
      malformedScopedTimeout: 'silently defaulted to 10000; shared PHOENIX_LLM_TIMEOUT_MS=6000 was not used',
    },
    accountVerifyTimeout: timeout,
    newsPolling: polling,
    gateway: {
      disableAuth: gatewayDefaults.disableAuth,
      parserURL: gatewayDefaults.parserURL,
      historyURL: gatewayDefaults.historyURL,
      settingsURL: gatewayDefaults.settingsURL,
      emptyValues: 'source readEnvVars precedence falls back to defaults',
    },
    conclusion: 'ETCO_* source names win over defaults; scoped LLM values win over PHOENIX_*; validation is inconsistent across timeout surfaces.',
  };
}

export async function runProbe() {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const report = {
    schemaVersion: 1,
    task: 'R-03 observability',
    referenceRevision: '5c0a7390539663ba749d360de348a428c088505c',
    phoenixRevision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    capturedAt: new Date().toISOString(),
    sourceTreeBoundary: 'No packages/*/src files edited by this lane',
    tracePropagation: await measureTracePropagation(),
    logging: measureLogging(),
    healthcheck: await measureHistoryHealthcheck(),
    serviceHealthSourceInventory: await measureServiceHealthSourceInventory(),
    configuration: await measureConfiguration(),
    acceptance: 'measured-gap',
  };
  return report;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const output = process.argv[2];
  if (!output) throw new Error('Usage: node scripts/parity-r03-observability/run.mjs OUTPUT.json');
  const report = await runProbe();
  const { writeFile } = await import('node:fs/promises');
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({
    output,
    acceptance: report.acceptance,
    traceCalls: report.tracePropagation.calls.length,
    loggerFields: report.logging.alwaysFields,
    historyHealth: {
      before: report.healthcheck.baseline.status,
      afterFault: report.healthcheck.afterFault.status,
      writeAfterFault: report.healthcheck.storeOperationAfterFault.status,
    },
    malformedLlmTimeout: report.configuration.llm.timeoutMs,
  }));
}
