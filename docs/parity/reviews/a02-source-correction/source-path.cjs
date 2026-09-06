/*
 * Reproducible source-path probe for A-02.
 *
 * This file deliberately stays CommonJS/Node 8 compatible. It transpiles only
 * the pinned AccountController, TokenController, and WebToken files, stubs the
 * unrelated account dependencies, and invokes the real source call path:
 *
 *   AccountController.createHubToken
 *     -> TokenController.createHubToken
 *       -> WebToken.sign
 *
 * The account and hub secrets are synthetic. The output records their hashes,
 * never their plaintext values. Set PHX_A02_SOURCE_PATH_OUT to save JSON;
 * otherwise the safe JSON is printed to stdout.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Module = require('module');

const WORKTREE = process.env.PHX_REPO_ROOT || path.resolve(__dirname, '../../../../');
const CONSUMERS = process.env.PHX_A02_CONSUMERS_ROOT || path.join(WORKTREE, '.parity', 'consumers');
const TYPESCRIPT = process.env.PHX_A02_TYPESCRIPT || path.join(WORKTREE, 'node_modules', 'typescript');
const JSONWEBTOKEN = process.env.PHX_A02_JSONWEBTOKEN || path.join(
  '/home/shell/work/phoenix/.parity/reference/5c0a7390539663ba749d360de348a428c088505c',
  'node_modules', 'jsonwebtoken',
);
const FIXED_NOW_MS = 1700000000000;
const ACCOUNT_ROOT = path.join(CONSUMERS, 'account-ws-b525601', 'src');
const SERVER_ROOT = path.join(CONSUMERS, 'server-0a39764', 'src');
const ACCOUNT_ID = 'synthetic-account-id';
const ACCESS_KEY = 'A02SOURCEKEY00';
const ACCOUNT_SECRET = 'a02-source-synthetic-secret';
const HUB_SECRET = 'a02-source-hub-secret';

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function decodeJsonPart(token) {
  const encoded = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
  return JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
}

function compile(input, output, ts) {
  const result = ts.transpileModule(fs.readFileSync(input, 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2017,
      experimentalDecorators: true,
      esModuleInterop: false,
    },
  });
  fs.writeFileSync(output, result.outputText);
}

function removeTree(directory) {
  if (!fs.existsSync(directory)) return;
  fs.readdirSync(directory).forEach((entry) => {
    const child = path.join(directory, entry);
    if (fs.statSync(child).isDirectory()) removeTree(child);
    else fs.unlinkSync(child);
  });
  fs.rmdirSync(directory);
}

async function run() {
  const ts = require(TYPESCRIPT);
  const sourceJwt = require(JSONWEBTOKEN);
  const tempRoot = fs.mkdtempSync(path.join(require('os').tmpdir(), 'a02-source-path-'));
  const webtokenPath = path.join(tempRoot, 'webtoken.js');
  const tokenPath = path.join(tempRoot, 'token.ctrl.js');
  const accountPath = path.join(tempRoot, 'account.ctrl.js');
  compile(path.join(SERVER_ROOT, 'webtoken.ts'), webtokenPath, ts);
  compile(path.join(ACCOUNT_ROOT, 'controllers', 'token.ctrl.ts'), tokenPath, ts);
  compile(path.join(ACCOUNT_ROOT, 'controllers', 'account.ctrl.ts'), accountPath, ts);

  const originalNow = Date.now;
  const originalLoad = Module._load;
  Date.now = function fixedDateNow() { return FIXED_NOW_MS; };

  const fakeServer = {
    WebToken: null,
    Boom: { createWithCode: function createWithCode(code) {
      const error = new Error(code);
      error.code = code;
      return error;
    } },
    log: { debug: function debug() {}, error: function error() {} },
  };
  const fakeDefault = { default: {} };
  Module._load = function sourceLoad(request, parent, isMain) {
    if (request === '@jibo/server') return fakeServer;
    if (request === './token.ctrl' || request === '../controllers/token.ctrl') return require(tokenPath);
    if (request === 'jsonwebtoken') return sourceJwt;
    if (request === './log') return { default: { debug: function debug() {}, error: function error() {} } };
    if (request === 'mongoose') return { Types: { ObjectId: function ObjectId() {} } };
    if (request === 'twilio') return function TwilioStub() {};
    if (request === 'escape-regexp') return function escapeRegexp(value) { return value; };
    if (request === 'querystring') return originalLoad.call(this, request, parent, isMain);
    if (request.startsWith('.') || request.startsWith('@jibo/')) return fakeDefault;
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    const sourceWebToken = require(webtokenPath);
    fakeServer.WebToken = sourceWebToken.WebToken;
    const AccountController = require(accountPath).default;
    const TokenController = require(tokenPath).default;
    const account = {
      _id: { toString: function toString() { return ACCOUNT_ID; } },
      accessKeyId: ACCESS_KEY,
      email: 'source-fixture@example.invalid',
      friendlyId: 'source-robot',
      secretAccessKey: ACCOUNT_SECRET,
    };
    const tokenController = new TokenController({ config: { server: {
      hubTokenSecret: HUB_SECRET,
      hubTokenSecretOld: '',
      hubTokenSecretOldExpTimestamp: 0,
    } } });
    const controller = Object.create(AccountController.prototype);
    controller.findById = async function findById(id) {
      if (id !== ACCOUNT_ID) throw new Error('unexpected account id');
      return account;
    };
    controller.tokenCtrl = tokenController;

    const issued = await controller.createHubToken({ accountId: ACCOUNT_ID, payload: 'source-path-payload' });
    const claims = decodeJsonPart(issued.token);
    const claimKeys = Object.keys(claims);
    if (claims.secretAccessKey !== ACCOUNT_SECRET) throw new Error('source path did not carry account secret');
    if (claimKeys.join(',') !== 'accessKeyId,email,friendlyId,id,payload,secretAccessKey,iat,exp') {
      throw new Error(`unexpected claim order: ${claimKeys.join(',')}`);
    }
    if (claims.exp - claims.iat !== 10800) throw new Error('wrong source lifetime');
    return {
      fixture: 'pinned-account-controller-token-controller-webtoken',
      sourcePath: 'account.ctrl.createHubToken -> token.ctrl.createHubToken -> WebToken.sign',
      fixedNowMs: FIXED_NOW_MS,
      synthetic: true,
      claimKeys,
      claims: {
        accessKeyId: claims.accessKeyId,
        email: claims.email,
        friendlyId: claims.friendlyId,
        id: claims.id,
        payload: claims.payload,
        secretAccessKeySha256: sha256(ACCOUNT_SECRET),
        iat: claims.iat,
        exp: claims.exp,
      },
      expires: issued.expires,
      expiresType: typeof issued.expires,
      tokenSha256: sha256(issued.token),
      tokenLength: issued.token.length,
      sourceFiles: {
        accountController: path.join(ACCOUNT_ROOT, 'controllers', 'account.ctrl.ts'),
        tokenController: path.join(ACCOUNT_ROOT, 'controllers', 'token.ctrl.ts'),
        webToken: path.join(SERVER_ROOT, 'webtoken.ts'),
      },
    };
  } finally {
    Module._load = originalLoad;
    Date.now = originalNow;
    // The temporary transpiled files are review-only and are not evidence.
    removeTree(tempRoot);
  }
}

run().then(function writeResult(result) {
  const serialized = `${JSON.stringify(result, null, 2)}\n`;
  if (process.env.PHX_A02_SOURCE_PATH_OUT) {
    fs.writeFileSync(process.env.PHX_A02_SOURCE_PATH_OUT, serialized);
  } else {
    process.stdout.write(serialized);
  }
}).catch(function reportFailure(error) {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
