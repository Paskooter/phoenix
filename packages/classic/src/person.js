// `person` service (Person_20160801) — per-loop/per-account properties, the app's personalized
// questionnaire answers, loop holidays and birthdays. Graduated out of the tier-3 stub file in
// A-15; the stub only round-tripped a couple of in-memory property maps and answered holidays with
// a bare "Command accepted".
//
// Pinned from the archive (read through the Jibo archive MCP, not guessed):
//   apis/person-2016-08-01.normal.json                       jiborobot/srv-jibo-server-client
//       targetPrefix "Person_20160801"; ops List/Answer/EnableHolidays/ListHolidays/
//       DisableHolidays/SetLoopProperty/GetLoopProperties/SetAccountProperty/
//       GetAccountProperties/ListAccountPropertyKeys.
//   jiborobot/srv-person-ws@fc06373f
//       src/handlers/person.handler.js     Joi per op, @parseCredentials({}) for every op,
//                                          accountId = request.auth.credentials.id
//       src/handlers/property.handler.js   property Joi (value must be an object)
//       src/controllers/person.ctrl.js     list/answer/validate/enable/disable/listHolidays/
//                                          listUpcomingYearHolidays/syncHolidays/matchHolidays
//       src/controllers/property.ctrl.js   membership-gated upsert/read
//       src/errors/person.js               the exact error catalogue (codes + statusCodes)
//       src/schemes/answer.js|holiday.js|accountProperty.js|loopProperty.js  stored fields
//       src/clients/account.client.js      isLoopMember / isAccountOwnerOrRobot / listBirthdays
//       config/config.json                 PERSON_QUESTIONS + HOLIDAYS (see ./personCatalog.js)
//   jiborobot/srv-security-gw@43a692fe src/controllers/auth.ctrl.ts
//       `unauthorizedMethods` does NOT list any Person target and `unsignedMethods` is empty, so
//       the gateway requires a signed AWS4 Authorization header; `unactiveMethods` is only
//       Account_20151111.Remove. Missing header -> MISSING_AUTH_HEADER 401 (errors/account.ts).
//
// Source semantics deliberately kept:
//   * answer is checked for ALREADY_ANSWERED *before* the question is validated
//   * list filters out the caller's already-answered keys
//   * Enable/DisableHolidays is owner-or-robot only and flips `isEnabled` on matching ids
//   * ListHolidays computes the upcoming holidays for this + next year, syncs them into the DB
//     (creating disabled records and removing vanished ones), then answers the stored records
//     with a sha256 eventId derived from (name||memberId)+date
//   * Get/Set*Properties read/write maps keyed by the caller's account id
//
// Phoenix divergences (divergence candidates, not silent fixes):
//   * Mongo is gone. The store is one atomically replaced JSON file, written synchronously on
//     every mutation (same discipline as MediaStore/NotificationStore) so state survives a
//     restart. `id` fields are opaque strings.
//   * The account service is reached through an injected seam. When no seam is wired the
//     membership/ownership gates are skipped (LAN trust), exactly like Media's dropped gates —
//     the deployed launcher injects the real client.
//   * ListAccountPropertyKeys answers the declared API shape `{keys:[…]}`, while the source
//     controller returned a bare array (see A-01 candidate, "verified/inferred/unknown" split).
//     The generated client can only observe the declared structure, so `{keys}` is the wire.

import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, openSync, closeSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { sendAmz, sendAmzError, accessKeyIdFromAuth, ValidationException } from './awsJson.js';
import { PERSON_QUESTIONS, HOLIDAYS } from './personCatalog.js';

// srv-person-ws src/errors/person.js — verbatim codes, messages and status codes.
export const PERSON_ERRORS = {
  LOOP_MEMBER_ONLY: { code: 'LOOP_MEMBER_ONLY', statusCode: 403, message: 'Only loop member can query loop properties.' },
  CATEGORY_NOT_FOUND: { code: 'CATEGORY_NOT_FOUND', statusCode: 404, message: 'Specified category not found' },
  QUESTION_NOT_FOUND: { code: 'QUESTION_NOT_FOUND', statusCode: 404, message: 'Specified question not found' },
  ALREADY_ANSWERED: { code: 'ALREADY_ANSWERED', statusCode: 409, message: 'Question already answered' },
  ANSWER_OPTION_WRONG: { code: 'ANSWER_OPTION_WRONG', statusCode: 422, message: 'Provided answer is not an option' },
  HOLIDAY_NOT_FOUND: { code: 'HOLIDAY_NOT_FOUND', statusCode: 404, message: 'Holiday not found' },
  ACCOUNT_SERVICE_UNAVAILABLE: { code: 'ACCOUNT_SERVICE_UNAVAILABLE', statusCode: 503, message: 'Account service not available' },
  HOLIDAY_MUST_BE_OWNER_OR_ROBOT: { code: 'HOLIDAY_MUST_BE_OWNER_OR_ROBOT', statusCode: 403, message: 'You must be owner or robot to manipulate loop holidays' },
  PROPERTY_NOT_FOUND: { code: 'PROPERTY_NOT_FOUND', statusCode: 404, message: 'Property not found.' },
};

// srv-security-gw src/errors/account.ts — the gateway rejects an unsigned Person/Collision call.
export const MISSING_AUTH_HEADER = { code: 'MISSING_AUTH_HEADER', statusCode: 401, message: 'Request is not signed properly, missing authorization header' };

export const PERSON_OPERATIONS = [
  'list', 'answer', 'enableholidays', 'listholidays', 'disableholidays',
  'setloopproperty', 'getloopproperties', 'setaccountproperty', 'getaccountproperties',
  'listaccountpropertykeys',
];

const pair = (a, b) => `${a}\u0000${b}`;
const sameId = (a, b) => a != null && b != null && String(a) === String(b);

/**
 * Durable Person store. Sections:
 *   answers            accountId\u0000key      -> { key, answer, accountId, created }
 *   accountProperties  accountId\u0000key      -> { key, value, accountId, created, updated }
 *   loopProperties     loopId\u0000key         -> { loopId, key, value, updatedAccountId, created, updated }
 *   holidays           id                     -> { id, loopId, name?, memberId?, isEnabled, created }
 * `created`/`updated` are epoch-ms numbers (mongoose's toJSON transform emitted epoch ms).
 */
export class PersonStore {
  constructor({
    file = process.env.ETCO_classic_personFile || join(tmpdir(), 'phoenix-person.json'),
    clock = Date.now,
  } = {}) {
    this.file = file;
    this.clock = clock;
    this.answers = new Map();
    this.accountProperties = new Map();
    this.loopProperties = new Map();
    this.holidays = new Map();
    this._load();
  }

  _load() {
    if (!existsSync(this.file)) return;
    let raw;
    try {
      raw = JSON.parse(readFileSync(this.file, 'utf8'));
    } catch (error) {
      throw new Error(`person store unreadable (${this.file}): ${error.message}`);
    }
    for (const record of raw.answers || []) if (record) this.answers.set(pair(record.accountId, record.key), record);
    for (const record of raw.accountProperties || []) if (record) this.accountProperties.set(pair(record.accountId, record.key), record);
    for (const record of raw.loopProperties || []) if (record) this.loopProperties.set(pair(record.loopId, record.key), record);
    for (const record of raw.holidays || []) if (record && record.id) this.holidays.set(String(record.id), record);
  }

  _flush() {
    const serialized = JSON.stringify({
      answers: [...this.answers.values()],
      accountProperties: [...this.accountProperties.values()],
      loopProperties: [...this.loopProperties.values()],
      holidays: [...this.holidays.values()],
    }, null, 2);
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${randomUUID()}.tmp`;
    const fd = openSync(tmp, 'wx', 0o600);
    try {
      try { writeFileSync(fd, serialized); } finally { closeSync(fd); }
      renameSync(tmp, this.file);
    } finally {
      try { unlinkSync(tmp); } catch { /* renamed or cleanup unavailable */ }
    }
  }

  now() { return typeof this.clock === 'function' ? this.clock() : Date.now(); }

  // --- answers ---------------------------------------------------------------------------------
  findAnswers(accountId) {
    return [...this.answers.values()].filter((a) => sameId(a.accountId, accountId));
  }

  findAnswer(accountId, key) {
    for (const a of this.answers.values()) if (sameId(a.accountId, accountId) && a.key === key) return a;
    return null;
  }

  createAnswer({ accountId, key, answer }) {
    const record = { key, answer, accountId, created: this.now() };
    this.answers.set(pair(accountId, key), record);
    this._flush();
    return record;
  }

  // --- account properties ----------------------------------------------------------------------
  findAccountProperty(accountId, key) {
    for (const p of this.accountProperties.values()) if (sameId(p.accountId, accountId) && p.key === key) return p;
    return null;
  }

  /** `keys` omitted (Joi made it optional) reads every property for the account — INFERRED. */
  findAccountProperties(accountId, keys) {
    const wanted = Array.isArray(keys) ? new Set(keys) : null;
    return [...this.accountProperties.values()]
      .filter((p) => sameId(p.accountId, accountId) && (!wanted || wanted.has(p.key)));
  }

  saveAccountProperty({ accountId, key, value }) {
    const existing = this.findAccountProperty(accountId, key);
    const record = existing
      ? { ...existing, value, updated: this.now() }
      : { accountId, key, value, created: this.now(), updated: this.now() };
    this.accountProperties.set(pair(accountId, key), record);
    this._flush();
    return record;
  }

  listAccountPropertyKeys(accountId) {
    return this.findAccountProperties(accountId, null).map((p) => p.key);
  }

  // --- loop properties -------------------------------------------------------------------------
  findLoopProperty(loopId, key) {
    for (const p of this.loopProperties.values()) if (sameId(p.loopId, loopId) && p.key === key) return p;
    return null;
  }

  findLoopProperties(loopId, keys) {
    const wanted = Array.isArray(keys) ? new Set(keys) : null;
    return [...this.loopProperties.values()]
      .filter((p) => sameId(p.loopId, loopId) && (!wanted || wanted.has(p.key)));
  }

  saveLoopProperty({ loopId, key, value, updatedAccountId }) {
    const existing = this.findLoopProperty(loopId, key);
    const record = existing
      ? { ...existing, value, updatedAccountId, updated: this.now() }
      : { loopId, key, value, updatedAccountId, created: this.now(), updated: this.now() };
    this.loopProperties.set(pair(loopId, key), record);
    this._flush();
    return record;
  }

  // --- holidays --------------------------------------------------------------------------------
  findHolidays(loopId) {
    return [...this.holidays.values()].filter((h) => sameId(h.loopId, loopId));
  }

  createHoliday({ name, memberId, loopId, isEnabled }) {
    const record = { id: randomUUID().replace(/-/g, ''), name, memberId, loopId, isEnabled, created: this.now() };
    this.holidays.set(record.id, record);
    this._flush();
    return record;
  }

  setHolidayEnabled({ ids, loopId, isEnabled }) {
    const wanted = new Set((ids || []).map(String));
    let changed = false;
    for (const holiday of this.holidays.values()) {
      if (wanted.has(String(holiday.id)) && sameId(holiday.loopId, loopId)) {
        holiday.isEnabled = isEnabled;
        changed = true;
      }
    }
    if (changed) this._flush();
    return changed;
  }

  removeHoliday({ loopId, name, memberId }) {
    for (const [id, holiday] of [...this.holidays.entries()]) {
      if (!sameId(holiday.loopId, loopId)) continue;
      if (name !== undefined && holiday.name === name) { this.holidays.delete(id); continue; }
      if (memberId !== undefined && sameId(holiday.memberId, memberId)) this.holidays.delete(id);
    }
    this._flush();
  }
}

// ------------------------------------------------------------------------------------------------
// Controller — a direct port of srv-person-ws src/controllers/person.ctrl.js + property.ctrl.js
// ------------------------------------------------------------------------------------------------

function fail(code) { const err = new Error(code); Object.assign(err, PERSON_ERRORS[code]); throw err; }

/** PersonController.matchHolidays — name equality wins, else memberId equality. */
function matchHolidays(first, second) {
  return (first.name && first.name === second.name)
    || (first.memberId && String(first.memberId) === String(second.memberId));
}

export class PersonController {
  constructor(account, questions, holidays, store, now) {
    this.account = account;
    this.questions = questions;
    this.holidays = holidays;
    this.store = store;
    this.now = now;
  }

  async list({ accountId, category }) {
    const questions = this.questions[category];
    if (!questions) fail('CATEGORY_NOT_FOUND');
    const answerKeys = this.store.findAnswers(accountId).map((answer) => answer.key);
    return questions.filter((question) => !answerKeys.includes(question.key));
  }

  /** PersonController.validate — QUESTION_NOT_FOUND unless a question carries the key; when the
   *  question declares options the answer must be one of their keys (ANSWER_OPTION_WRONG 422). */
  validate({ key, answer }) {
    for (const category of Object.keys(this.questions)) {
      const targetQuestion = this.questions[category].find((question) => question.key === key);
      if (targetQuestion) {
        if (targetQuestion.options
          && !targetQuestion.options.some((option) => option.key === answer)) {
          fail('ANSWER_OPTION_WRONG');
        }
        return true;
      }
    }
    fail('QUESTION_NOT_FOUND');
  }

  async answer({ accountId, key, answer }) {
    if (this.store.findAnswer(accountId, key)) fail('ALREADY_ANSWERED');
    this.validate({ key, answer });
    return this.store.createAnswer({ accountId, key, answer });
  }

  async requireOwnerOrRobot({ loopId, accountId }) {
    if (!this.account || typeof this.account.isAccountOwnerOrRobot !== 'function') return;
    let ok;
    try {
      ok = await this.account.isAccountOwnerOrRobot({ loopId, accountId });
    } catch (error) {
      throw accountFailure(error);
    }
    if (!ok) fail('HOLIDAY_MUST_BE_OWNER_OR_ROBOT');
  }

  async enableHolidays({ ids, accountId, loopId }) {
    await this.requireOwnerOrRobot({ loopId, accountId });
    this.store.setHolidayEnabled({ ids, loopId, isEnabled: true });
    return { result: 'Command accepted' };
  }

  async disableHolidays({ ids, accountId, loopId }) {
    await this.requireOwnerOrRobot({ loopId, accountId });
    this.store.setHolidayEnabled({ ids, loopId, isEnabled: false });
    return { result: 'Command accepted' };
  }

  listAllHolidays({ year }) {
    return Object.keys(this.holidays).map((name) => ({
      name,
      category: this.holidays[name].category,
      subcategory: this.holidays[name].subcategory,
      date: this.holidays[name][year],
      endDate: this.holidays[name][`${year}End`],
    }));
  }

  async listUpcomingYearHolidays({ loopId, year }) {
    const allHolidaysThisYear = this.listAllHolidays({ year });
    const allHolidaysNextYear = this.listAllHolidays({ year: year + 1 });
    const today = new Date(this.now());
    today.setHours(0, 0, 0, 0);
    const nextYearDay = new Date(today);
    nextYearDay.setFullYear(today.getFullYear() + 1);
    const birthdaysRaw = (this.account && typeof this.account.listBirthdays === 'function')
      ? (await this.account.listBirthdays(loopId)) || []
      : [];
    return allHolidaysThisYear.concat(allHolidaysNextYear)
      .filter((holiday) => {
        const holidayDate = new Date(holiday.date);
        holidayDate.setHours(0, 0, 0, 0);
        return (holidayDate >= today) || (holidayDate <= nextYearDay);
      })
      .concat(birthdaysRaw.map((birthday) => ({
        category: 'birthday',
        memberId: birthday.memberId,
        date: new Date(birthday.date).toISOString().slice(0, 10),
      })));
  }

  async syncHolidays({ loopId, allHolidays }) {
    const existingHolidays = this.store.findHolidays(loopId);
    const existingBirthdays = existingHolidays.filter((holiday) => holiday.memberId);
    const areBirthdaysEnabled = existingBirthdays.length === 0 || existingBirthdays.some((holiday) => holiday.isEnabled);
    const missingHolidays = allHolidays.filter((holiday) => !existingHolidays.some((existing) => matchHolidays(holiday, existing)));
    const extraHolidays = existingHolidays.filter((existing) => !allHolidays.some((holiday) => matchHolidays(existing, holiday)));
    for (const missing of missingHolidays) {
      this.store.createHoliday({
        name: missing.name,
        memberId: missing.memberId,
        loopId,
        isEnabled: missing.memberId ? areBirthdaysEnabled : false,
      });
    }
    for (const extra of extraHolidays) {
      const condition = { loopId };
      if (extra.name) condition.name = extra.name;
      else if (extra.memberId) condition.memberId = extra.memberId;
      this.store.removeHoliday(condition);
    }
  }

  async listHolidays({ loopId, accountId }) {
    await this.requireOwnerOrRobot({ loopId, accountId });
    const year = new Date(this.now()).getFullYear();
    const upcomingHolidayList = await this.listUpcomingYearHolidays({ loopId, year });
    const allHolidays = upcomingHolidayList.filter((item, pos, self) => self.findIndex(
      (thing) => (item.name ? item.name === thing.name : item.memberId === thing.memberId),
    ) === pos);
    await this.syncHolidays({ loopId, allHolidays });
    const holidays = this.store.findHolidays(loopId);
    const upcomingHolidays = [];
    for (const holiday of holidays) {
      const definedHolidayList = upcomingHolidayList.filter((initial) => matchHolidays(initial, holiday));
      for (const definedHoliday of definedHolidayList) {
        const holidayClone = { ...holiday };
        holidayClone.date = definedHoliday.date;
        holidayClone.endDate = definedHoliday.endDate || definedHoliday.date;
        holidayClone.category = definedHoliday.category;
        holidayClone.eventId = createHash('sha256')
          .update(`${definedHoliday.name || definedHoliday.memberId}${definedHoliday.date}`)
          .digest('hex');
        if (definedHoliday.subcategory) holidayClone.subcategory = definedHoliday.subcategory;
        upcomingHolidays.push(holidayClone);
      }
    }
    return upcomingHolidays;
  }
}

export class PropertyController {
  constructor(account, store) {
    this.account = account;
    this.store = store;
  }

  async requireLoopMember({ accountId, loopId }) {
    if (!this.account || typeof this.account.isLoopMember !== 'function') return;
    let ok;
    try {
      ok = await this.account.isLoopMember({ loopId, accountId });
    } catch (error) {
      throw accountFailure(error);
    }
    if (!ok) fail('LOOP_MEMBER_ONLY');
  }

  async setLoopProperty({ accountId, loopId, key, value }) {
    await this.requireLoopMember({ accountId, loopId });
    this.store.saveLoopProperty({ loopId, key, value, updatedAccountId: accountId });
  }

  async getLoopProperties({ accountId, loopId, keys }) {
    await this.requireLoopMember({ accountId, loopId });
    return this.store.findLoopProperties(loopId, keys)
      .reduce((previous, current) => { previous[current.key] = current.value; return previous; }, {});
  }

  async setAccountProperty({ accountId, key, value }) {
    this.store.saveAccountProperty({ accountId, key, value });
  }

  async getAccountProperties({ accountId, keys }) {
    return this.store.findAccountProperties(accountId, keys)
      .reduce((previous, current) => { previous[current.key] = current.value; return previous; }, {});
  }

  async listAccountPropertyKeys({ accountId }) {
    return { keys: this.store.listAccountPropertyKeys(accountId) };
  }
}

/** A failing account hop is ACCOUNT_SERVICE_UNAVAILABLE 503 unless the source already typed it. */
function accountFailure(error) {
  if (error && error.statusCode) return error;
  const err = new Error(PERSON_ERRORS.ACCOUNT_SERVICE_UNAVAILABLE.message);
  err.cause = error;
  return Object.assign(err, PERSON_ERRORS.ACCOUNT_SERVICE_UNAVAILABLE);
}

// ------------------------------------------------------------------------------------------------
// Identity + validation
// ------------------------------------------------------------------------------------------------

/** The account identity the source read from `request.auth.credentials.id`. The gateway verifies
 *  the signature; on the trusted internal hop the id comes from the SigV4 `Credential=<id>/…`
 *  accessKeyId, or from Account Settings' `x-amz-credentials: {"id":…}` header when present. */
export function accountIdFromRequest(req) {
  const raw = req?.headers?.['x-amz-credentials'];
  if (raw) {
    try {
      const parsed = JSON.parse(Array.isArray(raw) ? raw[0] : raw);
      if (parsed && parsed.id !== undefined && parsed.id !== null) return String(parsed.id);
    } catch { /* fall through to SigV4 */ }
  }
  return accessKeyIdFromAuth(req);
}

const isNonEmptyString = (v) => typeof v === 'string' && v.length > 0;
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function validationError(res, message) { return void sendAmzError(res, ValidationException, message); }

const VALIDATORS = {
  list: (b) => (isNonEmptyString(b.category) ? null : 'Invalid or missing category'),
  answer: (b) => (isNonEmptyString(b.key) && isNonEmptyString(b.answer) ? null : 'Invalid or missing key or answer'),
  enableholidays: (b) => (Array.isArray(b.ids) && b.ids.every(isNonEmptyString) && isNonEmptyString(b.loopId) ? null : 'Invalid or missing ids or loopId'),
  disableholidays: (b) => (Array.isArray(b.ids) && b.ids.every(isNonEmptyString) && isNonEmptyString(b.loopId) ? null : 'Invalid or missing ids or loopId'),
  listholidays: (b) => (isNonEmptyString(b.loopId) ? null : 'Invalid or missing loopId'),
  setloopproperty: (b) => (isNonEmptyString(b.loopId) && isNonEmptyString(b.key) && isPlainObject(b.value) ? null : 'Invalid or missing loopId, key or value'),
  getloopproperties: (b) => (isNonEmptyString(b.loopId) && (b.keys === undefined || (Array.isArray(b.keys) && b.keys.length > 0 && b.keys.every(isNonEmptyString))) ? null : 'Invalid or missing loopId or keys'),
  setaccountproperty: (b) => (isNonEmptyString(b.key) && isPlainObject(b.value) ? null : 'Invalid or missing key or value'),
  getaccountproperties: (b) => (b.keys === undefined || (Array.isArray(b.keys) && b.keys.length > 0 && b.keys.every(isNonEmptyString)) ? null : 'Invalid keys'),
  listaccountpropertykeys: () => null,
};

/**
 * Person_20160801 handler. `account` is the source AccountClient seam
 * ({ isLoopMember, isAccountOwnerOrRobot, listBirthdays }); it may be omitted (LAN trust).
 */
export function makePersonHandler({
  store, account, questions = PERSON_QUESTIONS, holidays = HOLIDAYS, now = Date.now,
} = {}) {
  if (!store) throw new TypeError('person handler requires a PersonStore');
  const controller = new PersonController(account, questions, holidays, store, now);
  const properties = new PropertyController(account, store);

  const handlers = {
    list: ({ body, accountId }) => controller.list({ accountId, category: body.category }),
    answer: ({ body, accountId }) => controller.answer({ accountId, key: body.key, answer: body.answer }),
    enableholidays: ({ body, accountId }) => controller.enableHolidays({ ids: body.ids, accountId, loopId: body.loopId }),
    disableholidays: ({ body, accountId }) => controller.disableHolidays({ ids: body.ids, accountId, loopId: body.loopId }),
    listholidays: ({ body, accountId }) => controller.listHolidays({ loopId: body.loopId, accountId }),
    setloopproperty: ({ body, accountId }) => properties.setLoopProperty({ accountId, loopId: body.loopId, key: body.key, value: body.value }),
    getloopproperties: ({ body, accountId }) => properties.getLoopProperties({ accountId, loopId: body.loopId, keys: body.keys }),
    setaccountproperty: ({ body, accountId }) => properties.setAccountProperty({ accountId, key: body.key, value: body.value }),
    getaccountproperties: ({ body, accountId }) => properties.getAccountProperties({ accountId, keys: body.keys }),
    listaccountpropertykeys: ({ accountId }) => properties.listAccountPropertyKeys({ accountId }),
  };

  return async function personHandler({ req, res, body, op, log }) {
    const name = String(op).toLowerCase();
    const handler = handlers[name];
    if (!handler) return void sendAmzError(res, ValidationException, `unknown person operation: ${op}`);
    const accountId = accountIdFromRequest(req);
    if (!accountId) return void sendAmzError(res, MISSING_AUTH_HEADER);
    const payload = body || {};
    const invalid = VALIDATORS[name](payload);
    if (invalid) return validationError(res, invalid);
    if (log) log.info('person request', { op: name });
    try {
      const out = await handler({ body: payload, accountId });
      return void sendAmz(res, 200, out === undefined ? {} : out);
    } catch (error) {
      if (error && error.statusCode) return void sendAmzError(res, error);
      log?.error?.('person request failed', { op: name, error: error?.message });
      return void sendAmzError(res, { code: 'InternalFailure', statusCode: 500, message: 'Internal server error' });
    }
  };
}
