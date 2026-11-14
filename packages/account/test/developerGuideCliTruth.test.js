// The public developer guides may only teach skill-kit commands the kit accepts.
// Each documented command goes through the kit's own argument parser, and the
// Skill SDK walkthrough runs end to end in a temporary directory. The kit checks
// and packs without evaluating project code, so no app code runs here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { argumentsFor } from '../../../tools/skill-kit/cli.mjs';
import { staticRoutes } from './fixtures/developer-content.mjs';

const CLI = fileURLToPath(new URL('../../../tools/skill-kit/cli.mjs', import.meta.url));
const GUIDES = ['skill-sdk.md', 'skill-example.md', 'skill-api.md', 'publishing.md'];
const readGuide = name => readFileSync(new URL('../../../docs/developers/' + name, import.meta.url), 'utf8');
const KIT_LINE = /^\s*node tools\/skill-kit\/cli\.mjs\b(.*)$/gm;
const commandsIn = text => [...text.matchAll(KIT_LINE)].map(m => m[1].trim().split(/\s+/).filter(Boolean));
// Mirrors scaffold() in tools/skill-kit/new.mjs, which rejects other names.
const PROJECT_NAME = /^[a-z][a-z0-9-]{0,39}$/;

test('developer guides teach only skill-kit commands the kit accepts', () => {
  for (const name of GUIDES) {
    for (const argv of commandsIn(readGuide(name))) {
      const shown = 'node tools/skill-kit/cli.mjs ' + argv.join(' ');
      assert.doesNotThrow(() => argumentsFor(argv), name + ' teaches a rejected command: ' + shown);
      if (argv[0] === 'new') assert.match(argv[1], PROJECT_NAME, name + ' passes an invalid project name: ' + shown);
    }
    const guide = readGuide(name);
    assert.doesNotMatch(guide, /--app-id\b/, name + ' must not offer an app ID option');
    assert.doesNotMatch(guide, /cli\.mjs test\b/, name + ' must not offer a test command');
    assert.doesNotMatch(guide, /\*\*Skill bundle\*\*|skill picker is not|browser packs ZIP source|let the browser pack|browser builds the same source-container|Submit skill for review/,
      name + ' must not describe a browser skill picker or packer');
  }
});

test('the Skill SDK documents the single JavaScript-app kit and runs offline as written', () => {
  const sdk = readGuide('skill-sdk.md');
  const argv = commandsIn(sdk);
  assert.deepEqual(argv.map(a => a[0]), ['new', 'check', 'pack', 'check']);
  assert.ok(argv[2].includes('--out'), 'pack names its output directory');
  assert.match(argv[3][1], /\.phnative$/, 'the packed file is checked');
  assert.match(sdk, /\.phskill[\s\S]{0,180}API-only|API-only[\s\S]{0,180}\.phskill/i);
  assert.match(sdk, /JavaScript apps can't be published to the Skill Store\./);
  const dir = mkdtempSync(join(tmpdir(), 'phx-guide-cli-'));
  try {
    for (const args of argv) {
      const out = JSON.parse(execFileSync(process.execPath, [CLI, ...args], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 }));
      assert.equal(out.ok, true, args.join(' '));
      assert.equal(out.result.kind, 'native', args.join(' '));
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

function env(values, fn) {
  const old = Object.fromEntries(Object.keys(values).map(k => [k, process.env[k]]));
  for (const [k, v] of Object.entries(values)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { return fn(); } finally { for (const [k, v] of Object.entries(old)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
}
const SITE = { PHOENIX_SKILL_STORE_ENABLED: 'true', PHOENIX_PAGES_DIR: undefined, PHOENIX_BRANDING_FILE: undefined, PHOENIX_SITE_URL: undefined };
// The command panel in the /developers landing hero, as plain text.
function landingCommands(guide) {
  return env({ ...SITE, PHOENIX_DEVELOPER_SKILLS_ENABLED: guide ? 'true' : undefined }, () => {
    const res = { writeHead() {}, end(bytes = '') { this.body = Buffer.from(bytes).toString(); } };
    staticRoutes()['GET /developers']({ req: { headers: {}, path: '/developers' }, res });
    const panel = /<pre[^>]*aria-label="Skill kit commands"[^>]*><code>([\s\S]*?)<\/code><\/pre>/.exec(res.body);
    assert.ok(panel, 'the landing hero shows its command panel');
    return panel[1].replace(/<[^>]+>/g, '').replace(/&amp;/g, '&');
  });
}

test('guide off: the /developers landing hero shows the working local-test-build flow and it runs offline', () => {
  const panel = landingCommands(false);
  const argv = commandsIn(panel);
  for (const args of argv) assert.doesNotThrow(() => argumentsFor(args), 'landing hero teaches a rejected command: ' + args.join(' '));
  assert.doesNotMatch(panel, /cli\.mjs test\b|--app-id\b|--kind\b|--template\b|\.\/hello-jibo/);
  assert.deepEqual(argv.map(a => a[0]), ['new', 'check', 'pack', 'check']);
  assert.match(argv[0][1], PROJECT_NAME);
  assert.deepEqual(argv[1], ['check', argv[0][1]]);
  assert.deepEqual(argv[2].slice(0, 3), ['pack', argv[0][1], '--out']);
  assert.match(argv[3][1], /\.phnative$/);
  const dir = mkdtempSync(join(tmpdir(), 'phx-landing-cli-'));
  try {
    for (const args of argv) {
      const out = JSON.parse(execFileSync(process.execPath, [CLI, ...args], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 }));
      assert.equal(out.ok, true, args.join(' '));
      assert.equal(out.result.kind, 'native', args.join(' '));
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('guide on: every landing hero command is accepted by the kit', () => {
  const argv = commandsIn(landingCommands(true));
  assert.ok(argv.length > 0);
  for (const args of argv) assert.doesNotThrow(() => argumentsFor(args), 'landing hero teaches a rejected command: ' + args.join(' '));
});

test('declarative and JavaScript publishing boundaries stay explicit', () => {
  for (const name of ['skill-sdk.md', 'skill-example.md', 'skill-api.md']) {
    const guide = readGuide(name);
    assert.match(guide, /\]\(\/developers\/skills\/workflow\)/, name + ' links the native workflow (falls back while the guide is held)');
    assert.match(guide, /\.phskill[\s\S]{0,180}API-only|API-only[\s\S]{0,180}\.phskill/i, name + ' keeps the API-only declarative boundary');
  }
  // Only the Skill SDK teaches the JavaScript-app kit; the declarative example and
  // API reference must not present kit commands as declarative authoring.
  for (const name of ['skill-example.md', 'skill-api.md']) {
    assert.deepEqual(commandsIn(readGuide(name)), [], name + ' must not present kit commands as declarative authoring');
  }
  // Theme-only browser picker; JavaScript apps are never signed, listed or installed by the Store.
  const publishing = readGuide('publishing.md');
  assert.match(publishing, /This browser picker accepts theme packs only/);
  assert.match(publishing, /The Store does not sign, list or install them/);
  const api = readGuide('skill-api.md');
  assert.match(api, /POST \/publisher\/skill-releases/);
  assert.match(api, /Declarative `?\.phskill` submission[\s\S]{0,180}API-only/i);
  assert.match(api, /409 `native_publication_disabled`/);
});

// Any served developer page, rendered with the guide off or on.
function served(path, guide) {
  return env({ ...SITE, PHOENIX_DEVELOPER_SKILLS_ENABLED: guide ? 'true' : undefined }, () => {
    const res = { writeHead() {}, end(bytes = '') { this.body = Buffer.from(bytes).toString(); } };
    staticRoutes()['GET ' + path]({ req: { headers: {}, path }, res });
    return res.body;
  });
}
const codeBlocks = html => [...html.matchAll(/<pre[^>]*><code[^>]*>([\s\S]*?)<\/code><\/pre>/g)]
  .map(m => m[1].replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&'));

test('guide off: the templates page shows the declarative starter commands and a kit flow that runs offline', () => {
  const html = served('/developers/templates', false);
  assert.match(html, /id="declarative-skill-starter"/);
  const blocks = codeBlocks(html), text = blocks.join('\n');
  assert.doesNotMatch(text, /\.\/hello-jibo|cli\.mjs test\b|--app-id\b|--kind\b/);
  // The starter's own commands are shown, not run: they would evaluate its code.
  assert.ok(blocks.some(b => /^node --test test\.mjs\nnode index\.js\n?$/.test(b)), 'the starter is run from its own folder');
  assert.match(html, /can(?:'|&#39;)t be published to the Skill Store\./);
  const argv = commandsIn(text);
  assert.deepEqual(argv.map(a => a[0]), ['new', 'check', 'pack', 'check']);
  for (const args of argv) assert.doesNotThrow(() => argumentsFor(args), 'templates page teaches a rejected command: ' + args.join(' '));
  assert.match(argv[0][1], PROJECT_NAME);
  assert.deepEqual(argv[2].slice(0, 3), ['pack', argv[0][1], '--out']);
  assert.match(argv[3][1], /\.phnative$/);
  const dir = mkdtempSync(join(tmpdir(), 'phx-templates-cli-'));
  try {
    for (const args of argv) {
      const out = JSON.parse(execFileSync(process.execPath, [CLI, ...args], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 }));
      assert.equal(out.ok, true, args.join(' '));
      assert.equal(out.result.kind, 'native', args.join(' '));
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('guide on: the templates page keeps only the skill kit starters', () => {
  const html = served('/developers/templates', true);
  assert.doesNotMatch(html, /id="declarative-skill-starter"|hello-jibo/);
  for (const args of commandsIn(codeBlocks(html).join('\n'))) assert.doesNotThrow(() => argumentsFor(args), args.join(' '));
});

test('the landing Skills summary describes the one JavaScript-app kit with the guide off and on', () => {
  const summary = guide => {
    const area = /<section class="dev-area" id="area-skills"[\s\S]*?<p>([\s\S]*?)<\/p>/.exec(served('/developers', guide));
    assert.ok(area, 'the landing page has a Skills area');
    return area[1].replace(/&#39;/g, "'");
  };
  const off = summary(false);
  assert.doesNotMatch(off, /data-only|Skill SDK|cards, buttons and speech/);
  assert.match(off, /JavaScript app with the skill kit/);
  assert.match(off, /local test build on your own Jibo/);
  assert.match(off, /JavaScript apps can’t be published to the Skill Store\./);
  assert.equal(summary(true), 'Build skills in JavaScript with the skill kit, then try them on your own Jibo.');
});
