import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGraphSkill, FnNode, GraphManager } from '../src/index.js';

const GENERAL = { accountID: 'fixture-account', robotID: 'fixture-robot' };

function launch(id) {
  return {
    type: 'LISTEN_LAUNCH',
    data: {
      general: GENERAL,
      skill: { id },
      result: { nlu: { intent: 'fixture', entities: {} } },
    },
  };
}

test('co-hosted GraphSkills share source global node allocation and trace lookup', async () => {
  const manager = new GraphManager();
  const first = createGraphSkill({
    name: 'first-skill',
    graphManager: manager,
    build: (gm) => gm.addNode(new FnNode('First', {
      enter: async () => ({ action: { type: 'FIRST' }, final: false }),
    })),
  });
  const second = createGraphSkill({
    name: 'second-skill',
    graphManager: manager,
    build: (gm) => gm.addNode(new FnNode('Second', {
      enter: async () => ({ action: { type: 'SECOND' }, final: false }),
    })),
  });

  const firstResponse = await first(launch('first-skill'));
  const secondResponse = await second(launch('second-skill'));

  assert.equal(firstResponse.data.skill.session.nodeID, 0);
  assert.equal(firstResponse.data.skill.session.trace[0].nodeID, 0);
  assert.equal(secondResponse.data.skill.session.nodeID, 1);
  assert.equal(secondResponse.data.skill.session.trace[0].nodeID, 1);
  assert.equal(manager.getNode(0).name, 'First');
  assert.equal(manager.getNode(1).name, 'Second');
});

test('custom GraphSkill creation remains isolated unless a host supplies its manager', async () => {
  const first = createGraphSkill({
    name: 'isolated-first',
    build: (gm) => gm.addNode(new FnNode('First', {
      enter: async () => ({ action: { type: 'FIRST' }, final: false }),
    })),
  });
  const second = createGraphSkill({
    name: 'isolated-second',
    build: (gm) => gm.addNode(new FnNode('Second', {
      enter: async () => ({ action: { type: 'SECOND' }, final: false }),
    })),
  });

  const firstResponse = await first(launch('isolated-first'));
  const secondResponse = await second(launch('isolated-second'));
  assert.equal(firstResponse.data.skill.session.nodeID, 0);
  assert.equal(secondResponse.data.skill.session.nodeID, 0);
});
