// Forgetting a person who deleted their Phoenix account.
//
// Removing a robot or a loop removes every record that mentions it. A person's
// account id is different: it also appears in records that belong to other
// people. Every reader of a message is listed on it, a loop's key backup names
// whichever owner made it (who may since have handed the loop on), and a loop
// setting names whoever last changed it. So each store below names the records
// that are the person's own, and only those go:
//
//   notifications  their notification token and whatever is queued on it
//   push           their registered phones
//   keys           their copies of loop keys and their binary requests (never a
//                  loop's key backup: that belongs to the loop)
//   media          what they uploaded (the files live in media/<account id>,
//                  which the purge route moves as a per-id folder)
//   jot            messages they sent and messages only for them; they are taken
//                  off the recipients and readers of everyone else's
//   person         their answers, their properties and their own holidays
//   ifttt          their IFTTT identity, its triggers and its media
//   voiceTraining  their voice samples
//
// Robot events, loop properties, loop backups and IFTTT actions belong to a
// robot or a loop, and go only when that robot or loop is removed.
//
// Each function takes the account ids (lower case) and { dryRun }, and returns
// { collection: count } for what it removed or would remove.

const idSet = (ids) => new Set(ids.map((id) => String(id).toLowerCase()));
const isOneOf = (people, value) => value !== undefined && value !== null && people.has(String(value).toLowerCase());
const mentionsOneOf = (people, value) => {
  const text = (JSON.stringify(value) ?? '').toLowerCase();
  return [...people].some((id) => text.includes(id));
};

/** Remove (or, with dryRun, only count) the entries of a Map or array that pass `test(value, key)`. */
function removeWhere(collection, test, dryRun) {
  let removed = 0;
  if (collection instanceof Map) {
    for (const [key, value] of [...collection.entries()]) {
      if (!test(value, key)) continue;
      removed += 1;
      if (!dryRun) collection.delete(key);
    }
  } else if (Array.isArray(collection)) {
    for (let index = collection.length - 1; index >= 0; index -= 1) {
      if (!test(collection[index])) continue;
      removed += 1;
      if (!dryRun) collection.splice(index, 1);
    }
  }
  return removed;
}

const nonZero = (counts) => Object.fromEntries(Object.entries(counts).filter(([, count]) => count > 0));

export function forgetNotifications(store, ids, { dryRun = true } = {}) {
  const people = idSet(ids);
  const tokenIds = new Set([...store.tokens.values()]
    .filter((token) => isOneOf(people, token.accountId)).map((token) => String(token._id)));
  return nonZero({
    notifications: removeWhere(store.notifications, (entry) => tokenIds.has(String(entry.tokenId)), dryRun),
    tokens: removeWhere(store.tokens, (token) => isOneOf(people, token.accountId), dryRun),
  });
}

export function forgetPushDevices(registry, ids, { dryRun = true } = {}) {
  const people = idSet(ids);
  return nonZero({
    accounts: removeWhere(registry.accounts, (entry, key) => isOneOf(people, key) || isOneOf(people, entry?.accountId), dryRun),
  });
}

export function forgetKeys(store, ids, { dryRun = true } = {}) {
  const people = idSet(ids);
  return nonZero({
    keys: removeWhere(store.keys, (key) => isOneOf(people, key.accountId), dryRun),
    binaries: removeWhere(store.binaries, (binary) => isOneOf(people, binary.accountId), dryRun),
  });
}

export function forgetMedia(store, ids, { dryRun = true } = {}) {
  const people = idSet(ids);
  return nonZero({
    records: removeWhere(store.records, (record) => isOneOf(people, record.accountId), dryRun),
  });
}

/**
 * Jot tags say whom a message is for, and `read` lists who has read it. Neither
 * makes the message theirs: a message goes when they sent it, or when it was for
 * them alone. An untagged message is for the whole loop, so a message tagged only
 * for them must not become one by losing its last tag.
 */
export function forgetJot(store, ids, { dryRun = true } = {}) {
  const people = idSet(ids);
  let messages = 0;
  let edited = 0;
  for (let index = store.messages.length - 1; index >= 0; index -= 1) {
    const message = store.messages[index];
    const tags = message.tags || [];
    const read = message.read || [];
    const keptTags = tags.filter((id) => !isOneOf(people, id));
    const keptRead = read.filter((id) => !isOneOf(people, id));
    if (isOneOf(people, message.sender) || (tags.length && !keptTags.length)) {
      messages += 1;
      if (!dryRun) store.messages.splice(index, 1);
    } else if (keptTags.length !== tags.length || keptRead.length !== read.length) {
      edited += 1;
      if (!dryRun) { message.tags = keptTags; message.read = keptRead; }
    }
  }
  return nonZero({
    messages,
    messagesForOthers: edited,
    // The record of message events kept in place of the retired message bus.
    events: removeWhere(store.events, (event) => mentionsOneOf(people, event), dryRun),
  });
}

export function forgetPerson(store, ids, { dryRun = true } = {}) {
  const people = idSet(ids);
  return nonZero({
    answers: removeWhere(store.answers, (record) => isOneOf(people, record.accountId), dryRun),
    accountProperties: removeWhere(store.accountProperties, (record) => isOneOf(people, record.accountId), dryRun),
    holidays: removeWhere(store.holidays, (record) => isOneOf(people, record.memberId), dryRun),
  });
}

/** An IFTTT identity is the Phoenix account id that connected IFTTT. */
export function forgetIfttt(store, ids, { dryRun = true } = {}) {
  const people = idSet(ids);
  return nonZero({
    identities: removeWhere(store.identities, (identity, key) => isOneOf(people, key) || isOneOf(people, identity?.id), dryRun),
    triggers: removeWhere(store.triggers, (row) => isOneOf(people, row.identity), dryRun),
    media: removeWhere(store.media, (row) => isOneOf(people, row.identity), dryRun),
    notifications: removeWhere(store.notifications, (row) => mentionsOneOf(people, row), dryRun),
  });
}

/** A voice sample is theirs when they uploaded it or its key names them. */
export function forgetVoiceTraining(store, ids, { dryRun = true } = {}) {
  const people = idSet(ids);
  return nonZero({
    records: removeWhere(store.records, (record) => isOneOf(people, record.accountId)
      || [...people].some((id) => String(record.path || '').toLowerCase().includes(id)), dryRun),
  });
}
