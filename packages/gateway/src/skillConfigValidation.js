// Pegasus 5c0a739: config/validation/* and utils/TimeUtils.ts. Keep the original
// truthiness checks, enum lookups and error order; stricter schemas change which
// manifests the server accepts.
const stringEnum = (...names) => Object.fromEntries(names.map(name => [name, name]));
const contextMatches = stringEnum('EXACT', 'NOT', 'CONTAINS_ALL', 'CONTAINS_ANY', 'NOT_CONTAIN', 'GREATER_THAN', 'LESS_THAN', 'CONTAINED_IN');
const historyMatches = stringEnum('EXACT', 'NOT', 'ONE_OF', 'CONTAINS', 'NOT_CONTAIN', 'CONTAINS_ANY', 'CONTAINS_ALL');
const ihMatches = stringEnum('EXACT', 'NOT', 'GREATER_THAN', 'LESS_THAN');
const settingsMatches = stringEnum('EXACT', 'NOT');
const queryTypes = stringEnum('LastEvent', 'Count');
const transforms = stringEnum('TimeSince');
const timeOffsets = stringEnum('SinceWaking');
const timeUnits = stringEnum('msec', 'sec', 'min', 'minute', 'minutes', 'hour', 'hours', 'day', 'days');
const settingTargets = { 0: 'loop', 1: 'person', 2: 'lasso', loop: 0, person: 1, lasso: 2 };
const ruleFields = ['skillID', 'intent', 'personIDs', 'payload'];

export function deepFreeze(value) {
  Object.freeze(value);
  if (value === undefined) return value;
  for (const key of Object.getOwnPropertyNames(value)) {
    const child = value[key];
    if (child !== null && (typeof child === 'object' || typeof child === 'function') && !Object.isFrozen(child)) deepFreeze(child);
  }
  return value;
}

export function legacyConfigError(error) {
  if (error instanceof TypeError) error.message = error.message
    .replace(/^Cannot read properties of (null|undefined) \(reading '(.+)'\)$/, "Cannot read property '$2' of $1")
    .replace(/^Cannot set properties of (null|undefined) \(setting '(.+)'\)$/, "Cannot set property '$2' of $1");
  return error;
}

export function validateSkillsIndex(config) {
  try {
    if (!Array.isArray(config.skills)) throw new Error("Hub service config missing required list parameter 'skills'");
    for (const entry of config.skills) {
      // ConfigFileValidator discards the regex result, so non-http URLs pass.
      if (entry.baseURL) /^http:\/\//.test(entry.baseURL);
      if (typeof entry.configPath !== 'string') throw new Error("Skill service config missing required parameter 'configPath'");
    }
  } catch (error) { throw legacyConfigError(error); }
}

export function validateSkillConfig(entry) {
  try { return validateEntry(entry); }
  catch (error) { throw legacyConfigError(error); }
}

function validateEntry(entry) {
  if (typeof entry.id !== 'string') throw new Error('Skill entry missing or has invalid ID string');
  if (typeof entry.URL !== 'string') throw new Error(`URL missing: ${entry.id}`);
  if (!entry.URL.length && !entry.onRobot) throw new Error(`Need to either be 'onRobot: true' or have URL: ${entry.id}`);
  if (!Array.isArray(entry.intents)) throw new Error(`Invalid intent list: ${entry.intents}`);
  for (const intentConfig of entry.intents) {
    if (!intentConfig.name) throw new Error(`Missing intent name in ${entry.id} config`);
    if (intentConfig.entities) {
      if (!Array.isArray(intentConfig.entities)) throw new Error(`Invalid entities list in ${entry.id} config`);
      for (const entityConfig of intentConfig.entities) {
        if (typeof entityConfig.name !== 'string') throw new Error(`Entity ${entityConfig.name} name is not a string in ${entry.id}/${intentConfig.name} config`);
        if (!['string', 'number', 'boolean'].includes(typeof entityConfig.value)) throw new Error(`Entity ${entityConfig.name} value is not alowed in ${entry.id}/${intentConfig.name} config`);
        if (String(entityConfig.value).length === 0) throw new Error(`Missing entity value in ${entry.id}/${intentConfig.name} config`);
      }
    }
  }
  if (entry.proactives) {
    if (!Array.isArray(entry.proactives)) throw new Error(`proactives should be a list: ${entry.proactives}`);
    for (const registration of entry.proactives) validateProactiveRegistration(registration, entry.IHQueries);
  }
  if (entry.settings) {
    try { validateSettingsView(entry.settings.view); }
    catch (error) { throw new Error(`Error validating manifest settings, Error: ${legacyConfigError(error).message}: ${entry.id}`); }
  }
  if (entry.IHQueries) {
    if (typeof entry.IHQueries !== 'object') throw new Error('IHQueries must be an object');
    for (const key of Object.keys(entry.IHQueries)) validateIHQuery(entry.IHQueries[key]);
  }
  return true;
}

function validateProactiveRegistration(registration, queries) {
  if (!Array.isArray(registration.topics)) throw new Error(`topics must be an array: ${registration.topics}`);
  for (const topic of registration.topics) if (typeof topic !== 'string') throw new Error(`topics must be strings: ${topic}`);
  if (!Array.isArray(registration.contextRules)) throw new Error(`rules must be an array: ${registration.contextRules}`);
  for (const rule of registration.contextRules) {
    checkProperties(rule, ['field', 'matchRule', 'value'], 'ContextRule');
    if (typeof rule.field !== 'string') throw new Error(`ContextRule field must be of type string: ${rule.field}`);
    if (!contextMatches[rule.matchRule]) throw new Error(`ContextRule invalid matchRule: ${rule.matchRule}`);
    if (!rule.hasOwnProperty('value')) throw new Error('ContextRule missing value');
  }
  if (registration.IHRules) {
    if (!Array.isArray(registration.IHRules)) throw new Error(`IHRules must be an array: ${registration.IHRules}`);
    for (const rule of registration.IHRules) validateIHRule(rule, queries);
  }
  if (registration.settingsRules) {
    if (!Array.isArray(registration.settingsRules)) throw new Error(`settingsRules must be an array: ${registration.settingsRules}`);
    for (const rule of registration.settingsRules) validateSettingsRule(rule);
  }
}

function validateIHRule(ihrule, queryDefinitions = {}) {
  checkProperties(ihrule, ['query', 'matchRule', 'transform', 'checkProperty', 'value'], 'IHRule');
  if (!ihrule.query) throw new Error('IHRule must have query');
  if (typeof ihrule.query === 'string') {
    if (!queryDefinitions[ihrule.query]) throw new Error(`Missing query ${ihrule.query}`);
  } else if (typeof ihrule.query === 'object') validateIHQuery(ihrule.query);
  else throw new Error('IHRule.query must be a string or an object');
  if (!ihrule.matchRule) throw new Error('IHRule must have a match method specified');
  if (!ihMatches[ihrule.matchRule]) throw new Error(`Unknown match method in IHRule: ${ihrule.matchRule}`);
  if (ihrule.transform) {
    if (!transforms[ihrule.transform]) throw new Error(`Unknown transform method in IHRule: ${ihrule.transform}`);
    if (ihrule.transform === transforms.TimeSince) validateTimePeriod(ihrule.value);
  }
  if (ihrule.checkProperty && typeof ihrule.checkProperty !== 'string') throw new Error('checkProperty in IHRule must be a string');
  if (!ihrule.hasOwnProperty('value')) throw new Error('Value in IHRule is missing');
  const valueType = Array.isArray(ihrule.value) ? 'array' : typeof ihrule.value;
  if (!['number', 'boolean', 'object', 'array'].includes(valueType)) throw new Error(`Value in IHRule cannot be ${valueType}`);
  if (valueType === 'object' && ihrule.value !== null) throw new Error('Value in IHRule cannot be an object except null');
}

export function validateIHQuery(query) {
  checkProperties(query, ['type', 'queryRules', 'personID', 'startTimeOffset', 'endTimeOffset'], 'IHQuery');
  if (!query.type) throw new Error('IHQuery should have a type');
  if (!queryTypes[query.type]) throw new Error(`Unsupported IHQuery type: ${query.type}`);
  if (query.queryRules) {
    if (!Array.isArray(query.queryRules)) throw new Error('IHQuery rules should be an array');
    for (const rule of query.queryRules) {
      checkProperties(rule, ['field', 'key', 'match', 'value'], 'IHQueryRule');
      if (!rule.field) throw new Error('Missing field in rule ' + JSON.stringify(rule));
      if (!ruleFields.includes(rule.field)) throw new Error(`Unknown field in IHRule.query.rules: ${rule.field}`);
      if (!rule.match) throw new Error('Missing match method in rule ' + JSON.stringify(rule));
      if (!historyMatches[rule.match]) throw new Error(`Unknown match method: ${rule.match} in rule ` + JSON.stringify(rule));
      if (typeof rule.value === 'undefined') throw new Error('Missing value method in rule ' + JSON.stringify(rule));
    }
  }
  if (query.startTimeOffset) validateTimeOffset(query.startTimeOffset);
  if (query.endTimeOffset) validateTimeOffset(query.endTimeOffset);
}

function validateSettingsRule(rule) {
  checkProperties(rule, ['skill', 'key', 'matchRule', 'value'], 'settingsRule');
  if (!rule.skill) throw new Error('Missing skill in settings rule ' + JSON.stringify(rule));
  if (typeof rule.skill !== 'string') throw new Error('SettingsRule.skill must be a string.');
  if (!rule.key) throw new Error('Missing key in settings rule ' + JSON.stringify(rule));
  if (typeof rule.key !== 'string') throw new Error('SettingsRule.key must be a string.');
  if (!rule.matchRule) throw new Error('IHRule must have a match method specified');
  if (!settingsMatches[rule.matchRule]) throw new Error(`Unknown match method in settingsRule: ${rule.matchRule}`);
}

function isTimePeriod(value) {
  return !!(Array.isArray(value) && value.length === 2 && typeof value[0] === 'number' && typeof value[1] === 'string' && timeUnits[value[1]]);
}

function validateTimePeriod(period, sign) {
  if (!isTimePeriod(period)) throw new Error('Invalid time period: ' + JSON.stringify(period));
  if (sign === 'negative' && period[0] > 0) throw new Error('Must be negative period: ' + JSON.stringify(period));
}

function validateTimeOffset(offset) {
  if (isTimePeriod(offset)) validateTimePeriod(offset, 'negative');
  else if (typeof offset === 'string') {
    if (!timeOffsets[offset]) throw new Error(`Unknown time offset: ${offset}`);
  } else throw new Error(`Invalid time offset: ${offset}`);
}

function checkProperties(object, expected, name) {
  for (const key of Object.keys(object)) if (!expected.includes(key)) throw new Error(`Unexpected property ${key} in ${name}`);
}

function validateSettingsView(view) {
  const stack = [view];
  while (stack.length) {
    const item = stack.pop();
    if (typeof item.type !== 'string' || item.type.trim().length === 0) settingsError('"type" must be non-empty string', item);
    if (typeof item.index !== 'number') settingsError('"index" must be a number', item);
    const def = item.valueDefinition;
    if (def) {
      if (!def.target) settingsError('"target" in value definition must be non-empty string', item);
      if (!(def.target in settingTargets)) settingsError('"target" in value definition must be one of the following: loop, person, lasso', item);
      if (typeof def.key !== 'string' || def.key.trim().length === 0) settingsError('"key" in value definition must be non-empty string', item);
    }
    if (item.childViews) {
      if (!Array.isArray(item.childViews)) settingsError('"childViews" must be an array', item);
      stack.push(...item.childViews);
    }
  }
}

function settingsError(message, item) {
  const value = Object.assign({}, item);
  delete value.childViews;
  throw new Error(`${message}\n${JSON.stringify(value)}`);
}
