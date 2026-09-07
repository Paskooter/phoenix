import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { compiledFstConstants } from './compiledFst.js';

// A decoded OpenFST graph is useful at the deployment boundary because it
// removes the native parser's binary-file dependency while retaining the
// graph, symbol-table, and arc order that the JavaScript executor consumes.
// This is deliberately a data format, not a second grammar or a lookup table.
export const FST_SNAPSHOT_SCHEMA = 'phoenix.nlu.compiled-fst';
export const FST_SNAPSHOT_VERSION = 1;
export const FST_SNAPSHOT_HASH_ANCHOR_SCHEMA = 'phoenix.nlu.compiled-fst-snapshot-hashes';
export const FST_SNAPSHOT_HASH_ANCHOR_VERSION = 1;

/**
 * Return the uncompressed JSON bytes for a stored snapshot. The decoded
 * document format remains JSON; compression is only a distribution encoding.
 */
export function decodeSnapshotBytes(value, { compression = 'json' } = {}) {
  const stored = Buffer.isBuffer(value) || value instanceof Uint8Array
    ? Buffer.from(value)
    : Buffer.from(String(value), 'utf8');
  if (compression === 'json') return stored;
  if (compression !== 'gzip') invalid(`unsupported snapshot compression: ${compression}`);
  try {
    return gunzipSync(stored);
  } catch (error) {
    invalid(`gzip decompression failed: ${error.message}`);
  }
}

const {
  EPSILON,
  NON_BLANK,
  CHARACTER_START,
  CHARACTER_END,
} = compiledFstConstants;

function invalid(message) {
  throw new Error(`Invalid compiled FST snapshot: ${message}`);
}

function encodeNumber(value, label) {
  if (typeof value === 'bigint') return { type: 'bigint', value: value.toString() };
  if (typeof value !== 'number') invalid(`${label} is not numeric`);
  if (Number.isFinite(value) && !Object.is(value, -0)) return value;
  if (Number.isNaN(value)) return { type: 'number', value: 'NaN' };
  if (value === Infinity) return { type: 'number', value: 'Infinity' };
  if (value === -Infinity) return { type: 'number', value: '-Infinity' };
  return { type: 'number', value: '-0' };
}

function decodeNumber(value, label, { integer = false, bigint = false } = {}) {
  if (typeof value === 'number') {
    if (bigint) invalid(`${label} must use the bigint encoding`);
    if (!Number.isFinite(value)) invalid(`${label} has an unencoded non-finite number`);
    if (integer && (!Number.isSafeInteger(value))) invalid(`${label} is not a safe integer`);
    return value;
  }
  if (!value || typeof value !== 'object' || typeof value.type !== 'string') {
    invalid(`${label} is not an encoded number`);
  }
  if (value.type === 'bigint') {
    if (!bigint || !/^-?(?:0|[1-9][0-9]*)$/.test(value.value)) {
      invalid(`${label} has an invalid bigint`);
    }
    return BigInt(value.value);
  }
  if (value.type !== 'number' || !['NaN', 'Infinity', '-Infinity', '-0'].includes(value.value)) {
    invalid(`${label} has an invalid special number`);
  }
  if (integer) invalid(`${label} cannot be a special number`);
  if (value.value === 'NaN') return NaN;
  if (value.value === 'Infinity') return Infinity;
  if (value.value === '-Infinity') return -Infinity;
  return -0;
}

function encodeBytes(bytes, label) {
  if (!Buffer.isBuffer(bytes) && !(bytes instanceof Uint8Array)) invalid(`${label} is not bytes`);
  return Buffer.from(bytes).toString('base64');
}

function decodeBytes(value, label) {
  if (typeof value !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    invalid(`${label} is not canonical base64`);
  }
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value) invalid(`${label} is not canonical base64`);
  return bytes;
}

function encodeSymbolTable(table, label) {
  if (!table || !(table.byLabel instanceof Map)) invalid(`${label} is missing decoded symbols`);
  return {
    name: String(table.name),
    availableKey: encodeNumber(table.availableKey, `${label}.availableKey`),
    entries: [...table.byLabel.entries()].map(([key, bytes], index) => ({
      label: encodeNumber(key, `${label}.entries[${index}].label`),
      bytes: encodeBytes(bytes, `${label}.entries[${index}].bytes`),
    })),
  };
}

function decodeSymbolTable(value, label) {
  if (!value || typeof value !== 'object' || !Array.isArray(value.entries)) invalid(`${label} is malformed`);
  const availableKey = decodeNumber(value.availableKey, `${label}.availableKey`, { integer: true });
  const byLabel = new Map();
  const byBytes = new Map();
  for (const [index, entry] of value.entries.entries()) {
    if (!entry || typeof entry !== 'object') invalid(`${label}.entries[${index}] is malformed`);
    const key = decodeNumber(entry.label, `${label}.entries[${index}].label`, { integer: true });
    const bytes = decodeBytes(entry.bytes, `${label}.entries[${index}].bytes`);
    if (byLabel.has(key) || byBytes.has(bytes.toString('hex'))) invalid(`${label} has duplicate symbols`);
    byLabel.set(key, bytes);
    byBytes.set(bytes.toString('hex'), key);
  }
  return { name: String(value.name || ''), availableKey, byLabel, byBytes };
}

function encodeState(state, stateId) {
  if (!state || !Array.isArray(state.arcs)) invalid(`state ${stateId} is malformed`);
  return {
    finalWeight: encodeNumber(state.finalWeight, `states[${stateId}].finalWeight`),
    arcs: state.arcs.map((arc, index) => {
      if (!arc || !Number.isSafeInteger(arc.ilabel) || !Number.isSafeInteger(arc.olabel)
        || !Number.isSafeInteger(arc.nextstate)) {
        invalid(`states[${stateId}].arcs[${index}] has an invalid label or destination`);
      }
      return {
        ilabel: arc.ilabel,
        olabel: arc.olabel,
        weight: encodeNumber(arc.weight, `states[${stateId}].arcs[${index}].weight`),
        nextstate: arc.nextstate,
      };
    }),
  };
}

function decodeState(value, stateId, stateCount) {
  if (!value || typeof value !== 'object' || !Array.isArray(value.arcs)) invalid(`states[${stateId}] is malformed`);
  const arcs = value.arcs.map((arc, index) => {
    if (!arc || !Number.isSafeInteger(arc.ilabel) || !Number.isSafeInteger(arc.olabel)
      || !Number.isSafeInteger(arc.nextstate) || arc.nextstate < 0 || arc.nextstate >= stateCount) {
      invalid(`states[${stateId}].arcs[${index}] has an invalid label or destination`);
    }
    return {
      ilabel: arc.ilabel,
      olabel: arc.olabel,
      weight: decodeNumber(arc.weight, `states[${stateId}].arcs[${index}].weight`),
      nextstate: arc.nextstate,
    };
  });
  return {
    finalWeight: decodeNumber(value.finalWeight, `states[${stateId}].finalWeight`),
    arcs,
  };
}

/**
 * Convert the decoded fields consumed by VectorStandardFst into a portable
 * JSON document. `artifact` contains relative provenance only; callers must
 * never put an absolute/private source path in a snapshot.
 */
export function serializeFstSnapshot(fst, artifact = {}) {
  if (!fst || !fst.header || !fst.inputSymbols || !fst.outputSymbols || typeof fst.state !== 'function') {
    invalid('source is not a decoded vector/standard FST');
  }
  const header = fst.header;
  if (header.fstType !== 'vector' || header.arcType !== 'standard') invalid('only vector/standard FSTs are supported');
  if (!Number.isSafeInteger(header.numStates) || header.numStates < 0) invalid('header.numStates is invalid');
  const states = Array.from({ length: header.numStates }, (_, stateId) => encodeState(fst.state(stateId), stateId));
  return {
    schema: FST_SNAPSHOT_SCHEMA,
    version: FST_SNAPSHOT_VERSION,
    kind: 'decoded-vector-standard-fst',
    artifact: { ...artifact },
    header: {
      fstType: header.fstType,
      arcType: header.arcType,
      version: header.version,
      flags: header.flags,
      properties: encodeNumber(header.properties, 'header.properties'),
      start: encodeNumber(header.start, 'header.start'),
      numStates: encodeNumber(header.numStates, 'header.numStates'),
      numArcs: encodeNumber(header.numArcs, 'header.numArcs'),
    },
    inputSymbols: encodeSymbolTable(fst.inputSymbols, 'inputSymbols'),
    outputSymbols: encodeSymbolTable(fst.outputSymbols, 'outputSymbols'),
    states,
  };
}

function validateArtifact(artifact) {
  if (artifact === undefined) return {};
  if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact)) invalid('artifact metadata is malformed');
  if (artifact.sourcePath !== undefined && (typeof artifact.sourcePath !== 'string'
    || /^(?:[A-Za-z]:[\\/]|[\\/])/.test(artifact.sourcePath)
    || artifact.sourcePath.split(/[\\/]/).includes('..'))) {
    invalid('artifact.sourcePath must be a relative label');
  }
  if (artifact.sourceSha256 !== undefined && !/^[a-f0-9]{64}$/.test(artifact.sourceSha256)) invalid('artifact.sourceSha256 is invalid');
  if (artifact.sourceBytes !== undefined && (!Number.isSafeInteger(artifact.sourceBytes) || artifact.sourceBytes < 0)) invalid('artifact.sourceBytes is invalid');
  return { ...artifact };
}

/** A decoded FST with the same interface used by CompiledFstExecutor. */
export class SnapshotStandardFst {
  constructor(document, { source = '<snapshot>' } = {}) {
    if (!document || document.schema !== FST_SNAPSHOT_SCHEMA || document.version !== FST_SNAPSHOT_VERSION
      || document.kind !== 'decoded-vector-standard-fst') invalid('schema or version mismatch');
    this.source = source;
    this.artifact = validateArtifact(document.artifact);
    const header = document.header;
    if (!header || header.fstType !== 'vector' || header.arcType !== 'standard') invalid('header is malformed');
    const numStates = decodeNumber(header.numStates, 'header.numStates', { integer: true });
    if (numStates < 0 || !Array.isArray(document.states) || document.states.length !== numStates) invalid('state count mismatch');
    this.header = {
      fstType: header.fstType,
      arcType: header.arcType,
      version: decodeNumber(header.version, 'header.version', { integer: true }),
      flags: decodeNumber(header.flags, 'header.flags', { integer: true }),
      properties: decodeNumber(header.properties, 'header.properties', { bigint: true }),
      start: decodeNumber(header.start, 'header.start', { integer: true }),
      numStates,
      numArcs: decodeNumber(header.numArcs, 'header.numArcs', { integer: true }),
    };
    if (this.header.start < -1 || this.header.start >= numStates) invalid('header.start is out of range');
    this.inputSymbols = decodeSymbolTable(document.inputSymbols, 'inputSymbols');
    this.outputSymbols = decodeSymbolTable(document.outputSymbols, 'outputSymbols');
    this.states = document.states.map((state, stateId) => decodeState(state, stateId, numStates));
  }

  stateCount() { return this.header.numStates; }

  state(stateId) {
    if (!Number.isInteger(stateId) || stateId < 0 || stateId >= this.header.numStates) invalid(`state ${stateId} is out of range`);
    return this.states[stateId];
  }

  isFinal(stateId) { return Number.isFinite(this.state(stateId).finalWeight); }

  inputLabelForByte(byte) {
    if (!Number.isInteger(byte) || byte < 0 || byte > 255) throw new RangeError('input byte must be 0..255');
    return CHARACTER_START + byte;
  }

  inputSymbol(label) {
    if (label === EPSILON) return 'ε';
    if (label === NON_BLANK) return 'σ';
    if (label >= CHARACTER_START && label <= CHARACTER_END) return String.fromCharCode(label - CHARACTER_START);
    const symbol = this.inputSymbols.byLabel.get(label);
    return symbol ? Buffer.from(symbol).toString('utf8') : undefined;
  }

  outputSymbol(label) {
    if (label === EPSILON) return 'ε';
    if (label === NON_BLANK) return 'σ';
    if (label === 2) return 'εsub';
    if (label === 3) return '<s>';
    if (label === 4) return '<\\/s>';
    if (label === 5) return '<wp>';
    if (label === 6) return 'H:';
    if (label >= CHARACTER_START && label <= CHARACTER_END) return `C:${label - CHARACTER_START}`;
    const symbol = this.outputSymbols.byLabel.get(label);
    return symbol ? Buffer.from(symbol).toString('utf8') : undefined;
  }
}

export function parseFstSnapshot(value, options = {}) {
  let document = value;
  if (Buffer.isBuffer(value) || typeof value === 'string') {
    const jsonBytes = decodeSnapshotBytes(value, options);
    try { document = JSON.parse(jsonBytes.toString('utf8')); }
    catch (error) { invalid(`JSON parse failed: ${error.message}`); }
  } else if (options.compression && options.compression !== 'json') {
    invalid('compressed snapshots must be supplied as bytes or text');
  }
  return new SnapshotStandardFst(document, options);
}

export function loadFstSnapshot(path, options = {}) {
  return parseFstSnapshot(readFileSync(path), { ...options, source: options.source || path });
}

export function stringifyFstSnapshot(document) {
  // JSON.stringify would turn an unencoded NaN/Infinity into null. The
  // serializer is intentionally kept here so exporters cannot accidentally
  // bypass the special-number representation.
  if (!document || document.schema !== FST_SNAPSHOT_SCHEMA || document.version !== FST_SNAPSHOT_VERSION) {
    invalid('cannot stringify an unknown snapshot document');
  }
  return `${JSON.stringify(document)}\n`;
}
