/*
 * Combine the Node 8 source-path/Hapi fixtures with the corrected Phoenix
 * original-client run. The fixed-time token comparison is byte-complete by
 * SHA-256 (the token itself is never written); validation comparisons retain
 * the exact synthetic response bodies and normalized headers.
 */

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.PHX_REPO_ROOT || resolve(HERE, '../../../../');
const sourcePathFile = process.env.PHX_A02_SOURCE_PATH_JSON || '/tmp/a02-source-path.json';
const hapiFile = process.env.PHX_A02_HAPI_VALIDATION_JSON || '/tmp/a02-hapi-validation.json';
const sdkFile = process.env.PHX_A02_CORRECTED_SDK_JSON || '/tmp/a02-corrected-sdk.json';
const artifactFile = process.env.PHX_A02_CORRECTED_ARTIFACT || join(
  ROOT, 'docs/parity/candidates/A-02-original-client-corrected-20260905.json',
);
const FIXED_NOW_MS = 1700000000000;
const ACCOUNT_SECRET = 'a02-source-synthetic-secret';
const HUB_SECRET = 'a02-source-hub-secret';

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function decodeJsonPart(token) {
  const encoded = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
  return JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
}

function safeHeaders(headers) {
  const result = {};
  for (const name of Object.keys(headers || {}).sort()) {
    result[name] = name === 'date' ? '<runtime-date>' : headers[name];
  }
  return result;
}

function sourceSummary(source) {
  return {
    claimKeys: source.claimKeys,
    claims: source.claims,
    expires: source.expires,
    expiresType: source.expiresType,
    tokenSha256: source.tokenSha256,
    tokenLength: source.tokenLength,
  };
}

function phoenixSummary(issued) {
  const claims = decodeJsonPart(issued.token);
  return {
    claimKeys: Object.keys(claims),
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
  };
}

function compareFixedToken(source, phoenix) {
  const sourceResult = sourceSummary(source);
  const phoenixResult = phoenixSummary(phoenix);
  const claimFields = ['accessKeyId', 'email', 'friendlyId', 'id', 'payload', 'secretAccessKeySha256', 'iat', 'exp'];
  const claimEquality = Object.fromEntries(claimFields.map((field) => [
    field, sourceResult.claims[field] === phoenixResult.claims[field],
  ]));
  return {
    source: sourceResult,
    phoenix: phoenixResult,
    equal: {
      claimKeys: JSON.stringify(sourceResult.claimKeys) === JSON.stringify(phoenixResult.claimKeys),
      claims: Object.values(claimEquality).every(Boolean),
      claimFields: claimEquality,
      expires: sourceResult.expires === phoenixResult.expires,
      expiresType: sourceResult.expiresType === phoenixResult.expiresType,
      tokenSha256: sourceResult.tokenSha256 === phoenixResult.tokenSha256,
      tokenLength: sourceResult.tokenLength === phoenixResult.tokenLength,
    },
  };
}

function compareValidation(sourceFixture, sdkRun) {
  const sourceCases = new Map(sourceFixture.cases.map((entry) => [entry.name, entry]));
  const phoenixCases = new Map((sdkRun.observations.validation || []).map((entry) => [entry.name, entry.response]));
  const names = [...sourceCases.keys()].filter((name) => phoenixCases.has(name));
  const cases = names.map((name) => {
    const source = sourceCases.get(name);
    const phoenix = phoenixCases.get(name);
    const sourceBody = source.body;
    const phoenixBody = phoenix.body;
    const sourceHeaders = source.normalizedHeaders;
    const phoenixHeaders = safeHeaders(phoenix.headers);
    return {
      name,
      source: {
        status: source.status,
        headers: sourceHeaders,
        body: sourceBody,
      },
      phoenix: {
        status: phoenix.status,
        headers: phoenixHeaders,
        body: phoenixBody,
      },
      equal: {
        status: source.status === phoenix.status,
        body: JSON.stringify(sourceBody) === JSON.stringify(phoenixBody),
        headers: JSON.stringify(sourceHeaders) === JSON.stringify(phoenixHeaders),
      },
    };
  });
  return {
    sourcePackages: sourceFixture.packages,
    cases,
    allStatusesEqual: cases.every((entry) => entry.equal.status),
    allBodiesEqual: cases.every((entry) => entry.equal.body),
    allHeadersEqual: cases.every((entry) => entry.equal.headers),
    exactWireParity: cases.every((entry) => Object.values(entry.equal).every(Boolean)),
  };
}

const sourcePath = readJson(sourcePathFile);
const hapiValidation = readJson(hapiFile);
const sdkRun = readJson(sdkFile);

const originalNow = Date.now;
Date.now = () => FIXED_NOW_MS;
let phoenixFixed;
try {
  const model = await import(pathToFileURL(join(ROOT, 'packages/account/src/model.js')));
  phoenixFixed = model.createAuthenticatedHubToken({
    _id: 'synthetic-account-id',
    accessKeyId: 'A02SOURCEKEY00',
    email: 'source-fixture@example.invalid',
    friendlyId: 'source-robot',
    secretAccessKey: ACCOUNT_SECRET,
  }, HUB_SECRET, 'source-path-payload');
} finally {
  Date.now = originalNow;
}

const fixedToken = compareFixedToken(sourcePath, phoenixFixed);
if (!Object.values(fixedToken.equal).every((value) => value === true || typeof value === 'object')) {
  throw new Error(`fixed source/Phoenix token comparison failed: ${JSON.stringify(fixedToken.equal)}`);
}
if (!fixedToken.equal.claimFields || !Object.values(fixedToken.equal.claimFields).every(Boolean)) {
  throw new Error(`fixed source/Phoenix claim comparison failed: ${JSON.stringify(fixedToken.equal)}`);
}

const validation = compareValidation(hapiValidation, sdkRun);
const output = {
  artifact: 'A-02-original-client-corrected-20260905',
  status: 'unverified-review-evidence',
  syntheticOnly: true,
  historicalArtifactPreserved: 'A-02-original-client-compat-20260905.json',
  sourcePath: sourceSummary(sourcePath),
  fixedTokenComparison: fixedToken,
  originalSdkRun: {
    generatedAt: sdkRun.generatedAt,
    sourcePins: sdkRun.sourcePins,
    sourceHashes: sdkRun.sourceHashes,
    syntheticCredential: sdkRun.syntheticCredential,
    observations: sdkRun.observations,
  },
  validationComparison: validation,
  wireDifferences: validation.cases.filter((entry) => !Object.values(entry.equal).every(Boolean)).map((entry) => ({
    case: entry.name,
    status: entry.equal.status ? null : 'source Hapi status and Phoenix status differ',
    body: entry.equal.body ? null : 'source Hapi/Boom body and Phoenix body differ',
    headers: entry.equal.headers ? null : 'source Hapi transport headers and Phoenix headers differ',
  })),
  limits: [
    'The source fixture stubs unrelated AccountController dependencies and does not start the original account service.',
    'The corrected SDK/native requests use synthetic credentials against ephemeral Phoenix listeners; no robot or live service was used.',
    'The source Hapi error renderer is pinned and captured with server.inject; runtime date headers are normalized only for comparison.',
  ],
};

writeFileSync(artifactFile, `${JSON.stringify(output, null, 2)}\n`);
process.stdout.write(JSON.stringify({
  artifactFile,
  fixedTokenByteEqual: fixedToken.equal.tokenSha256,
  fixedExpiryEqual: fixedToken.equal.expires,
  validationExactWireParity: validation.exactWireParity,
  wireDifferenceCount: output.wireDifferences.length,
}, null, 2) + '\n');
