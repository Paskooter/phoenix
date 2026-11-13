import {randomUUID} from 'node:crypto';
import {mkdirSync,copyFileSync,writeFileSync,readFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {fail} from './format.mjs';
// Every starter is the same kind of project: a JavaScript skill for Jibo.
export const TEMPLATES=Object.freeze(['hello','touch-ui','voice','network-service']);
export function scaffold(name,template='hello',cwd=process.cwd()) {
  if(!/^[a-z][a-z0-9-]{0,39}$/.test(name))fail('invalid_name');
  if(!TEMPLATES.includes(template))fail('unknown_template');
  const root=new URL('templates/'+template+'/',import.meta.url);
  const config=JSON.parse(readFileSync(new URL('skill.json',root)));
  config.name=name;
  const dir=resolve(cwd,name),appId='app-'+randomUUID();mkdirSync(dir,{mode:0o700});
  function json(file,v){writeFileSync(join(dir,file),JSON.stringify(v,null,2)+'\n',{flag:'wx'});}
  const app=JSON.parse(readFileSync(new URL('app.json',root)));
  app.appId=appId;app.name='@local/'+name+'-'+randomUUID();app.skills=(app.skills||[]).map(()=>app.name);json('app.json',app);
  for(const file of config.files.filter(f=>f!=='app.json'))copyFileSync(fileURLToPath(new URL(file,root)),join(dir,file));
  json('skill.json',config);
  writeFileSync(join(dir,'.gitignore'),'.skill-kit/\nout/\n');
  const readme=readFileSync(new URL('README.md',root),'utf8').replaceAll('{{project}}',name);
  writeFileSync(join(dir,'README.md'),'# '+name+'\n\n'+readme);
  return {directory:dir,kind:'native',appId,template};
}
