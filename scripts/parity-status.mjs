#!/usr/bin/env node
// tasks.json is authoritative; TASKS.md is its generated, reviewable checklist.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ledger = JSON.parse(readFileSync(resolve(root, 'docs/parity/tasks.json'), 'utf8'));
const tasks = ledger.tasks;
const byId = new Map();
const errors = [];
const statuses = new Set(['todo', 'in_progress', 'blocked', 'verified']);
const reviewStates = new Set(['working', 'awaiting_review', 'changes_requested', 'accepted']);
for (const task of tasks) {
  if (!/^[A-Z]+-\d+$/.test(task.id) || byId.has(task.id)) errors.push(`Invalid or duplicate ID: ${task.id}`);
  byId.set(task.id, task);
  for (const key of ['title', 'track', 'priority', 'status', 'implementation', 'owner', 'finding']) {
    if (typeof task[key] !== 'string' || !task[key].trim()) errors.push(`${task.id}: missing ${key}`);
  }
  if (!(task.track in ledger.tracks) || !(task.phase in ledger.phases)) errors.push(`${task.id}: unknown track/phase`);
  if (!statuses.has(task.status)) errors.push(`${task.id}: unknown status`);
  if (!['P0', 'P1', 'P2'].includes(task.priority)) errors.push(`${task.id}: unknown priority`);
  for (const key of ['reference', 'phoenix', 'acceptance']) {
    if (!Array.isArray(task[key]) || !task[key].length || task[key].some(v => typeof v !== 'string' || !v.trim())) errors.push(`${task.id}: ${key} must be nonempty`);
  }
  if (!Array.isArray(task.dependsOn) || !Array.isArray(task.verification)) errors.push(`${task.id}: dependencies/evidence must be arrays`);
  const review = task.implementationReview;
  if (review) {
    if (!reviewStates.has(review.state) || !review.assignee || !review.scope) errors.push(`${task.id}: invalid candidate implementation record`);
    if (review.state !== 'working' && (!review.artifact || !existsSync(resolve(root, review.artifact)))) errors.push(`${task.id}: submitted candidate needs a review artifact`);
    if (review.state === 'accepted' && (!review.reviewedBy || !review.reviewEvidence || !existsSync(resolve(root, review.reviewEvidence)))) errors.push(`${task.id}: accepted candidate needs lead review evidence`);
    if (task.status === 'verified' && review.state !== 'accepted') errors.push(`${task.id}: candidate cannot be verified before lead acceptance`);
  }
  for (const path of task.phoenix || []) if (!existsSync(resolve(root, path))) errors.push(`${task.id}: missing Phoenix path ${path}`);
  if (task.status === 'blocked' && !task.blocker?.trim()) errors.push(`${task.id}: blocked task needs a concrete blocker`);
  if (task.status === 'verified') {
    if (!task.verification?.length) errors.push(`${task.id}: verified without evidence`);
    for (const evidence of task.verification || []) {
      if (!evidence.date || !evidence.basis || evidence.result !== 'pass' || !evidence.artifact || !existsSync(resolve(root, evidence.artifact))) {
        errors.push(`${task.id}: incomplete or missing passing evidence`);
      }
      if (task.track !== 'management' && (!evidence.referenceRevision || !evidence.phoenixRevision || !evidence.command)) {
        errors.push(`${task.id}: product verification needs revisions and a reproducible command`);
      }
    }
  }
}
for (const task of tasks) for (const dep of task.dependsOn || []) {
  if (!byId.has(dep)) errors.push(`${task.id}: unknown dependency ${dep}`);
  if (task.status === 'verified' && byId.get(dep)?.status !== 'verified') errors.push(`${task.id}: dependency ${dep} is not verified`);
}
const visiting = new Set(), visited = new Set();
function visit(id) {
  if (visiting.has(id)) { errors.push(`Dependency cycle at ${id}`); return; }
  if (visited.has(id) || !byId.has(id)) return;
  visiting.add(id);
  for (const dep of byId.get(id).dependsOn || []) visit(dep);
  visiting.delete(id); visited.add(id);
}
for (const task of tasks) visit(task.id);
if (tasks.filter(t => t.status === 'in_progress').length > 1) errors.push('Keep one lead verification task in progress; parallel implementation is tracked in implementationReview.');
if (errors.length) { console.error(errors.join('\n')); process.exit(1); }

const ready = tasks.filter(t => t.status === 'todo' && t.dependsOn.every(d => byId.get(d).status === 'verified'))
  .sort((a, b) => a.phase - b.phase || a.priority.localeCompare(b.priority));
const current = tasks.find(t => t.status === 'in_progress');
const summary = Object.entries(ledger.tracks).map(([track, description]) => {
  const group = tasks.filter(t => t.track === track);
  return { track, description, total: group.length, verified: group.filter(t => t.status === 'verified').length,
    inProgress: group.filter(t => t.status === 'in_progress').length, blocked: group.filter(t => t.status === 'blocked').length };
});
const local = path => `[${path}](../../${path})`;
function source(ref) {
  if (ref.startsWith('pegasus-restored:')) {
    const path = ref.slice('pegasus-restored:'.length);
    return `[Restored Pegasus ${path}](https://pvindex.org/gitea/jiboV2/pegasus/src/commit/${ledger.baseline.restored.commit}/${path})`;
  }
  if (ref.startsWith('pegasus:')) {
    const path = ref.slice(8);
    return `[Original Pegasus ${path}](https://pvindex.org/gitea/jiboV2/pegasus/src/commit/${ledger.baseline.original.commit}/${path})`;
  }
  if (ref.startsWith('jibo:confluence/')) return `[Jibo documentation](https://pvindex.org/${ref.slice(5)})`;
  if (ref.startsWith('jibo:')) {
    const parts = ref.slice(5).split('/'), repo = parts.splice(0, 2).join('/');
    const pin = repo === ledger.baseline.classicApi.repository ? `commit/${ledger.baseline.classicApi.commit}` : 'branch/master';
    return `[${ref.slice(5)}](https://pvindex.org/gitea/${repo}/src/${pin}/${parts.join('/')})`;
  }
  return ref;
}
const lines = [
  '# Phoenix parity task checklist', '',
  'Generated from [tasks.json](tasks.json). Edit the ledger, then run `npm run parity:status -- --write`; `npm run parity:check` checks evidence/dependencies and detects stale output.', '',
  'A checked box means the acceptance criteria and linked evidence were reviewed. Existing code and green unit tests are recorded independently of verified product parity. Counts below measure this task plan, not a percentage of server functionality.', '',
  'Parallel candidates have their own implementation checkbox. A checked candidate means a proposed implementation was submitted; only the main task checkbox means the lead verified every acceptance criterion. Candidate submissions do not increase the verified counts.', '',
  '| Track | Verified | Total | In progress | Blocked |', '|---|---:|---:|---:|---:|',
  ...summary.map(s => `| ${s.track} | ${s.verified} | ${s.total} | ${s.inProgress} | ${s.blocked} |`), '',
  `Current task: ${current ? `**${current.id} — ${current.title}**` : 'none'}.`, '',
  `Next ready task: ${ready[0] ? `**${ready[0].id} — ${ready[0].title}**` : 'none; review blockers or completed scope'}.`, '',
  'See [PLAN.md](PLAN.md) for execution rules, [COMPATIBILITY.md](COMPATIBILITY.md) for the frozen target and [AUDIT.md](AUDIT.md) for initial findings. Pegasus source links use the original commit; restored-only code and atlas links are labeled separately. API definitions are pinned; other Jibo links are discovery references to be pinned before verification.', '',
];
for (const [phase, label] of Object.entries(ledger.phases)) {
  lines.push(`## ${phase}. ${label}`, '');
  for (const task of tasks.filter(t => t.phase === Number(phase))) {
    lines.push(`### ${task.id} — ${task.title}`, '',
      `- [${task.status === 'verified' ? 'x' : ' '}] **${task.status}** · ${task.priority} · ${task.track} · implementation: ${task.implementation}`, '',
      `Owner: ${task.owner}. Dependencies: ${task.dependsOn.length ? task.dependsOn.join(', ') : 'none'}.`, '',
      task.finding, '', 'Done when:', '', ...task.acceptance.map(a => `- ${a}`), '',
      `Source: ${task.reference.map(source).join('; ')}.`, '',
      `Phoenix: ${task.phoenix.map(local).join('; ')}.`, '',
      task.verification.length ? `Evidence: ${task.verification.map(e => `${local(e.artifact)} (${e.date}; ${e.basis})`).join('; ')}.` : 'Evidence: pending.', '',
    );
    if (task.implementationReview) {
      const review = task.implementationReview;
      lines.push(`- [${review.state === 'working' ? ' ' : 'x'}] Candidate implementation — **${review.state}**; ${review.assignee}.`, '',
        `Candidate scope: ${review.scope}`, '',
        review.artifact ? `Candidate report: ${local(review.artifact)}.` : 'Candidate report: pending.', '',
        review.state === 'accepted' ? `Lead review: ${review.reviewedBy}; ${local(review.reviewEvidence)}. Complete task acceptance is still governed by the main checkbox above.` : 'Lead verification: pending. This candidate does not certify task parity.', '');
    }
    if (task.blocker) lines.push(`Blocker: ${task.blocker}`, '');
  }
}
const rendered = lines.join('\n');
const target = resolve(root, 'docs/parity/TASKS.md');
const args = new Set(process.argv.slice(2));
if ([...args].some(arg => !['--write', '--check', '--json'].includes(arg))) {
  console.error('Usage: node scripts/parity-status.mjs [--write | --check] [--json]'); process.exit(1);
}
if (args.has('--write') && args.has('--check')) { console.error('Choose --write or --check.'); process.exit(1); }
if (args.has('--write')) writeFileSync(target, rendered);
if (args.has('--check') && (!existsSync(target) || readFileSync(target, 'utf8') !== rendered)) {
  console.error('TASKS.md is stale. Run npm run parity:status -- --write.'); process.exit(1);
}
if (args.has('--json')) console.log(JSON.stringify({ summary, current: current ? { id: current.id, title: current.title } : null, ready: ready.map(t => ({ id: t.id, title: t.title })) }, null, 2));
else {
  for (const s of summary) console.log(`${s.track}: ${s.verified}/${s.total} verified; ${s.inProgress} in progress; ${s.blocked} blocked`);
  if (current) console.log(`Current: ${current.id} — ${current.title}`);
  console.log(`Next: ${ready[0] ? `${ready[0].id} — ${ready[0].title}` : 'no ready task'}`);
  if (args.has('--check')) console.log('Tracker structure, dependencies, evidence links and generated checklist are valid.');
}
