#!/usr/bin/env node

import crypto from 'node:crypto';

// Compact declaration for every named row in the pinned News.test.js.  The
// generated matrix is committed so a replay does not depend on parsing a test
// runner or on the test file being present in the candidate checkout.

const DEFAULT_OPTS = {
  mockNoHeadlines: false,
  duplicateItems: false,
  childSpeaker: false,
  userNotIDed: false,
  IDedSpeaker: true,
  bannedWord: false,
  correction: false,
  adultWord: false,
  noSummary: false,
};

// Counts are taken from the 60 `expect(...)` calls in the pinned archived
// test.  Each row below is projected in full, so these counts are an audit
// index for the expanded assertions rather than a replacement for them.
const assertionCounts = new Map([
  ['ServiceDown MIM if no data from service', 2],
  ['ServiceDown MIM if active categories but no headlines', 3],
  ['play default categories if user is not IDed', 6],
  ['play 3 headlines if only 1 category active', 7],
  ['play 2 headlines per category if 2 categories active', 7],
  ['play 1 headline per category if >= 3 categories active', 6],
  ['play 5 random categories if >= 5 categories active', 1],
  ['filters news items without summary', 1],
  ['filters corrections', 1],
  ['filters banned words in summary', 1],
  ['filters adult headlines for children', 1],
  ['filters adult headlines for non-IDed speaker', 1],
  ['does NOT filter adult headlines for IDed adults', 5],
  ['filters out duplicate news items', 1],
  ['landscape image fills width', 2],
  ['widescreen landscape image fills height', 2],
  ['portrait image fills height', 2],
  ['contains headline images', 1],
  ['images have unique IDs', 2],
  ['"leaveEmpty: true" for all but last image', 4],
  ['overlay text matches category name', 3],
  ['asset src is image source', 1],
]);

const cases = [];
const add = (group, sourceName, sourceLine, opts, activeNewsCategories = {}) => {
  cases.push({
    id: `s10:${group}:${String(cases.filter(item => item.group === group).length + 1).padStart(2, '0')}`,
    group,
    sourceName,
    sourceLine,
    assertionCount: assertionCounts.get(sourceName),
    operation: 'logic',
    runs: [{
      opts: opts === null ? null : { ...DEFAULT_OPTS, ...opts },
      activeNewsCategories,
      localISO: '2018-01-01T12:00:00.000Z',
    }],
  });
};

// Top-level rows (lines are source test line numbers).
add('top-level', 'ServiceDown MIM if no data from service', 58, null);
add('top-level', 'ServiceDown MIM if active categories but no headlines', 67,
  { mockNoHeadlines: true }, { technology: true, business: true });
add('top-level', 'play default categories if user is not IDed', 78,
  { userNotIDed: true });
add('top-level', 'play 3 headlines if only 1 category active', 92,
  {}, { technology: true });
add('top-level', 'play 2 headlines per category if 2 categories active', 107,
  {}, { technology: true, business: true });
add('top-level', 'play 1 headline per category if >= 3 categories active', 122,
  {}, { technology: true, business: true, strange: true, sports: true });
add('top-level', 'play 5 random categories if >= 5 categories active', 136,
  {}, { technology: true, business: true, strange: true, national: true, international: true, general: true, sports: true });

// Filtering rows (the nested beforeEach fixes these three active categories).
const filtering = { technology: true, business: true, strange: true };
add('filtering', 'filters news items without summary', 158, { noSummary: true }, filtering);
add('filtering', 'filters corrections', 166, { correction: true }, filtering);
add('filtering', 'filters banned words in summary', 174, { bannedWord: true }, filtering);
add('filtering', 'filters adult headlines for children', 182, { adultWord: true, childSpeaker: true }, filtering);
add('filtering', 'filters adult headlines for non-IDed speaker', 191, { adultWord: true, IDedSpeaker: false }, filtering);
add('filtering', 'does NOT filter adult headlines for IDed adults', 200, { adultWord: true }, filtering);
add('filtering', 'filters out duplicate news items', 213, { duplicateItems: true }, filtering);

// View rows (the nested beforeEach fixes technology unless overridden).
const technology = { technology: true };
add('views', 'landscape image fills width', 231, { imageWidth: 512, imageHeight: 300 }, technology);
add('views', 'widescreen landscape image fills height', 241, { imageWidth: 512, imageHeight: 200 }, technology);
add('views', 'portrait image fills height', 251, { imageWidth: 300, imageHeight: 512 }, technology);
add('views', 'contains headline images', 261, {}, technology);
add('views', 'images have unique IDs', 268, {}, technology);
add('views', '"leaveEmpty: true" for all but last image', 276, {}, { technology: true, business: true });
add('views', 'overlay text matches category name', 287, {}, { technology: true, business: true, strange: true });
add('views', 'asset src is image source', 298, {}, technology);

const groups = { 'top-level': 7, filtering: 7, views: 8 };
const apFixtures = [
  {
    id: 's10:ap-fixture:01',
    exportName: 'apNewsXMLResponse',
    category: 'entertainment',
    sourceID: 42201,
    sourceEntryCount: 11,
    localISO: '2018-01-01T12:00:00.000Z',
  },
  {
    id: 's10:ap-fixture:02',
    exportName: 'apNewsXMLResponseTwo',
    category: 'entertainment',
    sourceID: 42201,
    sourceEntryCount: 1,
    localISO: '2018-01-01T12:00:00.000Z',
  },
];
for (const [group, expected] of Object.entries(groups)) {
  const actual = cases.filter(item => item.group === group).length;
  if (actual !== expected) throw new Error(`S-10 matrix ${group}: expected ${expected}, got ${actual}`);
}
if (cases.length !== 22) throw new Error(`S-10 matrix: expected 22 named cases, got ${cases.length}`);
if (cases.some(item => !Number.isInteger(item.assertionCount))) throw new Error('S-10 matrix: assertion count missing');

const inventory = cases.map(item => ({
  id: item.id,
  group: item.group,
  sourceName: item.sourceName,
  sourceLine: item.sourceLine,
  assertionCount: item.assertionCount,
  runCount: item.runs.length,
}));
const inventorySha256 = crypto.createHash('sha256').update(JSON.stringify(inventory)).digest('hex');
const sourceExpectCalls = cases.reduce((sum, item) => sum + item.assertionCount, 0);
if (sourceExpectCalls !== 60) throw new Error(`S-10 matrix: expected 60 source assertions, got ${sourceExpectCalls}`);
const caseMatrixSha256 = crypto.createHash('sha256').update(JSON.stringify(cases)).digest('hex');
const fixtureMatrixSha256 = crypto.createHash('sha256').update(JSON.stringify(apFixtures)).digest('hex');

const matrix = {
  schema: 'phoenix.parity.s10.news-matrix.v1',
  task: 'S-10',
  reference: {
    repo: 'jiboV2/pegasus',
    revision: '5c0a7390539663ba749d360de348a428c088505c',
    testPath: 'packages/report-skill/tests/subskills/News.test.js',
    testSha256: '3921317aae411c1630c6e3f5eb44fcce07da79209a5f16125b90b0ee2044cc00',
    testSupportPath: 'packages/report-skill/tests/TestUtils.js',
    testSupportSha256: '298daca08946f19de78617bfdfb446df2988ed28507941c20473d3fd1a288e9c',
    compiledRecordSha256: '5a387ec70ce48f9cfacb3dd10857cbbb3840352355f379916a83c98311cb4884',
    sourcePaths: [
      'packages/report-skill/src/subskills/news/NewsData.ts',
      'packages/report-skill/src/subskills/news/NewsParse.ts',
      'packages/report-skill/src/subskills/news/NewsMimLogic.ts',
      'packages/report-skill/src/subskills/news/NewsViews.ts',
    ],
    sourceHashes: {
      'packages/report-skill/src/subskills/news/NewsData.ts': '36c1e2d99a7a775ab12ac67b25c6fef6b66dd920ae6c317e4333f67ba95f16da',
      'packages/report-skill/src/subskills/news/NewsParse.ts': 'e74154d76ef7041dbe09b942e96cdbafe08730d236a2f69b46c490ad8bdb1b25',
      'packages/report-skill/src/subskills/news/NewsMimLogic.ts': 'ba6e680f9c054bc4a0d690d9f520c83b2f0ba80626d3bac6a40497e60ca15bf1',
      'packages/report-skill/src/subskills/news/NewsViews.ts': 'd6a466ddad4994bc882f83217515b9468509909282f7ba6ffea6653afc1382c8'
    },
    compiledHashes: {
      'packages/report-skill/lib/subskills/news/NewsData.js': 'bf514f63da6d264af00e11651777b2de5150fa26dbbc6f494ceed23f97ffccca',
      'packages/report-skill/lib/subskills/news/NewsFactory.js': '401474bd5847ebefb85091a56ae8c38fffda8992695a374725479dfbf926b237',
      'packages/report-skill/lib/subskills/news/NewsMimLogic.js': '5db8b6a01b5ba518c8083bf1ad6838685eadc27923aa1c9f260e760c52601dc6',
      'packages/report-skill/lib/subskills/news/NewsParse.js': '44e91a41643909fb890d75afbaa5aef2192b00f6ed52f82ed31dd69fc401592e',
      'packages/report-skill/lib/subskills/news/NewsViews.js': '4db38c5bc661c0bc3f317748a84033f931da66c267cca2e190d79d211dd8575c',
      'packages/report-skill/lib/subskills/news/index.js': 'ae82c9e3c31d4b33cb9f04cbed8e858ca0adbba4de2c559844e6d1b85ea27dcf',
    },
    resourceHashes: {
      'packages/report-skill/resources/views/newsHeadline.json': 'c559b0de05db6adc752280856d38284ec39d10cb3bba98c26f6ef306c3f44500'
    },
    fixtureSource: {
      sourcePath: 'packages/test-utils/src/lasso-test/APNewsTestData.ts',
      sourceSha256: 'd0f28597b8353a0fa182b8ac8e9bac341848ae9a2e78fa32450ce2c201ea4958',
      compiledPath: 'packages/test-utils/lib/lasso-test/APNewsTestData.js',
      compiledSha256: 'd6c06c4b48beb68518428b20f7ea911faf4ec6423d70d72982ea42dd81176d0e',
      artifactPath: 'scripts/parity-s10-source-diff/ap-fixtures.json',
      artifactSha256: '9b199398172e9c08391300b1f8fbca6a55f094a2f082c979f0fb09da2c68d717',
      exports: ['apNewsXMLResponse', 'apNewsXMLResponseTwo'],
    },
  },
  runtime: {
    sourceImage: 'node:8.9.4-slim',
    sourceImageDigest: 'sha256:8233daae003ba0ecba4e6d70cab8525c30a3f085935afc624a275892ebe23f7c',
    timezone: 'UTC',
    clockISO: '2018-01-01T12:00:00.000Z',
    randomSeed: 0x534e4557,
  },
  counts: { namedCases: 22, expandedRuns: 22, expandedAssertions: sourceExpectCalls, fixtureProbes: apFixtures.length, groups },
  inventorySha256,
  caseMatrixSha256,
  fixtureMatrixSha256,
  apFixtures,
  cases,
};

const fs = await import('node:fs/promises');
await fs.writeFile(new URL('./matrix.json', import.meta.url), `${JSON.stringify(matrix, null, 2)}\n`);
console.log(JSON.stringify({ namedCases: matrix.counts.namedCases, expandedRuns: matrix.counts.expandedRuns, groups }));
