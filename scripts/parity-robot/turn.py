#!/usr/bin/env python3
"""Observe a native Jetstream transaction and the original BE on a real robot.

No cloud message or response is synthesized. --text uses Jetstream's documented
clientASR injection API and does NOT certify microphone recognition.
"""
import argparse
import asyncio
import datetime
import hashlib
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
var skill=be.currentSkill,pack=skill&&skill.assetPack,
 currentView=jibo.face&&jibo.face.views&&jibo.face.views.currentView,
 tracker=window.__phxViewInstanceTracker;
if(!tracker){tracker={next:0,weak:typeof WeakMap==='function'?new WeakMap():null,objects:[],tokens:[]};window.__phxViewInstanceTracker=tracker;}
var viewInstance=null;
if(currentView&&typeof currentView==='object'){
 if(tracker.weak){viewInstance=tracker.weak.get(currentView);
  if(!viewInstance){viewInstance='view-'+(++tracker.next);tracker.weak.set(currentView,viewInstance);}
 }else{var index=-1;for(var i=0;i<tracker.objects.length;i++)if(tracker.objects[i]===currentView){index=i;break;}
  if(index<0){viewInstance='view-'+(++tracker.next);tracker.objects.push(currentView);tracker.tokens.push(viewInstance);}
  else viewInstance=tracker.tokens[index];
 }
}
return {skill:typeof pack==='string'?pack:pack&&{name:pack.name,rootPath:pack.rootPath},
talking:!!jibo.tts.isTalking,view:currentView&&currentView.id,viewInstance:viewInstance,
listen:jibo.embodied&&jibo.embodied._embodied&&jibo.embodied._embodied.listen&&jibo.embodied._embodied.listen.current&&jibo.embodied._embodied.listen.current.name};
})()'''

VIEW_INSTANCE_FINISH = '''(function(){
if(window.__phxViewInstanceTracker)delete window.__phxViewInstanceTracker;
return true;
})()'''


class CaptureError(RuntimeError):
    """Raised when a requested display capture cannot be correlated safely."""


def _walk_json(value, path=()):
    """Yield JSON nodes in source order with their paths."""
    if isinstance(value, dict):
        yield path, value
        for key, child in value.items():
            for item in _walk_json(child, path + (key,)):
                yield item
    elif isinstance(value, list):
        for index, child in enumerate(value):
            for item in _walk_json(child, path + (index,)):
                yield item


def _display_view_config(display):
    """Return a DISPLAY's resolved viewConfig, if its shape is valid."""
    view = display.get('view')
    context = view.get('context') if isinstance(view, dict) else None
    data = context.get('data') if isinstance(context, dict) else None
    if isinstance(data, dict) and isinstance(data.get('viewConfig'), dict):
        return data['viewConfig']
    return None


def _display_actions_from_event(row, event_index, strict=True):
    """Extract ordered DISPLAY actions from one native event row.

    Native Jetstream reports place the action tree under ``event.data.action``.
    The complete action tree is retained in ``events``; this small projection
    supplies stable paths/IDs for screenshot correlation without rewriting it.
    """
    event = row.get('event') if isinstance(row, dict) else None
    if not isinstance(event, dict):
        event = row if isinstance(row, dict) else None
    if not isinstance(event, dict) or event.get('type') != 'SKILL_ACTION':
        return []
    data = event.get('data')
    action = data.get('action') if isinstance(data, dict) else None
    if not isinstance(action, dict):
        return []

    jcp = action.get('config', {}).get('jcp') if isinstance(action.get('config'), dict) else None
    jcp_id = jcp.get('id') if isinstance(jcp, dict) else None
    found = []
    for path, node in _walk_json(action, ('data', 'action')):
        if not isinstance(node, dict) or node.get('type') != 'DISPLAY':
            continue
        view_config = _display_view_config(node)
        view_id = view_config.get('id') if isinstance(view_config, dict) else None
        if not isinstance(view_id, str) or not view_id:
            message = 'DISPLAY action has no viewConfig.id at event %d path %s' % (event_index, path)
            if strict:
                raise CaptureError(message)
        found.append({
            'eventIndex': event_index,
            'eventElapsedMs': row.get('elapsedMs') if isinstance(row, dict) else None,
            'eventTs': event.get('ts'),
            'eventType': event.get('type'),
            'requestID': event.get('requestID'),
            'transID': event.get('transID'),
            'jcpId': jcp_id,
            'displayId': node.get('id'),
            'displayIndex': len(found),
            'actionPath': list(path),
            'viewId': view_id,
        })
    return found


def _public_display_action(action):
    """Copy an action's JSON metadata while omitting planner-only fields."""
    return {key: value for key, value in action.items() if not key.startswith('_')}


class DisplayCapturePlanner:
    """Plan ordered screenshots from view observations and native DISPLAY actions.

    A view ID is not a render identity.  Each DISPLAY action gets a monotonic
    occurrence, and a repeated ID remains pending until the client exposes a
    new view interval.  If that boundary cannot be observed, ``finish`` raises
    instead of silently treating a duplicate ID as already captured.
    """

    def __init__(self, screenshot_delay, strict=True):
        self.screenshot_delay = screenshot_delay
        self.strict = strict
        self.events_seen = 0
        self.actions = []
        self._occurrences = {}
        self._pending = []
        self._captured_view_ids = set()
        self._legacy_captures = set()
        self._captured_generations = set()
        self._current_view = None
        self._current_instance = None
        self._have_observation = False
        self._view_since = None
        self._view_generation = 0
        self._next_capture_ordinal = 1
        self.errors = []

    @property
    def current_view(self):
        return self._current_view

    @property
    def view_since(self):
        return self._view_since

    def public_actions(self):
        return [_public_display_action(action) for action in self.actions]

    def _fail(self, message, **details):
        error = {'message': message}
        error.update(details)
        self.errors.append(error)
        raise CaptureError(message)

    def _ingest(self, event_rows, now):
        new = []
        while self.events_seen < len(event_rows):
            index = self.events_seen
            row = event_rows[index]
            actions = _display_actions_from_event(row, index, strict=self.strict)
            for action in actions:
                view_id = action.get('viewId')
                if not view_id and self.strict:
                    self._fail('DISPLAY action cannot be captured without a view ID', eventIndex=index)
                occurrence = self._occurrences.get(view_id, 0) + 1
                self._occurrences[view_id] = occurrence
                action['viewOccurrence'] = occurrence
                action['displayOrdinal'] = len(self.actions) + 1
                action['captureKey'] = '%s#%d' % (view_id, occurrence)
                action['_seenAt'] = now
                action['_readySince'] = None
                action['_viewGeneration'] = None
                action['captureStatus'] = 'pending'
                self.actions.append(action)
                self._pending.append(action)
                new.append(action)
            self.events_seen += 1
        return new

    def _arm(self, action, now):
        if action['_readySince'] is not None or self._current_view != action.get('viewId'):
            return
        if not self._pending or self._pending[0] is not action:
            # DISPLAY actions are rendered in source order.  A later action
            # cannot be armed while an earlier view is unresolved.
            return
        if self._view_generation in self._captured_generations:
            # A currentView object represents one render.  A second action
            # with the same ID must wait for a new object/token.
            return
        if action.get('viewId') in self._legacy_captures:
            self._fail(
                'DISPLAY action arrived after an uncorrelated view capture',
                viewId=action.get('viewId'),
                displayOrdinal=action.get('displayOrdinal'),
            )
        action['_readySince'] = now
        action['_viewGeneration'] = self._view_generation
        action['viewGeneration'] = self._view_generation

    def _on_view_change(self, view, instance, now):
        old_view = self._current_view
        old_instance = self._current_instance
        same_instance = (self._have_observation and old_view == view
                         and old_instance == instance)
        if same_instance:
            return
        if self._have_observation and old_view is not None:
            lost = [
                pending for pending in self._pending
                if pending.get('viewId') == old_view and pending.get('_readySince') is not None
            ]
            if lost:
                self._fail(
                    'DISPLAY view left before its stable screenshot was captured',
                    viewId=old_view,
                    displayOrdinal=lost[0].get('displayOrdinal'),
                )
        self._current_view = view
        self._current_instance = instance
        self._have_observation = True
        self._view_since = now
        self._view_generation += 1
        for action in self._pending:
            self._arm(action, now)
            if action.get('_readySince') is not None:
                break

    def update(self, value, now, event_rows):
        """Ingest events/one CDP state and return (newActions, dueCapture)."""
        new_actions = self._ingest(event_rows, now)
        view = value.get('view') if isinstance(value, dict) else None
        instance = value.get('viewInstance') if isinstance(value, dict) else None
        self._on_view_change(view, instance, now)
        for action in new_actions:
            self._arm(action, now)

        # DISPLAY actions are an ordered queue.  Never capture a later action
        # while an earlier one is unresolved.
        if self._pending:
            first = self._pending[0]
            ready_since = first.get('_readySince')
            if (self._current_view == first.get('viewId') and ready_since is not None
                    and now - ready_since >= self.screenshot_delay):
                return new_actions, self._capture_request(first, now)

        # Keep the old observer behavior for views which have no DISPLAY
        # action (notably the initial eyeView): capture each unique ID once.
        known_display_views = {action.get('viewId') for action in self.actions}
        if (self._current_view and self._current_view not in self._captured_view_ids
                and self._current_view not in known_display_views
                and self._view_since is not None
                and now - self._view_since >= self.screenshot_delay):
            return new_actions, self._capture_request(None, now)
        return new_actions, None

    def _capture_request(self, action, now):
        view_id = action.get('viewId') if action else self._current_view
        return {
            '_action': action,
            '_requestedAt': now,
            '_readySince': action.get('_readySince') if action else self._view_since,
            '_viewSince': self._view_since,
            'captureOrdinal': self._next_capture_ordinal,
            'viewId': view_id,
            'viewInstance': self._current_instance,
            'viewGeneration': self._view_generation,
            'viewOccurrence': action.get('viewOccurrence') if action else None,
        }

    def captured(self, request, now):
        """Mark one successfully written screenshot and advance the queue."""
        action = request.get('_action')
        if action is None:
            self._captured_view_ids.add(request.get('viewId'))
            self._legacy_captures.add(request.get('viewId'))
        else:
            if not self._pending or self._pending[0] is not action:
                self._fail('capture queue changed while writing screenshot', viewId=request.get('viewId'))
            self._pending.pop(0)
            action['captureStatus'] = 'captured'
            action['captureOrdinal'] = request['captureOrdinal']
            action['_capturedAt'] = now
            self._captured_view_ids.add(action.get('viewId'))
            self._captured_generations.add(request['viewGeneration'])
        self._next_capture_ordinal += 1

    def finish(self, event_rows, now):
        """Validate that every observed DISPLAY action received a screenshot."""
        self._ingest(event_rows, now)
        if self._pending:
            first = self._pending[0]
            self._fail(
                'DISPLAY action did not produce a distinct stable screenshot',
                viewId=first.get('viewId'),
                displayOrdinal=first.get('displayOrdinal'),
                pendingDisplayOrdinals=[action.get('displayOrdinal') for action in self._pending],
            )


def _sha256_file(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _screenshot_path(base, ordinal):
    """Return the legacy-compatible, ordinal-stable screenshot filename."""
    return base.with_name(base.stem + '-view-%d.png' % ordinal)


async def run(args):
    events, snapshots = [], []
    start = time.monotonic()
    planner = DisplayCapturePlanner(args.screenshot_delay) if args.screenshots else None
    report = {'started': datetime.datetime.now(datetime.timezone.utc).isoformat(),
              'robot': 'moth-radius-breazeal-felt.jibo', 'mode': args.mode,
              'input': 'passive native microphone observation' if args.observe_only else ('native clientASR text injection' if args.text is not None else 'native microphone capture'),
              'text': args.text, 'microphoneAcceptance': False, 'events': events, 'snapshots': snapshots,
              'displayActions': [], 'screenshots': [], 'captureErrors': []}
    async with websockets.connect('ws://127.0.0.1:%d/events' % args.native_port,
                                  max_size=2 * 1024 * 1024, ping_interval=None) as ws:
        async def receive():
            async for data in ws:
                if len(events) >= 2000:
                    raise RuntimeError('Native event limit reached')
                events.append({'elapsedMs': round((time.monotonic()-start)*1000), 'event': json.loads(data)})

        async def observe():
            previous = None
            while True:
                result = await evaluate(args.cdp_port, args.slot, SNAPSHOT)
                value = result['result'].get('value')
                if value != previous:
                    snapshots.append({'elapsedMs': round((time.monotonic()-start)*1000), 'be': value})
                    previous = value
                if planner:
                    now = time.monotonic()
                    new_actions, request = planner.update(value, now, events)
                    if new_actions:
                        report['displayActions'] = planner.public_actions()
                    if request:
                        out = _screenshot_path(args.out, request['captureOrdinal'])
                        capture_result = await screenshot(args.cdp_port, args.slot, out)
                        if not out.is_file():
                            planner._fail('CDP screenshot returned without writing the requested file',
                                          filename=str(out), captureOrdinal=request['captureOrdinal'])
                        capture_result['sha256'] = _sha256_file(out)
                        captured_at = time.monotonic()
                        planner.captured(request, captured_at)
                        action = request.get('_action')
                        ready_since = request.get('_readySince')
                        if ready_since is None:
                            ready_since = captured_at
                        capture_metadata = {
                            'ordinal': request['captureOrdinal'],
                            'viewId': request['viewId'],
                            'viewInstance': request['viewInstance'],
                            'viewGeneration': request['viewGeneration'],
                            'viewOccurrence': request['viewOccurrence'],
                            'stableForMs': round(max(0, captured_at - ready_since) * 1000),
                            'filename': str(out),
                            'sha256': capture_result['sha256'],
                            'displayAction': _public_display_action(action) if action else None,
                        }
                        snapshots.append({'elapsedMs': round((captured_at-start)*1000),
                                          'stableView': request['viewId'],
                                          'capture': capture_result,
                                          'captureMetadata': capture_metadata})
                        report['screenshots'].append(capture_metadata)
                        report['displayActions'] = planner.public_actions()
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
            if planner:
                planner.finish(events, time.monotonic())
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
            try:
                await evaluate(args.cdp_port, args.slot, VIEW_INSTANCE_FINISH)
            except Exception as error:
                report['viewInstanceTrackerCleanupError'] = str(error)
            report['durationMs'] = round((time.monotonic()-start)*1000)
            if planner:
                report['displayActions'] = planner.public_actions()
                report['captureErrors'] = list(planner.errors)
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
