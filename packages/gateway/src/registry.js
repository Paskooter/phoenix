// SkillUtils + ConfigFileParser, Pegasus 5c0a739. Preserve the complete manifest
// and fail startup on an unreadable/invalid index or manifest.
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { legacyJsonError } from '@phoenix/common';
import { deepFreeze, legacyConfigError, validateSkillsIndex } from './skillConfigValidation.js';

const DEFAULT_RES = join(dirname(fileURLToPath(import.meta.url)), '..', 'resources', 'skills');

async function readJSON(path) {
  const content = await readFile(path, 'utf8');
  try { return JSON.parse(content); }
  catch (error) { throw new Error(`Error when parsing '${path}': ${legacyJsonError(content, error.message)}`); }
}

function cleanPathElement(pathElement = '') {
  if (pathElement.startsWith('/')) pathElement = pathElement.slice(1);
  if (pathElement.endsWith('/')) pathElement = pathElement.slice(0, -1);
  return pathElement;
}

/**
 * rootPath supports an unchanged Pegasus hub package: index files live in
 * rootPath/resources/skills and manifest paths are relative to rootPath.
 * Phoenix's bundled deployment keeps manifests beside its index instead.
 * skillsBase is the explicit Phoenix single-service routing adapter; omitting
 * it preserves each entry's baseURL/basePath/v1/main exactly as Pegasus does.
 */
export async function loadRegistry({ skillsBase = '', rootPath, resourcesDir, env = process.env, indexFile = env.ETCO_hub_skillsConfig || 'skills-local.json' } = {}) {
  const indexDir = resourcesDir || (rootPath ? join(rootPath, 'resources', 'skills') : DEFAULT_RES);
  const manifestRoot = rootPath || indexDir;
  const index = await readJSON(join(indexDir, indexFile));
  validateSkillsIndex(index);
  try {
    const skills = await Promise.all(index.skills.map(async entry => {
      const config = await readJSON(join(manifestRoot, entry.configPath));
      config.URL = entry.baseURL
        ? [cleanPathElement(entry.baseURL), cleanPathElement(config.basePath), 'v1', 'main'].filter(Boolean).join('/')
        : '';
      if (skillsBase && entry.baseURL) config.URL = `${skillsBase.replace(/\/$/, '')}/v1/${config.id}/main`;
      return config;
    }));
    return deepFreeze(skills);
  } catch (error) { throw legacyConfigError(error); }
}
