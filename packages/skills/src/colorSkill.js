// color-skill — a minimal two-turn GraphSkill demonstrating the FSM + multi-turn sessions.
// Turn 1 (AskColor): asks a question, returns final:false (skill stays open). Turn 2 (ReplyColor):
// on LISTEN_UPDATE, reads the answer from data.result.asr.text, stores it in session.data, and
// replies final:true. session{nodeID,data} round-trips through the robot between turns.

import { createGraphSkill } from './graph/graphSkill.js';
import { FnNode } from './graph/node.js';
import { buildJcpAction } from './jcp.js';

export const colorSkill = createGraphSkill({
  name: 'color-skill',
  build: (gm) => {
    const ask = gm.addNode(new FnNode('AskColor', {
      transitions: ['answered'],
      enter: () => ({
        action: buildJcpAction({ esmlText: "What's your favorite color?", mimId: 'ColorQN', mimType: 'question', promptSubCategory: 'Q', listenRule: 'global' }),
        final: false, // keep the skill open for the answer
      }),
      exit: (data) => {
        const color = (((data.result && data.result.asr && data.result.asr.text) || '').trim()) || 'that';
        data.skill.session.data.color = color;
        return { transition: 'answered', result: { color } };
      },
    }));
    const reply = gm.addNode(new FnNode('ReplyColor', {
      enter: (data) => ({
        action: buildJcpAction({ esmlText: `Oh, ${data.skill.session.data.color} is a great color! Mine is teal.`, mimId: 'ColorAN' }),
        final: true,
      }),
    }));
    ask.addTransition('answered', reply);
    return ask;
  },
});
