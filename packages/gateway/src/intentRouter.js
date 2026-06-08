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
    this.skillIds = new Set(); // every known skill id (for launch-by-skill-entity)
    for (const cfg of skillConfigs) {
      this.skillIds.add(cfg.id);
      for (const intent of cfg.intents || []) {
        const key = intent.name.toLowerCase();
        if (!this.byIntent.has(key)) this.byIntent.set(key, []);
        this.byIntent.get(key).push({ skillID: cfg.id, entities: intent.entities || [], memo: intent.memo });
      }
    }
  }

  /** @param {{intent?:string, rules?:string[], entities?:object}} nluData */
  getSkillIDFromNLU(nluData) {
    if (!nluData || !Array.isArray(nluData.rules) || nluData.rules.indexOf('launch') === -1) return null;

    // 1. intent decision tree (cloud skills + be-skills whose grammar emits the manifest intent).
    if (nluData.intent) {
      const decisions = this._getDecisions(nluData.intent, nluData.entities || {});
      if (decisions.length) return decisions[0];
    }

    // 2. launch-by-skill-entity: many be-skill launch grammars tag entities.skill='@be/<id>'
    //    without (or with a different) manifest intent. The reference robot/sim treat the skill
    //    entity itself as the launch signal (registry.parse: match.skillID = ent.skill), so route
    //    to it directly when it names a known skill.
    const skillEnt = nluData.entities && nluData.entities.skill;
    if (skillEnt && this.skillIds.has(skillEnt)) {
      return { skillID: skillEnt, weight: 0, memo: (nluData.entities && nluData.entities.memo) || null };
    }
    return null;
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
