// SPDX-License-Identifier: BSD-3-Clause
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ICON_TARGETS } from './pack.mjs';
const root=fileURLToPath(new URL('../../',import.meta.url));
const files=['docs/THEMES.md','docs/themes/REFERENCE.md','docs/themes/SURFACES.md','docs/themes/PUBLISHING.md','docs/themes/TESTING.md','tools/theme-kit/README.md'];
const available=existsSync(resolve(root,'docs/THEMES.md'));
const options={skip:!available&&'Documentation is not included in this standalone copy.'};
const text=available?files.map(p=>readFileSync(resolve(root,p),'utf8')).join('\n'):'';
test('theme reference names all base/extension fields and every permitted icon target',options,()=>{
  for(const name of ['schema','kind','runtime','themeApi','appId','version','minFirmware','name','description','releaseNotes','permissions','launchNames','theme','assets','id','role','path','layout','palette','fonts','background','previewAsset','storeAppIcon','overrides','menuKey','icons','itemId','asset','opacity','surface','surfaceSecondary','text','mutedText','accent','titleFamily','labelFamily','titleSize','labelSize','eye','eyeAsset','face','texture','alpha','color','closed','states','listening','colorMode','scalePercent','menuLayout','scrollMode','buttonSize','buttonOffset','iconSize','iconOffset','labelSize','labelWidth','labelOffset','mediaType','sha256','bytes','width','height','releaseId','manifestSha256','manifestBytes','assetCount','keyId','signature']) assert.ok(text.includes(name),name);
  for(const [scope,ids] of Object.entries(ICON_TARGETS)) {assert.ok(text.includes(scope),scope);for(const id of ids)assert.ok(text.includes('`'+id+'`'),id);}
  assert.doesNotMatch(text,/Eye themes are coming|not supported yet|browser-console helper/);
});
test('icon reference distinguishes accepted targets from visible replacement',options,()=>{
  const guide=readFileSync(resolve(root,'docs/THEMES.md'),'utf8');
  assert.match(guide,/Accepted targets and visible replacements/);
  assert.match(guide,/`phoenix-tic-tac-toe`[\s\S]*not a renderer replacement target/);
  assert.match(guide,/trusted native app icon/);
});
test('theme publishing distinguishes pending exact-bundle review from publication',options,()=>{
  const publishing=readFileSync(resolve(root,'docs/themes/PUBLISHING.md'),'utf8');
  assert.match(publishing,/immutable pending submission/);
  assert.match(publishing,/operator reviews the exact[\s\S]*source and normalized[\s\S]*before signing and publication/);
  assert.match(publishing,/Each new third-party version requires operator review/);
  assert.match(publishing,/Pending, rejected and changes-requested submissions are not signed/);
  assert.match(publishing,/corrected material needs a higher version and fresh review/);
  assert.doesNotMatch(publishing,/without per-app preapproval|creates a release ID and signs the descriptor/);
});
test('local theme documentation links and fragments resolve',options,()=>{
  const slug=s=>s.toLowerCase().replace(/<[^>]+>/g,'').replace(/[^\p{L}\p{N}_\-\s]/gu,'').replace(/ /g,'-');
  for(const file of files)for(const match of readFileSync(resolve(root,file),'utf8').matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    const href=match[1];if(/^(?:https?:|mailto:)/.test(href))continue;
    const [pathname,fragment]=href.split('#'), target=pathname?resolve(root,dirname(file),pathname):resolve(root,file);
    assert.ok(existsSync(target),file+' -> '+href);
    if(fragment){const headings=[...readFileSync(target,'utf8').matchAll(/^#{1,6} (.+)$/gm)].map(m=>slug(m[1]));assert.ok(headings.includes(fragment),file+' -> '+href);}
  }
});
