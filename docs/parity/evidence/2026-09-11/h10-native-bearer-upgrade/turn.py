#!/usr/bin/env python3
"""Observe a native Jetstream transaction and the original BE on a real robot.

No cloud message or response is synthesized. --text uses Jetstream's documented
clientASR injection API and does NOT certify microphone recognition.
"""
import argparse
import asyncio
import datetime
import json
from pathlib import Path
import time
import urllib.request
import websockets
from cdp import evaluate, screenshot


VISUAL_START = '''(function(){
if(window.__phxVisual)throw new Error('Another visual probe is installed');
var probe={calls:[],restore:[]},listen=jibo.embodied._embodied.listen;
window.__phxVisual=probe;
function wrap(target,key){
 var original=target[key];if(typeof original!=='function')return;
 var wrapper=function(){
  if(probe.calls.length<500)probe.calls.push({at:Date.now(),method:key,
   value:key==='setLEDColor'?Array.prototype.slice.call(arguments,0,3):arguments[0]});
  return original.apply(this,arguments);
 };
 target[key]=wrapper;
 probe.restore.push(function(){if(target[key]!==wrapper)throw new Error('Probe wrapper changed: '+key);target[key]=original;});
}
wrap(jibo.expression,'setLEDColor');wrap(listen,'_addAnimToQueue');
return true;
})()'''

VISUAL_FINISH = '''(function(){
var p=window.__phxVisual;if(!p)return null;
var result={calls:p.calls,listen:jibo.embodied._embodied.listen.current.name,
 proactiveInitialized:!!(jibo.action&&jibo.action._runtime&&jibo.action._runtime.proactive)};
p.restore.forEach(function(f){f();});delete window.__phxVisual;
return result;
})()'''

FOLLOWUP_START = '''(function(){
if(window.__phxFollowup)throw new Error('Another follow-up probe is installed');
var p={calls:[],used:false,original:jibo.jetstream.startLocalTurn,timer:null};
window.__phxFollowup=p;
p.wrapper=function(options){
 var eligible=be.currentSkill&&be.currentSkill.assetPack===TARGET_SKILL&&
  options.nluRules&&options.nluRules.indexOf(TARGET_RULE)>=0&&!p.used;
 var result=p.original.apply(this,arguments);
 if(eligible){p.used=true;result.then(function(r){
  var entry={at:Date.now(),requestID:r.id,rules:options.nluRules,text:FOLLOWUP_TEXT};p.calls.push(entry);
  p.timer=setTimeout(function(){entry.statusBeforeUpdate=r.status;
   if(r.status!=='ACTIVE'){entry.skipped=true;return;}
   r.update(FOLLOWUP_TEXT).then(function(){entry.updateCompleted=true;},function(e){entry.error=String(e);});
  },350);
 },function(e){p.calls.push({error:String(e)});});}
 return result;
};
jibo.jetstream.startLocalTurn=p.wrapper;return true;
})()'''

FOLLOWUP_FINISH = '''(function(){
var p=window.__phxFollowup;if(!p)return null;
clearTimeout(p.timer);
if(jibo.jetstream.startLocalTurn!==p.wrapper)throw new Error('Follow-up wrapper changed');
jibo.jetstream.startLocalTurn=p.original;delete window.__phxFollowup;
return {calls:p.calls,used:p.used,restored:true};
})()'''


SNAPSHOT = '''(function(){
var skill=be.currentSkill,pack=skill&&skill.assetPack;
return {skill:typeof pack==='string'?pack:pack&&{name:pack.name,rootPath:pack.rootPath},
talking:!!jibo.tts.isTalking,view:jibo.face&&jibo.face.views&&jibo.face.views.currentView&&jibo.face.views.currentView.id,
listen:jibo.embodied&&jibo.embodied._embodied&&jibo.embodied._embodied.listen&&jibo.embodied._embodied.listen.current&&jibo.embodied._embodied.listen.current.name};
})()'''


async def run(args):
    events, snapshots = [], []
    start = time.monotonic()
    report = {'started': datetime.datetime.now(datetime.timezone.utc).isoformat(),
              'robot': 'moth-radius-breazeal-felt.jibo', 'mode': args.mode,
              'input': 'passive native microphone observation' if args.observe_only else ('native clientASR text injection' if args.text is not None else 'native microphone capture'),
              'text': args.text, 'microphoneAcceptance': False, 'events': events, 'snapshots': snapshots}
    async with websockets.connect('ws://127.0.0.1:%d/events' % args.native_port,
                                  max_size=2 * 1024 * 1024, ping_interval=None) as ws:
        async def receive():
            async for data in ws:
                if len(events) >= 2000:
                    raise RuntimeError('Native event limit reached')
                events.append({'elapsedMs': round((time.monotonic()-start)*1000), 'event': json.loads(data)})

        async def observe():
            previous = None
            views = set()
            current_view, view_since = None, time.monotonic()
            while True:
                result = await evaluate(args.cdp_port, args.slot, SNAPSHOT)
                value = result['result'].get('value')
                if value != previous:
                    snapshots.append({'elapsedMs': round((time.monotonic()-start)*1000), 'be': value})
                    previous = value
                if value and value.get('view') != current_view:
                    current_view, view_since = value.get('view'), time.monotonic()
                if (args.screenshots and value and value.get('view') not in views
                        and time.monotonic() - view_since >= args.screenshot_delay):
                    views.add(value.get('view'))
                    out = args.out.with_name(args.out.stem + '-view-%d.png' % len(views))
                    snapshots.append({'elapsedMs': round((time.monotonic()-start)*1000),
                                      'stableView': current_view,
                                      'capture': await screenshot(args.cdp_port, args.slot, out)})
                await asyncio.sleep(0.2)

        readers = [asyncio.create_task(receive())]
        visual_installed = False
        followup_installed = False
        try:
            if args.followup_text is not None:
                expression = FOLLOWUP_START.replace('TARGET_SKILL', json.dumps(args.followup_skill))
                expression = expression.replace('TARGET_RULE', json.dumps(args.followup_rule))
                expression = expression.replace('FOLLOWUP_TEXT', json.dumps(args.followup_text))
                await evaluate(args.cdp_port, args.slot, expression)
                followup_installed = True
            if args.visuals:
                await evaluate(args.cdp_port, args.slot, VISUAL_START)
                visual_installed = True
            initial = await evaluate(args.cdp_port, args.slot, SNAPSHOT)
            snapshots.append({'elapsedMs': round((time.monotonic()-start)*1000), 'be': initial['result'].get('value')})
            if not args.observe_only:
                options = {'clientASR': args.text} if args.text is not None else {
                    'nluRules': ['launch'], 'sosTimeout': 5, 'maxSpeechTimeout': 12}
                endpoint = '/listen/mimic_global_turn' if args.mode == 'global' else '/listen/start_local_turn'
                if args.mode == 'local':
                    options.setdefault('nluRules', ['launch'])
                # The SDK must create its Request object for a local turn. A direct
                # HTTP POST leaves its request registry empty, so TURN_STARTED can
                # be misclassified as global and omit the embodied listening cue.
                method = 'mimicGlobalTurn' if args.mode == 'global' else 'startLocalTurn'
                expression = '''(function(){window.__phxTurn={};jibo.jetstream.METHOD(OPTIONS).then(function(r){
                    window.__phxTurn.ack={requestID:r.id};
                    if(r.promise)r.promise.then(function(v){window.__phxTurn.result=v;},function(e){window.__phxTurn.error=String(e);});
                    },function(e){window.__phxTurn.error=String(e);});return true;})()'''
                expression = expression.replace('METHOD', method).replace('OPTIONS', json.dumps(options))
                await evaluate(args.cdp_port, args.slot, expression)
                for _ in range(40):
                    ack = await evaluate(args.cdp_port, args.slot, 'window.__phxTurn')
                    value = ack['result'].get('value', {})
                    if value.get('error'):
                        raise RuntimeError(value['error'])
                    if value.get('ack'):
                        report['ack'] = value['ack']
                        break
                    await asyncio.sleep(0.1)
                else:
                    raise RuntimeError('Native SDK request acknowledgement timed out')
                report['request'] = {'endpoint': endpoint, 'body': options, 'via': 'original BE Jetstream SDK'}
            readers.append(asyncio.create_task(observe()))
            await asyncio.sleep(args.duration)
            for reader in readers:
                if reader.done():
                    reader.result()
        finally:
            for reader in readers:
                reader.cancel()
            await asyncio.gather(*readers, return_exceptions=True)
            if followup_installed:
                try:
                    value = await evaluate(args.cdp_port, args.slot, FOLLOWUP_FINISH)
                    report['followup'] = value['result'].get('value')
                except Exception as error:
                    report['followupProbeCleanupError'] = str(error)
            if visual_installed:
                try:
                    value = await evaluate(args.cdp_port, args.slot, VISUAL_FINISH)
                    report['visuals'] = value['result'].get('value')
                except Exception as error:
                    report['visualProbeCleanupError'] = str(error)
            report['durationMs'] = round((time.monotonic()-start)*1000)
            args.out.parent.mkdir(parents=True, exist_ok=True)
            args.out.write_text(json.dumps(report, indent=2)+'\n')
    print(json.dumps(report, indent=2))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--native-port', type=int, default=18090)
    parser.add_argument('--cdp-port', type=int, default=19223)
    parser.add_argument('--slot', default='phoenix-be12-parity')
    parser.add_argument('--mode', choices=['global', 'local'], default='global')
    parser.add_argument('--text')
    parser.add_argument('--duration', type=float, default=15)
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--screenshots', action='store_true')
    parser.add_argument('--screenshot-delay', type=float, default=1.8, help='Seconds of stable view before capture')
    parser.add_argument('--observe-only', action='store_true', help='Observe real user turns without initiating a request')
    parser.add_argument('--followup-text', help='Use original LocalTurnRequest.update once for a scoped follow-up')
    parser.add_argument('--followup-skill')
    parser.add_argument('--followup-rule')
    parser.add_argument('--visuals', action='store_true',
                        help='Observe original LED/animation calls with temporary forwarding wrappers')
    args = parser.parse_args()
    if args.followup_text is not None and not (args.followup_skill and args.followup_rule):
        parser.error('--followup-text requires both --followup-skill and --followup-rule')
    if not 0 <= args.screenshot_delay <= 5:
        parser.error('--screenshot-delay must be 0..5 seconds')
    if args.observe_only and args.text is not None:
        parser.error('--observe-only cannot inject text')
    if not 1 <= args.duration <= (180 if args.observe_only else 45):
        parser.error('duration must be 1..45 seconds, or up to 180 for passive observation')
    asyncio.run(run(args))


if __name__ == '__main__':
    main()
