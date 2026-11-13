import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,existsSync,readdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname,resolve} from 'node:path';
import {Script} from 'node:vm';
import {spawnSync} from 'node:child_process';
import {iconFields} from './native-icons.mjs';
const root=fileURLToPath(new URL('../../',import.meta.url));
const pages=['docs/SKILLS.md',...['MANIFESTS','CONTEXT','SDK','WORKFLOW','COOKBOOK','TROUBLESHOOTING'].map(n=>'docs/skills/'+n+'.md')];
const content=Object.fromEntries(pages.map(p=>[p,readFileSync(resolve(root,p),'utf8')]));
test('developer reference documents every author, descriptor and context field',()=>{
  const manifests=content['docs/skills/MANIFESTS.md'];
  for(const field of ['schema','kind','name','files','appId','version','minFirmware','hostAbi','entry','permissions','optionalPermissions','launchNames','skills','plugins','menuEntries','incomingPorts','sha256','iconApi','icon','iconImage','fileManifest','path','length','mode'])assert.ok(manifests.includes('`'+field+'`'),field);
  const context=content['docs/skills/CONTEXT.md'];
  for(const field of ['appId','releaseId','appRoot','dataRoot','legacySettings','grants','services','hooks','launchers','settings','timers','speech','attention'])assert.ok(context.includes('`'+field+'`'),field);
  for(const method of ['prepareBeforeInit','startAfterInit','registerLaunchers','getSetupState','health','stop','removeData'])assert.ok(context.includes('`'+method+'('),method);
});
test('developer reference links resolve without fetching web content',()=>{
  for(const [page,text] of Object.entries(content))for(const link of text.matchAll(/\]\(([^)]+)\)/g)) {
    const target=link[1].split('#')[0];if(!target||/^[a-z]+:/i.test(target))continue;
    assert.ok(existsSync(resolve(root,dirname(page),target)),page+' -> '+target);
  }
});
test('all JavaScript cookbook and reference snippets compile for the chosen runtime',()=>{
  const snippets=[];
  for(const [page,text] of Object.entries(content))for(const [index,match] of [...text.matchAll(/```js\n([\s\S]*?)\n```/g)].entries()) {
    const body=match[1].trim().startsWith('{')?'('+match[1]+');':match[1];
    const code='(function recipe(context,jibo,be) {\n'+body+'\n});';
    new Script(code,{filename:page+':'+index});snippets.push(code);
  }
  assert.ok(snippets.length>=20);
  if(process.env.SKILL_KIT_NODE_6_5) {
    const code='if(process.version!=="v6.5.0")process.exit(42);var s=JSON.parse(require("fs").readFileSync(0,"utf8"));s.forEach(function(v){new(require("vm").Script)(v);});process.stdout.write(String(s.length));';
    const result=spawnSync(process.env.SKILL_KIT_NODE_6_5,['-e',code],{input:JSON.stringify(snippets),encoding:'utf8',timeout:10000});
    assert.equal(result.status,0,result.stderr);assert.equal(Number(result.stdout),snippets.length);
  }
});
test('local-test guidance states the 13.8.0 menu behavior, context, grants and data erasure',()=>{
  const context=content['docs/skills/CONTEXT.md'],workflow=content['docs/skills/WORKFLOW.md'];
  for(const field of ['channel','identity','badge'])assert.ok(context.includes('`'+field+'`'),field);
  assert.match(context,/does not call `removeData\(\)`/);
  assert.match(context,/services\.localStorage` is always `null`/);
  const flat=workflow.replace(/\s+/g,' ');
  assert.match(flat,/On Jibo \*\*13\.8\.0\*\*, Home lists a running local test's entries after the Skill Store entries, prefixed \*\*LOCAL \/ Test —\*\*/);
  assert.match(flat,/Local voice aliases are not registered\. Paused, disabled, recovery-required and Allow-off tests do not get launchable entries/);
  assert.match(workflow,/runtimeState: "running"/);assert.match(workflow,/Only \*\*one skill test build\*\* can be installed at a time/);
  assert.match(content['docs/skills/MANIFESTS.md'],/Local protocol 1 grants only\nrequired permissions/);
});
test('guide commands use the one skill kit and make no stale availability claims',()=>{
  let commands=0;
  for(const [page,text] of Object.entries(content)) {
    for(const m of text.matchAll(/node (tools\/[\w./-]+)/g)) {
      commands++;
      assert.match(m[1],/^tools\/skill-kit\/(?:cli|ssh|native-pack)\.mjs$/,page+': '+m[0]);
      assert.ok(existsSync(resolve(root,m[1])),m[1]);
    }
    const flat=text.replace(/\s+/g,' ');
    for(const stale of [/coming next/i,/come later/i,/not available yet/i,/aren't available yet/i,/13\.7\.2-dev/,/\bdev\.[23]\b/,/next[- ]firmware/i,/compatible software is released/i,/wait for a compatible release/i])
      assert.doesNotMatch(flat,stale,page+' '+stale);
  }
  assert.ok(commands>=30,String(commands));
  // Template READMEs are copied into every new project.
  for(const name of readdirSync(new URL('./templates/',import.meta.url))) {
    const readme=readFileSync(new URL(`./templates/${name}/README.md`,import.meta.url),'utf8');
    assert.doesNotMatch(readme,/coming next|available yet|\bdev\.[23]\b/,name);
    for(const m of readme.matchAll(/node (tools\/[\w./-]+)/g))assert.equal(m[1],'tools/skill-kit/cli.mjs',name);
  }
});
test('the guide, kit README and starters tell one story: one project kind, one kit',()=>{
  const sources={...content,'tools/skill-kit/README.md':readFileSync(new URL('./README.md',import.meta.url),'utf8')};
  for(const name of readdirSync(new URL('./templates/',import.meta.url)))sources['templates/'+name]=readFileSync(new URL(`./templates/${name}/README.md`,import.meta.url),'utf8');
  for(const [page,text] of Object.entries(sources)) {
    const flat=text.replace(/\s+/g,' ');
    // ssh.mjs's protocol `project --kind native` is the only remaining kind spelling, in the README's low-level section.
    const kinds=[...flat.matchAll(/--kind (\S+)/g)].map(m=>m[1]);
    assert.ok(kinds.every(k=>k==='native')&&(kinds.length===0||page==='tools/skill-kit/README.md'),page+' '+kinds);
    assert.doesNotMatch(flat,/declarative|Skill SDK|data-only|skill-package|native-skill-kit|native skill kit|--from hello|older format/i,page);
    assert.doesNotMatch(flat,/\]\((?:\.\.\/)?developers\/(?:skill-sdk|skill-example|skill-api|touchscreen-apps)\.md/,page);
  }
  assert.match(content['docs/SKILLS.md'],/^# Build a skill for Jibo$/m);
  assert.match(content['docs/skills/WORKFLOW.md'],/Publishing skills to the Skill Store isn't available yet/);
});
test('troubleshooting documents the real partial-icon validation code',()=>{
  let code;
  assert.throws(()=>iconFields({iconApi:1}),error=>{code=error.code;return code==='app_icon_ref_invalid';});
  const rows=content['docs/skills/TROUBLESHOOTING.md'].split('\n');
  const row=rows.find(line=>line.startsWith('| `Skill request failed: '+code+'` |'));
  assert.ok(row,'missing troubleshooting row for '+code);
  for(const field of ['iconApi','icon','iconImage'])assert.ok(row.includes('`'+field+'`'),field);
  assert.match(row,/all three[\s\S]*or none/);
  assert.ok(row.includes('[v2 icon rules](MANIFESTS.md#v2-icon-rules)'));
  assert.doesNotMatch(rows.find(line=>line.startsWith('| `Skill request failed: invalid_app_manifest` |')),/iconApi|iconImage/);
});
test('sound and camera recipes avoid ambiguous global aliases and ignored wrapper options',()=>{
  for(const page of ['docs/skills/SDK.md','docs/skills/COOKBOOK.md']) {
    const sounds=[...content[page].matchAll(/jibo\.loader\.load\(\{([\s\S]*?)\},/g)];
    assert.ok(sounds.length);for(const sound of sounds)assert.match(sound[1],/id: context\.appId \+ '-chime'/);
  }
  const camera=content['docs/skills/SDK.md'].match(/jibo\.media\.takePhoto\(\{([\s\S]*?)\},/);
  assert.ok(camera);assert.doesNotMatch(camera[1],/\bstore\s*:/);
});
test('starter coverage, physical approval and native trust boundaries stay explicit',()=>{
  const all=Object.values(content).join('\n');
  for(const template of ['hello','touch-ui','voice','network-service'])assert.ok(content['docs/skills/WORKFLOW.md'].includes('--template '+template));
  assert.ok(content['docs/skills/WORKFLOW.md'].includes('node tools/skill-kit/cli.mjs new my-hello\n'),'hello is the default starter');
  for(const required of ['Install full-access test','Remove test build','Allow test builds','full access','they do not limit the code','local v1 does not register','dataRoot','resourcesReleased'])assert.ok(all.replace(/\s+/g,' ').toLowerCase().includes(required.toLowerCase()),required);
  assert.ok((content['docs/skills/COOKBOOK.md'].match(/^## \d+\./gm)||[]).length>=10);
  for(const path of pages)assert.doesNotMatch(content[path],/(?<!\/opt)\/home\/|192\.168\.\d|\/wave-\d|\/tmp\/|\/dev\/shm\//);
});
