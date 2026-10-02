// Invented source material for offline news integration tests.
export const newsSpeech = {
  tone: 'bright',
  sentences: [
    'NASA reports that a new satellite has started mapping coastal waters to help researchers study changes in ocean temperatures.',
    'The spacecraft measures surface conditions across wide areas, giving scientists a clearer picture of how those waters vary.',
    'Researchers will compare these observations with earlier measurements as they examine seasonal patterns along coastlines.',
  ],
};
export const newsDraft = {
  usable: true, tone: newsSpeech.tone,
  sentences: newsSpeech.sentences.map((text, index) => ({ text, evidence: [index + 1] })),
};
export const newsTime = Date.parse('2026-10-02T12:00:00Z');
export const worldArticle = {
  id: 1, title: 'A satellite maps coastal waters', url: 'https://www.nasa.gov/fixture-news',
  publish_date: '2026-10-02 10:00:00', source_country: 'us',
  text: newsSpeech.sentences.join(' ') + ' ' + newsSpeech.sentences.join(' '),
};
export const newsBriefing = {
  id: 'a'.repeat(64), title: worldArticle.title, publisher: 'NASA', url: worldArticle.url,
  publishedAt: '2026-10-02T10:00:00Z', generatedAt: '2026-10-02T12:00:00Z',
  adult: false, speech: newsSpeech,
};
