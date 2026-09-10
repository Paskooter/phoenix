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
    server.once('error', error => {
      // Binding 443 as an unprivileged user is the expected first-run failure.
      if (error?.code === 'EACCES' && number < 1024) {
        reject(new Error(`cannot bind privileged port ${number} as this user. `
          + 'Either lower the unprivileged port floor '
          + `(sudo sysctl -w net.ipv4.ip_unprivileged_port_start=${number}, persisted in `
          + '/etc/sysctl.d/), or set PHOENIX_ROBOT_ENTRYPOINT_PORT to an unprivileged port '
          + 'and redirect 443 to it.'));
        return;
      }
      if (error?.code === 'EADDRINUSE') {
        reject(new Error(`port ${number} on ${host} is already in use`));
        return;
      }
      reject(error);
    });
    server.listen(number, host, () => { server.removeAllListeners('error'); resolveListen(server); });
  });
}
function closeServer(server) {
  if (!server?.listening) return Promise.resolve();
  return new Promise(resolveClose => {
    server.close(() => resolveClose());
    server.closeAllConnections?.();
  });
}

import { ensureTlsCertificates } from '../ensure-tls-certs.mjs';

/** Run in a dedicated process: service modules read process.env at import time. */
export async function startAuthenticatedRobotStack({
  runDir, secretFile, storeFile, keyFile, certFile, snapshotManifest,
  basePort = 19000, entrypointPort = 443, entrypointHost = '0.0.0.0',
  publicUrl = 'https://localhost', parakeetUrl = 'http://192.168.1.252:6972',
} = {}) {
  if (process.env.PHOENIX_ENV_FILE !== '/dev/null') throw new Error('PHOENIX_ENV_FILE=/dev/null is required');
  if (!runDir) throw new Error('runDir is required');

  // The server owns its robot-facing certificate. Generating it here means a
  // first start is self-sufficient and the repoint script can simply read what
  // we made, rather than the operator running openssl and having to get the
  // robot's hostnames exactly right. Explicit paths always win.
  if (!certFile || !keyFile) {
    const tls = ensureTlsCertificates({ log: message => console.error(JSON.stringify({ ns: 'tls', msg: message })) });
    certFile = certFile || tls.cert;
    keyFile = keyFile || tls.key;
  }
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
  let account;
  let accountStore;
  let notificationRecovery;
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
  // The shipped default is the AST parser (DIVERGENCES.md N1). A compiled
  // profile is opt-in: pass a snapshot manifest to select it. Running without
  // one is the normal case and means this launcher exercises what we ship.
  Object.assign(process.env, snapshotManifest ? {
    PHOENIX_NLU_RUNTIME: 'compiled-fst',
    PHOENIX_NLU_COMPILED_SNAPSHOT_MANIFEST: resolve(snapshotManifest),
  } : {});
  Object.assign(process.env, {
    PHOENIX_SKILL_ID: '', PHOENIX_GQA_PROFILE: '', PHOENIX_GQA_DEFAULT_PROFILE: '',
    ETCO_parser_llmUrl: '', ETCO_answer_llmUrl: '',
    ETCO_account_dataFile: accountPath,
    ETCO_classic_backupDir: resolve(directory, 'backups'),
    ETCO_classic_notificationFile: resolve(directory, 'notifications.json'),
    ETCO_classic_publicUrl: publicUrl,
    HUB_TOKEN_SECRET: secret, ETCO_server_hubTokenSecret: secret,
    ETCO_hub_disableAuth: 'false', ETCO_hub_accountUrl: '',
    ETCO_server_parakeetUrl: parakeetUrl,
  });
  try {
    const { compiledFstRuntimeConfig } = await import('../../packages/nlu/src/compiledFstRuntime.js');
    const compiledProfile = snapshotManifest ? compiledFstRuntimeConfig() : null;
    // Only validate the compiled profile when one was deliberately selected.
    if (snapshotManifest && !compiledProfile?.snapshotManifest) {
      throw new Error('A validated portable compiled-parser profile is required');
    }
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
    // Account and Classic share one Store instance in this colocated
    // development profile. The outbox is constructed without a publisher so
    // requests arriving during Account startup are durably recorded until the
    // Classic notification store and resolver are ready.
    accountStore = new Store(accountPath);
    account = createAccountService({ store: accountStore });
    servers.push(account.server);
    await listen(account.server, choosePort(11));
    endpoints.account = account.server.address().port;
    process.env.NET_account = `127.0.0.1:${endpoints.account}`;

    const { createClassicEntrypoint, MediaStore, accessKeyAccountResolver, createVerifiedNotificationAccountResolver } = await import('../../packages/classic/src/index.js');
    const notificationAccountResolver = createVerifiedNotificationAccountResolver({
      resolveCredentials: (accessKeyId) => accountStore.accountByAccessKeyId(accessKeyId),
    });
    // Media_20160725 has a real store (the app's Gallery tab reads it). Classic and Account are
    // colocated here, so the same resolved account identity and the same loop documents used by
    // the account service back the media membership gate — the check srv-media-ws did over HTTP.
    const memberAccountIds = (loop) => (loop?.members || [])
      .map((member) => (member && member.accountId != null ? String(member.accountId) : null))
      .filter((id) => id !== null);
    const mediaLoops = {
      members: (loopId) => memberAccountIds(accountStore.loops.get(String(loopId))),
      accountLoops: (accountId) => [...accountStore.loops.values()]
        .filter((loop) => memberAccountIds(loop).includes(String(accountId)))
        .map((loop) => String(loop._id)),
      ownedLoops: (accountId) => accountStore.loopsByOwner(String(accountId)).map((loop) => String(loop._id)),
    };
    classic = createClassicEntrypoint({
      tls: tlsOptions,
      notificationFile: resolve(directory, 'notifications.json'),
      notificationAccountResolver,
      media: {
        store: new MediaStore({
          directory: resolve(directory, 'media'),
          file: resolve(directory, 'media.json'),
        }),
        accountResolver: accessKeyAccountResolver((accessKeyId) => accountStore.accountByAccessKeyId(accessKeyId)),
        loops: mediaLoops,
      },
    });
    servers.push(classic.server);
    // Use the same TLS server for HTTP and notification upgrades. Wrapping only
    // classic.app in a second server would leave its upgrade listener behind.
    classic.server.on('tlsClientError', (_error, socket) => socket.destroy());
    await listen(classic.server, tlsPort, entrypointHost);
    endpoints.entrypointTls = classic.server.address().port;

    // Attach the Account -> Classic bridge only after Classic has a durable
    // notification store, verified resolver, and listening socket. A failed
    // publication remains in Account's durable outbox; the explicit recovery
    // pass below handles rows created before readiness or during an outage.
    account.loopUpdatedOutbox.publisher = ({ accountId, skillId, notification }) =>
      classic.hub.deliverNotification({ accountId, skillId, notification });
    try {
      notificationRecovery = await account.loopUpdatedOutbox.recover();
    } catch (error) {
      let retained = null;
      try { retained = account.loopUpdatedOutbox.pending().length; } catch { /* preserve startup failure */ }
      notificationRecovery = { error: error?.message || String(error), retained };
    }

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
      notification: {
        accountStore: accountPath,
        notificationFile: resolve(directory, 'notifications.json'),
        accountDocumentIdentity: 'Account._id/id from the verified SigV4 credential record',
        publisherAttachedAfterClassicReady: typeof account.loopUpdatedOutbox.publisher === 'function',
        recovery: notificationRecovery,
      },
      parserProfile: snapshotManifest ? 'compiled-fst' : 'ast',
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
      entrypointPort: process.env.PHOENIX_ROBOT_ENTRYPOINT_PORT ?? 443,
      entrypointHost: process.env.PHOENIX_ROBOT_ENTRYPOINT_HOST || '0.0.0.0',
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
