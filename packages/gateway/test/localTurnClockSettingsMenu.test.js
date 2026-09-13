// N-03 local-turn WebSocket acceptance.
//
// The robot's local turn reaches the hub as LISTEN(mode:'CLIENT_ASR') +
// CLIENT_ASR over the listen socket; the hub then runs the requested NLU rule
// set (ListenTransactionHandler -> parser /v1/parse) and routes the result. This
// drives that exact path with the N-03 clock/settings/main-menu rule sets and
// asserts the parsed intent/entities on the final LISTEN frame. The recovered
// time factory is active, so source-declared time and AM/PM values are ordinary
// successful NLU results on this path.
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

async function assertLocalTurns(rows) {
  for (const [rule, text, intent, entities] of rows) {
    const final = finalNlu(await localTurn([rule], text));
    assert.equal(final.type, 'LISTEN', `${rule} ${JSON.stringify(text)}: expected a LISTEN final`);
    assert.equal(final.data.nlu.intent, intent, `${rule} ${JSON.stringify(text)}: intent`);
    assert.deepEqual(final.data.nlu.entities, entities, `${rule} ${JSON.stringify(text)}: entities`);
    assert.deepEqual(final.data.nlu.rules, intent === null ? [] : [rule], `${rule} ${JSON.stringify(text)}: echoed rule set`);
  }
}

test('N-03 local turn: clock rules reach the NLU and route on the final LISTEN', async () => {
  for (const [rules, text, intent, entities] of [
    [['clock/clock_menu'], 'what time is it', 'askForTime', { domain: 'clock' }],
    [['clock/timer_set_value'], 'set a timer for five minutes', 'timerValue', { hours: 'null', minutes: '5', seconds: 'null', domain: 'timer' }],
    [['clock/stop_timer'], 'stop the timer', 'stop', {}],
    [['clock/alarm_timer_change'], 'yes', 'delete', {}],
    [['clock/alarm_set_value'], 'set an alarm for seven thirty am', 'alarmValue', { time: '7:30', ampm: 'AM', domain: 'alarm' }],
    [['clock/alarm_set_value'], 'cancel', 'cancel', { time: 'null', ampm: 'null', domain: 'alarm' }],
    [['clock/alarm_timer_ampm'], 'p.m.', 'set', { ampm: 'PM', domain: 'alarm' }],
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

test('N-03 local turn: source-declared time and AM/PM arms yield final LISTEN results', async () => {
  // Pinned source evidence: pegasus@5c0a739 clock/alarm_set_value.rule:40-53
  // contains the $factory:time arm, while clock/alarm_timer_ampm.rule:10-13
  // contains both $factory:time and the explicit AM_PM arm. The recovered
  // time.grm:237-252 maps "am"/"p.m." to AM/PM. A successful parse therefore
  // follows the local-turn LISTEN contract instead of becoming PARSER/500.
  for (const [rule, text, intent, entities] of [
    ['clock/alarm_set_value', 'am', 'alarmValue', { time: 'am', ampm: 'AM', domain: 'alarm' }],
    ['clock/alarm_set_value', 'seven thirty am', 'alarmValue', { time: '7:30', ampm: 'AM', domain: 'alarm' }],
    ['clock/alarm_set_value', 'pm', 'alarmValue', { time: 'pm', ampm: 'PM', domain: 'alarm' }],
    ['clock/alarm_set_value', 'a.m.', 'alarmValue', { time: 'am', ampm: 'AM', domain: 'alarm' }],
    ['clock/alarm_set_value', 'a m', 'alarmValue', { time: 'am', ampm: 'AM', domain: 'alarm' }],
    ['clock/alarm_set_value', 'p m', 'alarmValue', { time: 'pm', ampm: 'PM', domain: 'alarm' }],
    ['clock/alarm_set_value', 'a. m.', 'alarmValue', { time: 'am', ampm: 'AM', domain: 'alarm' }],
    ['clock/alarm_set_value', 'p. m.', 'alarmValue', { time: 'pm', ampm: 'PM', domain: 'alarm' }],
    ['clock/alarm_timer_ampm', 'am', 'set', { ampm: 'AM', domain: 'alarm' }],
    ['clock/alarm_timer_ampm', 'pm', 'set', { ampm: 'PM', domain: 'alarm' }],
    ['clock/alarm_timer_ampm', 'a.m.', 'set', { ampm: 'AM', domain: 'alarm' }],
    ['clock/alarm_timer_ampm', 'a m', 'set', { ampm: 'AM', domain: 'alarm' }],
    ['clock/alarm_timer_ampm', 'p m', 'set', { ampm: 'PM', domain: 'alarm' }],
    ['clock/alarm_timer_ampm', 'a. m.', 'set', { ampm: 'AM', domain: 'alarm' }],
    ['clock/alarm_timer_ampm', 'p. m.', 'set', { ampm: 'PM', domain: 'alarm' }],
    ['clock/alarm_timer_ampm', 'p.m.', 'set', { ampm: 'PM', domain: 'alarm' }],
  ]) {
    const messages = await localTurn([rule], text);
    const final = finalNlu(messages);
    assert.equal(final.type, 'LISTEN', `${rule} ${JSON.stringify(text)}: expected a LISTEN final`);
    assert.equal(final.data.nlu.intent, intent, `${rule} ${JSON.stringify(text)}: intent`);
    assert.deepEqual(final.data.nlu.entities, entities, `${rule} ${JSON.stringify(text)}: entities`);
    assert.deepEqual(final.data.nlu.rules, [rule], `${rule} ${JSON.stringify(text)}: echoed rule set`);
  }
});

test('N-03 local turn falsification: bare AM is not a parser refusal', async () => {
  // Native parse at the pinned two-FST oracle returns alarmValue/time=am/ampm=AM
  // for alarm_set_value "am". This assertion catches a regression to the stale
  // PARSER-error expectation independently of the broader representative table.
  const final = finalNlu(await localTurn(['clock/alarm_set_value'], 'am'));
  assert.notEqual(final.type, 'ERROR', 'a source-matched AM value must not become a parser error');
  assert.equal(final.type, 'LISTEN');
  assert.equal(final.data.nlu.intent, 'alarmValue');
  assert.deepEqual(final.data.nlu.entities, { time: 'am', ampm: 'AM', domain: 'alarm' });
});

test('N-03 local turn: timer cancellation and confirmation responses follow source variants', async () => {
  // timer_set_value.rule:60-63 declares the cancellation vocabulary. The
  // alarm_set_value.rule:53-56 reuses the same cancellation vocabulary, and
  // stop_timer.rule:7-9 declares the stop/cancel control vocabulary.
  // confirmation rows follow alarm_timer_change.rule:5-14,
  // alarm_timer_other_set.rule:5-14, alarm_timer_none_set.rule:6-10,
  // alarm_timer_too_long.rule:5-10, alarm_timer_info.rule:5-21,
  // alarm_timer_query_menu.rule:5-21, and alarm_timer_okay.rule:5-9.
  await assertLocalTurns([
    ...['cancel', 'exit', 'escape', 'quit', 'go back', 'nevermind', 'never mind', "that's enough", 'that is enough', 'forget about it', 'cancel the timer']
      .map(text => ['clock/timer_set_value', text, 'cancel', { hours: 'null', minutes: 'null', seconds: 'null', domain: 'timer' }]),
    ...['cancel', 'exit', 'escape', 'quit', 'go back', 'nevermind', 'never mind', "that's enough", 'that is enough', 'forget about it']
      .map(text => ['clock/alarm_set_value', text, 'cancel', { time: 'null', ampm: 'null', domain: 'alarm' }]),
    ...['stop', 'kill', 'end', 'quit', 'cancel', 'terminate']
      .map(text => ['clock/stop_timer', text, 'stop', {}]),
    ['clock/timer_set_value', 'start the timer', null, null],
    ['clock/alarm_timer_change', 'no', 'keep', {}],
    ['clock/alarm_timer_change', 'keep it', 'keep', {}],
    ['clock/alarm_timer_change', 'sure', 'delete', {}],
    ['clock/alarm_timer_change', 'qzx florp', null, null],
    ['clock/alarm_timer_other_set', 'no', 'keep', {}],
    ['clock/alarm_timer_other_set', 'fine', 'replace', {}],
    ['clock/alarm_timer_other_set', 'qzx florp', null, null],
    ['clock/alarm_timer_none_set', 'no', 'no', {}],
    ['clock/alarm_timer_none_set', 'sounds good', 'yes', {}],
    ['clock/alarm_timer_none_set', 'qzx florp', null, null],
    ['clock/alarm_timer_too_long', 'no', 'no', {}],
    ['clock/alarm_timer_too_long', 'sounds good', 'yes', {}],
    ['clock/alarm_timer_too_long', 'qzx florp', null, null],
    ['clock/alarm_timer_info', 'cancel it', 'cancel', {}],
    ['clock/alarm_timer_info', 'edit that', 'change', {}],
    ['clock/alarm_timer_info', 'qzx florp', null, null],
    ['clock/alarm_timer_query_menu', 'cancel that', 'cancel', {}],
    ['clock/alarm_timer_query_menu', 'change it', 'change', {}],
    ['clock/alarm_timer_query_menu', 'qzx florp', null, null],
    ['clock/alarm_timer_okay', 'wrong', 'wrong', {}],
    ['clock/alarm_timer_okay', 'cancel', 'wrong', {}],
    ['clock/alarm_timer_okay', 'qzx florp', null, null],
  ]);
});

test('N-03 local turn: shutdown confirmation and every volume operation reach LISTEN', async () => {
  // shut_down_confirmation.rule:5-41 declares yes/no plus boundary wording.
  // volume_control.rule:11-32 declares query, max, min, up, down, and numeric
  // level arms; its numeric vocabulary is source-declared at lines 84-96.
  await assertLocalTurns([
    ['settings/shut_down_confirmation', 'yes', 'yes', {}],
    ['settings/shut_down_confirmation', 'no', 'no', {}],
    ['settings/shut_down_confirmation', 'definitely', 'yes', {}],
    ['settings/shut_down_confirmation', 'certainly', 'yes', {}],
    ['settings/shut_down_confirmation', 'stay on', 'no', {}],
    ['settings/shut_down_confirmation', 'qzx florp', null, null],
    ['settings/volume_control', 'turn the volume up', 'volumeUp', { volumeLevel: 'null', domain: 'gui_command' }],
    ['settings/volume_control', 'turn the volume down', 'volumeDown', { volumeLevel: 'null', domain: 'gui_command' }],
    ['settings/volume_control', "what's your volume", 'volumeQuery', { volumeLevel: 'null', domain: 'gui_command' }],
    ['settings/volume_control', 'maximum volume', 'volumeToValue', { volumeLevel: '10', domain: 'gui_command' }],
    ['settings/volume_control', 'minimum volume', 'volumeToValue', { volumeLevel: '01', domain: 'gui_command' }],
    ...[['zero', '0'], ['one', '01'], ['two', '02'], ['three', '03'], ['four', '04'], ['five', '05'], ['six', '06'], ['seven', '07'], ['eight', '08'], ['nine', '09'], ['ten', '10']]
      .map(([word, value]) => ['settings/volume_control', `set the volume to ${word}`, 'volumeToValue', { volumeLevel: value, domain: 'gui_command' }]),
    ['settings/volume_control', 'turn it up a bit', 'volumeUp', { volumeLevel: 'null', domain: 'gui_command' }],
    ['settings/volume_control', 'qzx florp', null, null],
  ]);
});

test('N-03 local turn: every settings and main-menu destination is source-covered', async () => {
  // execute_settings_menu.rule:17-25 declares all seven settings destinations.
  // download_now_later.rule:3-9 and okay_thanks_to_clear.rule:6-16 provide
  // the remaining settings confirmation/acknowledgement response variants.
  // execute_main_menu.rule:12-25 declares all twelve main-menu destinations.
  // execute_fun_stuff.rule:13-20 and execute_personal_report.rule:13-20
  // declare the remaining fun and personal-report destinations.
  await assertLocalTurns([
    ['settings/execute_settings_menu', 'battery', 'battery', {}],
    ['settings/execute_settings_menu', 'shut down', 'shutDown', {}],
    ['settings/execute_settings_menu', 'about', 'about', {}],
    ['settings/execute_settings_menu', 'volume', 'volumeQuery', {}],
    ['settings/execute_settings_menu', 'wifi', 'wifiStatus', {}],
    ['settings/execute_settings_menu', 'updates', 'updates', {}],
    ['settings/execute_settings_menu', 'wipe', 'wipe', {}],
    ['settings/execute_settings_menu', 'turn it off', 'shutDown', {}],
    ['settings/execute_settings_menu', 'qzx florp', null, null],
    ['settings/download_now_later', 'yes', 'yes', {}],
    ['settings/download_now_later', 'no thanks', 'no', {}],
    ['settings/download_now_later', 'why not', 'yes', {}],
    ['settings/download_now_later', 'not now', 'no', {}],
    ['settings/download_now_later', 'cancel', 'no', {}],
    ['settings/download_now_later', 'never', 'never', {}],
    ['settings/download_now_later', 'qzx florp', null, null],
    ['settings/okay_thanks_to_clear', 'okay thanks', 'okayThanks', {}],
    ['settings/okay_thanks_to_clear', 'got it', 'okayThanks', {}],
    ['settings/okay_thanks_to_clear', 'thank you', 'okayThanks', {}],
    ['settings/okay_thanks_to_clear', 'thanks', 'okayThanks', {}],
    ['settings/okay_thanks_to_clear', 'no', null, null],
    ['settings/okay_thanks_to_clear', 'qzx florp', null, null],
    ['main-menu/execute_main_menu', 'tutorial', 'loadMenu', { destination: 'tutorial' }],
    ['main-menu/execute_main_menu', 'things I can do', 'loadMenu', { destination: 'friendly-tips' }],
    ['main-menu/execute_main_menu', 'fun stuff', 'loadMenu', { destination: 'fun' }],
    ['main-menu/execute_main_menu', 'snapshot', 'loadMenu', { destination: 'snapshot' }],
    ['main-menu/execute_main_menu', 'personal report', 'loadMenu', { destination: 'personal-report' }],
    ['main-menu/execute_main_menu', 'photobooth', 'loadMenu', { destination: 'photobooth' }],
    ['main-menu/execute_main_menu', 'gallery', 'loadMenu', { destination: 'gallery' }],
    ['main-menu/execute_main_menu', 'clock', 'loadMenu', { destination: 'clock' }],
    ['main-menu/execute_main_menu', 'introductions', 'loadMenu', { destination: 'introductions' }],
    ['main-menu/execute_main_menu', 'settings', 'loadMenu', { destination: 'settings' }],
    ['main-menu/execute_main_menu', 'radio', 'loadMenu', { destination: 'radio' }],
    ['main-menu/execute_main_menu', 'yoga', 'loadMenu', { destination: 'exercise' }],
    ['main-menu/execute_main_menu', 'qzx florp', null, null],
    ['main-menu/execute_fun_stuff', 'circuit saver game', 'loadMenu', { destination: 'circuit-saver' }],
    ['main-menu/execute_fun_stuff', 'word of the day', 'loadMenu', { destination: 'word-of-the-day' }],
    ['main-menu/execute_fun_stuff', 'joke', 'loadMenu', { destination: 'joke' }],
    ['main-menu/execute_fun_stuff', 'dance', 'loadMenu', { destination: 'dance' }],
    ['main-menu/execute_fun_stuff', 'surprise me', 'loadMenu', { destination: 'surprise' }],
    ['main-menu/execute_fun_stuff', 'qzx florp', null, null],
    ['main-menu/execute_personal_report', 'full report', 'loadMenu', { destination: 'full-report' }],
    ['main-menu/execute_personal_report', 'weather', 'loadMenu', { destination: 'weather' }],
    ['main-menu/execute_personal_report', 'calendar', 'loadMenu', { destination: 'calendar' }],
    ['main-menu/execute_personal_report', 'commute', 'loadMenu', { destination: 'commute' }],
    ['main-menu/execute_personal_report', 'news', 'loadMenu', { destination: 'news' }],
    ['main-menu/execute_personal_report', 'qzx florp', null, null],
  ]);
});
