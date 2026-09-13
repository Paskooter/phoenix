#!/usr/bin/env node

// Build the checked-in S-13 report-view matrix.  This file is intentionally
// deterministic: running it after changing Phoenix only changes the candidate
// provenance hashes, and the immutable contract will reject that replacement.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const fileSha = file => sha(fs.readFileSync(path.join(root, file)));

const sourceRevision = '5c0a7390539663ba749d360de348a428c088505c';
const implementationRevision = '0902410c597f8dc424af60ee98fc4d32f19a1bb0';
const sourceImage = 'node:8.9.4-slim';
const sourceImageDigest = 'sha256:8233daae003ba0ecba4e6d70cab8525c30a3f085935afc624a275892ebe23f7c';
const candidateImage = 'node:22.22.0-slim';
const candidateImageDigest = 'sha256:dd9d21971ec4395903fa6143c2b9267d048ae01ca6d3ea96f16cb30df6187d94';

const source = {
  revision: sourceRevision,
  image: sourceImage,
  imageDigest: sourceImageDigest,
  preparedPath: 'parity-prepared.json',
  preparedSha256: '6ea32b67f579e69225b98446db63789c117328206e04c780e98b5a47339f4e4f',
  compiledPath: 'parity-compiled.json',
  compiledSha256: '5a387ec70ce48f9cfacb3dd10857cbbb3840352355f379916a83c98311cb4884',
  rootManifestPath: 'package.json',
  rootManifestSha256: '410afd8bc2efee5ef2532c3fa57133d175464974352cfb79986d6fbec6aeb4ed',
  lockPath: 'yarn.lock',
  lockSha256: '8c271aefba35f68bc7669a99d2f5818836b02e1ea8fde947fa2cac35b5672b60',
  reportManifestPath: 'packages/report-skill/package.json',
  reportManifestSha256: '6460d894564435790f914a7906e0128d86e90b8f9c93400d078910137416d33f',
  testFiles: {
    'packages/report-skill/tests/subskills/Weather.test.js': 'b2209e30f28ae672d99b5842da8c673c6733f4b0af09bb0bf4f01420ddd8eeac',
    'packages/report-skill/tests/subskills/News.test.js': '3921317aae411c1630c6e3f5eb44fcce07da79209a5f16125b90b0ee2044cc00',
    'packages/report-skill/tests/subskills/Commute.test.js': '71140b44f5fe3cfda25a15fe85d425afd929f872165d5787276571c0f4c31ec6',
    'packages/report-skill/tests/subskills/Calendar.test.js': 'e3ffe3c37b74c5656dc48a4192b5501840b680c079c1a9fc999f9fdc04e39139',
    'packages/report-skill/tests/TestUtils.js': '298daca08946f19de78617bfdfb446df2988ed28507941c20473d3fd1a288e9c',
  },
  sourcePaths: {
    'packages/report-skill/src/subskills/weather/WeatherViews.ts': '10c3facad5cb6efbba2ce4623ec23d37396122ff6050d0c30a37323cc42232b1',
    'packages/report-skill/src/subskills/news/NewsViews.ts': 'd6a466ddad4994bc882f83217515b9468509909282f7ba6ffea6653afc1382c8',
    'packages/report-skill/src/subskills/commute/CommuteViews.ts': '2a11818e948f45c640450b1db825c778b74cbd8f9aa37b6f37aebb9ad2f82086',
    'packages/report-skill/src/subskills/calendar/CalendarViews.ts': '8941260270313a9ac45f3f7062537db3d1586770b3e71c394b9bbce182f0b990',
  },
  compiledPaths: {
    'packages/report-skill/lib/subskills/weather/WeatherViews.js': '1fd35022fb7c79912069cf668662c1f529eb3df059780ffc658e23349b534fe6',
    'packages/report-skill/lib/subskills/news/NewsViews.js': '4db38c5bc661c0bc3f317748a84033f931da66c267cca2e190d79d211dd8575c',
    'packages/report-skill/lib/subskills/commute/CommuteViews.js': '651af074a57ff0ba16c890daa9c9ec9d249c32060efc01c29ebbffa8014242e0',
    'packages/report-skill/lib/subskills/calendar/CalendarViews.js': '0a7574b611969db171aa1ff95555ebe2b8224a80adff2b5ba39b24d871956b6a',
    'packages/report-skill/lib/utils.js': 'fe5bba7fe80870957fa18b339141d41dc127bf3d250e7e1b051666b20b7f1e5c',
    'packages/report-skill/lib/Names.js': 'd0980ccd164e63c5ebcdd312fd19adb70d72863e64ed36c115e85b5a16e37a31',
  },
  resources: {
    'packages/report-skill/resources/views/weatherHiLo.json': '89cbcfd06e3e18d34226e7e600b756446078199db53335300ba4c5884c9d8a4a',
    'packages/report-skill/resources/views/newsHeadline.json': 'c559b0de05db6adc752280856d38284ec39d10cb3bba98c26f6ef306c3f44500',
    'packages/report-skill/resources/views/commuteTraffic.json': 'dd91bbd037f4b6493a979c55af3f0337bdda5f8c76883747aaffbf379dcd910e',
    'packages/report-skill/resources/views/commuteDepart.json': 'b57b7d1188a27231d60bb24f99392882fb24796a005c74fd031b41ffec0995e5',
    'packages/report-skill/resources/views/calendarEvent.json': '066dd3c79c8c8898872bf28fe8c78518e5352e8e7f2b1e4628ad8e0c8c810c67',
    'packages/report-skill/resources/views/calendarIconWords.json': 'f7a1c6df0612807112487da7351bc6075b5fa98d2c701c7a4e196db4a0300b78',
  },
};

const candidatePaths = {
  'packages/skills/src/report/weatherViews.js': 'e3166522922ae986ab40eac925604efa4b14f17154f95d83cbc52714de5f5ea6',
  'packages/skills/src/report/newsViews.js': '9b5a475d4c0bda4cc1ee3e01fa6f9aeb9093ce4f30bc313825e1e6a02c8c3576',
  'packages/skills/src/report/commuteViews.js': '268c66636792a1b5c809b1b0fd7487d60bdcfa7a25379fac3db870f2b791c7cf',
  'packages/skills/src/report/calendarViews.js': '5ecbf7dd8ee69562874b3eb1c648dbd1178cedfd1c66cb4767f7f2a57459acef',
  'packages/skills/src/report/utils.js': '8b13ff0884b59b7eecf3ff019777d9d09de5eed4eb0794acd5a0f55178ecf13d',
};
const candidateResources = {
  'packages/skills/resources/views/weatherHiLo.json': '89cbcfd06e3e18d34226e7e600b756446078199db53335300ba4c5884c9d8a4a',
  'packages/skills/resources/views/newsHeadline.json': 'c559b0de05db6adc752280856d38284ec39d10cb3bba98c26f6ef306c3f44500',
  'packages/skills/resources/views/commuteTraffic.json': 'dd91bbd037f4b6493a979c55af3f0337bdda5f8c76883747aaffbf379dcd910e',
  'packages/skills/resources/views/commuteDepart.json': 'b57b7d1188a27231d60bb24f99392882fb24796a005c74fd031b41ffec0995e5',
  'packages/skills/resources/views/calendarEvent.json': '066dd3c79c8c8898872bf28fe8c78518e5352e8e7f2b1e4628ad8e0c8c810c67',
  'packages/skills/resources/views/calendarIconWords.json': 'f7a1c6df0612807112487da7351bc6075b5fa98d2c701c7a4e196db4a0300b78',
};
const candidateDependencies = {
  'package.json': 'efc3628eec21d481c6961a6e706503f52093a6550f900f79969a1f226b3a5c78',
  'package-lock.json': '38841632b2ab0e8e9d9e01c77aa6ddea5e0cbdc7f8bf9f4a97dee0b8304e34d1',
  'packages/skills/package.json': '7fc2dc35ba679e5ed51bebb755919522613f6e2876ecd002fc6a506cbedbcf01',
};

const row = (id, group, sourceName, sourceLine, kind, args) => ({
  id, group, sourceName, sourceLine, kind, assertionCount: 1, args,
});
const rows = [];
for (const celsius of [false, true]) {
  for (const high of [-10, -9, 0, 9, 10, 40, 85, 86, 99, 100]) {
    rows.push(row(
      `s13:report-view:weather:${rows.length + 1}`,
      'weather',
      celsius ? `high-temperature ${high}°C unit and boundary` : `high-temperature ${high}°F unit and boundary`,
      549,
      'weather',
      [{ highTemp: high, lowTemp: high - 12, icon: 'clear-day' }, celsius],
    ));
  }
}
for (const extra of [-1, 0, 4.9, 5, 14.9, 15, 60]) {
  rows.push(row(`s13:report-view:traffic:${rows.length + 1}`, 'traffic', `traffic extra minutes ${extra}`, 372, 'traffic', [extra]));
}
for (const time of ['12:00 AM', '8:05 AM', '1:00 PM', '11:59 PM']) {
  rows.push(row(`s13:report-view:depart:${rows.length + 1}`, 'depart', `departure time ${time}`, 396, 'depart', [{ departDT: { time } }]));
}
for (const [width, height] of [[600, 1000], [1280, 720], [2000, 720], [500, 500], [300, 200]]) {
  rows.push(row(
    `s13:report-view:news:${rows.length + 1}`,
    'news',
    `news image geometry ${width}x${height}`,
    231,
    'news',
    [['strange', 'sports'].map((category, index) => ({
      category,
      headline: `Source review ${index}`,
      image: { source: `http://fixture.invalid/image-${index}.jpg`, width: String(width), height: String(height) },
    }))],
  ));
}
for (const hour of [0, 11, 12, 18, 19, 23]) {
  for (const fullDay of [false, true]) {
    for (const minute of [0, 25]) {
      const time = `${hour % 12 || 12}:${minute ? '25' : '00'} ${hour >= 12 ? 'PM' : 'AM'}`;
      rows.push(row(
        `s13:report-view:calendar:${rows.length + 1}`,
        'calendar',
        `calendar ${fullDay ? 'all-day' : 'timed'} ${hour}:${String(minute).padStart(2, '0')}`,
        612,
        'calendar',
        [[{ summary: `Birthday party and board meeting ${'.'.repeat(30)}`, fullDay, dateTime: { hour, minute, time } }], { skill: { session: { data: { _personalReport: { singleSkill: 'calendar' } } } } }],
      ));
    }
  }
}
rows.push(row(
  `s13:report-view:calendar:${rows.length + 1}`,
  'calendar',
  'calendar malformed null event is retained as null view',
  578,
  'calendar',
  [[null, { summary: 'Lunch', fullDay: true, dateTime: { hour: 12, minute: 0, time: '12:00 PM' } }], { skill: { session: { data: { _personalReport: { singleSkill: 'calendar' } } } } }],
));

const groups = { weather: 20, traffic: 7, depart: 4, news: 5, calendar: 25 };
if (rows.length !== 61) throw new Error(`expected 61 rows, got ${rows.length}`);
if (JSON.stringify(Object.fromEntries(Object.keys(groups).map(group => [group, rows.filter(item => item.group === group).length]))) !== JSON.stringify(groups)) throw new Error('matrix group inventory mismatch');

const matrix = {
  schema: 'phoenix.parity.s13.report-view-matrix.v1',
  task: 'S-13',
  base: implementationRevision,
  counts: { namedCases: 61, expandedRuns: 61, expandedAssertions: 61, groups },
  runtime: {
    source: { image: sourceImage, imageDigest: sourceImageDigest, node: 'v8.9.4' },
    candidate: { image: candidateImage, imageDigest: candidateImageDigest, node: 'v22.22.0' },
    timezone: 'UTC',
    clockISO: '2017-11-09T13:00:00.000Z',
    randomSeed: 1309,
    network: 'none',
  },
  reference: {
    repo: 'jiboV2/pegasus',
    ...source,
  },
  candidate: {
    implementationRevision,
    paths: candidatePaths,
    resources: candidateResources,
    dependencies: candidateDependencies,
  },
  rows,
};

const outputPath = path.join(here, 'matrix.json');
fs.writeFileSync(outputPath, `${JSON.stringify(matrix, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ rows: rows.length, groups, sha256: fileSha('scripts/parity-s13-source-diff/matrix.json') })}\n`);
