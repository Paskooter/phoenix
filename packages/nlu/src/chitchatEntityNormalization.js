// The archived native chitchat FST collapses three overlapping action paths
// before its NLU result crosses the parser boundary. The source AST matcher
// retains both action fields (or the less specific field) for these cases.
// Normalize only the source-shaped result fields that affect chitchat routing.

export function normalizeChitchatEntities(intent, entities) {
  const normalized = { ...(entities || {}) };

  if (intent === 'isJiboDescriptor') {
    if (normalized.GeneralDescriptor === 'Depressed') {
      delete normalized.GeneralDescriptor;
      normalized.Emotion = 'Sad';
    } else if (normalized.GeneralDescriptor === 'GoodOrEvil') {
      delete normalized.GeneralDescriptor;
      normalized.JiboDescriptor = 'GoodOrEvil';
    }
  }

  if (intent === 'doesJiboWantThing'
    && normalized.FoodGeneral === 'SomeFoodGeneral'
    && normalized.Food === 'FoodGeneral') {
    delete normalized.Food;
  }

  return normalized;
}
