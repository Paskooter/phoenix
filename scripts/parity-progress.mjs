#!/usr/bin/env node
// Generated checklist progress. Commits use the index; unstaged edits stay unstaged.
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

export const START = '<!-- parity-progress:start -->';
export const END = '<!-- parity-progress:end -->';
const LEDGER = 'docs/parity/tasks.json';
const README = 'README.md';
const BAR = 'docs/parity/progress.svg';
const STATUSES = new Set(['todo', 'in_progress', 'blocked', 'verified']);
const LABELS = { management: 'Planning', verification: 'Verification tooling', pegasus: 'Pegasus', classic: 'Companion cloud', restoration: 'Restoration', release: 'Release' };

export function completion(ledger) {
  if (!Array.isArray(ledger.tasks)) throw new Error('Parity ledger needs a tasks array');
  const ids = new Set();
  for (const task of ledger.tasks) {
    if (!task.id || ids.has(task.id) || !STATUSES.has(task.status) || !Object.hasOwn(ledger.tracks, task.track)) {
      throw new Error(`Invalid parity task: ${task.id}`);
    }
    ids.add(task.id);
  }
  const total = ledger.tasks.length;
  const verified = ledger.tasks.filter(task => task.status === 'verified').length;
  const percent = total ? (100 * verified / total).toFixed(1) : '0.0';
  const tracks = Object.keys(ledger.tracks).map(track => {
    const tasks = ledger.tasks.filter(task => task.track === track);
    return { track, total: tasks.length, verified: tasks.filter(task => task.status === 'verified').length };
  });
  return { total, verified, percent, tracks };
}

export function renderProgress(ledger) {
  const summary = completion(ledger);
  const { total, verified, percent, tracks } = summary;
  const label = `${percent}% checklist completion — ${verified} of ${total} tasks verified`;
  const block = [START, '', `![${label}](${BAR})`, '',
    `**${percent}% checklist completion · ${verified}/${total} tasks verified.**`, '',
    'Counts only tasks whose full acceptance criteria and evidence have been reviewed. Candidate implementations do not count. This includes planning and verification tooling; it is not a percentage of server functionality.', '',
    '| Track | Verified | Total |', '|---|---:|---:|',
    ...tracks.map(item => `| ${LABELS[item.track] || item.track} | ${item.verified} | ${item.total} |`), '',
    '[Verified checklist](docs/parity/TASKS.md) · [Execution plan](docs/parity/PLAN.md) · [Behavioral comparisons](docs/parity/PRODUCTION.md)', '', END].join('\n');
  const width = total ? Number((456 * verified / total).toFixed(2)) : 0;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="520" height="86" viewBox="0 0 520 86" role="img" aria-labelledby="title desc">
  <title id="title">${label}</title>
  <desc id="desc">Verified checklist tasks, including planning and test infrastructure. Candidate work is excluded.</desc>
  <rect width="520" height="86" rx="12" fill="#111827"/>
  <text x="24" y="29" fill="#f9fafb" font-family="Arial, sans-serif" font-size="15">Checklist completion</text>
  <text x="480" y="29" text-anchor="end" fill="#93c5fd" font-family="Arial, sans-serif" font-size="15">${percent}% · ${verified}/${total} verified</text>
  <rect x="24" y="45" width="456" height="14" rx="7" fill="#374151"/>
  <rect x="24" y="45" width="${width}" height="14" rx="7" fill="#60a5fa"/>
</svg>
`;
  return { summary, block, svg };
}

export function replaceProgress(readme, block) {
  const start = readme.indexOf(START), end = readme.indexOf(END);
  if (start < 0 || end < start || readme.indexOf(START, start + START.length) >= 0 || readme.indexOf(END, end + END.length) >= 0) {
    throw new Error('README needs exactly one parity-progress marker pair');
  }
  return readme.slice(0, start) + block + readme.slice(end + END.length);
}

export function updateProgress(root, { check = false, ledger } = {}) {
  const rendered = renderProgress(ledger || JSON.parse(readFileSync(resolve(root, LEDGER), 'utf8')));
  const before = readFileSync(resolve(root, README), 'utf8');
  const readme = replaceProgress(before, rendered.block);
  const bar = resolve(root, BAR);
  if (check) {
    if (before !== readme || !existsSync(bar) || readFileSync(bar, 'utf8') !== rendered.svg) {
      throw new Error('README checklist progress is stale. Run npm run parity:status -- --write.');
    }
  } else {
    if (before !== readme) writeFileSync(resolve(root, README), readme);
    mkdirSync(dirname(bar), { recursive: true });
    if (!existsSync(bar) || readFileSync(bar, 'utf8') !== rendered.svg) writeFileSync(bar, rendered.svg);
  }
  return rendered.summary;
}

function git(root, args, input) {
  const result = spawnSync('git', args, { cwd: root, input, encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr.trim() || `git ${args[0]} failed`);
  return result.stdout;
}

export function updateStagedProgress(root) {
  const ledger = JSON.parse(git(root, ['show', `:${LEDGER}`]));
  const staged = renderProgress(ledger);
  const before = git(root, ['show', `:${README}`]);
  const readme = replaceProgress(before, staged.block);
  // Preflight working-tree rendering before touching the index. It can describe
  // a different ledger when tasks or README are only partially staged.
  const working = renderProgress(JSON.parse(readFileSync(resolve(root, LEDGER), 'utf8')));
  const workingReadme = replaceProgress(readFileSync(resolve(root, README), 'utf8'), working.block);
  const entries = [[README, readme], [BAR, staged.svg]].map(([path, content]) => {
    const existing = git(root, ['ls-files', '--stage', '--', path]).trim();
    if (existing && !/^\d+ [a-f0-9]+ 0\t[^\n]+$/.test(existing)) throw new Error(`Unmerged generated file: ${path}`);
    const mode = existing ? existing.split(' ')[0] : '100644';
    const oid = git(root, ['hash-object', '-w', '--stdin'], content).trim();
    return `${mode} ${oid}\t${path}\n`;
  });
  // A single index update stages only the generated block and SVG. It does not
  // stage unrelated README text or an unstaged change to the task ledger.
  git(root, ['update-index', '--index-info'], entries.join(''));
  writeFileSync(resolve(root, README), workingReadme);
  mkdirSync(dirname(resolve(root, BAR)), { recursive: true });
  writeFileSync(resolve(root, BAR), working.svg);
  return staged.summary;
}

export function installHook(root) {
  if (!existsSync(resolve(root, '.git'))) return; // npm ci in an image/source archive
  const current = spawnSync('git', ['config', '--get', 'core.hooksPath'], { cwd: root, encoding: 'utf8' });
  if (current.error) throw current.error;
  if (current.status !== 0 && current.status !== 1) throw new Error(current.stderr.trim());
  if (current.stdout.trim() && current.stdout.trim() !== '.githooks') {
    throw new Error('Existing core.hooksPath preserved. Add `node scripts/parity-progress.mjs --staged` to its pre-commit hook.');
  }
  if (!current.stdout.trim() && existsSync(resolve(root, git(root, ['rev-parse', '--git-path', 'hooks/pre-commit']).trim()))) {
    throw new Error('Existing default pre-commit hook preserved. Add `node scripts/parity-progress.mjs --staged` to it.');
  }
  git(root, ['config', '--local', 'core.hooksPath', '.githooks']);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const mode = process.argv.slice(2);
  try {
    if (mode.length !== 1 || !['--write', '--check', '--staged', '--install-hook'].includes(mode[0])) {
      throw new Error('Usage: node scripts/parity-progress.mjs --write | --check | --staged | --install-hook');
    }
    if (mode[0] === '--install-hook') installHook(root);
    else {
      const summary = mode[0] === '--staged' ? updateStagedProgress(root) : updateProgress(root, { check: mode[0] === '--check' });
      console.log(`Checklist: ${summary.verified}/${summary.total} verified (${summary.percent}%)`);
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
