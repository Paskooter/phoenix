// Skill registry loader. Reads resources/skills/skills-local.json + the referenced manifests
// (vendored from the reference hub/{be-skills,pegasus-skills}) and produces the registry the
// IntentRouter + SkillConfigManager consume.
//
// - be-skills: onRobot:true, no URL — the hub returns a final LISTEN with match.onRobot=true and
//   the robot runs them locally. Their launch intents are gated on an entity `skill == <id>`.
// - cloud skills (answer/report/chitchat): routed to the Phoenix skills service (all hosted there
//   for now; only answer-skill is implemented).

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_RES = join(dirname(fileURLToPath(import.meta.url)), '..', 'resources', 'skills');

/**
 * @param {{ skillsBase?: string, resourcesDir?: string }} opts
 * @returns {Array<{id:string, onRobot:boolean, URL?:string, intents:Array}>}
 */
export function loadRegistry({ skillsBase = '', resourcesDir = DEFAULT_RES } = {}) {
  const base = skillsBase.replace(/\/$/, '');
  const index = JSON.parse(readFileSync(join(resourcesDir, 'skills-local.json'), 'utf8'));
  const out = [];
  for (const entry of index.skills || []) {
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(join(resourcesDir, entry.configPath), 'utf8'));
    } catch {
      continue; // skip manifests we couldn't read
    }
    const onRobot = !!manifest.onRobot || !entry.baseURL;
    const cfg = { id: manifest.id, onRobot, intents: manifest.intents || [] };
    if (!onRobot) {
      // Cloud skills are hosted by the Phoenix skills service, each at /v1/<id>/main.
      const host = base || (entry.baseURL || '').replace(/\/$/, '');
      cfg.URL = `${host}/v1/${manifest.id}/main`;
    }
    out.push(cfg);
  }
  return out;
}
