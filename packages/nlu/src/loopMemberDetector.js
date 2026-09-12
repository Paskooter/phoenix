// Loop-member post-processing for NLU results.

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function isValidLoopUser(user) {
  return isPlainObject(user)
    && typeof user.id === 'string' && user.id.trim().length > 0
    && typeof user.firstName === 'string' && user.firstName.trim().length > 0
    && typeof user.lastName === 'string' && user.lastName.trim().length > 0;
}

export function isValidLoop(loop) {
  return isPlainObject(loop)
    && Array.isArray(loop.users)
    && loop.users.every(isValidLoopUser);
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isEqual(a, b) {
  return typeof a === 'string' && typeof b === 'string'
    && a.toLowerCase() === b.toLowerCase();
}

function getStringEntityValue(entities, key) {
  const value = entities && entities[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export class LoopMemberDetector {
  static detectLoopMembers(request, result) {
    if (!result || !isPlainObject(result.entities)) return result;
    const loopMember = LoopMemberDetector.findLoopMember(request, result);
    if (loopMember) {
      result.entities.loopMemberReferent = loopMember.id;
      result.entities['given-name'] = loopMember.firstName;
      result.entities['last-name'] = loopMember.lastName;
    }
    return result;
  }

  static findLoopMember(request, result) {
    if (!request || !isValidLoop(request.loop) || !result || !result.intent) return null;
    const loopUsers = request.loop.users;
    const entities = isPlainObject(result.entities) ? result.entities : {};
    const givenNameEntityExpected = Object.prototype.hasOwnProperty.call(entities, 'given-name')
      || Object.prototype.hasOwnProperty.call(entities, 'GivenName');
    const givenNameEntityValue = getStringEntityValue(entities, 'given-name')
      || getStringEntityValue(entities, 'GivenName');
    const lastNameEntityValue = getStringEntityValue(entities, 'last-name')
      || getStringEntityValue(entities, 'LastName');

    if (givenNameEntityValue && lastNameEntityValue) {
      return loopUsers.find(user => isEqual(user.firstName, givenNameEntityValue)
        && isEqual(user.lastName, lastNameEntityValue));
    }
    if (givenNameEntityValue && !lastNameEntityValue) {
      return loopUsers.find(user => isEqual(user.firstName, givenNameEntityValue));
    }

    if (!givenNameEntityValue && typeof request.text === 'string') {
      const mentionedUser = loopUsers.find(user => {
        const pattern = new RegExp(`\\b${escapeRegExp(user.firstName)} ${escapeRegExp(user.lastName)}\\b`, 'i');
        return pattern.test(request.text);
      });
      if (mentionedUser) return mentionedUser;
    }

    if (givenNameEntityExpected && typeof request.text === 'string') {
      const mentionedByName = loopUsers.find(user => {
        const pattern = new RegExp(`\\b${escapeRegExp(user.firstName)}\\b`, 'i');
        return pattern.test(request.text);
      });
      if (mentionedByName) return mentionedByName;
    }
    return null;
  }
}
