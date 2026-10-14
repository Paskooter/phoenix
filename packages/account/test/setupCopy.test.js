import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { parse } from 'acorn';

const portal = new URL('../portal/', import.meta.url);
const banned = /\b(?:firmware|repoint(?:ed|ing)?|migrat(?:e[ds]?|ing|ion))\b|\bother server\b/i;

// Compatibility routes and source filenames are contracts, not prose. Do not
// exclude a whole sentence just because it also mentions a technical path.
function prose(text) {
  return text.replace(/(?:https?:\/\/)?[\w.~-]*(?:\/[\w.~-]+)+/g, '');
}
function strings(source) {
  const result = [];
  const tree = parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
  function walk(node) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'Literal' && typeof node.value === 'string') result.push(node.value);
    if (node.type === 'TemplateElement') result.push(node.value.cooked || node.value.raw);
    for (const [key, value] of Object.entries(node)) {
      if (key === 'value' && node.type === 'Literal') continue;
      if (Array.isArray(value)) value.forEach(walk);
      else if (value && typeof value === 'object') walk(value);
    }
  }
  walk(tree);
  return result;
}

test('copy scanner catches new phrases but excludes identifiers and compatibility routes', () => {
  for (const copy of ['New firmware is ready', 'Please repoint him', 'He migrated today', 'A migration is needed', 'Try the other server']) {
    assert.match(prose(copy), banned, copy);
  }
  assert.doesNotMatch(prose('/repoint scripts/parity-robot/repoint-robot.sh minFirmware'), banned);
  assert.deepEqual(strings('// firmware\nconst repointHost = "setup command";'), ['setup command']);
  assert.match(prose(strings('const x = `Please migrate ${name}`;')[0]), banned);
});

test('shipped console scripts and shells have no prohibited user-facing setup wording', () => {
  // The public landing/legal defaults describe self-hosting and are operator-
  // overridable. This guard covers console code, not those independent pages.
  const scripts = readdirSync(portal).filter(name => name.endsWith('.js') && !['site.js', 'site-render.js'].includes(name));
  const findings = [];
  for (const name of scripts) {
    for (const text of strings(readFileSync(new URL(name, portal), 'utf8'))) {
      if (banned.test(prose(text))) findings.push(`${name}: ${text}`);
    }
  }
  for (const name of ['app.html', 'verify-email.html', 'console.css']) {
    const source = readFileSync(new URL(name, portal), 'utf8').replace(/<!--[\s\S]*?-->|\/\*[\s\S]*?\*\//g, '');
    const visible = name.endsWith('.css')
      ? [...source.matchAll(/content\s*:\s*(['"])(.*?)\1/g)].map(match => match[2]).join('\n')
      : source.replace(/<[^>]+>/g, ' ');
    if (banned.test(prose(visible))) findings.push(`${name}: prohibited text`);
  }
  const branding = JSON.parse(readFileSync(new URL('branding.json', portal), 'utf8'));
  assert.doesNotMatch(JSON.stringify(branding.console), banned);
  assert.deepEqual(findings, []);
});

test('the displayed hosted command uses the setup address', () => {
  const source = readFileSync(new URL('app.js', portal), 'utf8');
  assert.match(source, /curl -fsSL https:\/\/jibo\.io\/setup/);
  assert.doesNotMatch(source, /curl -fsSL https:\/\/jibo\.io\/repoint/);
});
