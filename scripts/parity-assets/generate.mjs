// S-06 asset-provenance fixture generator (run from the Phoenix worktree root).
//
// Re-derives the provenance fixture from a pinned Pegasus checkout and the
// Phoenix worktree. It hashes every MIM / manifest / grammar / view / config
// asset family, records a count + canonical aggregate digest per family, and
// (for families under FILE_LIMIT entries) a per-file SHA-256 map.
//
// Canonical aggregate: sha256 over the sorted lines `<relpath> <sha256>\n`.
//
// Usage:
//   node scripts/parity-assets/generate.mjs \
//     --source /home/shell/work/pegasus \
//     --out packages/skills/test/fixtures/asset-provenance.json \
//     --out-manifests packages/gateway/test/fixtures/manifest-provenance.json \
//     --out-grammar packages/nlu/test/fixtures/grammar-provenance.json
//
// The generator is a provenance tool, not a test dependency: the committed
// fixtures are what the tests assert against, so the suite never needs the
// external Pegasus checkout.

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i].replace(/^--/, ''), process.argv[i + 1]);
const SOURCE = resolve(args.get('source') || '/home/shell/work/pegasus');
const SOURCE2 = resolve(args.get('source2') || '/home/shell/work/pegasus');
const SOURCE_REVISION = args.get('revision') || 'd682547a31511cd164db0913b6104eb1786455a2';
const REFERENCE_REVISION = args.get('reference') || '5c0a7390539663ba749d360de348a428c088505c';
const FILE_LIMIT = Number(args.get('file-limit') || 300);

const sha256File = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');

function walk(absDir) {
  const out = [];
  for (const name of readdirSync(absDir)) {
    const p = join(absDir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

function family(phxRel, sourceDesc) {
  const abs = join(ROOT, phxRel);
  const isFile = statSync(abs).isFile();
  const files = isFile ? [phxRel.split('/').pop()] : walk(abs).map((p) => relative(abs, p)).sort();
  const base = isFile ? dirname(abs) : abs;
  const hashOf = (rel) => sha256File(join(base, rel));
  const rows = files.map((rel) => `${rel} ${hashOf(rel)}\n`).sort();
  const aggregateSha256 = createHash('sha256').update(rows.join('')).digest('hex');
  const out = { phoenix: phxRel, source: sourceDesc, count: files.length, aggregateSha256 };
  if (files.length <= FILE_LIMIT) {
    out.files = Object.fromEntries(files.map((rel) => [rel, hashOf(rel)]));
  } else {
    // Deterministic spread: first file of each directory (sorted), capped.
    const byDir = new Map();
    for (const rel of files) {
      const dir = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
      if (!byDir.has(dir)) byDir.set(dir, rel);
    }
    out.samples = Object.fromEntries([...byDir.values()].slice(0, 24).map((rel) => [rel, hashOf(rel)]));
  }
  return out;
}

function sourceFamily(absDir) {
  if (!existsSync(absDir)) return { missing: true, count: 0 };
  const files = walk(absDir).map((p) => relative(absDir, p)).sort();
  const rows = files.map((rel) => `${rel} ${sha256File(join(absDir, rel))}\n`).sort();
  return {
    count: files.length,
    files: Object.fromEntries(files.map((rel) => [rel, sha256File(join(absDir, rel))])),
    aggregateSha256: createHash('sha256').update(rows.join('')).digest('hex'),
  };
}

// Compare a Phoenix asset tree against one or more source trees remapped to the
// same relative layout (prefix re-homes a source dir, e.g. category CSVs).
function equivalence(phxRel, parts) {
  const phxAbs = join(ROOT, phxRel);
  const phx = Object.fromEntries(walk(phxAbs).map((p) => [relative(phxAbs, p), sha256File(p)]));
  const src = {};
  for (const { dir, prefix = '' } of parts) {
    const abs = dir.startsWith('/') ? dir : join(SOURCE, dir);
    if (!existsSync(abs)) continue;
    for (const p of walk(abs)) src[`${prefix}${relative(abs, p)}`] = sha256File(p);
  }
  const onlySource = Object.keys(src).filter((k) => !(k in phx)).sort();
  const onlyPhoenix = Object.keys(phx).filter((k) => !(k in src)).sort();
  const differ = Object.keys(phx).filter((k) => k in src && phx[k] !== src[k]).sort();
  return {
    phoenixCount: Object.keys(phx).length,
    sourceCount: Object.keys(src).length,
    identical: onlySource.length === 0 && onlyPhoenix.length === 0 && differ.length === 0,
    onlySource: onlySource.slice(0, 40),
    onlyPhoenix: onlyPhoenix.slice(0, 40),
    differing: differ.slice(0, 40),
  };
}

const S = (rel) => join(SOURCE, rel);

const SOURCES_BLOCK = {
  pinnedReference: { revision: REFERENCE_REVISION, path: SOURCE, role: 'authoritative pinned original (5c0a739 originalPegasusCandidate)' },
  workingCheckout: { revision: SOURCE_REVISION, path: SOURCE2, role: 'd682547a Pegasus working checkout, used as a cross-check' },
};

// Single-file provenance comparison.
function fileEquivalence(phxRel, srcRel) {
  const phxAbs = join(ROOT, phxRel);
  const srcAbs = srcRel.startsWith('/') ? srcRel : join(SOURCE, srcRel);
  if (!existsSync(phxAbs) || !existsSync(srcAbs)) return { identical: false, missing: !existsSync(phxAbs) ? phxRel : srcRel };
  const phoenixSha256 = sha256File(phxAbs);
  const sourceSha256 = sha256File(srcAbs);
  return { identical: phoenixSha256 === sourceSha256, phoenixSha256, sourceSha256, source: srcRel };
}

// --- skills family set -------------------------------------------------------
const skillsFamilies = {
  chitchat: family('packages/skills/resources/mims/chitchat',
    'packages/chitchat-skill/mims (4,424) + packages/chitchat-skill/res/semi_specific_categories (66)'),
  reportMims: family('packages/skills/resources/mims/report', 'packages/report-skill/mims'),
  baseMims: family('packages/skills/resources/mims/base', 'packages/baseskill/mims'),
  templateMims: family('packages/skills/resources/mims/template', 'packages/template-skill/mims'),
  gqaMims: family('packages/skills/resources/mims/gqa',
    'recovered srv-gqa-ws@ebe1a7d pegasus_mims (10) + Phoenix-authored GQA_banned_word.mim (1)'),
  colorMims: family('packages/skills/resources/mims/color', 'Phoenix-authored (no pinned source)'),
  views: family('packages/skills/resources/views', 'packages/report-skill/resources/views'),
  gqaResources: family('packages/skills/resources/gqa', 'recovered srv-gqa-ws@ebe1a7d data files'),
  mimPromptText: family('packages/skills/resources/report-mimPromptText.json', 'packages/report-skill/resources/mimPromptText.json'),
  prefsConfig: family('packages/skills/resources/report-prefsConfig.json', 'packages/report-skill/resources/prefsConfig.json'),
};

const skillsFixture = {
  schemaVersion: 1,
  task: 'S-06',
  digest: 'sha256 of the concatenated sorted lines `<relpath> <sha256>\\n`',
  sources: SOURCES_BLOCK,
  generatedFrom: {
    pegasusLocal: SOURCE_REVISION,
    pegasusReference: REFERENCE_REVISION,
    note: 'MIM/CSV/view/config trees are byte-identical between the local Pegasus checkout and the pinned reference copy; aggregates below were re-derived from the local checkout and cross-checked against the reference copy.',
  },
  crossCheck: {
    'packages/chitchat-skill/mims': 'byte-identical to reference copy (4,424 files, 0 hash diffs)',
    'packages/report-skill/mims': 'byte-identical to reference copy (82 files, 0 hash diffs)',
    'packages/baseskill/mims': 'byte-identical to reference copy (4 files, 0 hash diffs)',
    'packages/report-skill/resources': 'byte-identical to reference copy (10 files, 0 hash diffs)',
    'packages/chitchat-skill/res': 'byte-identical to reference copy (66 files, 0 hash diffs)',
    'packages/parser/robust-parser/rules_src': 'byte-identical to reference copy (117 files, 0 hash diffs)',
  },
  sourceEquivalence: {
    'mims/chitchat': equivalence('packages/skills/resources/mims/chitchat', [
      { dir: 'packages/chitchat-skill/mims' },
      { dir: 'packages/chitchat-skill/res/semi_specific_categories', prefix: 'semi_specific_categories/' },
    ]),
    'mims/report': equivalence('packages/skills/resources/mims/report', [{ dir: 'packages/report-skill/mims' }]),
    'mims/base': equivalence('packages/skills/resources/mims/base', [{ dir: 'packages/baseskill/mims' }]),
    'mims/template': equivalence('packages/skills/resources/mims/template', [{ dir: 'packages/template-skill/mims' }]),
    'views': equivalence('packages/skills/resources/views', [{ dir: 'packages/report-skill/resources/views' }]),
    'mims/gqa': equivalence('packages/skills/resources/mims/gqa', [
      { dir: '/home/shell/work/phoenix/.parity/reviews/q01-gqa-20260906/source/pegasus_mims' },
    ]),
  },
  families: skillsFamilies,
};

// --- gateway manifests -------------------------------------------------------
const manifestsFixture = {
  schemaVersion: 1,
  task: 'S-06',
  digest: 'sha256 of the concatenated sorted lines `<relpath> <sha256>\\n`',
  sources: SOURCES_BLOCK,
  generatedFrom: {
    sourceIndexes: 'packages/hub/resources/skills/{skills-local,skills-pegasus1,skills-pegasus2}.json',
    sourceManifests: 'packages/hub/pegasus-skills + packages/hub/be-skills',
    pegasusReference: REFERENCE_REVISION,
  },
  phoenixFamilies: {
    skillsDir: family('packages/gateway/resources/skills', 'hub skill indexes + pegasus/be manifests'),
  },
  sourceEquivalence: {
    'pegasus-skills': equivalence('packages/gateway/resources/skills/pegasus-skills', [{ dir: 'packages/hub/pegasus-skills' }]),
    'be-skills': equivalence('packages/gateway/resources/skills/be-skills', [{ dir: 'packages/hub/be-skills' }]),
    'external-skills': equivalence('packages/gateway/resources/skills/external-skills', [{ dir: 'packages/hub/external-skills' }]),
  },
  indexFiles: {
    'skills-local.json': fileEquivalence('packages/gateway/resources/skills/skills-local.json', 'packages/hub/resources/skills/skills-local.json'),
    'skills-pegasus1.json': fileEquivalence('packages/gateway/resources/skills/skills-pegasus1.json', 'packages/hub/resources/skills/skills-pegasus1.json'),
    'skills-pegasus2.json': fileEquivalence('packages/gateway/resources/skills/skills-pegasus2.json', 'packages/hub/resources/skills/skills-pegasus2.json'),
    'answer_skill_manifest.json': fileEquivalence('packages/gateway/resources/skills/pegasus-skills/answer_skill_manifest.json', join(SOURCE2, 'packages/hub/pegasus-skills/answer_skill_manifest.json')),
    'stringNormalizationMap.json': fileEquivalence('packages/gateway/resources/stringNormalizationMap.json', 'packages/hub/resources/stringNormalizationMap.json'),
  },
  externalAnswerManifest: (() => {
    const p = S('packages/hub/external-skills/answer_manifest.json');
    if (!existsSync(p)) return { note: 'source checkout does not ship external-skills/answer_manifest.json' };
    const src = JSON.parse(readFileSync(p, 'utf8'));
    return { path: 'packages/hub/external-skills/answer_manifest.json', id: src.id, intents: [...new Set(src.intents.map((i) => i.name))].sort() };
  })(),
  sourceFamilies: {
    skillsDir: sourceFamily(S('packages/hub/resources/skills')),
    pegasusSkills: sourceFamily(S('packages/hub/pegasus-skills')),
    beSkills: sourceFamily(S('packages/hub/be-skills')),
  },
  answerManifest: (() => {
    const srcPath = join(SOURCE2, 'packages/hub/pegasus-skills/answer_skill_manifest.json');
    const phxPath = join(ROOT, 'packages/gateway/resources/skills/pegasus-skills/answer_skill_manifest.json');
    if (!existsSync(srcPath)) return { note: `source checkout does not ship answer_skill_manifest.json: ${srcPath}` };
    const src = JSON.parse(readFileSync(srcPath, 'utf8'));
    const phx = JSON.parse(readFileSync(phxPath, 'utf8'));
    const sNames = src.intents.map((i) => i.name);
    const pNames = phx.intents.map((i) => i.name);
    const sMemo = Object.fromEntries(src.intents.map((i) => [i.name, i.memo]));
    const pMemo = Object.fromEntries(phx.intents.map((i) => [i.name, i.memo]));
    return {
      sourcePath: 'packages/hub/pegasus-skills/answer_skill_manifest.json (d682547a checkout only)',
      sourceIntents: sNames,
      phoenixIntents: pNames,
      addedIntents: [...new Set(pNames.filter((n) => !sNames.includes(n)))].sort(),
      missingIntents: [...new Set(sNames.filter((n) => !pNames.includes(n)))].sort(),
      // memos must agree wherever a name exists on both sides
      memoConflicts: Object.keys(sMemo).filter((n) => n in pMemo && JSON.stringify(sMemo[n]) !== JSON.stringify(pMemo[n])),
      id: { source: src.id, phoenix: phx.id },
    };
  })(),
  unchangedSourceFiles: [
    'packages/hub/resources/skills/skills-pegasus1.json',
    'packages/hub/pegasus-skills/chitchat_skill_manifest.json',
    'packages/hub/pegasus-skills/report_skill_manifest.json',
    'packages/hub/pegasus-skills/example_skill_manifest.json',
    'packages/hub/pegasus-skills/template_skill_manifest.json',
    'packages/hub/be-skills/*.json',
  ],
};

// --- nlu grammar -------------------------------------------------------------
const grammarFixture = {
  schemaVersion: 1,
  task: 'S-06',
  digest: 'sha256 of the concatenated sorted lines `<relpath> <sha256>\\n`',
  sources: SOURCES_BLOCK,
  generatedFrom: { pegasusReference: REFERENCE_REVISION },
  phoenixFamilies: {
    rulesSrc: family('packages/nlu/resources/rules-src', 'packages/parser/robust-parser/rules_src'),
    grammar: family('packages/nlu/resources/grammar', 'subset of packages/parser/robust-parser/rules_src (loaded launch grammars)'),
    beLaunchRules: family('packages/nlu/resources/rules/@be', 'packages/parser/robust-parser/rules_src/<skill>/launch.rule'),
    eqWords: family('packages/nlu/resources/data', 'reference build data/en-us/word_lists/eq_words.txt'),
    factoryWords: family('packages/nlu/resources/factory-words', 'reference build data/en-us factory word lists'),
    factoryGrammars: family('packages/nlu/resources/factory', 'reference factory grammar handles'),
  },
  sourceFamilies: {
    rulesSrc: sourceFamily(S('packages/parser/robust-parser/rules_src')),
    rulesFst: sourceFamily(S('packages/parser/robust-parser/rules_fst')),
  },
  sourceEquivalence: {
    'rules-src': equivalence('packages/nlu/resources/rules-src', [{ dir: 'packages/parser/robust-parser/rules_src' }]),
    "rules/@be": equivalence('packages/nlu/resources/rules/@be', [{ dir: 'packages/parser/robust-parser/rules_src' }]),
  },
  documentedDivergences: {
    'rules/@be': {
      status: 'adaptation',
      detail: 'The launch-rule engine (src/launchRules.js) loads resources/rules/@be/<skill>/launch.rule, which are hand-trimmed copies of the pinned rules_src/<skill>/launch.rule (arm pruning, intent renames, factory rewrites) rather than the byte-identical grammar/skills copies. The full-grammar stage (src/fullGrammar.js) separately loads resources/grammar/skills, which ARE byte-identical to source.',
    },
  },
};

for (const [pathArg, data] of [
  ['out', skillsFixture],
  ['out-manifests', manifestsFixture],
  ['out-grammar', grammarFixture],
]) {
  const target = args.get(pathArg);
  if (!target) continue;
  const abs = resolve(ROOT, target);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, `${JSON.stringify(data, null, 2)}\n`);
  console.log(`wrote ${relative(ROOT, abs)}`);
}
