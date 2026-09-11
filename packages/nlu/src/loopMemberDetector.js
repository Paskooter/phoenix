// LoopMemberDetector — post-processing of an NLU result that resolves a
// mentioned household ("loop") member.
//
// Ported from the pinned Pegasus source:
//   pegasus:packages/parser/src/utils/LoopMemberDetector.ts
//   @ 5c0a7390539663ba749d360de348a428c088505c, lines 5-94.
//
// The reference invokes this from ParseRequestHandler.handleParseRequest:
//   ParseRequestHandler.ts:33
//     LoopMemberDetector.detectLoopMembers(req.body.data, result);
// after NLU result selection (and after the external-agent attachment inside
// getNLUResult). It MUTATES result.entities in place and the handler ignores
// the return value, so the HTTP response observes the mutation.
//
// Inputs / outputs (pegasus:packages/interfaces/src/nlu.ts@5c0a739, lines 33-42
// and 46-55):
//   request: { text: string, rules: string[], loop?: { users: LooperBasicInfo[] } }
//   LooperBasicInfo = { id: string, firstName: string, lastName: string }
//   result:  { intent, entities: { [name]: value }, rules }
//   output:  result.entities gains
//              loopMemberReferent = loopUser.id
//              given-name        = loopUser.firstName
//              last-name         = loopUser.lastName
//            only when a member was found; otherwise the result is untouched.
//
// Ordered resolution (LoopMemberDetector.ts:47-93), first match wins:
//   0. bail unless request.loop.users, result and result.intent are all truthy
//   1. non-empty given-name (or GivenName) AND non-empty last-name (or
//      LastName): first user with a case-insensitive firstName+lastName match
//   2. non-empty given-name only: first user with a case-insensitive firstName
//      match
//   3. no given-name value at all: first user whose `firstName lastName` appears
//      in the request text, matched case-insensitively by an UNESCAPED
//      `\b<first> <last>\b` regex
//   4. given-name entity expected (key present, even if empty): first user
//      whose `firstName` appears in the request text, matched by an UNESCAPED
//      `\b<first>\b` regex
//
// Fidelity notes (both deliberate, both observable):
//   * Steps 3 and 4 interpolate the user's name straight into a RegExp with no
//     escaping (LoopMemberDetector.ts:73,84). A member name containing regex
//     metacharacters therefore behaves as a pattern, not a literal.
//   * Steps 3 and 4 guard on no member name being usable; a member whose
//     firstName/lastName is missing produces the literal `undefined` in the
//     pattern (LoopMemberDetector.ts:73,84). This port keeps that behavior
//     rather than adding a guard the source does not have.
//   * `isEqual` lowercases both sides without a type check
//     (LoopMemberDetector.ts:5-7); a malformed user alongside a given-name
//     entity throws, exactly as the source does.

function isEqual(a, b) {
  return a.toLowerCase() === b.toLowerCase();
}

function getStringEntityValue(entities, key) {
  const entityValue = entities && entities[key];
  if (typeof entityValue === 'string' && entityValue.length > 0) {
    return entityValue;
  }
  return null;
}

export class LoopMemberDetector {
  /**
   * Checks which loop member is mentioned and adds loop member entities to the
   * NLU result (LoopMemberDetector.ts:30-38). Mutates `result.entities`.
   */
  static detectLoopMembers(request, result) {
    const loopMember = LoopMemberDetector.findLoopMember(request, result);
    if (loopMember) {
      result.entities['loopMemberReferent'] = loopMember.id;
      result.entities['given-name'] = loopMember.firstName;
      result.entities['last-name'] = loopMember.lastName;
    }
    return result;
  }

  /**
   * Finds the loop member mentioned in the request, by entities then text
   * (LoopMemberDetector.ts:47-93). Returns the matched LooperBasicInfo or null.
   */
  static findLoopMember(request, result) {
    if (!request.loop || !request.loop.users || !result || !result.intent) {
      return null;
    }

    const loopUsers = request.loop.users;
    const givenNameEntityExpected = result.entities
      && (Object.prototype.hasOwnProperty.call(result.entities, 'given-name')
        || Object.prototype.hasOwnProperty.call(result.entities, 'GivenName'));
    const givenNameEntityValue = getStringEntityValue(result.entities, 'given-name')
      || getStringEntityValue(result.entities, 'GivenName');
    const lastNameEntityValue = getStringEntityValue(result.entities, 'last-name')
      || getStringEntityValue(result.entities, 'LastName');

    // 1. 'given-name' + 'last-name' entities.
    if (givenNameEntityValue && lastNameEntityValue) {
      return loopUsers.find(loopUser => isEqual(loopUser.firstName, givenNameEntityValue)
        && isEqual(loopUser.lastName, lastNameEntityValue));
    }

    // 2. 'given-name' entity only.
    if (givenNameEntityValue && !lastNameEntityValue) {
      return loopUsers.find(loopUser => isEqual(loopUser.firstName, givenNameEntityValue));
    }

    if (!givenNameEntityValue) {
      // 3. First + last name together in the request text (unescaped pattern).
      const mentionedUser = loopUsers.find(loopUser => {
        const fullNameRegEx = new RegExp(`\\b${loopUser.firstName} ${loopUser.lastName}\\b`, 'i');
        return fullNameRegEx.test(request.text);
      });
      if (mentionedUser) return mentionedUser;
    }

    if (givenNameEntityExpected) {
      // 4. First name in the request text (unescaped pattern).
      const mentionedByName = loopUsers.find(loopUser => {
        const firstNameRegEx = new RegExp(`\\b${loopUser.firstName}\\b`, 'i');
        return firstNameRegEx.test(request.text);
      });
      if (mentionedByName) return mentionedByName;
    }

    return null;
  }
}
