// Versioned public briefing contract. Only this renderer creates Jibo ESML.
export const NEWS_BRIEFING_VERSION = 1;
export const NEWS_PROMPT_VERSION = 'jibo-news-1';
export const newsWordCount = (text) => (String(text).match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu) || []).length;

export function plainNewsText(value, max = 16000) {
  return String(value ?? '').replace(/<[^>]*>/g, ' ').replace(/&(?:amp|nbsp);/g, ' ')
    .replace(/&(?:quot|apos);/g, "'").replace(/[\x00-\x1f]/g, ' ')
    .replace(/\s+/g, ' ').trim().slice(0, max);
}

export function newsHttpUrl(value) {
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return null;
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) {
      if (/^utm_|^(fbclid|gclid|at_campaign|at_medium)$/.test(key)) url.searchParams.delete(key);
    }
    return url.href;
  } catch { return null; }
}

export function validateNewsSpeech(speech) {
  if (!speech || !['neutral', 'bright'].includes(speech.tone)
      || !Array.isArray(speech.sentences) || speech.sentences.length !== 3) {
    throw new Error('Invalid news speech shape');
  }
  for (const sentence of speech.sentences) {
    if (typeof sentence !== 'string' || sentence.trim() !== sentence || sentence.length > 220
        || /[<>&\x00-\x1f]|\$\{|https?:\/\//i.test(sentence)
        || newsWordCount(sentence) < 8 || newsWordCount(sentence) > 26
        || !/[.!?]$/.test(sentence)) throw new Error('Invalid news sentence');
  }
  const words = newsWordCount(speech.sentences.join(' '));
  // Aim for 50–60; allow a small margin, never pad or truncate a factual sentence.
  if (words < 48 || words > 62) throw new Error(`News speech must contain 48–62 words (received ${words})`);
  return speech;
}

export function renderNewsBriefing(speech) {
  validateNewsSpeech(speech);
  const [first, ...rest] = speech.sentences;
  const style = speech.tone === 'bright' ? 'enthusiastic' : 'neutral';
  // Jibo's break takes seconds in `size`, not SSML's `time` attribute.
  // No model-provided tags, animation names, paths, or nested pitch wrappers.
  return [`<style set="${style}">${first}</style>`, ...rest].join('<break size="0.35"/>');
}

export function validateNewsBriefing(item) {
  if (!item || typeof item.id !== 'string' || !/^[a-f0-9]{64}$/.test(item.id)
      || typeof item.title !== 'string' || !item.title || item.title.length > 240
      || typeof item.publisher !== 'string' || !item.publisher || item.publisher.length > 100
      || !newsHttpUrl(item.url) || !Number.isFinite(Date.parse(item.publishedAt))
      || !Number.isFinite(Date.parse(item.generatedAt)) || typeof item.adult !== 'boolean') {
    throw new Error('Invalid news briefing metadata');
  }
  validateNewsSpeech(item.speech);
  return item;
}
