// Proactive interaction-history rules — exact port of hub/proactive/tools/
// IHRulesChecker.ts + IHTools.ts.
//
// Pinned source: pegasus@5c0a7390539663ba749d360de348a428c088505c
//   packages/hub/src/proactive/tools/IHTools.ts:23-129       (evaluate, transform, offsets, query lookup)
//   packages/hub/src/proactive/tools/IHRulesChecker.ts:34-135 (query cache, buildHistoryServiceQuery)
//   packages/hub/src/proactive/tools/IHRulesChecker.ts:140-174 (personID rule)
//   packages/hub/src/utils/TimeUtils.ts:6-44                  (TimePeriod units + ms conversion)
//   packages/utils-common/src/Object.ts:47-57                 (getObjectProperty dot path)
//
// The source's own quirks are reproduced, not smoothed over:
//   * `getQueryDefinition` is called OUTSIDE the per-query try/catch, so an IHRule naming an
//     undefined query aborts the whole transaction (IHRulesChecker.ts:54-55).
//   * a failed history request, an unknown query type or an invalid query definition land in
//     the same catch and become the sentinel 'ERROR' (IHRulesChecker.ts:59-64).
//   * `evaluateIHRule` has NO 'ERROR' special case: 'ERROR' is compared like any other value,
//     and a value/expected type mismatch short-circuits to `matchRule === 'NOT'`
//     (IHTools.ts:42-44).
//   * `context.wakeUpTime` is always null (ProactiveTransactionHandler.ts:116), so a
//     'SinceWaking' offset always throws in the reference.

const UNIT_MS = {
  msec: 1,
  sec: 1e3,
  min: 6e4,
  minute: 6e4,
  minutes: 6e4,
  hour: 36e5,
  hours: 36e5,
  day: 864e5,
  days: 864e5,
};
const TIME_UNITS = new Set(Object.keys(UNIT_MS));

function isTimePeriod(value) {
  return Array.isArray(value) && value.length === 2 && typeof value[0] === 'number' && typeof value[1] === 'string' && TIME_UNITS.has(value[1]);
}

function validateTimePeriod(period, ensureThat) {
  if (!isTimePeriod(period)) throw new Error(`Invalid time period: ` + JSON.stringify(period));
  if (ensureThat === 'negative' && period[0] > 0) throw new Error(`Must be negative period: ` + JSON.stringify(period));
  if (ensureThat === 'positive' && period[0] < 0) throw new Error(`Must be positive period: ` + JSON.stringify(period));
}

/** TimeUtils.timePeriodToMiliseconds — validates first, then converts by unit. */
export function timePeriodToMiliseconds(period) {
  validateTimePeriod(period);
  const [quantity, units] = period;
  return quantity * UNIT_MS[units];
}

/** Object.ts getObjectProperty: dot path, undefined once a non-object is reached. */
export function getObjectProperty(object, path) {
  return String(path).split('.').reduce((value, piece) => {
    if (typeof value === 'object' && value !== null) return value[piece];
    return undefined;
  }, object);
}

/**
 * IHTools.getTimeByOffset — a TimePeriod is relative to now; 'SinceWaking' needs the
 * transaction's wakeUpTime (always null in the reference) and throws otherwise.
 */
export function getTimeByOffset(timeOffset, context = {}, now = Date.now()) {
  if (isTimePeriod(timeOffset)) return now + timePeriodToMiliseconds(timeOffset);
  if (typeof timeOffset === 'string') {
    if (timeOffset === 'SinceWaking') {
      if (!context.wakeUpTime) throw new Error('Robot wake up time is unknown');
      return context.wakeUpTime;
    }
    throw new Error(`Unknown timeOffset: ${timeOffset}`);
  }
  throw new Error('Invalid time offset: ' + JSON.stringify(timeOffset));
}

/** IHTools.getTimeSince — Date.now() - timestamp, or undefined when there is no timestamp. */
export function getTimeSince(data) {
  if (typeof data === 'object' && data !== null && Object.prototype.hasOwnProperty.call(data, 'timestamp')) {
    return Date.now() - data.timestamp;
  }
  return undefined;
}

/** IHTools.applyTransformation. */
export function applyTransformation(value, transformation) {
  if (transformation === 'TimeSince') return getTimeSince(value);
  throw new Error(`Unknown transform method ${transformation}`);
}

/** IHTools.evaluateIHRule(rule, historyResponse). */
export function evaluateIHRule(rule, historyResponse) {
  let value = historyResponse;
  let compareWithValue = rule.value;
  if (rule.transform) value = applyTransformation(value, rule.transform);
  if (rule.checkProperty) {
    if (typeof value === 'object' && value !== null) value = getObjectProperty(value, rule.checkProperty);
    else value = undefined;
  }
  if (rule.transform === 'TimeSince') {
    validateTimePeriod(rule.value, 'positive');
    compareWithValue = timePeriodToMiliseconds(rule.value);
  }
  if (typeof value !== typeof compareWithValue) return rule.matchRule === 'NOT';
  switch (rule.matchRule) {
    case 'EXACT': return value === compareWithValue;
    case 'NOT': return value !== compareWithValue;
    case 'GREATER_THAN': return value > compareWithValue;
    case 'LESS_THAN': return value < compareWithValue;
    default: throw new Error(`Unknown matchRule in IHRule: ${rule.matchRule}`);
  }
}

/** IHTools.getQueryDefinition — a named query must exist; the throw is not caught. */
export function getQueryDefinition(query, queryDefinitions) {
  const queryType = typeof query;
  if (queryType === 'string') {
    const definition = (queryDefinitions || {})[query];
    if (!definition) throw new Error(`Missing query definition: ${query}`);
    return definition;
  }
  if (queryType === 'object') return query;
  throw new Error(`IHRuleQuery cannot be of type ${queryType}`);
}

/** IHRulesChecker.buildPersonIDRule — the personID pseudo-rule appended to the query rules. */
export function buildPersonIDRule(query, context = {}) {
  switch (query.personID) {
    case 'UNKNOWN':
      return { field: 'personIDs', match: 'CONTAINS', value: 'UNKNOWN' };
    case 'NONE':
      return { field: 'personIDs', match: 'CONTAINS', value: 'NONE' };
    case 'IDENTIFIED':
      return { field: 'personIDs', match: 'NOT_CONTAIN', value: ['UNKNOWN', 'NONE'] };
    case 'FOCUSED_PERSON':
      return { field: 'personIDs', match: 'CONTAINS', value: context.focusedPerson };
    case 'ANY':
      return null;
    default:
      throw new Error(`Unsupported personID value in a history query: ${query.personID}`);
  }
}

/**
 * IHRulesChecker.buildHistoryServiceQuery — validate the definition, then translate it into the
 * history-service IHQuery (robotID, rules, optional start/end times). `validate` is injected so
 * the config validator (skillConfigValidation.js) supplies the same check the source calls.
 */
export function buildHistoryQuery(queryDef, context = {}, now = Date.now(), validate) {
  if (validate) validate(queryDef);
  const ihQuery = { robotID: context.robotID, rules: queryDef.queryRules || [] };
  if (queryDef.personID) {
    const personRule = buildPersonIDRule(queryDef, context);
    if (personRule) {
      // don't use .push here — it would modify the original queryDef.queryRules
      ihQuery.rules = [...queryDef.queryRules, personRule];
    }
  }
  if (queryDef.startTimeOffset) ihQuery.startTime = getTimeByOffset(queryDef.startTimeOffset, context, now);
  if (queryDef.endTimeOffset) ihQuery.endTime = getTimeByOffset(queryDef.endTimeOffset, context, now);
  return ihQuery;
}

/**
 * IHRulesChecker.checkIHRules — resolve every distinct query once, then keep the PRs whose
 * rules all pass.
 *
 * @param {Array} prs eligible PRs (each may carry IHRules)
 * @param {object} ihQueries the skill's IHQueryDefinitions (named)
 * @param {{robotID:string, focusedPerson?:string, wakeUpTime?:number}} ctx
 * @param {import('../historyClient.js').HistoryClient} history
 * @param {(def:object)=>void} [validate] IHQueryDefinition validator (SkillConfigValidator.validateIHQuery)
 */
export async function checkIHRules(prs, ihQueries = {}, ctx, history, validate) {
  const queryResults = new Map();
  // find all history queries
  for (const pr of prs) {
    if (pr.IHRules && pr.IHRules.length > 0) for (const rule of pr.IHRules) queryResults.set(rule.query, null);
  }
  // fetch query results
  for (const query of [...queryResults.keys()]) {
    // Outside the try: an undefined named query is not swallowed (IHRulesChecker.ts:54-55).
    const queryDef = getQueryDefinition(query, ihQueries);
    let result;
    try {
      const q = buildHistoryQuery(queryDef, ctx, Date.now(), validate);
      result = queryDef.type === 'LastEvent' ? await history.getLatestSkillLaunch(q) : await history.getSkillLaunchCount(q);
    } catch {
      // 'ERROR' because null is a valid history-service response (no records found)
      result = 'ERROR';
    }
    queryResults.set(query, result);
  }
  return prs.filter((pr) => {
    if (!pr.IHRules || !pr.IHRules.length) return true;
    return pr.IHRules.every((rule) => evaluateIHRule(rule, queryResults.get(rule.query)));
  });
}
