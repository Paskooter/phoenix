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
  assert.match(sdk, /JavaScript apps cannot be submitted to the Skill Store yet/);
  const dir = mkdtempSync(join(tmpdir(), 'phx-guide-cli-'));
  try {
    for (const args of argv) {
      const out = JSON.parse(execFileSync(process.execPath, [CLI, ...args], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 }));
      assert.equal(out.ok, true, args.join(' '));
      assert.equal(out.result.kind, 'native', args.join(' '));
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('declarative and JavaScript publishing boundaries stay explicit', () => {
  for (const name of ['skill-sdk.md', 'skill-example.md', 'skill-api.md']) {
    const guide = readGuide(name);
    assert.match(guide, /\]\(\/developers\/skills\/workflow\)/, name + ' links the native workflow (falls back while the guide is held)');
    assert.match(guide, /\.phskill[\s\S]{0,180}API-only|API-only[\s\S]{0,180}\.phskill/i, name + ' keeps the API-only declarative boundary');
  }
  const publishing = readGuide('publishing.md');
  assert.match(publishing, /JavaScript apps made with the skill kit \(`\.phnative`\) cannot be submitted to the Skill Store yet/);
  assert.match(publishing, /This picker accepts theme packs only\./);
  assert.match(readGuide('skill-api.md'), /POST \/publisher\/skill-releases/);
});
