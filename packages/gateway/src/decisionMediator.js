// Pegasus DecisionMediator adapts report launches for pre-Hashbrown robots.
// The release comes from the robot's preprocessed CONTEXT. Only the explicit
// RELEASE_NOT_FOUND sentinel means the robot is known to lack jibo-tbd.
export function mediateDecision(decision, asr, nlu, release) {
  const [major, minor] = releaseParts(release === 'RELEASE_NOT_FOUND' ? '1.9.0' : release);
  if (major > 1 || (major === 1 && minor >= 9) || decision.skillID !== 'report-skill') return;

  switch (nlu.intent) {
    case 'launchPersonalReport': return scripted('KU_GiveMeA');
    case 'requestWeatherPR': return { skillID: 'answer' };
    case 'requestCommute': return scripted('RA_JBO_Traffic');
    case 'requestCalendar': return scripted('RA_JBO_Calendar');
    case 'requestNews': return { skillID: 'news' };
    default: return scripted('KU_AreYouAbleTo');
  }
}

function scripted(mim) {
  return { skillID: 'chitchat-skill', memo: { mim, type: 'ScriptedResponse' } };
}

// The pinned semver 5.5.0 coerce/valid pair extracts the first numeric version,
// pads missing components with zero and ignores prerelease/build suffixes.
// Numeric components have at most 16 digits, no leading zeros and must fit in
// a safe integer. Invalid releases fail the transaction before any launch.
function releaseParts(release) {
  const match = typeof release === 'string'
    && /(?:^|[^\d])(\d{1,16})(?:\.(\d{1,16}))?(?:\.(\d{1,16}))?(?:$|[^\d])/.exec(release);
  if (!match) throw new TypeError('Invalid robot release');
  return match.slice(1, 4).map(part => {
    const value = part || '0';
    const number = Number(value);
    if ((value.length > 1 && value[0] === '0') || !Number.isSafeInteger(number)) {
      throw new TypeError('Invalid robot release');
    }
    return number;
  });
}
