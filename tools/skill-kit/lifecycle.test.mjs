import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {EventEmitter} from 'node:events';
import {runInNewContext} from 'node:vm';
import {scaffold} from './new.mjs';
function event(){const set=new Set();return {on:fn=>set.add(fn),off:fn=>set.delete(fn),emit:()=>[...set].forEach(fn=>fn()),size:()=>set.size};}
function fixture(defer=false,template='hello') {
  const base=mkdtempSync(join(tmpdir(),'skill-life-')),dir=scaffold('hello',template,base).directory;
  const heard=event(),touch=event(),process=event(),active=new Set(),launchers=[],lines=[];let pending;
  const engine={active:null,unresolved:new Set()};
  const speech={speak(text){lines.push(text);engine.active={};return Promise.resolve().then(()=>{engine.active=null;return 'SUCCEEDED';});},stop(){engine.active=null;return Promise.resolve();}};
  const views={events:{process},_viewProcess:{active:false},ActionData:{CALLBACK:'callback'},GESTURE:{SWIPE_DOWN:'swipe'},TRANSITION:{IN:'in',OUT:'out',NONE:'none'},
    createView(type,config){const parts=new Map(config.componentConfigs.map(c=>[c.id,{...c,display:{addChild(){}},text:c.text}]));return {state:'loaded',inputLocked:false,addAction(type,data){this.swipe=data.callback;},getComponentById:id=>parts.get(id)};},
    changeView(options,done,fail,loaded){if(options.addView){const view=options.addView;this.currentView=view;if(loaded)loaded();const open=()=>{view.state='opened';this._viewProcess.active=false;done();process.emit();};if(defer){this._viewProcess.active=true;pending=open;}else open();}else{this.currentView.state='destroyed';this.currentView=null;done();}}
  };
  class BeSkill extends EventEmitter {constructor(config){super();this.config=config;}exit(){this.emit('exit');}destroy(done){done();}}
  const be={skills:{},redirect(data){this.currentSkill=data.skill;data.skill.open();},exit(skill){skill.close(()=>{});}};
  function owned(dispose){const h={remove(){active.delete(h);dispose();}};active.add(h);return h;}
  const lease=()=>({acquire:()=>owned(()=>{})});
  const context={appRoot:dir,services:{be,Be:{BeSkill,SkillSwitchData:class {constructor(skill){this.skill=skill;}}},jibo:{face:{views},jetstream:{events:{hjHeard:heard}},system:{events:{touchOn:touch}},embodied:{speech,_embodied:{speech:engine},listen:{getActiveMode:()=>null}},tts:{isTalking:false}}},
    hooks:{on(emitter,name,fn){emitter.on(name,fn);return owned(()=>emitter.removeListener(name,fn));}},attention:lease(),speech:lease(),launchers:{register(entry){launchers.push(entry);return owned(()=>launchers.splice(launchers.indexOf(entry),1));}}};
  const cache={};function load(file){if(file.endsWith('.json'))return JSON.parse(readFileSync(join(dir,file)));if(cache[file])return cache[file].exports;const module={exports:{}};cache[file]=module;
    runInNewContext(readFileSync(join(dir,file),'utf8'),{module,exports:module.exports,Promise,global:{PIXI:{Graphics:class{beginFill(){}drawRect(){}endFill(){}}}},require(name){if(name==='timers')return {setTimeout,clearTimeout};if(name==='./app.json')return load('app.json');if(name==='./hello')return load('hello.js');if(name==='./voice-input')return load('voice-input.js');throw Error('unexpected import '+name);}});return module.exports;}
  const app=load('entry.js').create(context);
  return {app,be,views,launchers,lines,heard,touch,active,jibo:context.services.jibo,finishOpen:()=>pending(),cleanup:()=>rmSync(base,{recursive:true,force:true})};
}
test('native starter registers home launcher, speaks, responds to tap and releases every resource on stop',async()=>{
  const f=fixture();try{
    f.app.prepareBeforeInit();f.app.startAfterInit();f.app.registerLaunchers();assert.equal(f.launchers.length,1);
    f.launchers[0].open();await new Promise(resolve=>setImmediate(resolve));assert.equal(f.lines[0],'Hello from your own skill!');
    const view=f.views.currentView;view.getComponentById('hello').action.data.callback();await Promise.resolve();
    assert.equal(view.getComponentById('title').text,'You tapped!');assert.equal(f.lines[1],'Hello again!');
    const released=await f.app.stop();assert.equal(released.resourcesReleased,true);assert.equal(view.state,'destroyed');assert.equal(f.active.size,0);assert.equal(f.heard.size(),0);assert.equal(f.touch.size(),0);assert.equal(Object.keys(f.be.skills).length,0);
  }finally{f.cleanup();}
});
test('native stop while opening waits for transition and never speaks after stop',async()=>{
  const f=fixture(true);try{
    f.app.prepareBeforeInit();f.app.startAfterInit();f.app.registerLaunchers();f.launchers[0].open();
    const stop=f.app.stop();await Promise.resolve();f.finishOpen();await stop;assert.equal(f.lines.length,0);assert.equal(f.views.currentView,null);assert.equal(f.active.size,0);
  }finally{f.cleanup();}
});
test('native head touch exits and closes the owned screen',async()=>{
  const f=fixture();try{f.app.prepareBeforeInit();f.app.startAfterInit();f.app.registerLaunchers();f.launchers[0].open();await Promise.resolve();f.touch.emit();await Promise.resolve();await Promise.resolve();await f.app.stop();assert.equal(f.views.currentView,null);assert.equal(f.active.size,0);}finally{f.cleanup();}
});

test('touch template changes screens, counts, returns and closes all resources',async()=>{
  const f=fixture(false,'touch-ui');try{
    f.app.prepareBeforeInit();f.app.startAfterInit();f.app.registerLaunchers();f.launchers[0].open();await new Promise(resolve=>setImmediate(resolve));
    const view=f.views.currentView,tap=id=>view.getComponentById(id).action.data.callback();
    tap('hello');assert.equal(view.getComponentById('title').text,'Count: 0');
    tap('hello');assert.equal(view.getComponentById('title').text,'Count: 1');
    tap('back');assert.equal(view.getComponentById('title').text,'Touch demo');
    assert.equal(view.getComponentById('tap-label').text,'Next');
    await f.app.stop();assert.equal(f.active.size,0);assert.equal(f.views.currentView,null);
  }finally{f.cleanup();}
});
for (const template of ['hello','touch-ui','voice']) {
  test(`${template} refuses a disabled renderer before acquiring focus`,async()=>{
    const f=fixture(false,template);
    try {
      f.app.prepareBeforeInit();f.app.startAfterInit();f.app.registerLaunchers();
      f.views.disabled=true;
      assert.equal(f.launchers[0].open(),'native_view_unavailable');
      assert.equal(f.views.currentView,undefined);assert.equal(f.active.size,4);
    } finally {await f.app.stop();f.cleanup();}
  });
  test(`${template} repeated stop returns the same completion barrier`,async()=>{
    const f=fixture(false,template);
    try {
      f.app.prepareBeforeInit();f.app.startAfterInit();f.app.registerLaunchers();f.launchers[0].open();
      const first=f.app.stop(),second=f.app.stop();
      assert.equal(first,second);await first;assert.equal(f.active.size,0);
    } finally {await f.app.stop();f.cleanup();}
  });
  test(`${template} failed opening exits before readiness and releases focus`,async()=>{
    const f=fixture(false,template);
    try {
      const change=f.views.changeView.bind(f.views);let exits=0;
      const exit=f.be.exit;f.be.exit=skill=>{exits++;return exit(skill);};
      f.views.changeView=(options,done,fail,loaded)=>{
        if(options.addView){f.views.currentView=options.addView;fail();}else change(options,done,fail,loaded);
      };
      f.app.prepareBeforeInit();f.app.startAfterInit();f.app.registerLaunchers();f.launchers[0].open();
      await new Promise(resolve=>setImmediate(resolve));
      assert.equal(exits,1,'failed opening must request BE exit, even before ready');
      assert.equal(f.views.currentView,null);assert.equal(f.lines.length,0);
      assert.equal(f.active.size,4,'only registry hooks and launcher remain after close');
    } finally {await f.app.stop();f.cleanup();}
  });
  test(`${template} ignores loaded callback after its view has closed`,async()=>{
    const f=fixture(false,template);
    try {
      const change=f.views.changeView.bind(f.views);let late;
      f.views.changeView=(options,done,fail,loaded)=>{
        if(options.addView)late=loaded;
        return change(options,done,fail,loaded);
      };
      f.app.prepareBeforeInit();f.app.startAfterInit();f.app.registerLaunchers();f.launchers[0].open();
      await new Promise(resolve=>setImmediate(resolve));
      const view=f.views.currentView;await f.app.stop();
      view.getComponentById=()=>assert.fail('late callback touched destroyed view');
      late();assert.equal(f.views.currentView,null);
    } finally {await f.app.stop();f.cleanup();}
  });
}
test('voice screen speaks ESML, listens after prompt, shows result and stops cleanly',async()=>{
  const f=fixture(false,'voice');try{
    f.jibo.jetstream.startLocalTurn=()=>Promise.resolve({status:'FINISHED',promise:Promise.resolve({status:'SUCCEEDED',result:{asr:{text:'hello'}}})});
    f.app.prepareBeforeInit();f.app.startAfterInit();f.app.registerLaunchers();f.launchers[0].open();await new Promise(resolve=>setImmediate(resolve));
    assert.match(f.lines[0],/<break size=/);
    const view=f.views.currentView;view.getComponentById('hello').action.data.callback();await new Promise(resolve=>setImmediate(resolve));
    assert.equal(f.lines[1],'Say hello.');assert.equal(view.getComponentById('title').text,'Hello to you too!');
    await f.app.stop();assert.equal(f.active.size,0);assert.equal(f.views.currentView,null);
  }finally{f.cleanup();}
});
