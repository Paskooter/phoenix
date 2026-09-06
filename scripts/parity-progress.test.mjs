import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, chmodSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { completion, renderProgress, replaceProgress, START, END } from './parity-progress.mjs';

const ledger = statuses => ({ tracks: { management: 'Planning', pegasus: 'Server' }, tasks: statuses.map((status, i) => ({ id: `T-${i}`, track: i ? 'pegasus' : 'management', status, implementationReview: { state: 'accepted' } })) });

test('completion counts verified tasks and excludes submitted or accepted candidates', () => {
  const result = completion(ledger(['verified', 'todo', 'in_progress', 'blocked']));
  assert.equal(result.percent, '25.0');
  assert.equal(result.verified, 1);
  assert.equal(result.total, 4);
  assert.deepEqual(result.tracks, [{ track: 'management', total: 1, verified: 1 }, { track: 'pegasus', total: 3, verified: 0 }]);
  assert.equal(completion(ledger([])).percent, '0.0');
  assert.equal(completion(ledger(['verified'])).percent, '100.0');
  assert.throws(() => completion(ledger(['implemented'])), /Invalid parity task/);
});

test('README refresh preserves surrounding content and rejects ambiguous markers', () => {
  const { block, svg } = renderProgress(ledger(['verified', 'todo']));
  const updated = replaceProgress(`before\n${START}\nold\n${END}\nafter\n`, block);
  assert.equal(updated, `before\n${block}\nafter\n`);
  assert.match(svg, /width="228"/);
  assert.throws(() => replaceProgress(`${START}${END}${START}`, block), /exactly one/);
  assert.throws(() => replaceProgress('no markers', block), /exactly one/);
});

test('real pre-commit hook uses staged tasks and preserves unstaged README and ledger edits', t => {
  const root = mkdtempSync(join(tmpdir(), 'phoenix-progress-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const run = (cmd, args) => {
    const result = spawnSync(cmd, args, { cwd: root, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return result.stdout;
  };
  const git = (...args) => run('git', args);
  for (const dir of ['scripts', '.githooks', 'docs/parity']) mkdirSync(join(root, dir), { recursive: true });
  copyFileSync(new URL('./parity-progress.mjs', import.meta.url), join(root, 'scripts/parity-progress.mjs'));
  copyFileSync(new URL('../.githooks/pre-commit', import.meta.url), join(root, '.githooks/pre-commit'));
  chmodSync(join(root, '.githooks/pre-commit'), 0o755);
  const readme = join(root, 'README.md'), tasks = join(root, 'docs/parity/tasks.json');
  writeFileSync(readme, `# Fixture\n\n${START}\n${END}\n\nKeep this text.\n`);
  writeFileSync(tasks, JSON.stringify(ledger(['todo', 'todo'])));
  git('init', '--quiet');
  git('config', 'user.name', 'Parity fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  git('config', 'commit.gpgSign', 'false');
  run(process.execPath, ['scripts/parity-progress.mjs', '--install-hook']);
  assert.equal(git('config', '--local', '--get', 'core.hooksPath').trim(), '.githooks');
  run(process.execPath, ['scripts/parity-progress.mjs', '--write']);
  git('add', '.');
  git('commit', '--quiet', '-m', 'initial fixture');
  writeFileSync(tasks, JSON.stringify(ledger(['verified', 'todo'])));
  writeFileSync(readme, readFileSync(readme, 'utf8') + '\nStaged text.\n');
  git('add', 'README.md', 'docs/parity/tasks.json');
  writeFileSync(tasks, JSON.stringify(ledger(['verified', 'verified'])));
  writeFileSync(readme, readFileSync(readme, 'utf8') + '\nUnstaged text.\n');
  git('commit', '--quiet', '-m', 'partial fixture');
  const committed = git('show', 'HEAD:README.md');
  assert.match(committed, /50\.0% checklist completion/);
  assert.match(committed, /Staged text\./);
  assert.doesNotMatch(committed, /Unstaged text\./);
  assert.match(git('show', 'HEAD:docs/parity/progress.svg'), /50\.0%/);
  assert.equal(JSON.parse(git('show', 'HEAD:docs/parity/tasks.json')).tasks[1].status, 'todo');
  const working = readFileSync(readme, 'utf8');
  assert.match(working, /100\.0% checklist completion/);
  assert.match(working, /Unstaged text\./);
  assert.match(readFileSync(join(root, 'docs/parity/progress.svg'), 'utf8'), /100\.0%/);
  assert.equal(JSON.parse(readFileSync(tasks, 'utf8')).tasks[1].status, 'verified');
  assert.equal(git('diff', '--cached', '--name-only').trim(), '');
});
