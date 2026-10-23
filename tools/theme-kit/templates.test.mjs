// SPDX-License-Identifier: BSD-3-Clause
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cpSync, readdirSync } from 'node:fs';
import { packDirectory } from './pack.mjs';
import { measurements } from './cli.mjs';
const expected=JSON.parse(readFileSync(new URL('./templates/expected-sha256.json',import.meta.url)));
for(const name of Object.keys(expected))test(`${name} committed bytes match its measured reference`,async()=>{
  const p=await packDirectory(fileURLToPath(new URL('./templates/'+name,import.meta.url)));
  const r=measurements(p);for(const [key,value] of Object.entries(expected[name]))assert.equal(r[key],value,key);
});
test('additional starters work from a detached kit and rebuild deterministically',t=>{
  const cwd=mkdtempSync(join(tmpdir(),'theme-detached-'));t.after(()=>rmSync(cwd,{recursive:true,force:true}));
  cpSync(fileURLToPath(new URL('./',import.meta.url)),join(cwd,'tools/theme-kit'),{recursive:true});
  cpSync(fileURLToPath(new URL('../../themes/ember',import.meta.url)),join(cwd,'themes/ember'),{recursive:true});
  const r=spawnSync(process.execPath,[join(cwd,'tools/theme-kit/build-templates.mjs')],{cwd,encoding:'utf8'});assert.equal(r.status,0,r.stderr);
  for(const name of Object.keys(expected))for(const rel of readdirSync(join(cwd,'tools/theme-kit/templates',name),{recursive:true,withFileTypes:true}).filter(e=>e.isFile())) {
    const file=join(rel.parentPath||rel.path,rel.name), original=file.replace(cwd,fileURLToPath(new URL('../../',import.meta.url)).replace(/\/$/,''));
    assert.deepEqual(readFileSync(file),readFileSync(original),name+'/'+rel.name);
  }
  assert.deepEqual(JSON.parse(readFileSync(join(cwd,'tools/theme-kit/templates/expected-sha256.json'))),expected);
  // No original themes directory is needed to scaffold an additional starter.
  rmSync(join(cwd,'themes'),{recursive:true});
  const p=spawnSync(process.execPath,[join(cwd,'tools/theme-kit/cli.mjs'),'new','sample','--from','paper'],{cwd,encoding:'utf8'});assert.equal(p.status,0,p.stderr);
});
const root=fileURLToPath(new URL('../../',import.meta.url));
test('Terrace font overrides affect visible labels in its geometry layout', () => {
  const { theme } = JSON.parse(readFileSync(new URL('./templates/terrace/theme.json', import.meta.url)));
  assert.ok(theme.menuLayout);
  // Geometry hides the title and derives label size from menuLayout.labelSize.
  // A family change remains visible; title-only/labelSize-only examples do not.
  for (const menuKey of ['@be/main-menu#main-menu', '@be/clock#clockMenu']) {
    const override = theme.overrides.find(o => o.menuKey === menuKey);
    assert.ok(override?.fonts, menuKey);
    assert.notEqual(override.fonts.labelFamily, theme.fonts.labelFamily, menuKey);
  }
});
for(const name of ['paper','signals','terrace','cut-paper'])test(`new ${name} scaffold checks and packs through the real CLI`,t=>{
  const cwd=mkdtempSync(join(tmpdir(),'theme-template-')); t.after(()=>rmSync(cwd,{recursive:true,force:true}));
  const cli=join(root,'tools/theme-kit/cli.mjs');
  const run=args=>spawnSync(process.execPath,[cli,...args],{cwd,encoding:'utf8',timeout:30000});
  let r=run(['new','sample','--from',name,'--author','Example Artist']); assert.equal(r.status,0,r.stderr);
  const license=readFileSync(join(root,'tools/theme-kit/templates',name,'LICENSE.md'),'utf8');
  assert.match(license,/build-templates\.mjs/); assert.doesNotMatch(license,/Phoenix Ember|Pillow|NumPy/);
  const source=JSON.parse(readFileSync(join(root,'tools/theme-kit/templates',name,'theme.json')));
  const authored=JSON.parse(readFileSync(join(cwd,'sample/theme.json')));
  assert.notEqual(authored.appId,source.appId); assert.deepEqual(authored.theme,source.theme);
  assert.match(readFileSync(join(cwd,'sample/AUTHOR.md'),'utf8'),/Example Artist/);
  r=run(['check',join(cwd,'sample')]); assert.equal(r.status,0,r.stderr);
  r=run(['pack',join(cwd,'sample'),'--out',join(cwd,'out')]); assert.equal(r.status,0,r.stderr);
  const pack=JSON.parse(r.stdout); assert.ok(pack.files.some(f=>f.endsWith('.phtheme')));
  const bytes=readFileSync(pack.files.find(f=>f.endsWith('.phtheme'))); const manifest=JSON.parse(bytes.subarray(12,12+bytes.readUInt32BE(8)));
  assert.equal(manifest.themeApi,source.themeApi); assert.deepEqual(manifest.theme,source.theme);
});
