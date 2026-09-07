import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { ListenTransaction } from '../src/listenTransaction.js';
import { SkillClient, SkillConfigManager } from '../src/skillClient.js';

const silentLog = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

function makeContext({ speaker = null, peoplePresent = [], skill = {} } = {}) {
  return {
    data: {
      general: { robotID: 'robot-h04' },
      runtime: { perception: { speaker, peoplePresent } },
      skill,
    },
  };
}

function response(type, skillID, sessionID, extra = {}) {
  return {
    type,
    data: {
      skill: { id: skillID, session: { id: sessionID } },
      ...extra,
    },
  };
}

async function withSkillServer(sequence, run, onRobotIDs = []) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    requests.push({ method: req.method, url: req.url, body });
    const answers = sequence[body.data.skill.id] || [];
    const answer = answers.shift();
    if (!answer) {
      res.statusCode = 500;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ error: 'unconfigured skill call' }));
      return;
    }
    res.statusCode = answer.status || 200;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(answer.body));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/v1/main`;
  const configs = Object.keys(sequence).map((id) => ({ id, URL: url, intents: [], onRobot: onRobotIDs.includes(id) }));
  const manager = new SkillConfigManager(configs);
  const client = new SkillClient(manager);
  try {
    return await run({ client, manager, requests });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function makeTransaction({ client, manager, history, recordLaunchHistory = true }) {
  const writes = [];
  const messages = [];
  const tx = new ListenTransaction(
    { _jiboHeaders: {}, _auth: null, _remoteAddress: '127.0.0.1' },
    {
      config: { recordLaunchHistory },
      skillClient: client,
      skillConfigManager: manager,
      historyClient: history || {
        writeSkillLaunch(data) { writes.push(structuredClone(data)); return Promise.resolve(); },
      },
    },
    { write(message) { messages.push(message); } },
    silentLog,
  );
  tx.nluData = { intent: 'original-intent', entities: { original: true } };
  tx.asrData = { text: 'original asr', confidence: 1 };
  return { tx, writes, messages };
}

test('successful launch records speaker only and preserves returned session', async () => {
  await withSkillServer({ alpha: [{ body: response('SKILL_ACTION', 'alpha', 'session-alpha') }] }, async ({ client, manager, requests }) => {
    const { tx, writes } = makeTransaction({ client, manager });
    try {
      await tx._onSkillMatch('alpha', makeContext({ speaker: 'speaker-1', peoplePresent: [{ id: 'other-1' }] }), 'memo');
      assert.deepEqual(writes, [{
        robotID: 'robot-h04',
        sessionID: 'session-alpha',
        skillID: 'alpha',
        intent: 'original-intent',
        personIDs: ['speaker-1'],
      }]);
      assert.equal(requests.length, 1);
      assert.equal(requests[0].body.type, 'LISTEN_LAUNCH');
      assert.equal(requests[0].body.data.result.asr.text, 'original asr');
    } finally {
      tx.resolve();
    }
  });
});

test('missing speaker records UNKNOWN and a failed skill records no launch', async () => {
  await withSkillServer({
    missing: [{ status: 500, body: { message: 'provider failed' } }],
    unknown: [{ body: response('SKILL_ACTION', 'unknown', 'session-unknown') }],
  }, async ({ client, manager }) => {
    const first = makeTransaction({ client, manager });
    try {
      await first.tx._onSkillMatch('missing', makeContext({ speaker: null, peoplePresent: [{ id: 'present-1' }] }));
      assert.deepEqual(first.writes, []);
    } finally {
      first.tx.resolve();
    }

    const second = makeTransaction({ client, manager });
    try {
      await second.tx._onSkillMatch('unknown', makeContext());
      assert.deepEqual(second.writes, [{
        robotID: 'robot-h04',
        sessionID: 'session-unknown',
        skillID: 'unknown',
        intent: 'original-intent',
        personIDs: ['UNKNOWN'],
      }]);
    } finally {
      second.tx.resolve();
    }
  });
});

test('successful redirect through _onSkillMatch records both launches', async () => {
  const redirect = response('SKILL_REDIRECT', 'source', 'source-session', {
    skillID: 'destination',
    nlu: { intent: 'redirect-intent', entities: {} },
    asr: { text: 'redirect asr' },
    memo: 'redirect-memo',
  });
  await withSkillServer({
    source: [{ body: redirect }],
    destination: [{ body: response('SKILL_ACTION', 'destination', 'destination-session') }],
  }, async ({ client, manager, requests }) => {
    const { tx, writes } = makeTransaction({ client, manager });
    try {
      await tx._onSkillMatch('source', makeContext({ speaker: 'speaker-3' }));
      assert.deepEqual(writes.map(({ skillID, sessionID, intent }) => ({ skillID, sessionID, intent })), [
        { skillID: 'source', sessionID: 'source-session', intent: 'original-intent' },
        { skillID: 'destination', sessionID: 'destination-session', intent: 'original-intent' },
      ]);
      assert.equal(requests[1].body.data.result.asr, undefined);
    } finally {
      tx.resolve();
    }
  });
});

test('redirect destination failure keeps the initial successful launch only', async () => {
  const redirect = response('SKILL_REDIRECT', 'source', 'source-session', {
    skillID: 'destination', nlu: { intent: 'redirect-intent' }, asr: { text: 'redirect-asr' }, memo: 'redirect-memo',
  });
  await withSkillServer({
    source: [{ body: redirect }],
    destination: [{ status: 500, body: { message: 'destination failed' } }],
  }, async ({ client, manager }) => {
    const { tx, writes, messages } = makeTransaction({ client, manager });
    try {
      await tx._onSkillMatch('source', makeContext({ speaker: 'speaker-failure' }));
      assert.deepEqual(writes.map(({ skillID, sessionID }) => ({ skillID, sessionID })), [
        { skillID: 'source', sessionID: 'source-session' },
      ]);
      assert.equal(messages.at(-1).type, 'ERROR');
    } finally {
      tx.resolve();
    }
  });
});

test('repeated redirect records each successful launch before rejecting', async () => {
  const redirect = (skillID, sessionID) => response('SKILL_REDIRECT', skillID, sessionID, {
    skillID: 'destination', nlu: { intent: 'redirect-intent' }, asr: { text: 'redirect-asr' }, memo: 'redirect-memo',
  });
  await withSkillServer({
    source: [{ body: redirect('source', 'source-session') }],
    destination: [{ body: redirect('destination', 'destination-session') }],
  }, async ({ client, manager }) => {
    const { tx, writes } = makeTransaction({ client, manager });
    try {
      await assert.rejects(tx._onSkillMatch('source', makeContext({ speaker: 'speaker-repeat' })), /Too many redirects/);
      assert.deepEqual(writes.map(({ skillID, sessionID }) => ({ skillID, sessionID })), [
        { skillID: 'source', sessionID: 'source-session' },
        { skillID: 'destination', sessionID: 'destination-session' },
      ]);
    } finally {
      tx.resolve();
    }
  });
});

test('on-robot matches record without a cloud request; disabled history stays silent', async () => {
  await withSkillServer({ robot: [] }, async ({ client, manager, requests }) => {
    const { tx, writes } = makeTransaction({ client, manager, recordLaunchHistory: true });
    try {
      await tx._onSkillMatch('robot', makeContext({ speaker: 'speaker-4' }));
      assert.deepEqual(writes.map(({ skillID, personIDs }) => ({ skillID, personIDs })), [{ skillID: 'robot', personIDs: ['speaker-4'] }]);
      assert.deepEqual(requests, []);
    } finally {
      tx.resolve();
    }
  }, ['robot']);

  await withSkillServer({ cloud: [{ body: response('SKILL_ACTION', 'cloud', 'cloud-session') }] }, async ({ client, manager, requests }) => {
    const { tx, writes } = makeTransaction({ client, manager, recordLaunchHistory: false });
    try {
      await tx._onSkillMatch('cloud', makeContext({ speaker: 'speaker-5' }));
      assert.deepEqual(writes, []);
      assert.equal(requests.length, 1);
    } finally {
      tx.resolve();
    }
  });
});
