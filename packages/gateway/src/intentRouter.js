// Intent Router — the gateway-side port of the reference hub intent tree.
//
// The reference keeps one decision tree per registry snapshot. Entity paths
// are grouped by name and operator, and a node's bare decisions are used only
// when no constrained branch matches. The small tree below deliberately keeps
// those details instead of flattening registrations into independent tests.

const WILDCARD = '*';

function getObjectProperty(object, path) {
  return path.split('.').reduce((value, piece) => {
    if (typeof value === 'object' && value !== null) return value[piece];
    return undefined;
  }, object);
}

class Operator {
  getValueType(value) {
    if (Array.isArray(value)) return 'array';
    if (value === null) return 'null';
    return typeof value;
  }

  isNotEmpty(value) {
    switch (this.getValueType(value)) {
      case 'boolean':
      case 'number':
      case 'string':
        return String(value).length > 0;
      case 'array':
        return value.length > 0 && value.some(item => this.isNotEmpty(item));
      case 'object':
        return Object.keys(value).length > 0;
      default:
        return false;
    }
  }

  isEqual(value, expectedValue) {
    switch (this.getValueType(value)) {
      case 'boolean':
      case 'number':
      case 'string':
        return String(value).toLowerCase() === String(expectedValue).toLowerCase();
      case 'array':
        return value.length > 0 && value.some(item => this.isEqual(item, expectedValue));
      case 'object':
        return false;
      default:
        return false;
    }
  }
}

class Any extends Operator {
  check(value) {
    return this.isNotEmpty(value);
  }

  toString() {
    return WILDCARD;
  }
}

class Exact extends Operator {
  constructor(expectedValue) {
    super();
    this.expectedValue = expectedValue;
  }

  check(value) {
    return this.isNotEmpty(value) && this.isEqual(value, this.expectedValue);
  }

  toString() {
    return `EXACT[${this.expectedValue}]`;
  }
}

class Not extends Operator {
  constructor(expectedValue) {
    super();
    this.expectedValue = expectedValue;
  }

  check(value) {
    return this.isNotEmpty(value) && !this.isEqual(value, this.expectedValue);
  }

  toString() {
    return `NOT[${this.expectedValue}]`;
  }
}

function getEntityOperator(entityConfig) {
  if (entityConfig.value === WILDCARD) return new Any();
  const matchRule = entityConfig.matchRule || 'EXACT';
  switch (matchRule) {
    case 'EXACT': return new Exact(entityConfig.value);
    case 'NOT': return new Not(entityConfig.value);
    default: throw new Error(`Unknown matchRule for ${entityConfig.name}: ${matchRule}`);
  }
}

class TreeNode {
  constructor() {
    this.nodes = new Map();
  }

  createNode(key, value) {
    this.nodes.set(key, value);
    return value;
  }

  getNode(key) {
    return this.nodes.get(key);
  }

  getOrCreateNode(key, create) {
    if (!this.nodes.has(key)) this.createNode(key, create());
    return this.nodes.get(key);
  }

  removeNodes() {
    return this.nodes.clear();
  }

  forEachChild(callback) {
    for (const [key, value] of this.nodes.entries()) callback(key, value);
  }

  toObject() {
    const result = {};
    this.forEachChild((key, value) => {
      result[key.toString()] = value.toObject();
    });
    return result;
  }
}

class EntityDecisionsNode extends TreeNode {
  createDecisionNode(operator) {
    return this.createNode(operator, new DecisionTreeNode());
  }
}

class DecisionTreeNode extends TreeNode {
  constructor() {
    super();
    this.decisions = [];
  }

  createEntityNode(entityName) {
    return this.getOrCreateNode(entityName, () => new EntityDecisionsNode());
  }

  addDecision(decision) {
    this.decisions.push(decision);
  }

  getDecisions(data) {
    if (this.nodes.size === 0 || !data.entities) return this.decisions;

    const entityResults = [];
    this.forEachChild((entityName, entityDecisions) => {
      const entityValue = getObjectProperty(data.entities, entityName);
      entityDecisions.forEachChild((operator, deeperNode) => {
        if (operator.check(entityValue)) {
          entityResults.push(...deeperNode.getDecisions(data));
        }
      });
    });
    return entityResults.length ? entityResults : this.decisions;
  }

  toObject() {
    const result = super.toObject();
    if (this.decisions.length) result.skills = this.decisions.map(decision => decision.skillID);
    return result;
  }
}

class DecisionTree extends TreeNode {
  createIntentNode() {
    return new DecisionTreeNode();
  }

  getIntentKey(intentName) {
    return intentName.toLowerCase();
  }

  getOrCreateIntent(intentName) {
    return this.getOrCreateNode(this.getIntentKey(intentName), () => this.createIntentNode());
  }
}

// Node 8 (V8 6.x) used this in-place quicksort for arrays longer than ten
// elements. The reference sorts its decision array with a zero comparator for
// ties, so using the host Node's stable sort changes the selected skill when a
// registry has more than ten equal-weight decisions. This is the source
// algorithm, including its insertion-sort short-array path.
function legacySort(array, compare) {
  function insertionSort(values, from, to) {
    for (let i = from + 1; i < to; i += 1) {
      const element = values[i];
      let j;
      for (j = i - 1; j >= from; j -= 1) {
        const temporary = values[j];
        const order = compare(temporary, element);
        if (order > 0) values[j + 1] = temporary;
        else break;
      }
      values[j + 1] = element;
    }
  }

  function getThirdIndex(values, from, to) {
    const candidates = [];
    const increment = 200 + ((to - from) & 15);
    let j = 0;
    from += 1;
    to -= 1;
    for (let i = from; i < to; i += increment) {
      candidates[j] = [i, values[i]];
      j += 1;
    }
    legacySort(candidates, (left, right) => compare(left[1], right[1]));
    return candidates[candidates.length >> 1][0];
  }

  function quickSort(values, from, to) {
    let thirdIndex = 0;
    while (true) {
      if (to - from <= 10) {
        insertionSort(values, from, to);
        return;
      }
      if (to - from > 1000) thirdIndex = getThirdIndex(values, from, to);
      else thirdIndex = from + ((to - from) >> 1);

      let v0 = values[from];
      let v1 = values[to - 1];
      let v2 = values[thirdIndex];
      const c01 = compare(v0, v1);
      if (c01 > 0) {
        const temporary = v0;
        v0 = v1;
        v1 = temporary;
      }
      const c02 = compare(v0, v2);
      if (c02 >= 0) {
        const temporary = v0;
        v0 = v2;
        v2 = v1;
        v1 = temporary;
      } else {
        const c12 = compare(v1, v2);
        if (c12 > 0) {
          const temporary = v1;
          v1 = v2;
          v2 = temporary;
        }
      }

      values[from] = v0;
      values[to - 1] = v2;
      const pivot = v1;
      let lowEnd = from + 1;
      let highStart = to - 1;
      values[thirdIndex] = values[lowEnd];
      values[lowEnd] = pivot;

      partition: for (let i = lowEnd + 1; i < highStart; i += 1) {
        let element = values[i];
        let order = compare(element, pivot);
        if (order < 0) {
          values[i] = values[lowEnd];
          values[lowEnd] = element;
          lowEnd += 1;
        } else if (order > 0) {
          do {
            highStart -= 1;
            if (highStart === i) break partition;
            const topElement = values[highStart];
            order = compare(topElement, pivot);
          } while (order > 0);
          values[i] = values[highStart];
          values[highStart] = element;
          if (order < 0) {
            element = values[i];
            values[i] = values[lowEnd];
            values[lowEnd] = element;
            lowEnd += 1;
          }
        }
      }

      if (to - highStart < lowEnd - from) {
        quickSort(values, highStart, to);
        to = lowEnd;
      } else {
        quickSort(values, from, lowEnd);
        from = highStart;
      }
    }
  }

  quickSort(array, 0, array.length);
  return array;
}

class IRDecisionMaker {
  constructor(configManager) {
    this.tree = new DecisionTree();
    this.rebuildDecisionTree(configManager.getSkillConfigs());
  }

  getDecisions(data) {
    const intentNode = this.tree.getNode(this.tree.getIntentKey(data.intentName));
    if (!intentNode) return [];
    return legacySort(intentNode.getDecisions(data), (left, right) => right.weight - left.weight);
  }

  getTreeJSON() {
    return JSON.stringify(this.tree.toObject());
  }

  rebuildDecisionTree(skillConfigs) {
    this.tree.removeNodes();
    skillConfigs.forEach(skillConfig => {
      skillConfig.intents.forEach(intent => {
        let currentNode = this.tree.getOrCreateIntent(intent.name);
        let decisionWeight = 0;
        if (intent.entities) {
          intent.entities.forEach(entityConfig => {
            currentNode = currentNode.createEntityNode(entityConfig.name)
              .createDecisionNode(getEntityOperator(entityConfig));
            decisionWeight += entityConfig.value === WILDCARD ? 0.5 : 1;
          });
        }
        const decision = { skillID: skillConfig.id, weight: decisionWeight };
        if (intent.memo) decision.memo = intent.memo;
        currentNode.addDecision(decision);
      });
    });
  }
}

export class IntentRouter {
  constructor(skillConfigsOrManager) {
    const configManager = Array.isArray(skillConfigsOrManager)
      ? { getSkillConfigs: () => skillConfigsOrManager }
      : skillConfigsOrManager;
    this.decisionMaker = new IRDecisionMaker(configManager);
  }

  getSkillIDFromNLU(nluData) {
    if (nluData && nluData.intent && nluData.rules && nluData.rules.indexOf('launch') !== -1) {
      const decisions = this.getDecisions(nluData);
      if (decisions.length > 0) return decisions[0];
    }
  }

  getDecisions(nluData) {
    return this.decisionMaker.getDecisions({
      intentName: nluData.intent,
      entities: nluData.entities,
    });
  }

  // Existing gateway probes call this shape; the reference public method is
  // getDecisions(nluData), and both use the same tree and sort operation.
  _getDecisions(intentName, entities) {
    return this.decisionMaker.getDecisions({ intentName, entities });
  }
}
