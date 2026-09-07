// Long-running development stack using the actual Account issuer and Hub verifier.
// Private inputs are supplied as files; this launcher never records message/audio bodies.
import { readFileSync, statSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
function port(value, name) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0 || number > 65535) throw new Error(`Invalid ${name}`);
  return number;
}
function privateFile(path, name) {
  if (!path) throw new Error(`${name} is required`);
  const absolute = resolve(path);
  const stat = statSync(absolute);
  if (!stat.isFile() || (stat.mode & 0o077)) throw new Error(`${name} must be a private regular file (0600)`);
  return absolute;
}
function listen(server, number, host = '127.0.0.1') {
  return new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(number, host, () => { server.off('error', reject); resolveListen(server); });
  });
}
function closeServer(server) {
  if (!server?.listening) return Promise.resolve();
  return new Promise(resolveClose => {
    server.close(() => resolveClose());
    server.closeAllConnections?.();
  });
}

/** Run in a dedicated process: service modules read process.env at import time. */
export async function startAuthenticatedRobotStack({
  runDir, secretFile, storeFile, keyFile, certFile, snapshotManifest,
  basePort = 19000, entrypointPort = 19443, entrypointHost = '127.0.0.1',
  publicUrl = 'https://localhost', parakeetUrl = 'http://192.168.1.252:6972',
} = {}) {
  if (process.env.PHOENIX_ENV_FILE !== '/dev/null') throw new Error('PHOENIX_ENV_FILE=/dev/null is required');
  if (!runDir || !snapshotManifest) throw new Error('runDir and snapshotManifest are required');
  const base = port(basePort, 'basePort');
  if (base > 65524) throw new Error('basePort leaves no room for the service ports');
  const tlsPort = port(entrypointPort, 'entrypointPort');
  const choosePort = offset => base === 0 ? 0 : base + offset;
  const secretPath = privateFile(secretFile, 'secretFile');
  const accountPath = privateFile(storeFile, 'storeFile');
  const tlsKeyPath = privateFile(keyFile, 'keyFile');
  if (!certFile) throw new Error('certFile is required');
  const secret = readFileSync(secretPath, 'utf8').trim();
  if (!secret) throw new Error('secretFile must not be empty');
  const tlsOptions = { key: readFileSync(tlsKeyPath), cert: readFileSync(certFile), minVersion: 'TLSv1.2' };
  const directory = resolve(runDir);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if ((statSync(directory).mode & 0o077) !== 0) throw new Error('runDir must be private (0700)');
  const endpoints = {};
  const servers = [];
  let gateway;
  let classic;
  let stopping;
  function stop() {
    if (stopping) return stopping;
    stopping = (async () => {
      for (const wss of [gateway?.wss, classic?.wss]) {
        for (const socket of wss?.clients || []) socket.terminate();
        wss?.close();
      }
      await Promise.allSettled(servers.map(closeServer));
    })();
    return stopping;
  }
  // Keep this named hardware profile separate from the default AST parser and
  // from the optional external-answer profiles under review.
  for (const name of Object.keys(process.env)) {
    if (name.startsWith('PHOENIX_NLU_')) delete process.env[name];
  }
  Object.assign(process.env, {
    PHOENIX_NLU_RUNTIME: 'compiled-fst',
    PHOENIX_NLU_COMPILED_SNAPSHOT_MANIFEST: resolve(snapshotManifest),
    PHOENIX_SKILL_ID: '', PHOENIX_GQA_PROFILE: '',
    ETCO_parser_llmUrl: '', ETCO_answer_llmUrl: '',
    ETCO_account_dataFile: accountPath,
    ETCO_classic_backupDir: resolve(directory, 'backups'),
    ETCO_classic_publicUrl: publicUrl,
    HUB_TOKEN_SECRET: secret, ETCO_server_hubTokenSecret: secret,
    ETCO_hub_disableAuth: 'false', ETCO_hub_accountUrl: '',
    ETCO_server_parakeetUrl: parakeetUrl,
  });
  try {
    const { compiledFstRuntimeConfig } = await import('../../packages/nlu/src/compiledFstRuntime.js');
    const compiledProfile = compiledFstRuntimeConfig();
    if (!compiledProfile?.snapshotManifest) throw new Error('A validated portable compiled-parser profile is required');
    // Open the actual service implementations, then bind their real addresses
    // into the downstream clients before importing/creating the Hub.
    for (const [name, offset] of [['nlu', 5], ['history', 6], ['data', 7], ['skills', 3]]) {
      const module = await import(`../../packages/${name}/src/index.js`);
      const server = await module.start(choosePort(offset));
      servers.push(server);
      const netName = name === 'nlu' ? 'parser' : name;
      endpoints[netName] = server.address().port;
      process.env[`NET_${netName}`] = `127.0.0.1:${endpoints[netName]}`;
    }
    const { createAccountService, Store } = await import('../../packages/account/src/index.js');
    const account = createAccountService({ store: new Store(accountPath) });
    servers.push(account.server);
    await listen(account.server, choosePort(11));
    endpoints.account = account.server.address().port;
    process.env.NET_account = `127.0.0.1:${endpoints.account}`;

    const { createClassicEntrypoint } = await import('../../packages/classic/src/index.js');
    classic = createClassicEntrypoint({ tls: tlsOptions });
    servers.push(classic.server);
    // Use the same TLS server for HTTP and notification upgrades. Wrapping only
    // classic.app in a second server would leave its upgrade listener behind.
    classic.server.on('tlsClientError', (_error, socket) => socket.destroy());
    await listen(classic.server, tlsPort, entrypointHost);
    endpoints.entrypointTls = classic.server.address().port;

    const { createGateway } = await import('../../packages/gateway/src/index.js');
    const { loadConfig } = await import('../../packages/gateway/src/config.js');
    const config = await loadConfig();
    config.disableAuth = false;
    config.hubTokenSecret = secret;
    config.accountUrl = '';
    gateway = await createGateway(config);
    servers.push(gateway.service.server);
    await listen(gateway.service.server, choosePort(0), '0.0.0.0');
    endpoints.hub = gateway.service.server.address().port;
    const receipt = {
      started: new Date().toISOString(), pid: process.pid,
      revision: execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      worktree: root, node: process.version, endpoints,
      authentication: 'real signed Account CreateHubToken and Hub JWT verification',
      compiledProfile, capture: 'no launcher wire or audio capture',
      scope: 'Development process lifecycle. History and notification durability and host/robot reboot supervision remain separate work.',
    };
    const temporary = resolve(directory, 'authenticated-stack.json.tmp');
    writeFileSync(temporary, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, resolve(directory, 'authenticated-stack.json'));
    return { receipt, stop, services: { account, classic, gateway } };
  } catch (error) {
    await stop();
    throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.umask(0o077);
  let stack;
  try {
    stack = await startAuthenticatedRobotStack({
      runDir: process.env.PHOENIX_ROBOT_RUN,
      secretFile: process.env.PHOENIX_ROBOT_SECRET_FILE,
      storeFile: process.env.PHOENIX_ROBOT_STORE_FILE,
      keyFile: process.env.PHOENIX_ROBOT_TLS_KEY,
      certFile: process.env.PHOENIX_ROBOT_TLS_CERT,
      snapshotManifest: process.env.PHOENIX_NLU_COMPILED_SNAPSHOT_MANIFEST,
      basePort: process.env.PHOENIX_ROBOT_PORT ?? 19000,
      entrypointPort: process.env.PHOENIX_ROBOT_ENTRYPOINT_PORT ?? 19443,
      entrypointHost: process.env.PHOENIX_ROBOT_ENTRYPOINT_HOST || '127.0.0.1',
      publicUrl: process.env.PHOENIX_ROBOT_PUBLIC_URL || 'https://localhost',
      parakeetUrl: process.env.ETCO_server_parakeetUrl || 'http://192.168.1.252:6972',
    });
    console.log(JSON.stringify({ ready: true, ...stack.receipt }));
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => {
      await stack.stop();
      process.exit(0);
    });
  } catch (error) {
    console.error(JSON.stringify({ ready: false, error: error.message }));
    process.exitCode = 1;
  }
}
