import { newMsgId } from '@phoenix/contracts';
import { buildSkillAction } from './jcp.js';

export const HOME_ASSISTANT_SKILL_ID = 'phoenix-home-assistant';
const ERRORS = {
  not_linked: 'Link Home Assistant in your Phoenix console first.',
  offline: 'Home Assistant is offline. Please check its connection.',
  busy: 'Home Assistant is still working on another command. Please wait a moment.',
  unavailable: "I can't reach Home Assistant right now. Please try again later.",
  invalid_command: "I couldn't send that Home Assistant command.",
  no_context: 'That Home Assistant conversation has ended. Please say the full command again.',
  follow_up_expired: 'That Home Assistant conversation has ended. Please say the full command again.',
  invalid_shortcut: 'That Home Assistant routine is no longer available.',
  routine_unavailable: 'That Home Assistant routine is no longer available.',
  room_unavailable: 'Choose a room for this Jibo in Home Assistant first.',
  no_valid_targets: "I couldn't find an available Home Assistant device for that request.",
  target_unavailable: 'That Home Assistant device is unavailable.',
  ambiguous_target: 'More than one Home Assistant device matches. Please use a more specific name.',
  unsupported_query: 'Try asking whether a home device is on, off, open, or closed.',
  unsupported_feature: 'That Home Assistant device does not support that change.',
  brightness_unavailable: 'I need that light to be on with a brightness reading before I can adjust it.',
  unsupported_route: 'This Home Assistant connection needs an update for that request.',
};

export function homeAssistantSpeech(result, route = null) {
  if (result?.outcome === 'uncertain') return "I couldn't confirm the result. Please check Home Assistant before trying again.";
  if (result?.outcome === 'expired') return "That command expired before Home Assistant could start it.";
  if (ERRORS[result?.code]) return ERRORS[result.code];
  const speech = typeof result?.speech === 'string' ? result.speech.trim().slice(0, 500) : '';
  if (result?.outcome === 'partial') return speech
    ? `Only part of that worked. ${speech}` : 'Only part of that worked. Please check Home Assistant.';
  if (speech) return speech;
  // Action completion without speech is not proof of a physical state change.
  if (result?.outcome === 'success') return route?.kind === 'query'
    ? "Home Assistant didn't provide a state answer." : 'Home Assistant handled that command.';
  return "Home Assistant couldn't handle that command.";
}

export function buildHomeAssistantReply(result, route = null) {
  return buildSkillAction({ skillId: HOME_ASSISTANT_SKILL_ID, sessionId: newMsgId(),
    esmlText: homeAssistantSpeech(result, route), mimId: 'HomeAssistantReply' });
}
