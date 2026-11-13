#!/usr/bin/env node
import {mkdirSync,existsSync,writeFileSync,renameSync,rmSync,lstatSync,realpathSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {run as ssh,DEFAULTS,parseArgs as parseSsh} from './ssh.mjs';
import {scaffold,TEMPLATES} from './new.mjs';
import {checkProject,packProject,loadProject,readRegular} from './project.mjs';
import {hash,parse,fail} from './format.mjs';
import {requireNativeSchema} from './native-icons.mjs';
const COMMON=['robot','be-root','node','state-root'];
const ALLOW_INSTRUCTION='Allow test builds is off on Jibo; on Jibo open Settings > Developer testing, turn on Allow test builds and confirm with a tap, then run the command again.';
const OPTIONS={new:['template','kind'],check:['syntax-node'],pack:['out','syntax-node'],install:[...COMMON,'timeout','syntax-node'],info:COMMON,status:[...COMMON,'request','list'],remove:[...COMMON,'keep-data','erase-data','timeout']};
const FLAGS=['keep-data','erase-data','list'];
export const HELP=`Jibo skill kit (Node 20+, no npm install)
  new <name> [--template hello|touch-ui|voice|network-service]
  check <project-or-pack>
  pack <project> --out <directory>
  info --robot <SSH alias>
  install <project> --robot <SSH alias> [--timeout <seconds>]
  status [<project>] --robot <SSH alias> [--request <id> | --list]
  remove <project> --robot <SSH alias> --keep-data|--erase-data
Remote path overrides: --be-root <path> --node <path> --state-root <path>
Exact Jibo syntax check: --syntax-node <local Node 6.5.0 executable>
  (optional on check, pack and install; compiles without evaluating skill code)
install sends a test build to your own Jibo over SSH.
No approve or enable command exists. Confirm on Jibo’s screen.
`;
export function argumentsFor(argv) {
  const command=argv[0]; if(!Object.hasOwn(OPTIONS,command))fail('unknown_command');
  const options={},pos=[];
  for(let i=1;i<argv.length;i++) {
    const item=argv[i];
    if(!item.startsWith('--')) {pos.push(item);continue;}
    const key=item.slice(2);if(!OPTIONS[command].includes(key)||Object.hasOwn(options,key))fail('invalid_option');
    if(FLAGS.includes(key))options[key]=true;else {const value=argv[++i];if(!value||value.startsWith('--')||/[\x00-\x1f\x7f]/.test(value))fail('invalid_option_value');options[key]=value;}
  }
  const count=['info'].includes(command)?0:command==='status'?null:1;
  if(pos.length>1||(count!==null&&pos.length!==count))fail('invalid_arguments');
  if(COMMON.some(k=>OPTIONS[command].includes(k))) {
    // Validate the entire connection before writing state or invoking SSH.
    parseSsh(['info',...COMMON.filter(k=>options[k]!==undefined).flatMap(k=>['--'+k,options[k]])]);
  }
  if(command==='new') {
    // Every project is the same kind. Older scripts may still pass --kind native.
    if(options.kind!==undefined&&(options.kind!=='native'||options.template))fail('invalid_option');
    if(options.template&&!TEMPLATES.includes(options.template))fail('unknown_template');
  }
  if(command==='pack'&&!options.out)fail('missing_out');
  if(command==='status'&&((options.list&&options.request)||(!pos.length&&!options.list&&!options.request)))fail('choose_request_or_list');
  if(command==='remove'&&!!options['keep-data']===!!options['erase-data'])fail('choose_keep_or_erase_data');
  if(options.timeout!==undefined&&(!/^[1-9][0-9]*$/.test(options.timeout)||Number(options.timeout)>3600))fail('invalid_timeout');
  return {command,options,target:pos[0]};
}
function connection(o) {return COMMON.filter(k=>o[k]!==undefined).flatMap(k=>['--'+k,o[k]]);}
function stateFile(target,o) {
  const {dir}=loadProject(target),folder=join(dir,'.skill-kit');
  if(!existsSync(folder))mkdirSync(folder,{mode:0o700});
  if(lstatSync(folder).isSymbolicLink()||!lstatSync(folder).isDirectory()||realpathSync(folder)!==folder)fail('invalid_local_state');
  const key=hash(JSON.stringify([o.robot,...['be-root','node','state-root'].map(k=>o[k]||DEFAULTS[k])]));
  return join(folder,key+'.json');
}
function readState(file) {return existsSync(file)?parse(readRegular(file,65536)):{};}
function save(file,state) {
  const tmp=file+'.'+randomUUID();writeFileSync(tmp,JSON.stringify(state),{flag:'wx',mode:0o600});
  try {renameSync(tmp,file);}finally {rmSync(tmp,{force:true});}
}
async function poll(initial,remote,o,deps,print,button='Install full-access test') {
  if(!initial||!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(initial.requestId||''))fail('invalid_robot_response');
  const now=deps.now||Date.now,sleep=deps.sleep||delay,deadline=now()+Number(o.timeout||600)*1000;
  let result=initial,last='',prompted=false;
  for(;;) {
    const state=result.state||result.status;
    const waitingNative=result.kind==='native'&&['installed','resumed'].includes(state)&&result.runtimeState==='pending_restart';
    const progress=waitingNative?result.runtimeState:state;
    if(button==='Install full-access test'&&state==='queued'&&result.blockedReason==='test_builds_disabled') {
      // The owner may switch Allow off after preflight. Do not cancel durable work.
      const cancel=['node','tools/skill-kit/ssh.mjs','cancel',...connection(o),'--request',result.requestId]
        .map(arg=>/^[a-zA-Z0-9_./:@=-]+$/.test(arg)?arg:"'"+arg.replaceAll("'","'\\''")+"'").join(' ');
      throw Object.assign(new Error('test_builds_disabled'),{code:'test_builds_disabled',requestId:result.requestId,
        ownerMessage:ALLOW_INSTRUCTION+'\nThe request stays on Jibo until Allow is on (it is cancelled if Jibo restarts).\nTo cancel it with the kit, run: '+cancel});
    }
    if(!prompted&&!['installed','resumed','removed'].includes(state)) {print('Tap '+button+' on Jibo');prompted=true;}
    if(progress!==last) {print(`Request ${result.requestId}: ${progress}${result.blockedReason?' ('+result.blockedReason+')':''}`);last=progress;}
    // The robot commits the approval before its native restart/health trial.
    // Follow the same durable request across that trial rather than reporting
    // success for accepted bytes which have never run.
    if(['installed','resumed','removed'].includes(state)&&!waitingNative)return result;
    if(['failed','canceled','declined','expired'].includes(state)) {
      const code=result.blockedReason||result.errorCode||'test_request_'+state,name=result.collisionName;
      const ownerMessage=state==='failed'&&['test_native_collision','test_identity_collision'].includes(code)
        &&typeof name==='string'&&name.trim()&&name.length<=120&&!/[\p{C}\p{Zl}\p{Zp}]/u.test(name)
        ? `Remove “${name}” first, then try again.` : undefined;
      throw Object.assign(new Error(code),{code,requestId:result.requestId,ownerMessage,terminalState:state});
    }
    if(!waitingNative&&!['queued','pending_robot_approval','staging','waiting','restarting','pending_restart','restart_pending'].includes(state))fail('unknown_robot_state');
    if(now()>=deadline)throw Object.assign(new Error('approval_timeout'),{code:'approval_timeout',requestId:result.requestId});
    await sleep(Math.min(3000,Math.max(1,deadline-now())));
    try {
      result=await remote(['status','--request',initial.requestId]);
    } catch(error) {
      if(!['ssh_or_robot_failed','ssh_timeout','ssh_stream_failed','test_manager_unavailable','unsupported_firmware'].includes(error.code))throw error;
      print('Waiting for Jibo to reconnect; request '+initial.requestId+' is still being checked');
      continue;
    }
    if(!result||result.requestId!==initial.requestId)fail('invalid_robot_response');
  }
}
export async function run(argv,deps={}) {
  if(!argv.length||['--help','help','-h'].includes(argv[0]))return {help:HELP};
  const {command,options:o,target}=argumentsFor(argv),print=deps.print||(()=>{});
  if(command==='new')return scaffold(target,o.template||'hello');
  if(command==='check')return {...checkProject(resolve(target),o['syntax-node']),notice:'Structure checked without running code. Robot validation and physical approval are still required.'};
  if(command==='pack')return packProject(resolve(target),o.out,undefined,o['syntax-node']);
  const remote=args=>(deps.ssh||ssh)([args[0],...connection(o),...args.slice(1)],deps);
  if(command==='info')return remote(['info']);
  if(command==='status'&&(o.list||o.request))return remote(['status',...(o.list?['--list']:['--request',o.request])]);
  if(command==='install') {
    const checked=checkProject(resolve(target),o['syntax-node']);
    const {config}=loadProject(target),info=await remote(['info']);
    if(!info||!Array.isArray(info.localKinds))fail('invalid_robot_response');
    if(!info.localKinds.includes(config.kind))
      throw Object.assign(new Error("This Jibo can't install skill test builds: its info has no native in localKinds. Check that Jibo runs its current software."),{code:'unsupported_kind'});
    requireNativeSchema(info,checked.nativeSchema);
    if(info.allowTestBuilds===false)throw Object.assign(new Error('test_builds_disabled'),{code:'test_builds_disabled',ownerMessage:ALLOW_INSTRUCTION});
  }
  const {config}=loadProject(target),file=stateFile(target,o),s=readState(file);
  if(command==='status') {if(!s.requestId)fail('no_saved_request');return remote(['status','--request',s.requestId]);}
  if(command==='remove') {
    if(!s.project)fail('no_saved_project');
    const choice=o['erase-data']?'--erase-data':'--keep-data';
    if(!s.remove||s.remove.choice!==choice||s.remove.done)s.remove={choice,clientRequestId:randomUUID()};
    save(file,s);
    const result=await remote(['remove','--project',s.project.projectId,choice,'--client-request-id',s.remove.clientRequestId]);
    s.requestId=result.requestId;save(file,s);
    const final=await poll(result,remote,o,deps,print,'Remove test build');s.remove.done=true;delete s.install;save(file,s);return final;
  }
  if(!s.project) {
    s.projectRequestId ||= randomUUID();save(file,s);
    s.project=await remote(['project','--kind',config.kind,'--name',config.name,'--client-request-id',s.projectRequestId]);
    if(!/^local-project-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(s.project.projectId||'')||!/^app-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(s.project.appId||'')||s.project.kind!==config.kind)fail('invalid_robot_response');
    save(file,s);
  }
  if(s.project.kind!==config.kind)fail('project_kind_changed');
  const out=join(resolve(target),'.skill-kit','build-'+randomUUID());
  let packed;
  try {
    packed=packProject(resolve(target),out,s.project.appId,o['syntax-node']);
    if(!s.install||s.install.sha256!==packed.sha256)s.install={sha256:packed.sha256,clientRequestId:randomUUID()};
    save(file,s);
    print('Checking the packed skill on Jibo');
    await remote(['check','--project',s.project.projectId,'--file',packed.file]);
    const result=await remote(['queue','--project',s.project.projectId,'--file',packed.file,'--client-request-id',s.install.clientRequestId]);
    s.requestId=result.requestId;save(file,s);
    try {return await poll(result,remote,o,deps,print);}
    catch(error) {
      // Preserve identity for transport/timeout ambiguity. Only a confirmed
      // terminal refusal retires this attempt; the user's next install then
      // queues a new physical approval even when the bytes have not changed.
      if(['failed','canceled','declined','expired'].includes(error.terminalState)) {delete s.install;save(file,s);}
      throw error;
    }
  } finally {rmSync(out,{recursive:true,force:true});}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  run(process.argv.slice(2),{print:line=>process.stderr.write(line+'\n'),stderr:process.stderr}).then(result=>{
    if(result.help)process.stdout.write(result.help);else process.stdout.write(JSON.stringify({ok:true,result},null,2)+'\n');
  },error=>{if(error.ownerMessage)process.stderr.write(error.ownerMessage+'\n');process.stderr.write('Skill request failed: '+(error.code||'host_io_error')+(error.requestId?' (request '+error.requestId+')':'')+'\n');if(error.code==='unsupported_kind'&&error.message!==error.code)process.stderr.write(error.message+'\n');process.exitCode=1;});
}
