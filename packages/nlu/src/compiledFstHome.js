// Source-backed install receipt for the closed 98-rule approved binary profile.
//
// Original production (pegasus 5c0a739 default.json) always loads compiled graphs
// from fstDirectories. Phoenix cannot ship those binaries in git, so a deployment
// provisions them into a home directory and selects compiled-fst. This module
// only reads an installer receipt; hash verification of the graphs remains in
// compiledFstRuntime.js.

import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { COMPILED_FST_PROFILE } from './compiledFstProfile.js';

export const COMPILED_FST_INSTALL_SCHEMA = 'phoenix.nlu.compiled-fst-install';
export const COMPILED_FST_INSTALL_VERSION = 1;
export const COMPILED_FST_INSTALL_KIND = 'approved-binary';
export const DEFAULT_COMPILED_HOME_RELATIVE = 'runtime/nlu-compiled';

function validHash(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

function relativeLayoutPath(value, label, { allowDot = false } = {}) {
  if (allowDot && value === '.') return '.';
  if (typeof value !== 'string' || value.length === 0 || value.startsWith('/')
    || value.includes('\\') || value.includes('\0')) {
    throw new Error(`Compiled NLU install ${label} must use a relative POSIX path`);
  }
  const parts = value.split('/');
  if (parts.some(part => part.length === 0 || part === '.' || part === '..')) {
    throw new Error(`Compiled NLU install ${label} contains an unsafe path segment`);
  }
  return value;
}

function inside(root, value, label) {
  const path = resolve(root, ...value.split('/'));
  const rel = relative(root, path);
  if (rel === '..' || rel.startsWith('..') || rel.startsWith('/')) {
    throw new Error(`Compiled NLU install ${label} escapes the home directory`);
  }
  return path;
}

export function defaultCompiledHome(repoRoot) {
  return resolve(repoRoot, DEFAULT_COMPILED_HOME_RELATIVE);
}

export function readCompiledInstallReceipt(home) {
  const root = resolve(home);
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    throw new Error(`Compiled NLU install home is unavailable: ${root}`);
  }
  const receiptPath = join(root, 'receipt.json');
  let receipt;
  try {
    receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
  } catch (error) {
    throw new Error(`Compiled NLU install receipt is invalid: ${error.message}`);
  }
  if (!receipt || receipt.schema !== COMPILED_FST_INSTALL_SCHEMA
    || receipt.version !== COMPILED_FST_INSTALL_VERSION
    || receipt.kind !== COMPILED_FST_INSTALL_KIND
    || receipt.runtime !== COMPILED_FST_PROFILE.runtime) {
    throw new Error('Compiled NLU install receipt schema is unsupported');
  }
  const profile = receipt.profile;
  if (!profile
    || profile.approvedLaunchSha256 !== COMPILED_FST_PROFILE.approvedLaunchSha256
    || profile.approvedInventorySha256 !== COMPILED_FST_PROFILE.approvedInventorySha256
    || profile.factoryManifestSha256 !== COMPILED_FST_PROFILE.factoryManifestSha256
    || profile.sourceRevision !== COMPILED_FST_PROFILE.sourceRevision
    || profile.referenceRevision !== COMPILED_FST_PROFILE.referenceRevision
    || profile.sourceRuntime !== COMPILED_FST_PROFILE.sourceRuntime
    || profile.nativeParserSha256 !== COMPILED_FST_PROFILE.nativeParserSha256
    || !validHash(profile.approvedLaunchSha256)) {
    throw new Error('Compiled NLU install receipt provenance is unsupported');
  }
  const layout = receipt.layout;
  if (!layout || typeof layout !== 'object') {
    throw new Error('Compiled NLU install receipt layout is missing');
  }
  const launch = relativeLayoutPath(layout.launch, 'launch');
  // '.' means inventory compiledPath values (rules_fst/...) are relative to home.
  const rulesDir = relativeLayoutPath(layout.rulesDir, 'rulesDir', { allowDot: true });
  const factoryDir = relativeLayoutPath(layout.factoryDir, 'factoryDir');
  const fstPath = inside(root, launch, 'launch');
  const resolvedRulesDir = rulesDir === '.' ? root : inside(root, rulesDir, 'rulesDir');
  const resolvedFactoryDir = inside(root, factoryDir, 'factoryDir');
  if (!existsSync(fstPath)) throw new Error(`Compiled NLU install launch graph is unavailable: ${fstPath}`);
  if (!existsSync(resolvedFactoryDir) || !statSync(resolvedFactoryDir).isDirectory()) {
    throw new Error(`Compiled NLU install factory directory is unavailable: ${resolvedFactoryDir}`);
  }
  return {
    home: root,
    receipt,
    fstPath,
    factoryDir: resolvedFactoryDir,
    rulesDir: resolvedRulesDir,
    expectedFstSha256: profile.approvedLaunchSha256,
  };
}

/**
 * Resolve a provisioned approved-binary home.
 * An explicit PHOENIX_NLU_COMPILED_HOME must be valid. The default
 * runtime/nlu-compiled path is used only when a receipt is already present.
 */
export function resolveProvisionedApprovedHome({ env = process.env, repoRoot } = {}) {
  if (typeof repoRoot !== 'string' || repoRoot.length === 0) {
    throw new Error('Compiled NLU install home requires a repository root');
  }
  const configured = env.PHOENIX_NLU_COMPILED_HOME;
  if (configured) return readCompiledInstallReceipt(configured);
  const home = defaultCompiledHome(repoRoot);
  if (!existsSync(join(home, 'receipt.json'))) return null;
  return readCompiledInstallReceipt(home);
}
