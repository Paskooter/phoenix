// Optional, explicit integration inputs for the independently owned skill kit.
// Hub sources always come from this checkout; another checkout cannot replace them.
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { SKILL_KIT_FILES } from '../../src/developerStarter.js';
import { staticRoutes as productionStaticRoutes } from '../../src/static.js';
import { developerPages as productionDeveloperPages } from '../../src/developerPortal.js';

export const repository = fileURLToPath(new URL('../../../../', import.meta.url));
const inputs = process.env.PHOENIX_DEVELOPER_TEST_INPUTS_DIR;
export const contentProjectDir = inputs ? mkdtempSync(join(tmpdir(), 'developer-content-')) : repository;
export const guideSources = ['docs/SKILLS.md', ...['MANIFESTS', 'CONTEXT', 'SDK', 'COOKBOOK', 'WORKFLOW', 'TROUBLESHOOTING'].map(name => `docs/skills/${name}.md`)];
if (inputs) {
  try {
    for (const path of ['docs/developers', 'docs/themes', 'docs/THEMES.md', 'docs/BUNDLE-REVIEW.md', 'themes/ember/assets/preview.png', 'themes/orbit/assets/preview.png', 'tools/theme-kit/templates']) {
      mkdirSync(dirname(join(contentProjectDir, path)), { recursive: true });
      cpSync(join(repository, path), join(contentProjectDir, path), { recursive: true });
    }
    // Only sibling-owned inputs are overlaid, never production Hub source or tests.
    for (const path of [...guideSources, ...SKILL_KIT_FILES]) {
      const from = path.startsWith('tools/skill-kit/') || guideSources.includes(path) ? inputs : repository;
      mkdirSync(dirname(join(contentProjectDir, path)), { recursive: true });
      cpSync(join(from, path), join(contentProjectDir, path));
    }
  } catch (error) {
    rmSync(contentProjectDir, { recursive: true, force: true });
    throw error;
  }
  process.on('exit', () => rmSync(contentProjectDir, { recursive: true, force: true }));
}
export const hasSkillGuide = [...guideSources, ...SKILL_KIT_FILES].every(path => existsSync(join(contentProjectDir, path)));
export const missingGuideReason = 'The independently owned native kit/guide is not in this checkout; set PHOENIX_DEVELOPER_TEST_INPUTS_DIR for an explicit integration run.';
export const staticRoutes = options => productionStaticRoutes({ developerProjectDir: contentProjectDir, ...options });
export const developerPages = options => productionDeveloperPages({ projectDir: contentProjectDir, ...options });

// Presence/refusal controls do not need executable kit bytes. These synthetic
// files only exercise route admission; real download qualification uses inputs above.
export function copyKit(projectDir) {
  for (const path of SKILL_KIT_FILES) {
    mkdirSync(dirname(join(projectDir, path)), { recursive: true });
    if (existsSync(join(contentProjectDir, path))) cpSync(join(contentProjectDir, path), join(projectDir, path));
    else writeFileSync(join(projectDir, path), 'Synthetic route-admission fixture, not a runnable kit.\n');
  }
}
