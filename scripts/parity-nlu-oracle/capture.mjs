#!/usr/bin/env node
// Capture ground truth from the REAL jibo-nlu parser, then diff Phoenix against it.
//
// The recovered 2.8.3 package ships the original `parse` executable, and the
// reference tree ships the compiled FSTs it reads. Together they are an oracle:
// not a reimplementation's opinion about what Jibo did, but Jibo's own parser
// answering the question.
//
// Both inputs are large private artifacts kept out of Git. This script records
// the oracle's answers into a small golden file that CAN be committed, so the
// differential keeps running in CI long after the binary is unavailable.
//
// Usage:
//   node scripts/parity-nlu-oracle/capture.mjs --write   # re-capture the golden
//   node scripts/parity-nlu-oracle/capture.mjs           # diff Phoenix vs golden

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../..');
const GOLDEN = join(repo, 'packages/nlu/resources/legacy-oracle/globals-golden.json');

const PACKAGE = join(repo, '.parity/reviews/n02-native-rebuild-followup-20260906/cache-2.8.3-package/build');
const FSTS = join(repo, '.parity/reference/5c0a7390539663ba749d360de348a428c088505c',
  'packages/parser/robust-parser/rules_fst');

// The rules a global turn parses against; see packages/gateway/src/listenTransaction.js.
const FST_FILES = [
  'launch.fst',
  'globals/global_commands_launch.fst',
  'globals/gui_nav.fst',
  'globals/mim_repeat.fst',
  'globals/mim_thanks.fst',
];
const RULES = [
  'launch',
  'globals/global_commands_launch',
  'globals/gui_nav',
  'globals/mim_repeat',
  'globals/mim_thanks',
];

// Everyday commands, weighted toward the global-command surface this covers.
export const UTTERANCES = [
  // global commands
  'turn up the volume', 'turn down the volume', 'set the volume to five',
  'volume up', 'volume down', 'louder', 'quieter', 'too loud', 'too soft',
  'stop', 'go to sleep', 'go back to sleep', 'help', 'main menu',
  'repeat that', 'say that again', 'thank you', 'thanks jibo',
  'turn around', 'look over here', 'what can you do',
  // GUI navigation
  'go back', 'next', 'previous', 'the first one', 'the second one', 'close that',
  // skill launches that must keep beating the globals
  'what time is it', 'what is the date', 'set an alarm for seven a m',
  'turn on the lights', 'turn off the lights', 'dim the lights',
  'take a picture', 'open the gallery', 'who am i', 'good morning', 'goodbye',
  'how is my commute', "what's in the news", 'how much battery do you have',
  // open domain
  'what year is it', 'what song is this', 'what stations do you have',
  'tell me a joke', 'sing me a song', 'do you like pizza',
  // nothing should claim these
  'asdfgh qwerty zxcvb', 'turn it down a bit',
];

function oracleAvailable() {
  return existsSync(join(PACKAGE, 'bin/parse')) && FST_FILES.every((f) => existsSync(join(FSTS, f)));
}

/** Run the original parser over the utterances; returns text -> intent|null. */
function runOracle() {
  const listFile = join(here, '.utterances.txt');
  writeFileSync(listFile, `${UTTERANCES.join('\n')}\n`);
  const args = [];
  for (const file of FST_FILES) args.push('--fst', join(FSTS, file));
  args.push('--txt', listFile, '--json');
  const stdout = execFileSync(join(PACKAGE, 'bin/parse'), args, {
    env: { ...process.env, LD_LIBRARY_PATH: join(PACKAGE, 'lib') },
    maxBuffer: 64 * 1024 * 1024,
    encoding: 'utf8',
  });

  // One JSON array per line: every result for that utterance, best first.
  const out = {};
  const lines = stdout.trim().split('\n').filter(Boolean);
  lines.forEach((line, index) => {
    const results = JSON.parse(line);
    const text = results.length ? results[0].Input : UTTERANCES[index];
    const best = results.length ? results[0].NLParse : null;
    out[text] = {
      intent: best ? best.intent : null,
      domain: best ? best.domain ?? null : null,
      score: results.length ? results[0].heuristic_score : null,
    };
  });
  // An utterance with no parse produces `[]`, which carries no Input to key on.
  for (const text of UTTERANCES) {
    if (!(text in out)) out[text] = { intent: null, domain: null, score: null };
  }
  return out;
}

async function runPhoenix() {
  const { parseRequest } = await import('../../packages/nlu/src/requestParser.js');
  const out = {};
  for (const text of UTTERANCES) {
    const result = parseRequest({ text, rules: [...RULES] });
    out[text] = {
      intent: result.intent ?? null,
      domain: (result.entities && result.entities.domain) ?? null,
    };
  }
  return out;
}

async function main() {
  const write = process.argv.includes('--write');

  if (write) {
    if (!oracleAvailable()) {
      console.error('the original parser or its FSTs are not present; cannot re-capture');
      process.exit(2);
    }
    const oracle = runOracle();
    writeFileSync(GOLDEN, `${JSON.stringify({
      source: 'jibo-nlu 2.8.3 `parse` over the pinned rules_fst',
      reference: '5c0a7390539663ba749d360de348a428c088505c',
      rules: RULES,
      note: 'Captured by scripts/parity-nlu-oracle/capture.mjs --write. Do not hand-edit.',
      results: oracle,
    }, null, 2)}\n`);
    console.log(`wrote ${GOLDEN} (${Object.keys(oracle).length} utterances)`);
  }

  if (!existsSync(GOLDEN)) {
    console.error(`no golden capture at ${GOLDEN}; run with --write where the parser is available`);
    process.exit(2);
  }
  const golden = JSON.parse(readFileSync(GOLDEN, 'utf8')).results;
  const phoenix = await runPhoenix();

  let agree = 0;
  const disagreements = [];
  for (const text of Object.keys(golden)) {
    const want = golden[text].intent;
    const got = phoenix[text] ? phoenix[text].intent : undefined;
    if (want === got) agree += 1;
    else disagreements.push({ text, oracle: want, phoenix: got });
  }
  for (const row of disagreements) {
    console.log(`  ✗ ${row.text.padEnd(28)} oracle=${String(row.oracle).padEnd(24)} phoenix=${row.phoenix}`);
  }
  console.log(`\nPhoenix vs jibo-nlu 2.8.3: ${agree}/${Object.keys(golden).length}`);
  process.exitCode = disagreements.length ? 1 : 0;
}

main().catch((error) => { console.error(error.message); process.exit(1); });
