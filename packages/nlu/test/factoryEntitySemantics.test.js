// N-02 acceptance 2/3: factory entity semantics recovered from version-matched
// source and preserved exactly by the production parser.
//
// The `$factory:` word lists under resources/factory-words are plain-text
// projections of the reference FSTs: they kept each spelling and dropped the
// private field name and value the reference grammar declares. The reference
// grammar sources are recovered under resources/factory-sources (origin and
// hashes in manifest.json) and their semantics are re-derived into
// word-list-semantics.json. This suite anchors both and then observes the
// production request parser.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { parseRequest } from '../src/requestParser.js';
import { deriveFactoryWordSemantics, semanticsDocument } from '../tools/extractFactoryWordSemantics.mjs';

const RES = new URL('../resources/', import.meta.url);
const SRC = new URL('factory-sources/', RES);
const manifest = JSON.parse(readFileSync(new URL('manifest.json', SRC), 'utf8'));
const semantics = JSON.parse(readFileSync(new URL('word-list-semantics.json', SRC), 'utf8'));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

test('every vendored factory source matches the manifest hash and its recorded upstream size', () => {
  assert.equal(manifest.schema, 'phoenix.nlu.factory-source-manifest');
  assert.equal(manifest.recoveredFrom.repo, 'ConvTech/jibo-nlu-data');
  assert.equal(manifest.factories.length, 15, 'the en-us factory_rules set has 15 .grm files');
  let vendored = 0;
  for (const f of manifest.factories) {
    const path = new URL(`${f.name}.grm`, SRC);
    if (!f.vendored) {
      // The portal returned a byte-truncated body for these; no partial source
      // is vendored so a wrong hash cannot masquerade as the real grammar.
      assert.equal(f.complete, false, `${f.name}: unvendored entry is marked incomplete`);
      assert.equal(existsSync(path), false, `${f.name}: truncated source must not be vendored`);
      assert.ok(f.recoveredBytes < f.upstreamBytes, `${f.name}: recoveredBytes < upstreamBytes`);
      continue;
    }
    vendored += 1;
    const bytes = readFileSync(path);
    assert.equal(bytes.length, f.upstreamBytes, `${f.name}: byte length equals the upstream blob size`);
    assert.equal(sha(bytes), f.sha256, `${f.name}: vendored hash matches the manifest`);
  }
  assert.equal(vendored, 13, '13 complete sources vendored');
});

test('the word-list semantics artifact is exactly what the recovered sources derive', () => {
  assert.deepEqual(semantics, semanticsDocument(), 'regenerate and compare');
  // The published field per factory, as the reference grammar declares it.
  assert.deepEqual(Object.fromEntries(Object.entries(semantics.factories).map(([k, v]) => [k, v.field])), {
    canada_province: '_nl',
    country: '_country',
    first_name: '_first_name',
    music_genre: '_genre',
    state: '_nl',
  });
  // state.grm carries a literal per arm: the two-letter code, not the name.
  assert.equal(semantics.factories.state.values.california, 'ca');
  assert.equal(semantics.factories.state.values.texas, 'tx');
  assert.equal(semantics.factories.music_genre.values.jungle, 'g.287');
  // Families that publish the matched text carry no value table.
  assert.equal(semantics.factories.country.values, undefined);
  assert.equal(semantics.factories.canada_province.values, undefined);
});

test('the recovered field names are the ones the references rules read', () => {
  const genred = readFileSync(new URL('../resources/rules-src/clock/launch.rule', import.meta.url), 'utf8');
  assert.match(genred, /\{_state=state\._nl\}/, 'D_TIME_USSTATE reads state._nl');
  assert.match(genred, /\{_state=canada_province\._nl\}/, 'D_TIME_CANADA_PROVINCE reads canada_province._nl');
  assert.match(genred, /\{_country=country\._country\}/, 'D_TIME_COUNTRY reads country._country');
});

// ---- production parser: exact entity values through POST /v1/parse ----

const parse = text => parseRequest({ text, rules: ['launch'] });

test('the state factory publishes the reference two-letter code at runtime', () => {
  const california = parse('what time is it in california');
  assert.equal(california.intent, 'askForTime');
  assert.equal(california.entities.state, 'ca');
  assert.equal(california.entities.skill, '@be/clock');

  const texas = parse('what time is it in texas usa');
  assert.equal(texas.entities.state, 'tx');
  assert.equal(texas.entities.country, 'usa');
});

test('the canada_province factory publishes the spoken province', () => {
  assert.equal(parse('what time is it in ontario').entities.state, 'ontario');
  const quebec = parse('what time is it in quebec');
  assert.equal(quebec.entities.state, 'quebec');
  // Known divergence (reported, not fixed here): the bundled word-list
  // projection stores the accented arm as mojibake (`quÃ©bec`, UTF-8 read as
  // Latin-1), so the accented spelling `québec` does not reach the factory,
  // even though the recovered source declares it. The word list is a
  // Pegasus-provenance-fenced asset, so changing it needs a fixture re-review.
});

test('a country slot still resolves through the word-list projection unchanged', () => {
  assert.equal(parse('what time is it in france').entities.country, 'france');
});
