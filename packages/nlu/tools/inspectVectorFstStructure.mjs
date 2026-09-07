#!/usr/bin/env node

// Source-review utility for comparing the ordered structure of a native
// OpenFST artifact.  It deliberately has no grammar or intent knowledge: the
// output is the graph as stored, including each state's ordered arcs.  Keep
// this under tools so node --test does not discover it as a test.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { VectorStandardFst } from '../src/compiledFst.js';

const file = process.argv[2];
if (!file) {
  process.stderr.write('usage: inspectVectorFstStructure.mjs FILE.fst\n');
  process.exitCode = 2;
} else {
  const bytes = readFileSync(file);
  const fst = new VectorStandardFst(bytes, { source: file });
  const states = [];

  for (let stateId = 0; stateId < fst.stateCount(); stateId += 1) {
    const state = fst.state(stateId);
    states.push({
      id: stateId,
      final: fst.isFinal(stateId),
      finalWeight: state.finalWeight,
      // Array order is part of the observable native graph.  Do not sort it.
      arcs: state.arcs.map((arc, index) => ({
        index,
        inputLabel: arc.ilabel,
        inputSymbol: fst.inputSymbol(arc.ilabel) ?? null,
        outputLabel: arc.olabel,
        outputSymbol: fst.outputSymbol(arc.olabel) ?? null,
        weight: arc.weight,
        nextState: arc.nextstate,
      })),
    });
  }

  const structure = {
    // VectorStandardFst keeps OpenFST's 64-bit properties value as a BigInt;
    // render it explicitly so the review receipt remains JSON and stable.
    header: { ...fst.header, properties: fst.header.properties.toString() },
    inputSymbols: [...fst.inputSymbols.byLabel.entries()].map(([label, value]) => [label, Buffer.from(value).toString('utf8')]),
    outputSymbols: [...fst.outputSymbols.byLabel.entries()].map(([label, value]) => [label, Buffer.from(value).toString('utf8')]),
    states,
  };
  const structureBytes = Buffer.from(JSON.stringify(structure));
  const moduleBytes = readFileSync(new URL('../src/compiledFst.js', import.meta.url));
  const actionArcs = [];
  for (const state of states) {
    for (const arc of state.arcs) {
      if (arc.inputLabel === 0 && arc.outputLabel >= 2000) {
        actionArcs.push({
          state: state.id,
          arcIndex: arc.index,
          outputLabel: arc.outputLabel,
          outputSymbol: arc.outputSymbol,
          weight: arc.weight,
          nextState: arc.nextState,
        });
      }
    }
  }

  process.stdout.write(`${JSON.stringify({
    format: 'phoenix-native-fst-structure-v1',
    file,
    fileSha256: createHash('sha256').update(bytes).digest('hex'),
    fileBytes: bytes.length,
    readerSha256: createHash('sha256').update(moduleBytes).digest('hex'),
    stateCount: fst.stateCount(),
    arcCount: states.reduce((sum, state) => sum + state.arcs.length, 0),
    structureSha256: createHash('sha256').update(structureBytes).digest('hex'),
    actionArcs,
    structure,
  }, null, 2)}\n`);
}
