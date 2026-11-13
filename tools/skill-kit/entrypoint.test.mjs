import test from 'node:test';
import assert from 'node:assert/strict';
import {copyFileSync,mkdtempSync,readdirSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';

test('directory entrypoint discovers every test suite exactly once and propagates failures',()=>{
  const base=mkdtempSync(join(tmpdir(),'skill-entrypoint-'));
  try {
    writeFileSync(join(base,'package.json'),JSON.stringify({type:'module'}));
    copyFileSync(new URL('./index.js',import.meta.url),join(base,'index.js'));
    const files=[...readdirSync(new URL('.',import.meta.url)).filter(name=>name.endsWith('.test.mjs')),'future-added.test.mjs'].sort();
    for(const name of files)writeFileSync(join(base,name),`import test from 'node:test';\ntest(${JSON.stringify(name)},()=>{});\n`);
    writeFileSync(join(base,'not-a-suite.mjs'),'throw Error("non-test file must not run");\n');
    const env={...process.env};
    delete env.NODE_TEST_CONTEXT;
    function run(args) {
      const result=spawnSync(process.execPath,['--test','--test-reporter=tap',...args],{env,encoding:'utf8',timeout:10000});
      assert.ifError(result.error);
      return result;
    }
    for(const args of [[base],files.map(name=>join(base,name))]) {
      const result=run(args);
      assert.equal(result.status,0,result.stdout+result.stderr);
      const names=[...result.stdout.matchAll(/^# Subtest: (.+)$/gm)].map(match=>match[1]).sort();
      assert.deepEqual(names,files,'directory and explicit suites must each run every discovered suite exactly once');
      assert.match(result.stdout,new RegExp('^# tests '+files.length+'$','m'));
    }
    writeFileSync(join(base,'future-added.test.mjs'),'throw Error("new suite import failure");\n');
    const failed=run([base]);
    assert.notEqual(failed.status,0,'a newly added broken suite must fail the directory runner');
    assert.match(failed.stdout+failed.stderr,/new suite import failure/);
  }finally{rmSync(base,{recursive:true,force:true});}
});
