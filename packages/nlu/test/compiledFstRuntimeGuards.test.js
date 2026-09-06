import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { constants, copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

const keys = ['PHOENIX_NLU_RUNTIME', 'PHOENIX_NLU_COMPILED_FST',
  'PHOENIX_NLU_COMPILED_FACTORY_DIR', 'PHOENIX_NLU_COMPILED_RULES_DIR',
  'PHOENIX_NLU_COMPILED_FST_SHA256'];
const original = Object.fromEntries(keys.map(key => [key, process.env[key]]));
const configured = original.PHOENIX_NLU_RUNTIME === 'compiled-fst'
  && keys.every(key => original[key]);
const approvedHash = '2ba09176e04522d4addbca23074f2bef62b1cbbe9702f03c390abd8b56fdc25a';
let instance = 0;

async function withConfig(values, fn) {
  try {
    for (const key of keys) {
      if (values[key] === undefined) delete process.env[key];
      else process.env[key] = values[key];
    }
    const runtime = await import(`../src/compiledFstRuntime.js?guard=${instance++}`);
    return await fn(runtime);
  } finally {
    for (const key of keys) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
  }
}

test('the default parser does not require compiled artifacts', async () => {
  await withConfig({}, ({ getCompiledFstRuntime }) => assert.equal(getCompiledFstRuntime(), null));
});

test('explicit compiled runtime rejects each missing artifact setting', async () => {
  const config = { PHOENIX_NLU_RUNTIME: 'compiled-fst', PHOENIX_NLU_COMPILED_FST: '/unused/launch.fst',
    PHOENIX_NLU_COMPILED_FACTORY_DIR: '/unused/factories', PHOENIX_NLU_COMPILED_RULES_DIR: '/unused/rules',
    PHOENIX_NLU_COMPILED_FST_SHA256: approvedHash };
  for (const key of keys.slice(1)) {
    await withConfig({ ...config, [key]: undefined }, ({ getCompiledFstRuntime }) => {
      assert.throws(getCompiledFstRuntime, /compiled-fst runtime requires/);
    });
  }
});

test('a caller cannot attach the approved provenance to an arbitrary graph hash', async () => {
  await withConfig({ PHOENIX_NLU_RUNTIME: 'compiled-fst', PHOENIX_NLU_COMPILED_FST: '/unused/other.fst',
    PHOENIX_NLU_COMPILED_FACTORY_DIR: '/unused/factories', PHOENIX_NLU_COMPILED_RULES_DIR: '/unused/rules',
    PHOENIX_NLU_COMPILED_FST_SHA256: '0'.repeat(64) },
  ({ getCompiledFstRuntime }) => assert.throws(getCompiledFstRuntime, /Unsupported compiled NLU launch profile/));
});

test('an invalid explicit profile prevents the HTTP listener from starting', async () => {
  await withConfig({ PHOENIX_NLU_RUNTIME: 'compiled-fst' }, async () => {
    const { start } = await import('../src/index.js');
    assert.throws(() => start(0), /compiled-fst runtime requires/);
  });
});

test('approved artifact pins reject substitution and execute verified graph and factory snapshots', { skip: !configured }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'phoenix-fst-pins-'));
  const fstPath = join(dir, 'launch.fst');
  const factoryDir = join(dir, 'factories');
  const rulesDir = join(dir, 'rules');
  const inventory = JSON.parse(readFileSync(new URL('../resources/rule-inventory.json', import.meta.url)));
  const config = { ...original, PHOENIX_NLU_COMPILED_FST: fstPath,
    PHOENIX_NLU_COMPILED_FACTORY_DIR: factoryDir, PHOENIX_NLU_COMPILED_RULES_DIR: rulesDir };
  try {
    copyFileSync(original.PHOENIX_NLU_COMPILED_FST, fstPath, constants.COPYFILE_FICLONE);
    cpSync(original.PHOENIX_NLU_COMPILED_FACTORY_DIR, factoryDir, { recursive: true });
    for (const { compiledPath } of Object.values(inventory.publicRules)) {
      const target = join(rulesDir, compiledPath);
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(join(original.PHOENIX_NLU_COMPILED_RULES_DIR, compiledPath), target, constants.COPYFILE_FICLONE);
    }
    const countryPath = join(factoryDir, 'country.fst');
    const countryHash = createHash('sha256').update(readFileSync(countryPath)).digest('hex');
    await withConfig({ ...config, PHOENIX_NLU_COMPILED_FST: countryPath, PHOENIX_NLU_COMPILED_FST_SHA256: countryHash },
      ({ getCompiledFstRuntime }) => assert.throws(getCompiledFstRuntime, /Unsupported compiled NLU launch profile/));
    await withConfig({ ...config, PHOENIX_NLU_COMPILED_FST: countryPath },
      ({ getCompiledFstRuntime }) => assert.throws(getCompiledFstRuntime, /Compiled NLU FST hash mismatch/));

    const firstNamePath = join(factoryDir, 'first_name.fst');
    const firstName = readFileSync(firstNamePath);
    writeFileSync(firstNamePath, 'substituted factory bytes');
    await withConfig(config,
      ({ getCompiledFstRuntime }) => assert.throws(getCompiledFstRuntime, /factory manifest hash mismatch/));
    writeFileSync(firstNamePath, firstName);

    const localPath = join(rulesDir, inventory.publicRules['globals/global_commands_launch'].compiledPath);
    const localBytes = readFileSync(localPath);
    rmSync(localPath);
    await withConfig(config,
      ({ getCompiledFstRuntime }) => assert.throws(getCompiledFstRuntime, /Compiled NLU rule is unavailable/));
    writeFileSync(localPath, 'substituted local graph bytes');
    await withConfig(config,
      ({ getCompiledFstRuntime }) => assert.throws(getCompiledFstRuntime, /Compiled NLU rule hash mismatch/));
    writeFileSync(localPath, localBytes);

    await withConfig(config, ({ getCompiledFstRuntime, matchCompiledLaunch, matchCompiledRule, compiledFstRuntimeConfig }) => {
      const runtime = getCompiledFstRuntime();
      const metadata = compiledFstRuntimeConfig();
      const expected = matchCompiledLaunch('who is jane jetson');
      assert.equal(expected.intent, 'whoIsPerson');
      assert.equal(expected.entities.GivenName, 'jane');
      // Both the launch graph and every factory must continue using the bytes
      // verified at load time, including a factory first invoked after this write.
      writeFileSync(fstPath, 'substituted launch bytes');
      writeFileSync(localPath, 'substituted local graph bytes');
      for (const name of readdirSync(factoryDir).filter(name => name.endsWith('.fst'))) {
        writeFileSync(join(factoryDir, name), 'substituted factory bytes');
      }
      assert.strictEqual(getCompiledFstRuntime(), runtime);
      assert.deepEqual(compiledFstRuntimeConfig(), metadata);
      assert.deepEqual(matchCompiledLaunch('who is jane jetson'), expected);
      assert.equal(matchCompiledLaunch('what time is it').intent, 'askForTime');
      // This executor is first created after its on-disk graph was replaced.
      // It must still consume the bytes verified with the rest of the profile.
      const local = matchCompiledRule('globals/global_commands_launch', 'cancel the timer', runtime);
      assert.equal(local.intent, 'stop');
      assert.equal(local.entities.domain, 'global_commands');
      assert.equal(local.score, 7);
    });
    await withConfig(config,
      ({ getCompiledFstRuntime }) => assert.throws(getCompiledFstRuntime, /Compiled NLU FST hash mismatch/));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
