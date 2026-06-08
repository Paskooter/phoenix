// Intent Router — port of intent/IntentRouter.ts + IRDecisionMaker.ts + the decision tree.
//
// Routes ONLY when nluData.intent is set AND nluData.rules includes 'launch'
// (IntentRouter.ts:25 — gotcha #6). A skill registers intents, each optionally constrained by
// entities with an operator (EXACT / NOT / wildcard '*'). Decision weight = sum over entities
// (exact/not = 1, wildcard = 0.5; IRDecisionMaker.ts:66). Highest weight wins; ties keep the
// first registered.

const WILDCARD = '*';

export class IntentRouter {
  /** @param {Array<{id:string, intents:Array<{name:string, entities?:Array<{name:string,value:string,matchRule?:string}>, memo?:any}>}>} skillConfigs */
  constructor(skillConfigs) {
    // intentName (lowercased) -> registrations
    this.byIntent = new Map();
    for (const cfg of skillConfigs) {
      for (const intent of cfg.intents || []) {
        const key = intent.name.toLowerCase();
        if (!this.byIntent.has(key)) this.byIntent.set(key, []);
        this.byIntent.get(key).push({ skillID: cfg.id, entities: intent.entities || [], memo: intent.memo });
      }
    }
  }

  /** @param {{intent?:string, rules?:string[], entities?:object}} nluData */
  getSkillIDFromNLU(nluData) {
    if (!nluData || !nluData.intent || !Array.isArray(nluData.rules) || nluData.rules.indexOf('launch') === -1) {
      return null;
    }
    const decisions = this._getDecisions(nluData.intent, nluData.entities || {});
    return decisions.length ? decisions[0] : null;
  }

  _getDecisions(intentName, entities) {
    const regs = this.byIntent.get(String(intentName).toLowerCase());
    if (!regs) return [];
    const decisions = [];
    for (const reg of regs) {
      let weight = 0;
      let ok = true;
      for (const ec of reg.entities) {
        const present = entities[ec.name];
        if (ec.value === WILDCARD) {
          if (present === undefined) { ok = false; break; }
          weight += 0.5;
        } else {
          const rule = ec.matchRule || 'EXACT';
          const matches = rule === 'NOT' ? present !== ec.value : present === ec.value;
          if (!matches) { ok = false; break; }
          weight += 1;
        }
      }
      if (ok) decisions.push({ skillID: reg.skillID, weight, memo: reg.memo });
    }
    return decisions.sort((a, b) => b.weight - a.weight);
  }
}
