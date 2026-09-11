// N-03 local-turn WebSocket acceptance.
//
// The robot's local turn reaches the hub as LISTEN(mode:'CLIENT_ASR') +
// CLIENT_ASR over the listen socket; the hub then runs the requested NLU rule
// set (ListenTransactionHandler -> parser /v1/parse) and routes the result. This
// drives that exact path with the N-03 clock/settings/main-menu rule sets and
// asserts the parsed intent/entities on the final LISTEN frame, plus the loud
// PARSER error the two time-factory rules must produce.
//
// Ports are ephemeral so this file can run beside the fixed-port suites.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { jwt } from '@phoenix/common';
// The worktree's node_modules is a symlink to the main checkout, so a bare
// `@phoenix/nlu` / `@phoenix/gateway` import would exercise the MAIN tree's code,
// not this worktree's. Import the two services under test by relative path so a
// change made here is actually the change under test.
import { start as startNlu } from '../../nlu/src/index.js';
import { start as startGateway } from '../src/index.js';

const SECRET = 'n03-secret';
let nluSrv, gw, gwPort;

before(async () => {
  process.env.ETCO_server_hubTokenSecret = SECRET;
  process.env.ETCO_hub_recordLaunchHistory = 'false';
  process.env.ETCO_hub_recordSpeechHistory = 'false';
  process.env.ETCO_hub_disableAuth = 'false';
  nluSrv = await startNlu(0);
  process.env.NET_parser = `localhost:${nluSrv.address().port}`;
  gw = await startGateway(0);
  gwPort = gw.service.server.address().port;
});

after(async () => {
  gw?.wss?.close();
  gw?.service?.server?.close();
  nluSrv?.close?.();
});

function token() {
  return jwt.sign({ id: 'acct-n03', friendlyId: 'N03-Robot', accessKeyId: 'k', secretAccessKey: 's' }, SECRET);
}

const context = () => ({
  type: 'CONTEXT', msgID: 'c', ts: Date.now(),
  data: {
    general: { accountID: 'acct-n03', robotID: 'N03-Robot', lang: 'en-US', release: '2.0.1' },
    runtime: { loop: { users: [] }, dialog: {} },
    skill: { id: null },
  },
});

// One local turn: LISTEN(CLIENT_ASR) -> CONTEXT -> CLIENT_ASR, collect frames.
function localTurn(rules, text) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${gwPort}/v1/listen`, {
      headers: { Authorization: `Bearer ${token()}`, 'x-jibo-transid': 'tid:n03' },
    });
    const messages = [];
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'LISTEN', msgID: '1', ts: Date.now(), data: { lang: 'en-US', hotphrase: false, rules, mode: 'CLIENT_ASR', asr: 'FAKE' } }));
      ws.send(JSON.stringify(context()));
      ws.send(JSON.stringify({ type: 'CLIENT_ASR', msgID: '3', ts: Date.now(), data: { text } }));
    });
    ws.on('message', (d) => {
      const m = JSON.parse(d.toString());
      messages.push(m);
      if (m.final) { ws.close(); resolve(messages); }
    });
    ws.on('error', reject);
  });
}

const finalNlu = messages => {
  const final = messages.findLast(m => m.final);
  assert.ok(final, `no final frame in ${JSON.stringify(messages.map(m => m.type))}`);
  return final;
};

test('N-03 local turn: clock rules reach the NLU and route on the final LISTEN', async () => {
  for (const [rules, text, intent, entities] of [
    [['clock/clock_menu'], 'what time is it', 'askForTime', { domain: 'clock' }],
    [['clock/timer_set_value'], 'set a timer for five minutes', 'timerValue', { hours: 'null', minutes: '5', seconds: 'null', domain: 'timer' }],
    [['clock/stop_timer'], 'stop the timer', 'stop', {}],
    [['clock/alarm_timer_change'], 'yes', 'delete', {}],
    [['settings/execute_settings_menu'], 'battery', 'battery', {}],
    [['settings/volume_control'], 'turn the volume up', 'volumeUp', { volumeLevel: 'null', domain: 'gui_command' }],
    [['main-menu/execute_main_menu'], 'settings', 'loadMenu', { destination: 'settings' }],
    [['main-menu/execute_personal_report'], 'weather', 'loadMenu', { destination: 'weather' }],
  ]) {
    const messages = await localTurn(rules, text);
    const final = finalNlu(messages);
    assert.equal(final.type, 'LISTEN', `${rules[0]} ${JSON.stringify(text)}: expected a LISTEN final`);
    assert.equal(final.data.nlu.intent, intent, `${rules[0]} ${JSON.stringify(text)}: intent`);
    assert.deepEqual(final.data.nlu.entities, entities, `${rules[0]} ${JSON.stringify(text)}: entities`);
    assert.deepEqual(final.data.nlu.rules, rules, `${rules[0]} ${JSON.stringify(text)}: echoed rule set`);
  }
});

test('N-03 local turn: the time-factory rules surface a loud PARSER error, never a silent no-match', async () => {
  for (const rule of ['clock/alarm_set_value', 'clock/alarm_timer_ampm']) {
    for (const text of ['am', 'seven thirty am', 'set an alarm']) {
      const messages = await localTurn([rule], text);
      const final = finalNlu(messages);
      assert.equal(final.type, 'ERROR', `${rule} ${JSON.stringify(text)}: expected the gateway PARSER error`);
      assert.equal(final.data.code, 'PARSER', `${rule} ${JSON.stringify(text)}: code`);
      // The gateway forwards the parser transport failure verbatim
      // (parserClient.js throws `parser ${res.status}`; ListenTransactionHandler
      // wraps any parser failure as HubErrorCode.PARSER).
      assert.equal(final.data.message, 'parser 500', `${rule} ${JSON.stringify(text)}: message`);
    }
  }
});
