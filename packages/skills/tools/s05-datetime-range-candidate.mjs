import fs from 'node:fs';

const candidateRoot = process.env.S05_CANDIDATE_ROOT || '/phoenix';
const { DateTime } = await import(`${candidateRoot}/packages/skills/src/graph/mims/dateTime.js`);
const fixed = Date.parse('2020-02-29T04:30:00.000Z');
Date.now = () => fixed;
const dateTime = new DateTime('2020-02-29T23:30:00-05:00');
const values = [
  '0/0', '0/1', '1/0', '1/1', '1/2', '1/31', '1/32', '2/0', '2/1',
  '2/28', '2/29', '2/30', '3/0', '3/1', '3/31', '3/32', '4/1', '6/1',
  '12/31', '13/1', '13/32', 'bad', '1', '01-01', '1-1', ' 1/1',
];
const pairs = [];
for (const start of values) {
  for (const end of values) {
    let result;
    try { result = dateTime.isInRange(start, end); } catch (error) { result = { throw: error.message }; }
    pairs.push([start, end, result]);
  }
}
fs.writeFileSync(process.argv[2] || '/tmp/s05-date-ranges.json', JSON.stringify(pairs));
