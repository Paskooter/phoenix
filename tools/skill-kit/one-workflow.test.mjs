import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,readdirSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
// One project type and one workflow: `new <name>` needs no kind or format
// choice, and the kit offers no second project format.
const cli=new URL('./cli.mjs',import.meta.url).pathname;
function kit(cwd,...args){return spawnSync(process.execPath,[cli,...args],{cwd,encoding:'utf8',timeout:30000});}
test('help offers one new-project command and no format choice',()=>{
  const help=kit(process.cwd(),'--help');
  assert.equal(help.status,0,help.stderr);
  assert.match(help.stdout,/^Jibo skill kit/);
  assert.match(help.stdout,/^ {2}new <name> \[--template hello\|touch-ui\|voice\|network-service\]$/m);
  assert.equal((help.stdout.match(/^ {2}new /gm)||[]).length,1);
  assert.doesNotMatch(help.stdout,/--kind|declarative|Skill SDK|data-only|native skill kit/i);
});
test('new with only a name makes the hello skill, which checks and packs',()=>{
  const base=mkdtempSync(join(tmpdir(),'skill-one-'));
  try {
    const made=kit(base,'new','my-skill');assert.equal(made.status,0,made.stderr);
    const result=JSON.parse(made.stdout).result;
    assert.equal(result.template,'hello');
    assert.deepEqual(JSON.parse(readFileSync(join(result.directory,'skill.json'))).kind,'native');
    assert.equal(JSON.parse(kit(base,'check','my-skill').stdout).result.kind,'native');
    const packed=kit(base,'pack','my-skill','--out','out');assert.equal(packed.status,0,packed.stderr);
    assert.match(JSON.parse(packed.stdout).result.file,/out\/my-skill-1\.0\.0\.phnative$/);
  } finally {rmSync(base,{recursive:true,force:true});}
});
test('the kit has no second project format to choose',()=>{
  const base=mkdtempSync(join(tmpdir(),'skill-one-'));
  try {
    assert.deepEqual(readdirSync(new URL('./templates/',import.meta.url)).sort(),['hello','network-service','touch-ui','voice']);
    for(const args of [['new','pages','--template','declarative'],['new','pages','--kind','declarative'],['new','pages','--from','hello']]) {
      const refused=kit(base,...args);assert.equal(refused.status,1,args.join(' '));assert.equal(existsSync(join(base,'pages')),false,args.join(' '));
    }
    // Older scripts (including Jibo's own release check) may still pass the one supported kind.
    const legacy=kit(base,'new','older','--kind','native');assert.equal(legacy.status,0,legacy.stderr);
    assert.equal(JSON.parse(legacy.stdout).result.template,'hello');
  } finally {rmSync(base,{recursive:true,force:true});}
});
