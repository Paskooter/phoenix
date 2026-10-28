// Counts only: never persist or expose provider bodies, model drafts, URLs or errors.
export const NEWS_REJECTION_REASONS = ['invalid', 'country', 'opinion', 'url', 'title', 'text', 'date', 'future', 'stale', 'publisher', 'excerpt'];
export const NEWS_FAILURE_REASONS = ['generation', 'model-http', 'model-incomplete', 'draft-json', 'draft-shape', 'draft-sentence', 'draft-evidence', 'draft-speech', 'draft-content'];
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
const counts = (keys, value) => Object.fromEntries(keys.map(key => [key, count(value?.[key])]));
const timestamp = value => Number.isSafeInteger(value) && value >= 0 ? value : null;

export function newsProviderDiagnostics(value) {
  if (!value || typeof value !== 'object') return null;
  return {
    ...counts(['received', 'considered', 'accepted'], value),
    rejected: counts(NEWS_REJECTION_REASONS, value.rejected),
  };
}

export function newsRunDiagnostics(value) {
  if (!value || typeof value !== 'object') return null;
  return {
    startedAt: timestamp(value.startedAt), completedAt: timestamp(value.completedAt),
    provider: newsProviderDiagnostics(value.provider),
    ...counts(['candidates', 'examined', 'duplicates', 'cached', 'cachedSkipped', 'generated', 'modelSkipped', 'published'], value),
    excluded: counts(['banned', 'opinion', 'correction'], value.excluded),
    failures: counts(NEWS_FAILURE_REASONS, value.failures),
  };
}
