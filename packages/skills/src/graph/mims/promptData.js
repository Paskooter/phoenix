// PromptData — the sandbox variables MIM conditions + prompt templates evaluate against
// (port of baseskill graph/mims/utils/slimmer/PromptData.ts + LooperData/JiboData).
// Built from the runtime context + skill-provided extras. The real chitchat library
// (4.4k MIMs) exercises this surface; the heavy hitters measured across all prompts:
//   dt.now.isInRange('M/D','M/D')   2845x  (seasonal content windows)
//   jibo.emotion == "JOYFUL"         644x  (emotion-conditioned variants; EmotionData
//                                          compares loosely as its name string)
//   referent.gender / speaker.id / loop.owner / jibo.isBirthday / dice.a / coin.a

import { loadMimFile } from './loadMim.js';

export function buildPromptData(runtime = {}, skillData = {}) {
  const loop = runtime.loop || {};
  const perception = runtime.perception || {};
  const location = runtime.location || {};
  const dialog = runtime.dialog || {};
  const nowDate = isoToDate(location.iso) || new Date();

  const users = (loop.users || []).map((u) => looperData(u, nowDate));
  const speaker = users.find((u) => u.id === perception.speaker) || null;
  const referent = users.find((u) => u.id === dialog.referent) || speaker;
  const owner = users.find((u) => u.role === 'OWNER' || u.owner === true) || users[0] || null;

  return {
    speaker,
    referent,
    loop: { ...loop, users, list: users, owner },
    location,
    perception,
    character: runtime.character || {},
    dialog,
    jibo: jiboData(loop.jibo, runtime.character, nowDate),
    dt: buildDt(location.iso, nowDate),
    ...skillData,
  };
}

// --- LooperData (lean port: id/name/gender/birthday/age + toString) ----------
function looperData(u, nowDate) {
  const birthdate = u.birthdate ? new Date(u.birthdate) : null;
  return {
    ...u,
    firstName: u.firstName || (u.name ? String(u.name).split(' ')[0] : undefined),
    gender: u.gender || 'unknown',
    isBirthday: birthdate ? sameMonthDay(birthdate, nowDate) : false,
    age: ageData(birthdate, nowDate),
    toString() { return this.firstName || 'someone'; },
  };
}

// --- JiboData (LooperData.ts:54) ---------------------------------------------
function jiboData(jiboInfo, character, nowDate) {
  const info = jiboInfo || {};
  const birthdate = info.birthdate ? new Date(info.birthdate) : null;
  const em = (character && character.emotion) || {};
  // EmotionData: conditions compare `jibo.emotion == "JOYFUL"` (loose string
  // equality via toString) and read `.valence`. Default to a mild positive state
  // when the context carries no emotion engine output (the sim usually doesn't).
  const emotion = {
    name: em.name || 'PLEASED',
    valence: em.valence != null ? em.valence : 0.6,
    arousal: em.arousal != null ? em.arousal : 0.3,
    toString() { return this.name; },
  };
  return {
    id: info.id,
    color: info.color || 'WHITE',
    birthdate: birthdate ? fmtLongDate(birthdate) : '',
    birthday: birthdate ? fmtMonthDay(birthdate) : '',
    isBirthday: birthdate ? sameMonthDay(birthdate, nowDate) : false,
    age: ageData(birthdate, nowDate),
    zodiac: { supplemented: birthdate ? zodiacOf(birthdate) : '' },
    emotion,
    toString() { return 'Jibo'; },
  };
}

// --- NLAge (lean: value in years + per-unit values with "supplemented" text) --
function ageData(birthdate, nowDate) {
  if (!birthdate || Number.isNaN(birthdate.getTime())) {
    const empty = { value: 0, supplemented: '' };
    return { value: 0, supplemented: '', years: empty, days: empty, hours: empty, minutes: empty, seconds: empty };
  }
  const ms = Math.max(0, nowDate.getTime() - birthdate.getTime());
  // supplemented = "3137 days" (no trailing "old" — the MIM templates add that).
  const mk = (v, unit) => ({ value: v, supplemented: `${v} ${unit}${v === 1 ? '' : 's'}` });
  const years = Math.floor(ms / (365.25 * 24 * 3600 * 1000));
  return {
    value: years,
    supplemented: mk(years, 'year').supplemented,
    years: mk(years, 'year'),
    days: mk(Math.floor(ms / (24 * 3600 * 1000)), 'day'),
    hours: mk(Math.floor(ms / (3600 * 1000)), 'hour'),
    minutes: mk(Math.floor(ms / 60000), 'minute'),
    seconds: mk(Math.floor(ms / 1000), 'second'),
  };
}

// --- DateTimeData (dt) ---------------------------------------------------------
function buildDt(iso, nowDate) {
  const hour = nowDate.getHours();
  const partOfDay = hour < 5 ? 'NIGHT' : hour < 12 ? 'MORNING' : hour < 17 ? 'AFTERNOON' : hour < 21 ? 'EVENING' : 'NIGHT';
  const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  return {
    hour,
    dayOfWeek: nowDate.getDay(),
    day: DAYS[nowDate.getDay()],     // "${dt.day}" -> "Friday" (PersonalReportKickOff)
    date: fmtMonthDay(nowDate),      // "${dt.date}" -> "June 12th"
    partOfDay,
    iso,
    // dt.now.isInRange('M/D', 'M/D') — inclusive month/day window, wrapping over
    // new year when start > end (e.g. '12/20','1/5'). The single most-used MIM
    // condition (jibo-data-utils DateTime.isInRange).
    now: {
      month: nowDate.getMonth() + 1,
      day: nowDate.getDate(),
      isInRange(start, end) {
        const cur = (nowDate.getMonth() + 1) * 100 + nowDate.getDate();
        const [sm, sd] = String(start).split('/').map(Number);
        const [em2, ed] = String(end).split('/').map(Number);
        const s = sm * 100 + sd; const e = em2 * 100 + ed;
        return s <= e ? (cur >= s && cur <= e) : (cur >= s || cur <= e);
      },
    },
  };
}

// --- helpers -------------------------------------------------------------------
function isoToDate(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}
function sameMonthDay(a, b) { return a.getMonth() === b.getMonth() && a.getDate() === b.getDate(); }
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
function ord(n) { const s = ['th', 'st', 'nd', 'rd']; const v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); }
function fmtMonthDay(d) { return `${MONTHS[d.getMonth()]} ${ord(d.getDate())}`; }
function fmtLongDate(d) { return `${fmtMonthDay(d)} ${d.getFullYear()}`; }
function zodiacOf(d) {
  const z = [[120, 'Aquarius'], [219, 'Pisces'], [321, 'Aries'], [420, 'Taurus'], [521, 'Gemini'], [621, 'Cancer'], [723, 'Leo'], [823, 'Virgo'], [923, 'Libra'], [1023, 'Scorpio'], [1122, 'Sagittarius'], [1222, 'Capricorn'], [1232, 'Aquarius']];
  const key = (d.getMonth() + 1) * 100 + d.getDate();
  for (const [k, name] of z) if (key < k) return name;
  return 'Aquarius';
}

export { loadMimFile };
