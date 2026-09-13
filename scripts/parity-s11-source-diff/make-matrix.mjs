#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const fileSha = file => sha(fs.readFileSync(path.join(root, file)));

const sourceRevision = '5c0a7390539663ba749d360de348a428c088505c';
const sourceImage = 'node:8.9.4-slim';
const sourceImageDigest = 'sha256:8233daae003ba0ecba4e6d70cab8525c30a3f085935afc624a275892ebe23f7c';

const sourcePaths = [
  'packages/report-skill/src/subskills/commute/CommuteData.ts',
  'packages/report-skill/src/subskills/commute/CommuteFactory.ts',
  'packages/report-skill/src/subskills/commute/CommuteMimLogic.ts',
  'packages/report-skill/src/subskills/commute/CommuteParse.ts',
  'packages/report-skill/src/subskills/commute/CommuteViews.ts',
  'packages/report-skill/src/subskills/commute/index.ts',
  'packages/report-skill/src/subskills/calendar/CalendarParse.ts',
  'packages/report-skill/src/utils.ts',
  'packages/report-skill/src/Names.ts',
  'packages/report-skill/src/LassoClient.ts',
  'packages/report-skill/src/LassoClientUtils.ts',
  'packages/report-skill/src/EnvVars.ts',
];
const sourceHashes = {
  'packages/report-skill/src/subskills/commute/CommuteData.ts': '305edcb112d4cb7d8dbb711f35f445537ca738066311706f8ba7569c9b7eb5ff',
  'packages/report-skill/src/subskills/commute/CommuteFactory.ts': '37483a53e4ea2f25de239b7fd46c65c8154a9ced494c066a50567e2c2e3e3dff',
  'packages/report-skill/src/subskills/commute/CommuteMimLogic.ts': '9026fe354b98032b20b5c6540898426cb30285906a89638d41c1d67d98d5ba1b',
  'packages/report-skill/src/subskills/commute/CommuteParse.ts': 'c9d0ab6eafaf3fb40c741246bd791f9dd1e87bc13062cec505036c2b5f12506f',
  'packages/report-skill/src/subskills/commute/CommuteViews.ts': '2a11818e948f45c640450b1db825c778b74cbd8f9aa37b6f37aebb9ad2f82086',
  'packages/report-skill/src/subskills/commute/index.ts': 'c2d9923e04feaea032b11c6418c1e4ea90a41d5a85598b33841b5941afea5833',
  'packages/report-skill/src/subskills/calendar/CalendarParse.ts': '9415b98b5893530bf444aa872bd25fbaab833d329ff200480d6ea8ae7f0a73ea',
  'packages/report-skill/src/utils.ts': 'a0dcd0219595a1293f051d277533b0de2802aa56f6e010f5d175bc15f47f6dae',
  'packages/report-skill/src/Names.ts': '6442d871900f1a95c4973baf9f7532623aa263c4157069fc48a4d24e99796320',
  'packages/report-skill/src/LassoClient.ts': '03c51556c302c9ddf48147b62b3abea2ecd250db55a00b03cca5820bc148c2c5',
  'packages/report-skill/src/LassoClientUtils.ts': '6d45345b87df0e3c325c5e8f8317f57f4894a595b4d530915110a5bcd53eb121',
  'packages/report-skill/src/EnvVars.ts': '9b62f558b9c7470f25ca69be4dcadcee647042c8bbe34abb2050ab8157b03f27',
};
const compiledPaths = [
  'packages/report-skill/lib/subskills/commute/CommuteData.js',
  'packages/report-skill/lib/subskills/commute/CommuteFactory.js',
  'packages/report-skill/lib/subskills/commute/CommuteMimLogic.js',
  'packages/report-skill/lib/subskills/commute/CommuteParse.js',
  'packages/report-skill/lib/subskills/commute/CommuteViews.js',
  'packages/report-skill/lib/subskills/commute/index.js',
  'packages/report-skill/lib/subskills/calendar/CalendarParse.js',
  'packages/report-skill/lib/utils.js',
  'packages/report-skill/lib/Names.js',
  'packages/report-skill/lib/LassoClient.js',
  'packages/report-skill/lib/LassoClientUtils.js',
  'packages/report-skill/lib/EnvVars.js',
];
const compiledHashes = {
  'packages/report-skill/lib/subskills/commute/CommuteData.js': 'adb56959a8b5703ae363be8dd32133767d91b7005f77aef79a783997c93af05c',
  'packages/report-skill/lib/subskills/commute/CommuteFactory.js': '022d7961daa278e0b0ffb9cb558dae84331710e64be70603dae9fb17b8fabf15',
  'packages/report-skill/lib/subskills/commute/CommuteMimLogic.js': 'a7bb0ee985a25213f03b4c3c4203f24f6cef668ec432b565c4486720a84c12ae',
  'packages/report-skill/lib/subskills/commute/CommuteParse.js': '47e62a9c063b1601b28acebff2bdeb3ac73c44790504c2fe814035d7513e1922',
  'packages/report-skill/lib/subskills/commute/CommuteViews.js': '651af074a57ff0ba16c890daa9c9ec9d249c32060efc01c29ebbffa8014242e0',
  'packages/report-skill/lib/subskills/commute/index.js': '08df0da67e92b5c5c8aa165b6ec89217a3cf8450bdeecedb64b8f8c48803e000',
  'packages/report-skill/lib/subskills/calendar/CalendarParse.js': '30263f8b8ceb5a1af13160d27eafffc1fd61cec35388acefae35aabd956373ba',
  'packages/report-skill/lib/utils.js': 'fe5bba7fe80870957fa18b339141d41dc127bf3d250e7e1b051666b20b7f1e5c',
  'packages/report-skill/lib/Names.js': 'd0980ccd164e63c5ebcdd312fd19adb70d72863e64ed36c115e85b5a16e37a31',
  'packages/report-skill/lib/LassoClient.js': '38c2640d359d693228d422daa015d99007fdb3d8a4c1de34bd0de2e692dc1501',
  'packages/report-skill/lib/LassoClientUtils.js': '67da130fffb04b8c3ffada3f6675e96c3017e15240d7e424a8f4e60081a0e053',
  'packages/report-skill/lib/EnvVars.js': 'fc80a5ed20300fd913e3bd36af5044190c44e45fdad485337a9b9e5c7280d5ca',
};
const resourcePaths = [
  'packages/report-skill/resources/views/commuteTraffic.json',
  'packages/report-skill/resources/views/commuteDepart.json',
];
const resourceHashes = {
  'packages/report-skill/resources/views/commuteTraffic.json': 'dd91bbd037f4b6493a979c55af3f0337bdda5f8c76883747aaffbf379dcd910e',
  'packages/report-skill/resources/views/commuteDepart.json': 'b57b7d1188a27231d60bb24f99392882fb24796a005c74fd031b41ffec0995e5',
};
const candidatePaths = [
  'packages/skills/src/report/commute.js',
  'packages/skills/src/report/commuteViews.js',
  'packages/skills/src/report/calendar.js',
  'packages/skills/src/report/dateTime.js',
  'packages/skills/src/report/utils.js',
  'packages/skills/src/graph/nodes.js',
  'packages/skills/src/graph/node.js',
  'packages/skills/src/graph/graph.js',
  'packages/skills/src/report/lassoClient.js',
  'packages/skills/src/jcpId.js',
  'packages/skills/src/graph/mims/protocol.js',
  'packages/skills/src/report/calendarViews.js',
  'packages/skills/src/report/xml.js',
  'packages/skills/src/report/env.js',
];
const candidateHashes = Object.fromEntries(candidatePaths.map(file => [file, fileSha(file)]));
const candidateResourcePaths = [
  'packages/skills/resources/views/commuteTraffic.json',
  'packages/skills/resources/views/commuteDepart.json',
];
const candidateResourceHashes = Object.fromEntries(candidateResourcePaths.map(file => [file, fileSha(file)]));
const candidateDependencyPaths = [
  'package.json',
  'package-lock.json',
  'packages/skills/package.json',
];
const candidateDependencyHashes = Object.fromEntries(candidateDependencyPaths.map(file => [file, fileSha(file)]));

const run = (operation, opts = {}, prefs = {}, extra = {}) => ({ operation, opts, prefs, ...extra });
const row = (id, group, sourceName, sourceLine, assertionCount, operation, opts, prefs, extra) => ({
  id, group, sourceName, sourceLine, assertionCount,
  runs: [run(operation, opts, prefs, extra)],
});

const cases = [
  row('s11:commute:01', 'top-level', '"ServiceDown" MIM if no data from service', 85, 1, 'logic', { commute: null }, {}, {
    replacePrefs: { commute: { active: true, origin: { lat: 42, lng: 24 }, destination: { lat: 24, lng: 42 }, mode: 'driving', complete: true } },
  }),
  row('s11:commute:02', 'top-level', '"AppSetup" MIM if no data from prefs', 106, 1, 'logic', { commute: null }, {}, {
    replacePrefs: { commute: { active: false, origin: { lat: null, lng: null }, destination: { lat: null, lng: null }, mode: null, complete: false } },
  }),
  row('s11:commute:03', 'top-level', 'no ConfirmSpeaker MIM for full report', 127, 0, 'logic'),
  row('s11:commute:04', 'get-data', 'fields are null if !commute.complete', 135, 1, 'getData', {}, { commute: { complete: false } }),
  row('s11:commute:05', 'parse', 'arrival is first event time if before normal work time', 151, 1, 'parse', { calendar: { hrsUntilFirstEvent: 0.5 } }),
  row('s11:commute:06', 'parse', 'fullDay event does not affect early arrival time', 158, 1, 'parse', { calendar: { hrsUntilFirstEvent: 0.5, addFullDayEvent: { tomorrow: false } } }),
  row('s11:commute:07', 'parse', 'arrival is commute.workTime if no calendar data', 166, 2, 'parse', { calendar: null }),
  row('s11:commute:08', 'parse', 'arrival is commute.workTime if workTime before first event', 178, 2, 'parse'),
  row('s11:commute:09', 'parse', 'arrival is commute.workTime if early event tomorrow', 189, 3, 'parse', { localISO: '2017-11-09T18:00:00.000-05:00', calendar: { hrsUntilFirstEvent: 14 } }, { commute: { workTime: { hour: 20 } } }),
  row('s11:commute:10', 'parse', 'modeIsDriving = true if commute mode "driving"', 203, 1, 'parse', {}, { commute: { mode: 'driving' } }),
  row('s11:commute:11', 'parse', 'modeIsDriving = false if commute mode is NOT "driving"', 210, 1, 'parse', {}, { commute: { mode: 'walking' } }),
  row('s11:commute:12', 'parse', 'departure = arrival - duration', 217, 1, 'parse'),
  row('s11:commute:13', 'parse', 'use duration if no duration_in_traffic', 224, 1, 'parse', { commute: { minsBaseline: 10, minsInTraffic: null } }),
  row('s11:commute:14', 'parse', 'extra minutes = duration_in_traffic - duration', 232, 1, 'parse', { commute: { minsBaseline: 10, minsInTraffic: 15 } }),
  row('s11:commute:15', 'parse', 'ignore duration_in_traffic if commute mode is NOT driving', 240, 1, 'parse', { commute: { minsBaseline: 10, minsInTraffic: 15 } }, { commute: { mode: 'walking' } }),
  row('s11:commute:16', 'parse', 'return undefined if no maps data', 249, 1, 'parse', {}, {}, { mapsData: null, directLocalData: true }),
  row('s11:commute:17', 'not-driving', '"Normal" mim if departure time within 2h', 259, 1, 'logic', {}, { commute: { mode: 'walking' } }),
  row('s11:commute:18', 'not-driving', 'ignore duration_in_traffic, always play "Normal" mim', 267, 1, 'logic', { commute: { minsInTraffic: 25 } }, { commute: { mode: 'transit' } }),
  row('s11:commute:19', 'driving-departure-over-2h', 'only play CommuteNow if any other enabled subskills', 281, 1, 'logic', {}, { commute: { workTime: { hour: 10, min: 30 } } }),
  row('s11:commute:20', 'driving-departure-over-2h', 'only play CommuteNow if only commute enabled', 289, 1, 'logic', {}, { commute: { workTime: { hour: 10, min: 30 } }, cats: { active: 'commute' } }),
  row('s11:commute:21', 'driving-departure-within-2h', 'DriveNormal, DepartTimeNormal mim if < 5 minutes of traffic', 301, 1, 'logic', { commute: { minsInTraffic: 14 } }),
  row('s11:commute:22', 'driving-departure-within-2h', 'DrivePoor, DepartTimeNotNormal mim if 5-14 minutes of traffic', 309, 1, 'logic', { commute: { minsInTraffic: 17 } }),
  row('s11:commute:23', 'driving-departure-within-2h', 'DriveTerrible, DepartTimeNotNormal mim if >= 15 minutes of traffic', 317, 1, 'logic', { commute: { minsInTraffic: 25 } }),
  row('s11:commute:24', 'driving-departure-within-2h', '"MinuteLeft" mim if departure time within 30 minutes', 325, 1, 'logic', {}, { commute: { workTime: { hour: 8, min: 30 } } }),
  row('s11:commute:25', 'driving-late', '"DriveHurry" mim if 1-9 mins late', 336, 1, 'logic', {}, { commute: { workTime: { hour: 8, min: 1 } } }),
  row('s11:commute:26', 'driving-late', '"DriveLate" mim if 10-30 mins late', 344, 1, 'logic', {}, { commute: { workTime: { hour: 7, min: 45 } } }),
  row('s11:commute:27', 'driving-late', 'only CommuteNow MIM if user is > 30 mins late (other enabled subskills)', 352, 1, 'logic', {}, { commute: { workTime: { hour: 7, min: 35 } } }),
  row('s11:commute:28', 'driving-late', 'CommuteNow if only Commute enabled', 360, 0, 'logic', {}, { commute: { workTime: { hour: 7, min: 35 } }, cats: { active: 'commute' } }),
  row('s11:commute:29', 'views', 'normal traffic view if traffic < 5 mins', 372, 1, 'logic', { commute: { minsInTraffic: 14 } }),
  row('s11:commute:30', 'views', 'bad traffic view if traffic between 5 and 15 mins', 380, 1, 'logic', { commute: { minsInTraffic: 15 } }),
  row('s11:commute:31', 'views', 'terrible traffic view if traffic >= 15 mins', 388, 1, 'logic', { commute: { minsInTraffic: 25 } }),
  row('s11:commute:32', 'views', 'Show departure time if user on time', 396, 2, 'logic', { commute: { minsInTraffic: 25 } }),
  row('s11:commute:33', 'views', 'NOT show departure time if user is late', 410, 1, 'logic', {}, { commute: { workTime: { hour: 7, min: 45 } } }),
];

// These probes are deliberately separate from the archived row inventory. They
// exercise every documented transport mode and one invalid mode while keeping
// the primary 33-row/36-assertion accounting exact.
const supplemental = [
  { id: 's11:supplemental:mode:driving', group: 'mode-boundary', sourceName: 'documented mode: driving', assertionCount: 0, runs: [run('logic', { commute: { minsInTraffic: 17 } }, { commute: { mode: 'driving' } })] },
  { id: 's11:supplemental:mode:transit', group: 'mode-boundary', sourceName: 'documented mode: transit', assertionCount: 0, runs: [run('logic', { commute: { minsInTraffic: 17 } }, { commute: { mode: 'transit' } })] },
  { id: 's11:supplemental:mode:bicycling', group: 'mode-boundary', sourceName: 'documented mode: bicycling', assertionCount: 0, runs: [run('logic', { commute: { minsInTraffic: 17 } }, { commute: { mode: 'bicycling' } })] },
  { id: 's11:supplemental:mode:walking', group: 'mode-boundary', sourceName: 'documented mode: walking', assertionCount: 0, runs: [run('logic', { commute: { minsInTraffic: 17 } }, { commute: { mode: 'walking' } })] },
  { id: 's11:supplemental:mode:invalid', group: 'mode-boundary', sourceName: 'invalid mode: invalid-mode', assertionCount: 0, runs: [run('logic', { commute: { minsInTraffic: 17 } }, { commute: { mode: 'invalid-mode' } })] },
];

const inventory = cases.map(({ id, group, sourceName, sourceLine, assertionCount, runs }) => ({
  id, group, sourceName, sourceLine, assertionCount, runCount: runs.length,
}));
const groupOrder = ['top-level', 'get-data', 'parse', 'not-driving', 'driving-departure-over-2h', 'driving-departure-within-2h', 'driving-late', 'views'];
const groups = Object.fromEntries(groupOrder.map(group => [group, cases.filter(item => item.group === group).length]));
const supplementalRecord = {
  counts: { namedCases: supplemental.length, expandedRuns: supplemental.reduce((sum, item) => sum + item.runs.length, 0), expandedAssertions: supplemental.reduce((sum, item) => sum + item.assertionCount, 0), groups: { 'mode-boundary': supplemental.length } },
  cases: supplemental,
  coverage: 'Five deterministic logic probes: driving, transit, bicycling, walking, and invalid-mode. These probes are not archived test rows and carry zero archived assertion claims. The source inventory’s broader SettingsClient, SingleSkills, and PersonalReport groups remain outside this lane.',
};
const matrix = {
  schema: 'phoenix.parity.s11.commute-matrix.v1',
  task: 'S-11',
  base: '0599e8fe60a2877cda089454a58f50f5316b7098',
  branch: 'w-s11-source-diff',
  counts: { namedCases: cases.length, expandedRuns: cases.reduce((sum, item) => sum + item.runs.length, 0), expandedAssertions: cases.reduce((sum, item) => sum + item.assertionCount, 0), groups },
  inventorySha256: sha(JSON.stringify(inventory)),
  caseMatrixSha256: sha(JSON.stringify(cases)),
  supplementalMatrixSha256: sha(JSON.stringify(supplementalRecord)),
  inventory,
  runtime: { sourceImage, sourceImageDigest, timezone: 'America/New_York', clockISO: '2017-11-09T08:00:00.000-05:00', randomSeed: 1109 },
  reference: {
    repo: 'jiboV2/pegasus',
    revision: sourceRevision,
    testPath: 'packages/report-skill/tests/subskills/Commute.test.js',
    testSha256: '71140b44f5fe3cfda25a15fe85d425afd929f872165d5787276571c0f4c31ec6',
    testSupportPath: 'packages/report-skill/tests/TestUtils.js',
    testSupportSha256: '298daca08946f19de78617bfdfb446df2988ed28507941c20473d3fd1a288e9c',
    compiledRecordSha256: '5a387ec70ce48f9cfacb3dd10857cbbb3840352355f379916a83c98311cb4884',
    sourcePaths, sourceHashes, compiledPaths, compiledHashes,
    resourcePaths, resourceHashes,
  },
  candidate: {
    paths: candidatePaths,
    hashes: candidateHashes,
    resourcePaths: candidateResourcePaths,
    resourceHashes: candidateResourceHashes,
    dependencyPaths: candidateDependencyPaths,
    dependencyHashes: candidateDependencyHashes,
  },
  cases,
  supplemental: supplementalRecord,
};

fs.writeFileSync(path.join(here, 'matrix.json'), JSON.stringify(matrix, null, 2) + '\n');
process.stdout.write(JSON.stringify({ namedCases: matrix.counts.namedCases, expandedRuns: matrix.counts.expandedRuns, expandedAssertions: matrix.counts.expandedAssertions, inventorySha256: matrix.inventorySha256, caseMatrixSha256: matrix.caseMatrixSha256 }) + '\n');
