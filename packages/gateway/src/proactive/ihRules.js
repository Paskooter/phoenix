// Proactive interaction-history rules — port of hub/proactive/tools/IHRulesChecker.ts + IHTools.
// Resolves each PR's IHRules against the history service: build the named IHQuery (rules +
// start/end times from offsets relative to now), run it (Count/LastEvent), evaluate the rule.

const UNIT_MS = { seconds: 1e3, minutes: 6e4, hours: 36e5, days: 864e5 };

/** [n, unit] (TimePeriod) -> absolute ms relative to `now`. SinceWaking unsupported -> undefined. */
export function getTimeByOffset(offset, now = Date.now()) {
  if (!Array.isArray(offset)) return undefined; // e.g. 'SinceWaking'
  const [n, unit] = offset;
  const ms = UNIT_MS[unit];
  return ms ? now + n * ms : undefined;
}

export function buildHistoryQuery(queryDef, { robotID }, now = Date.now()) {
  const q = { robotID, rules: queryDef.queryRules || [] };
  if (queryDef.startTimeOffset) { const t = getTimeByOffset(queryDef.startTimeOffset, now); if (t !== undefined) q.startTime = t; }
  if (queryDef.endTimeOffset) { const t = getTimeByOffset(queryDef.endTimeOffset, now); if (t !== undefined) q.endTime = t; }
  return q;
}

export function evaluateIHRule(rule, result) {
  if (result === 'ERROR') return false;
  let v = result;
  if (rule.transform === 'TimeSince' && result && result.timestamp) v = Date.now() - result.timestamp;
  if (rule.checkProperty && v && typeof v === 'object') v = rule.checkProperty.split('.').reduce((o, k) => (o == null ? undefined : o[k]), v);
  switch (rule.matchRule) {
    case 'EXACT': return v === rule.value;
    case 'NOT': return v !== rule.value;
    case 'GREATER_THAN': return v > rule.value;
    case 'LESS_THAN': return v < rule.value;
    default: throw new Error(`Unknown IH matchRule: ${rule.matchRule}`);
  }
}

/**
 * Filter PRs by their IHRules.
 * @param {Array} prs eligible PRs (each may carry IHRules)
 * @param {object} ihQueries the skill's IHQueryDefinitions (named)
 * @param {{robotID:string}} ctx
 * @param {import('../historyClient.js').HistoryClient} history
 */
export async function checkIHRules(prs, ihQueries = {}, ctx, history) {
  // resolve unique queries once
  const cache = new Map();
  const run = async (queryRef) => {
    const key = typeof queryRef === 'string' ? queryRef : JSON.stringify(queryRef);
    if (cache.has(key)) return cache.get(key);
    const def = typeof queryRef === 'string' ? ihQueries[queryRef] : queryRef;
    if (!def) { cache.set(key, 'ERROR'); return 'ERROR'; }
    let result;
    try {
      const q = buildHistoryQuery(def, ctx);
      result = def.type === 'LastEvent' ? await history.getLatestSkillLaunch(q) : await history.getSkillLaunchCount(q);
    } catch { result = 'ERROR'; }
    cache.set(key, result);
    return result;
  };

  const out = [];
  for (const pr of prs) {
    if (!pr.IHRules || !pr.IHRules.length) { out.push(pr); continue; }
    let ok = true;
    for (const rule of pr.IHRules) {
      const result = await run(rule.query);
      if (!evaluateIHRule(rule, result)) { ok = false; break; }
    }
    if (ok) out.push(pr);
  }
  return out;
}
