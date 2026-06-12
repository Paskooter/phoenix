// MIM resolution + state helpers — port of baseskill/graph/mims/utils/Utils.ts.

import { existsSync, readFileSync } from 'node:fs';
import { basename, extname } from 'node:path';

export function isFunc(data) { return typeof data === 'function'; }

/**
 * Resolve and load MIM(s) provided as objects, absolute paths or functions.
 * @param {string|object|Array|Function} mimDataGen Path(s), MimConfig(s) or a function yielding them.
 * @param {object} data Skill data (passed to provider functions).
 * @returns {Promise<object[]>} loaded MimConfigs
 */
export async function loadMims(mimDataGen, data) {
  const mimData = isFunc(mimDataGen) ? await mimDataGen(data) : mimDataGen;
  const mimDataArr = Array.isArray(mimData) ? mimData : [mimData];
  return Promise.all(mimDataArr.map((d) => _loadMim(d)));
}

async function _loadMim(mimData) {
  if (typeof mimData !== 'string') return mimData;
  if (extname(mimData) !== '.mim') throw new Error(`File at requested path is not a MIM: ${mimData}`);
  if (!existsSync(mimData)) throw new Error(`MIM not found at requested path: ${mimData}`);
  const rawMIM = readFileSync(mimData, 'utf8');
  try {
    const mim = JSON.parse(rawMIM);
    if (!mim.mim_id) mim.mim_id = basename(mimData, '.mim'); // missing ID -> filename
    return mim;
  } catch {
    throw new Error(`Unable to parse provided MIM at path: ${mimData}`);
  }
}

/**
 * Initialize or reset MIM state tracking (session.data._mim) for the current skill session.
 */
export function prepareMim(data, reset = false) {
  if (!data.skill.session.data) data.skill.session.data = {};
  if (reset || !data.skill.session.data._mim) {
    data.skill.session.data._mim = { noMatch: 0, noInput: 0, noMatchMax: false, noInputMax: false };
  }
}
