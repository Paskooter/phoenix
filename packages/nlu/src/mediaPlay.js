// Title-based media commands require an installed player and global launch rules.
// Skill follow-ups and external agents retain their contracts; queries stay data.
const GLOBAL_RULES = new Set(['launch', 'globals/global_commands_launch', 'globals/gui_nav', 'globals/mim_repeat', 'globals/mim_thanks']);

export function mediaPlayRequest(request) {
  if (!request || request.media !== true || request.external || typeof request.text !== 'string'
      || !Array.isArray(request.rules) || !request.rules.includes('launch')
      || request.rules.some(rule => !GLOBAL_RULES.has(rule))) return null;
  const text = request.text.trim().replace(/^hey\s+jibo\b[\s,:-]*/i, '')
    .replace(/^(?:(?:can|could|would) you\s+)?(?:please\s+)?/i, '');
  const match = /^(?:play|watch)\s+(?:me\s+)?(?:(?:(?:the|a)\s+)?(song|video|track)\s+(?:called\s+)?)?(.+?)\s*$/i.exec(text);
  if (!match) return null;
  const explicit = Boolean(match[1]) || /\s+on\s+(?:youtube|jibotube|jibo tube)[.!?]*$/i.test(match[2]);
  const query = match[2].replace(/\s+please[.!?]*$/i, '')
    .replace(/\s+on\s+(?:youtube|jibotube|jibo tube|your screen)[.!?]*$/i, '')
    .replace(/[.!?]+$/, '').trim().replace(/^(?:"(.*)"|'(.*)'|“(.*)”)$/, (_, a, b, c) => a ?? b ?? c).trim();
  if (!query || query.length > 160 || /[\x00-\x1f\x7f]/.test(query)) return null;
  // An explicit video may be titled "Chess"; bare games and transport commands
  // keep their existing owners. "Game of Thrones theme" is still a title.
  if (!explicit && (/^(?:(?:a|the|some)\s+)?(?:radio|news|music|song|songs|story|stories|joke|jokes|dance|dances)$/i.test(query)
      || /^(?:(?:a|the|some)\s+games?\b|games?(?:\s+(?:with me|please|called .+))?$|with\s|tic[ -]?tac[ -]?toe\b|circuit[ -]?saver\b|word of the day\b)/i.test(query)
      || /(?:^|\s)(?:games?|quiz|trivia)(?:\s+with me)?$/i.test(query)
      || /^(?:pong|ping[ -]?pong|chess|checkers|hangman|simon says|rock paper scissors|twenty questions|again|next|previous|pause|resume|it|that|something)(?:\s+(?:with me|again))?$/i.test(query))) return null;
  return { intent: 'phoenixPlayVideo', entities: { query }, rules: ['launch'] };
}
