#!/usr/bin/env node
// Broad grammar differential against Jibo's own parser.
//
// capture.mjs covers the global-command surface with a hand-chosen list. This
// sweeps a much larger corpus: the 4,925 verbatim training phrases in the
// pinned Dialogflow agent's usersays files. They are real sentences real people
// were recorded saying to Jibo, not utterances invented by this project, so
// they exercise the chitchat surface the way it was actually exercised.
//
// Both sides parse the same text against the same rule; the oracle's answer is
// the reference. Disagreements are grouped by (oracle intent -> phoenix intent)
// so a systematic divergence shows up as one large bucket rather than hundreds
// of individual rows.
//
// Usage:
//   node scripts/parity-nlu-oracle/sweep.mjs [--limit N] [--out FILE]

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../..');
const REFERENCE = '5c0a7390539663ba749d360de348a428c088505c';
const PACKAGE = join(repo, '.parity/reviews/n02-native-rebuild-followup-20260906/cache-2.8.3-package/build');
const FSTS = join(repo, '.parity/reference', REFERENCE, 'packages/parser/robust-parser/rules_fst');
const AGENT = join(repo, '.parity/reference', REFERENCE, 'packages/parser/dialogflow/main_agent/intents');

/** The binary echoes input with runs of whitespace collapsed; key on that form. */
function key(text) {
  return String(text).toLowerCase().replace(/\s+/g, ' ').trim();
}

function arg(name, fallback = null) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

/** Verbatim training phrases. Rows with an unresolved @Entity are skipped. */
function corpus() {
  const seen = new Set();
  for (const file of readdirSync(AGENT)) {
    if (!file.includes('usersays')) continue;
    let rows;
    try { rows = JSON.parse(readFileSync(join(AGENT, file), 'utf8')); } catch { continue; }
    for (const row of Array.isArray(rows) ? rows : []) {
      const text = (row.data || []).map((part) => part.text).join('').trim();
      // The parser lowercases input; keep one canonical form per phrase.
      const normalised = key(text);
      if (!normalised || normalised.includes('@') || normalised.includes('\t')) continue;
      seen.add(normalised);
    }
  }
  return [...seen].sort();
}

/**
 * Parse one batch through the original binary.
 *
 * The original aborts the WHOLE run on a rule-level JS error rather than
 * skipping the offending sentence -- clock/launch.rule:457 writes `ths._parsed`
 * for `this._parsed`, so any utterance reaching its LAST_NAME arm throws
 * `ReferenceError: ths is not defined` and takes every later result with it.
 * Batching contains the damage; a failing batch is then split so only the
 * genuinely poisonous sentences are lost, and they are reported rather than
 * silently dropped.
 */
function parseBatch(texts) {
  const listFile = join(here, '.sweep-utterances.txt');
  writeFileSync(listFile, `${texts.join('\n')}\n`);
  const stdout = execFileSync(join(PACKAGE, 'bin/parse'), [
    '--fst', join(FSTS, 'launch.fst'), '--txt', listFile, '--json',
  ], {
    env: { ...process.env, LD_LIBRARY_PATH: join(PACKAGE, 'lib') },
    maxBuffer: 512 * 1024 * 1024,
    encoding: 'utf8',
  });
  const out = new Map();
  stdout.trim().split('\n').forEach((line, index) => {
    let results;
    try { results = JSON.parse(line); } catch { return; }
    if (!Array.isArray(results)) return;
    const echoed = results.length ? key(results[0].Input) : key(texts[index]);
    out.set(echoed, results.length ? results[0].NLParse.intent ?? null : null);
  });
  if (out.size < texts.length) {
    // A truncated run means the binary died partway; treat it as a failure so
    // the caller subdivides instead of recording missing rows as no-match.
    throw new Error(`batch produced ${out.size}/${texts.length} results`);
  }
  return out;
}

function runOracle(texts, batchSize, poisoned) {
  const out = new Map();
  for (let start = 0; start < texts.length; start += batchSize) {
    const batch = texts.slice(start, start + batchSize);
    try {
      for (const [k, v] of parseBatch(batch)) out.set(k, v);
    } catch {
      if (batch.length === 1) { poisoned.push(batch[0]); continue; }
      const half = Math.ceil(batch.length / 2);
      for (const [k, v] of runOracle(batch.slice(0, half), half, poisoned)) out.set(k, v);
      for (const [k, v] of runOracle(batch.slice(half), batch.length - half, poisoned)) out.set(k, v);
    }
  }
  return out;
}

async function main() {
  if (!existsSync(join(PACKAGE, 'bin/parse')) || !existsSync(join(FSTS, 'launch.fst'))) {
    console.error('the original parser or its FSTs are not present; this sweep needs both');
    process.exit(2);
  }
  const limit = Number(arg('--limit', '0')) || 0;
  let texts = corpus();
  if (limit) texts = texts.slice(0, limit);
  console.log(`corpus: ${texts.length} verbatim training phrases`);

  const poisoned = [];
  const oracle = runOracle(texts, Number(arg('--batch', '250')), poisoned);
  if (poisoned.length) {
    console.log(`\nthe original parser ABORTS on ${poisoned.length} of these sentences`);
    console.log('(clock/launch.rule:457 writes `ths._parsed` for `this._parsed`)');
    for (const text of poisoned.slice(0, 10)) console.log(`  ${JSON.stringify(text)}`);
  }
  const { parseRequest } = await import('../../packages/nlu/src/requestParser.js');

  let agree = 0;
  // Results are keyed by the sentence the binary echoes back, which is not
  // always byte-identical to what was sent (it normalises some punctuation), so
  // a row can go unmatched. Count those rather than letting them quietly
  // inflate the agreement rate.
  const unmatched = [];
  const buckets = new Map();
  const rows = [];
  for (const text of texts) {
    if (!oracle.has(text)) { unmatched.push(text); continue; }
    const want = oracle.get(text) ?? null;
    let got = null;
    try { got = parseRequest({ text, rules: ['launch'] }).intent ?? null; } catch (error) { got = `ERROR:${error.message}`; }
    if (want === got) { agree += 1; continue; }
    const key = `${want} -> ${got}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(text);
    rows.push({ text, oracle: want, phoenix: got });
  }

  const ranked = [...buckets.entries()].sort((a, b) => b[1].length - a[1].length);
  const graded = texts.length - poisoned.length - unmatched.length;
  console.log(`\ngraded ${graded} of ${texts.length}`
    + `${poisoned.length ? `; ${poisoned.length} crashed the original` : ''}`
    + `${unmatched.length ? `; ${unmatched.length} unmatched by key` : ''}`);
  console.log(`agreement: ${agree}/${graded} (${(100 * agree / graded).toFixed(2)}%)`);
  if (unmatched.length) {
    console.log(`\nunmatched examples: ${unmatched.slice(0, 5).map((t) => JSON.stringify(t)).join(', ')}`);
  }
  if (ranked.length) {
    console.log(`\ndisagreement buckets (${ranked.length}):`);
    for (const [key, list] of ranked.slice(0, 25)) {
      console.log(`  ${String(list.length).padStart(5)}  ${key}`);
      console.log(`         e.g. ${JSON.stringify(list[0])}`);
    }
  }

  const out = arg('--out');
  if (out) {
    writeFileSync(out, `${JSON.stringify({
      corpus: texts.length,
      graded: texts.length - poisoned.length - unmatched.length,
      agree,
      poisoned,
      unmatched,
      reference: REFERENCE,
      rows,
    }, null, 2)}\n`);
    console.log(`\nwrote ${out}`);
  }
}

main().catch((error) => { console.error(error.message); process.exit(1); });
