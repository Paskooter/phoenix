// Synthetic World News/model responses, not recordings of production traffic.
// Keep every request in memory: replay exercises the real adapter and generator.
import { worldArticle, newsDraft, newsTime } from '../../../contracts/test/fixtures/newsBriefing.js';

export { newsTime, newsDraft };
export const skippedDraft = { usable: false, tone: 'neutral', sentences: [] };
export const invalidDraft = {
  ...structuredClone(newsDraft),
  sentences: newsDraft.sentences.map(sentence => ({ ...sentence, evidence: [999] })),
};
export const source = (category, index = 0, overrides = {}) => ({
  ...worldArticle,
  title: `Synthetic ${category} source ${index}`,
  url: `https://www.nasa.gov/fixture-${category}-${index}`,
  ...overrides,
});

export function emptyCategoryFeed(category) {
  if (category === 'health') return { news: [] };
  if (category === 'science') return { news: [
    source(category, 0, { source_country: undefined }),
    source(category, 1, { text: 'A headline without enough reporting.' }),
  ] };
  if (category === 'technology') return { news: [source(category)] };
  return { news: Array.from({ length: 5 }, (_, index) => source(category, index)) };
}

export function completion(draft, overrides = {}) {
  return {
    choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(draft) }, ...overrides }],
    usage: { cost: 0.00001 },
  };
}
