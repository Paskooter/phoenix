import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const REVISION = /^[0-9a-f]{7,64}$/i;

function firstRevision(value) {
  if (typeof value !== 'string') return '';
  const candidate = value.trim().split(/\s+/)[0] || '';
  return REVISION.test(candidate) ? candidate : '';
}

/**
 * Classify evidence without upgrading a historical capture to a current claim.
 * A current-head result must carry the exact HEAD revision; any other bounded
 * revision remains historical, even when its result is still useful evidence.
 */
export function verificationScope(evidence, currentHead) {
  const revision = firstRevision(evidence?.phoenixRevision);
  if (!revision || !currentHead) return revision ? 'historical-bounded' : 'unbounded';
  const head = String(currentHead).trim().toLowerCase();
  const raw = String(evidence.phoenixRevision).trim();
  const isExactHead = raw.toLowerCase() === head
    || (raw === revision && revision.length < head.length && head.startsWith(revision.toLowerCase()));
  return isExactHead ? 'current-head' : 'historical-bounded';
}

export function verificationSummary(tasks, currentHead) {
  const currentHeadVerification = [];
  const historicalBoundedEvidence = [];
  const unboundedEvidence = [];
  for (const task of tasks || []) {
    for (const evidence of task.verification || []) {
      const item = {
        task: task.id,
        artifact: evidence.artifact || null,
        date: evidence.date || null,
        scope: verificationScope(evidence, currentHead),
      };
      if (item.scope === 'current-head') currentHeadVerification.push(item);
      else if (item.scope === 'historical-bounded') historicalBoundedEvidence.push(item);
      else unboundedEvidence.push(item);
    }
  }
  return {
    currentHead,
    currentHeadVerification,
    historicalBoundedEvidence,
    unboundedEvidence,
    counts: {
      currentHead: currentHeadVerification.length,
      historicalBounded: historicalBoundedEvidence.length,
      unbounded: unboundedEvidence.length,
    },
  };
}

function dependencyAvailable(dependency, root) {
  if (dependency.includes('/')) return existsSync(resolve(root, dependency));
  if (!/^[A-Za-z0-9_.+-]+$/.test(dependency)) return false;
  try {
    execFileSync('/bin/sh', ['-c', 'command -v "$1" >/dev/null 2>&1', 'parity-status', dependency], {
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

function declarationsFor(value, field, owner, errors) {
  if (value === undefined) return [];
  if (Array.isArray(value)) return value.map((declaration, index) => ({ declaration, label: `${owner}.${field}[${index}]` }));
  if (value && typeof value === 'object') {
    return Object.entries(value).map(([command, dependencies]) => ({
      declaration: { command, dependencies },
      label: `${owner}.${field}.${command}`,
    }));
  }
  errors.push(`${owner}: ${field} must be an array or command-to-dependencies object`);
  return [];
}

/**
 * Validate optional declarations for commands intentionally not run by a
 * verification. Ignoring a command is allowed; silently ignoring one of its
 * declared dependencies is not.
 */
export function ignoredCommandDependencyErrors({ value, field = 'ignoredCommands', owner, root, isAvailable = dependency => dependencyAvailable(dependency, root) }) {
  const errors = [];
  for (const { declaration, label } of declarationsFor(value, field, owner, errors)) {
    if (typeof declaration === 'string') continue;
    if (!declaration || typeof declaration !== 'object' || Array.isArray(declaration)) {
      errors.push(`${label}: declaration must be a command name or object`);
      continue;
    }
    const command = declaration.command ?? declaration.name;
    if (typeof command !== 'string' || !command.trim()) errors.push(`${label}: command is required`);
    const dependencies = declaration.dependencies ?? declaration.dependsOn;
    if (dependencies === undefined) continue;
    if (!Array.isArray(dependencies) || dependencies.some(dependency => typeof dependency !== 'string' || !dependency.trim())) {
      errors.push(`${label}: dependencies must be a nonempty-string array`);
      continue;
    }
    for (const dependency of dependencies) {
      const name = dependency.trim();
      if (!isAvailable(name)) errors.push(`${label}: missing ignored-command dependency ${name}`);
    }
  }
  return errors;
}

export function ignoredCommandErrorsFor(item, owner, root) {
  const errors = [];
  for (const field of ['ignoredCommands', 'ignoredCommandDependencies']) {
    errors.push(...ignoredCommandDependencyErrors({ value: item?.[field], field, owner, root }));
  }
  return errors;
}

export { firstRevision };
