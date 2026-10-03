import { newMsgId } from '@phoenix/contracts';
import { buildSkillAction } from './jcp.js';

export const HOME_ASSISTANT_SKILL_ID = 'phoenix-home-assistant';
const ERRORS = {
  not_linked: 'Link Home Assistant in your Phoenix console first.',
  offline: 'Home Assistant is offline. Please check its connection.',
  busy: 'Home Assistant is still working on another command. Please wait a moment.',
  unavailable: "I can't reach Home Assistant right now. Please try again later.",
  invalid_command: "I couldn't send that Home Assistant command.",
};

export function homeAssistantSpeech(result) {
  if (result?.outcome === 'uncertain') return "I couldn't confirm the result. Please check Home Assistant before trying again.";
  if (result?.outcome === 'expired') return "That command expired before Home Assistant could start it.";
  if (ERRORS[result?.code]) return ERRORS[result.code];
  const speech = typeof result?.speech === 'string' ? result.speech.trim().slice(0, 500) : '';
  if (result?.outcome === 'partial') return speech
    ? `Only part of that worked. ${speech}` : 'Only part of that worked. Please check Home Assistant.';
  if (speech) return speech;
  // Action completion without speech is not proof of a physical state change.
  if (result?.outcome === 'success') return 'Home Assistant handled that command.';
  return "Home Assistant couldn't handle that command.";
}

export function buildHomeAssistantReply(result) {
  return buildSkillAction({ skillId: HOME_ASSISTANT_SKILL_ID, sessionId: newMsgId(),
    esmlText: homeAssistantSpeech(result), mimId: 'HomeAssistantReply' });
}
