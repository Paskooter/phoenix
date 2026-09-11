// N-07: derive the archived Dialogflow default-agent surface from the pinned
// Pegasus reference checkout.
//
// The Dialogflow (API.ai) service is dead, so no live round-trip can be
// recorded. The pinned agent export under
//   jiboV2/pegasus@5c0a7390539663ba749d360de348a428c088505c
//   packages/parser/dialogflow/main_agent
// is nevertheless a complete *archived* artifact:
//   - intents/<name>.json          the 99 intent definitions, each with a real
//                                  `responses[]` array whose `parameters`
//                                  entries are the intent's parameter schema
//   - intents/<name>_usersays_en.json
//                                  the training phrases; annotated segments
//                                  carry `meta: '@Entity'` + `alias`, which is
//                                  exactly the parameter surface Dialogflow
//                                  fills and DialogflowClient.ts:100-104 copies
//                                  into `entities` (response.result.parameters)
//   - entities/<name>.json         the 89 entity definitions
//
// This tool derives, per intent, the response a real Dialogflow call would have
// produced for the intent's own first training phrase:
//   { intent: <intentName>, entities: { <alias>: <annotated text> } }
// together with the archived parameter schema and contexts. It is a DERIVATION
// from pinned source, not an observed live response, and is labelled as such in
// the emitted fixture.
//
// Usage:
//   node packages/nlu/tools/deriveDialogflowArchivedAgent.mjs --check
//   node packages/nlu/tools/deriveDialogflowArchivedAgent.mjs --write \
//     [--reference <main_agent dir>] [--out <fixture path>]
//
// --check re-derives the fixture and compares it byte-for-byte with the
// committed copy, so a drifted fixture fails instead of silently passing.
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const TOOLS_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(TOOLS_DIR, '..', '..', '..');
export const REFERENCE_REVISION = '5c0a7390539663ba749d360de348a428c088505c';
export const REFERENCE_PATH = 'packages/parser/dialogflow/main_agent';
export const ARCHIVED_AGENT_SCHEMA = 'phoenix.nlu.dialogflow-archived-agent';
const DEFAULT_FIXTURE = join(REPO_ROOT, 'packages', 'nlu', 'test', 'fixtures', 'dialogflow-archived-agent.json');

function defaultReferenceDir() {
  return join(REPO_ROOT, '.parity', 'reference', REFERENCE_REVISION, REFERENCE_PATH);
}

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

// A single annotated training-phrase segment: Dialogflow marks user-defined
// entity segments with a `meta` of the form '@EntityName'.
function annotatedEntities(phrase) {
  const out = [];
  for (const segment of phrase.data || []) {
    if (typeof segment.meta === 'string' && segment.meta.startsWith('@')) {
      out.push({ alias: segment.alias || segment.meta.slice(1), entity: segment.meta.slice(1), text: segment.text });
    }
  }
  return out;
}

export function deriveArchivedAgent(referenceDir = defaultReferenceDir()) {
  if (!existsSync(referenceDir) || !statSync(referenceDir).isDirectory()) {
    throw new Error(`Archived Dialogflow agent is unavailable: ${referenceDir}`);
  }
  const intentsDir = join(referenceDir, 'intents');
  const entitiesDir = join(referenceDir, 'entities');
  const intentFiles = readdirSync(intentsDir).filter(f => f.endsWith('.json') && !f.endsWith('_usersays_en.json')).sort();
  const entityFiles = readdirSync(entitiesDir).filter(f => f.endsWith('.json') && !f.endsWith('_entries_en.json')).sort();

  const intents = [];
  const annotatedEntityNames = new Set();
  for (const file of intentFiles) {
    const path = join(intentsDir, file);
    const def = readJson(path);
    const usersaysFile = `${file.slice(0, -'.json'.length)}_usersays_en.json`;
    const usersaysPath = join(intentsDir, usersaysFile);
    if (!existsSync(usersaysPath)) throw new Error(`Archived intent ${def.name} has no training phrases: ${usersaysPath}`);
    const usersays = readJson(usersaysPath);

    // The archived response metadata Dialogflow exported with the intent.
    const responseParameters = [];
    const affectedContexts = [];
    for (const response of def.responses || []) {
      for (const parameter of response.parameters || []) {
        responseParameters.push({
          name: parameter.name,
          dataType: parameter.dataType,
          isList: Boolean(parameter.isList),
          required: Boolean(parameter.required),
          value: parameter.value,
        });
      }
      for (const context of response.affectedContexts || []) {
        affectedContexts.push({ name: context.name, lifespan: context.lifespan });
      }
    }

    // The response a live call would have produced for the intent's own first
    // training phrase: intentName + the filled parameter map.
    const firstPhrase = usersays.find(p => Array.isArray(p.data));
    const segments = firstPhrase ? annotatedEntities(firstPhrase) : [];
    const derivedEntities = {};
    for (const segment of segments) derivedEntities[segment.alias] = segment.text;

    // Every entity the intent's training data annotates, not just the first phrase.
    const attributedEntities = new Set();
    for (const phrase of usersays) {
      for (const segment of annotatedEntities(phrase)) {
        attributedEntities.add(segment.entity);
        annotatedEntityNames.add(segment.entity);
      }
    }

    intents.push({
      name: def.name,
      file,
      sha256: sha256(readFileSync(path)),
      usersaysFile,
      usersaysSha256: sha256(readFileSync(usersaysPath)),
      trainingPhraseCount: usersays.length,
      attributedEntities: [...attributedEntities].sort(),
      responseParameters,
      affectedContexts,
      derivedResponse: { intent: def.name, entities: derivedEntities },
      derivedFrom: `${file}[0]`,
    });
  }
  intents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  const entities = entityFiles.map(file => ({
    name: readJson(join(entitiesDir, file)).name,
    file,
    sha256: sha256(readFileSync(join(entitiesDir, file))),
  }));
  entities.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  const agentJsonPath = join(referenceDir, 'agent.json');
  const intentNameSet = new Set(intents.map(i => i.name));
  if (intentNameSet.size !== intents.length) throw new Error('Archived intent names are not unique');
  const entityNameSet = new Set(entities.map(e => e.name));
  if (entityNameSet.size !== entities.length) throw new Error('Archived entity names are not unique');

  // Training data also annotates Dialogflow system entities. Most carry the
  // `@sys.` prefix, but the archived export also serializes the bare aliases
  // `@given-name` / `@last-name` (the same built-ins as @sys.given-name /
  // @sys.last-name). System entities have no file under entities/, so classify by
  // membership: an annotated name with no archived definition must be a known
  // system entity, never a silently missing custom one.
  const SYSTEM_ENTITY_ALIASES = new Set(['given-name', 'last-name']);
  const allAnnotated = [...annotatedEntityNames].sort();
  const custom = allAnnotated.filter(name => entityNameSet.has(name));
  const system = allAnnotated.filter(name => !entityNameSet.has(name));
  for (const name of system) {
    if (!name.startsWith('sys.') && !SYSTEM_ENTITY_ALIASES.has(name)) {
      throw new Error(`Annotated entity ${name} has no archived definition and is not a known system entity`);
    }
  }

  return {
    schema: ARCHIVED_AGENT_SCHEMA,
    provenance: {
      repo: 'jiboV2/pegasus',
      ref: REFERENCE_REVISION,
      path: REFERENCE_PATH,
      agentJsonSha256: sha256(readFileSync(agentJsonPath)),
      note: 'Archived Dialogflow agent export. derivedResponse entries are DERIVED from '
        + 'the intent training phrases (DialogflowClient.ts:100-104 copies '
        + 'response.result.metadata.intentName and response.result.parameters), not observed '
        + 'live: the apiai/Dialogflow service is dead.',
    },
    intentCount: intents.length,
    entityCount: entities.length,
    annotatedEntityCount: allAnnotated.length,
    annotatedCustomEntities: custom,
    annotatedSystemEntities: system,
    annotatedEntities: allAnnotated,
    intents,
    entities,
  };
}

function stableJson(value) {
  return `${JSON.stringify(value, null, 1)}\n`;
}

function main() {
  const args = process.argv.slice(2);
  const referenceIndex = args.indexOf('--reference');
  const outIndex = args.indexOf('--out');
  const referenceDir = referenceIndex !== -1 ? resolve(args[referenceIndex + 1]) : defaultReferenceDir();
  const outPath = outIndex !== -1 ? resolve(args[outIndex + 1]) : DEFAULT_FIXTURE;
  const derived = deriveArchivedAgent(referenceDir);
  const rendered = stableJson(derived);

  if (args.includes('--write')) {
    writeFileSync(outPath, rendered);
    console.log(`wrote ${outPath}`);
    console.log(`intents=${derived.intentCount} entities=${derived.entityCount} annotatedEntities=${derived.annotatedEntityCount}`);
    return;
  }
  if (args.includes('--check')) {
    if (!existsSync(outPath)) throw new Error(`Archived agent fixture is missing: ${outPath}`);
    const committed = readFileSync(outPath, 'utf8');
    if (committed !== rendered) throw new Error(`Archived agent fixture drifted from its pinned derivation: ${outPath}`);
    console.log(`archived agent fixture matches its pinned derivation (${derived.intentCount} intents, ${derived.entityCount} entities)`);
    return;
  }
  throw new Error('Usage: --check | --write [--reference <dir>] [--out <path>]');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
