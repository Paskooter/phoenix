#!/usr/bin/env node
/* Candidate-side counterpart to s01-graph-nodeid-source.cjs. */
import '../src/index.js';
import { sharedGraphManager } from '../src/graph/graphManager.js';

const entries = Array.from(sharedGraphManager.idToNode.entries())
  .sort((a, b) => a[0] - b[0])
  .map(([id, node]) => ({id, name: node.name}));

process.stdout.write(JSON.stringify({
  runtime: process.version,
  order: ['chitchat-skill', 'report-skill'],
  nodeIDCounter: sharedGraphManager.nodeIDCounter,
  nodes: entries,
  chitchat: {
    initial: entries.find(node => node.name === 'Intent Split')?.id,
    nodeCount: entries.filter(node => node.id < 4).length,
  },
  report: {
    initial: entries.find(node => node.name === 'Intent Split' && node.id > 3)?.id,
    sendAllMims: entries.find(node => node.name === 'M:AN:SL:Send All Mims')?.id,
    nodeCount: entries.filter(node => node.id >= 4).length,
  },
}, null, 2) + '\n');
