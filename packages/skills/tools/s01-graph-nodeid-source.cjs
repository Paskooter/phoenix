#!/usr/bin/env node
/*
 * Source-only graph allocation witness. Run this with the pinned Node 8 image
 * and frozen Pegasus tree; it intentionally constructs the same two skills in
 * the order used by scripts/parity-production/original.cjs.
 */
'use strict';

const path = require('path');

const reference = path.resolve(process.argv[2] || '.');
const graphManagerPath = path.join(reference, 'packages/baseskill/lib/graph/GraphManager');
const chitchatPath = path.join(reference, 'packages/chitchat-skill/lib/Chitchat');
const reportPath = path.join(reference, 'packages/report-skill/lib/PersonalReport');

const { GraphManager } = require(graphManagerPath);
const { Chitchat } = require(chitchatPath);
const { PersonalReport } = require(reportPath);

GraphManager._resetInstance();
const chitchat = new Chitchat();
const afterChitchat = GraphManager.instance;
const chitchatGraph = chitchat.graph;
const report = new PersonalReport();
const afterReport = GraphManager.instance;
const reportGraph = report.graph;

function graphWitness(graph) {
  return {
    initial: {id: graph.initial.id, name: graph.initial.name},
    nodeCount: graph.nodes.size,
    nodes: Array.from(graph.nodes)
      .sort((a, b) => a.id - b.id)
      .map(node => ({id: node.id, name: node.name}))
  };
}

if (afterChitchat !== afterReport) throw new Error('GraphManager singleton changed between source skills');
process.stdout.write(JSON.stringify({
  runtime: process.version,
  order: ['chitchat-skill', 'report-skill'],
  afterChitchat: {nodeIDCounter: afterChitchat.nodeIDCounter, graph: graphWitness(chitchatGraph)},
  afterReport: {nodeIDCounter: afterReport.nodeIDCounter, graph: graphWitness(reportGraph)},
}, null, 2) + '\n');
