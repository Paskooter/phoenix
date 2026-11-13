import test from 'node:test';
import assert from 'node:assert/strict';
import {copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import {fileURLToPath} from 'node:url';

// Exercise only the portable runtime sources, outside the checkout and without
// package.json, node_modules, NODE_PATH or preloads. This is not a second kit or
// the Hub's download allowlist: that route has its own archive regression.
const root = fileURLToPath(new URL('../../', import.meta.url));
const runtimeFiles = ['cli.mjs', 'format.mjs', 'native-icons.mjs', 'native-pack.mjs', 'new.mjs', 'project.mjs', 'ssh.mjs'];
const templates = ['hello', 'touch-ui', 'voice', 'network-service'];
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const syntaxNode = process.env.SKILL_KIT_NODE_6_5;

function cleanSource(t) {
  assert.ok(existsSync(join(root, 'tools/skill-kit/cli.mjs')), 'clean source must include the released JavaScript skill kit');
  const base = mkdtempSync(join(tmpdir(), 'skill-clean-source-'));
  t.after(() => rmSync(base, {recursive: true, force: true}));
  const kit = join(base, 'tools/skill-kit');
  mkdirSync(kit, {recursive: true});
  for (const name of runtimeFiles) copyFileSync(join(root, 'tools/skill-kit', name), join(kit, name));
  cpSync(join(root, 'tools/skill-kit/templates'), join(kit, 'templates'), {recursive: true});
  mkdirSync(join(base, 'tools/theme-kit'));
  for (const name of ['format.cjs', 'themeFormat.cjs']) copyFileSync(join(root, 'tools/theme-kit', name), join(base, 'tools/theme-kit', name));
  const bin = join(base, 'bin'), toolTrap = join(base, 'unexpected-tool');
  mkdirSync(bin);
  for (const tool of ['npm', 'npx', 'ssh']) writeFileSync(join(bin, tool), '#!/bin/sh\nprintf unexpected > "$TOOL_TRAP_FILE"\nexit 90\n', {mode: 0o755});
  const env = {...process.env, PATH: bin, TOOL_TRAP_FILE: toolTrap};
  delete env.NODE_OPTIONS;
  delete env.NODE_PATH;
  const invoke = (...args) => {
    const result = spawnSync(process.execPath, [join(kit, 'cli.mjs'), ...args], {cwd: base, env, encoding: 'utf8', timeout: 30000});
    assert.ifError(result.error);
    return result;
  };
  const run = (...args) => {
    const result = invoke(...args);
    assert.equal(result.status, 0, `${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
    return JSON.parse(result.stdout).result;
  };
  return {base, kit, toolTrap, invoke, run};
}

// Independent, read-only decoding rather than validating the producer with its
// own inspector. No archive JavaScript is imported or evaluated here.
function unpack(bytes) {
  assert.equal(bytes.subarray(0, 8).toString(), 'PHXNAT1\n');
  const length = bytes.readUInt32BE(8);
  const metadata = JSON.parse(bytes.subarray(12, 12 + length));
  assert.equal(metadata.kind, 'native');
  assert.equal(metadata.schema, 1);
  assert.equal(metadata.hostAbi, 1);
  const tar = gunzipSync(bytes.subarray(12 + length));
  const files = [];
  let at = 0;
  while (tar.subarray(at, at + 512).some(Boolean)) {
    const header = tar.subarray(at, at + 512);
    assert.equal(header.subarray(257, 263).toString(), 'ustar\0');
    assert.equal(header[156], 48, 'only regular files');
    const text = (start, end) => header.subarray(start, end).toString().split('\0')[0];
    const path = [text(345, 500), text(0, 100)].filter(Boolean).join('/');
    const size = parseInt(text(124, 136).trim(), 8), mode = parseInt(text(100, 108).trim(), 8);
    assert.equal(parseInt(text(136, 148).trim(), 8), 0, 'packaged mtimes are fixed');
    const content = tar.subarray(at + 512, at + 512 + size);
    files.push({path, length: content.length, mode, sha256: digest(content)});
    at += 512 + Math.ceil(size / 512) * 512;
  }
  assert.equal(tar.length - at, 1024, 'exact two-block tar terminator');
  assert.ok(tar.subarray(at).every(byte => byte === 0));
  assert.deepEqual(files, metadata.fileManifest, 'archive bytes match the complete sorted manifest');
  assert.deepEqual(files.map(file => file.path), files.map(file => file.path).sort());
  return metadata;
}

for (const template of templates) {
  test(`clean source: ${template} new/check/pack needs no install and never evaluates bundle code`, t => {
    const {base, kit, toolTrap, run} = cleanSource(t);
    assert.deepEqual(readdirSync(join(kit, 'templates')).sort(), [...templates].sort());
    const made = run('new', 'sample', '--template', template);
    assert.equal(made.kind, 'native');
    const project = join(base, 'sample');
    const config = JSON.parse(readFileSync(join(project, 'skill.json')));
    assert.equal(config.kind, 'native');
    const app = JSON.parse(readFileSync(join(project, 'app.json')));
    assert.equal(app.hostAbi, 1);
    const sentinel = join(base, 'bundle-was-executed');
    for (const file of config.files.filter(file => file.endsWith('.js'))) {
      const path = join(project, file);
      writeFileSync(path, readFileSync(path, 'utf8') + `\nrequire('fs').writeFileSync(${JSON.stringify(sentinel)}, 'executed');\nthrow new Error('validation must not execute bundle code');\n`);
    }
    const flags = syntaxNode ? ['--syntax-node', syntaxNode] : [];
    const checked = run('check', project, ...flags);
    assert.match(checked.notice, /without running code/);
    const a = run('pack', project, '--out', join(base, 'a'), ...flags);
    for (const file of config.files) utimesSync(join(project, file), 1234567890, 1234567890);
    const b = run('pack', project, '--out', join(base, 'b'), ...flags);
    const bytes = readFileSync(a.file);
    assert.deepEqual(bytes, readFileSync(b.file), 'packaging ignores input mtimes and output paths');
    assert.equal(a.sha256, digest(bytes));
    assert.equal(a.sha256, b.sha256);
    const metadata = unpack(bytes);
    assert.equal(metadata.appId, made.appId);
    assert.deepEqual(metadata.fileManifest.map(file => file.path), [...config.files].sort());
    const inspected = run('check', a.file, ...flags);
    assert.equal(inspected.sha256, a.sha256);
    assert.equal(existsSync(sentinel), false, 'check/pack must not execute any submitted JavaScript');
    assert.equal(existsSync(toolTrap), false, 'offline authoring must not invoke npm, npx or SSH');
    assert.equal(existsSync(join(base, 'node_modules')), false);
    assert.equal(existsSync(join(project, '.skill-kit')), false, 'offline authoring allocates no robot state');
  });
}

test('exact legacy parser rejects modern syntax that passes the host parser without evaluating it', {skip: !syntaxNode && 'set SKILL_KIT_NODE_6_5 to a trusted Node 6.5.0 executable'}, t => {
  const {base, run, invoke} = cleanSource(t);
  run('new', 'modern');
  const project = join(base, 'modern');
  writeFileSync(join(project, 'entry.js'), 'throw new Error("must not execute");\nvar value = ({})?.value;\n');
  run('check', project);
  const refused = invoke('check', project, '--syntax-node', syntaxNode);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /Skill request failed: test_native_syntax_invalid/);
});
