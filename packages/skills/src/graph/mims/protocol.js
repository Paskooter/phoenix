// JCP behavior protocol builders — a line-for-line port of the pinned requester contract.
//
// Source (approved reference revision 5c0a7390539663ba749d360de348a428c088505c):
//   node_modules/jibo-command-requester/lib/jibo-command-requester.js
//     Display  :1654-1667  generateProtocol(name, view, layer, visible, keepDisplay, onCancel, overlay)
//     Listen   :1675-1687  generateProtocol(rules, intents)
//     Play     :1692-1702  generateProtocol(esml, config, options)
//     SLIM     :1709-1717  generateProtocol(config, options)
//     Parallel :1792-1801  generateProtocol(behaviors, succeedOnFirst = false)
//     Sequence :1808-1815  generateProtocol(behaviors)
//   node_modules/jibo-command-requester/lib/jibo-command-requester.js:356-364
//     generateTransactionID() — under Node an MD5 hex digest (32 lowercase hex characters),
//     in the browser a dash-free uuid v4.  Phoenix reproduces only the Node contract
//     (packages/skills/src/jcpId.js).
//
// The optional parameters (speakOptions, intents, options, overlay) are present-but-undefined
// exactly as the requester leaves them.  JSON serialization drops those keys, which is why the
// captured reference goldens are identical either way, but the in-memory objects must match the
// requester's key set and insertion order for exact structural comparison.

import { newJcpId } from '../../jcpId.js';

/** PLAY behavior (:1692-1702). */
export function playProtocol(esml, config, options) {
  return {
    id: newJcpId(),
    type: 'PLAY',
    autoRuleConfig: config,
    speakOptions: options,
    esml,
  };
}

/** LISTEN behavior (:1675-1687). `rules` may be a single rule or an array of rules. */
export function listenProtocol(rules, intents) {
  return {
    id: newJcpId(),
    type: 'LISTEN',
    contexts: Array.isArray(rules) ? rules : [rules],
    intents,
  };
}

/** DISPLAY behavior (:1654-1667). */
export function displayProtocol(name, view, layer, visible, keepDisplay, onCancel, overlay) {
  return {
    id: newJcpId(),
    type: 'DISPLAY',
    name,
    view,
    layer,
    overlay,
    visible,
    keepDisplay,
    onCancel,
  };
}

/** SLIM behavior (:1709-1717). */
export function slimProtocol(config, options) {
  return {
    id: newJcpId(),
    type: 'SLIM',
    config,
    options,
  };
}

/** SEQUENCE structural behavior (:1808-1815). */
export function sequenceProtocol(children) {
  return {
    id: newJcpId(),
    type: 'SEQUENCE',
    children,
  };
}

/** PARALLEL structural behavior (:1792-1801); succeedOnFirst defaults to false. */
export function parallelProtocol(children, succeedOnFirst = false) {
  return {
    id: newJcpId(),
    type: 'PARALLEL',
    children,
    succeedOnFirst,
  };
}
