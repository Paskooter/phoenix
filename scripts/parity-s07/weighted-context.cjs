'use strict';

// Weighted S-07 contexts extend the accepted library-context profiles instead
// of copying their fixture.  A profile is `weighted|key=value|...`; the old
// names continue to resolve through the imported base factory so the shared
// runners remain reusable.

const base = require('./library-context.cjs');

function runtimeFor(profile) {
  if (!profile || !profile.startsWith('weighted|')) return base.runtimeFor(profile);
  const runtime = base.clone(base.runtimeFor('baseline'));
  const parts = profile.split('|').slice(1);
  for (const part of parts) {
    const equal = part.indexOf('=');
    const key = equal === -1 ? part : part.slice(0, equal);
    const value = equal === -1 ? true : part.slice(equal + 1);
    apply(runtime, key, value);
  }
  return runtime;
}

function findUser(runtime, id) {
  return runtime.loop.users.find((item) => item.id === id);
}

function setBirthday(runtime, id, year = 2000) {
  const user = findUser(runtime, id);
  if (user) user.birthdate = Date.UTC(year, 4, 30);
}

function setNonBirthday(runtime, id) {
  const user = findUser(runtime, id);
  if (user) user.birthdate = Date.UTC(1970, 0, 1);
}

function setDate(runtime, date, hour = '12') {
  runtime.location.iso = `${date}T${String(hour).padStart(2, '0')}:00:00.000Z`;
}

function setReferent(runtime, value) {
  runtime.dialog.referent = value;
}

function setSpeaker(runtime, value) {
  runtime.perception.speaker = value;
}

function apply(runtime, key, value) {
  const allowed = {
    location: ['none'],
    speaker: ['none', 'present', 'birthday', 'nonbirthday', 'age40'],
    referent: ['none', 'male', 'female', 'male-adult', 'female-adult', 'female-child', 'male-child', 'age10', 'male-age10', 'age11', 'age12', 'age13', 'birthday', 'nonbirthday'],
    loop: ['empty', 'one', 'two', 'one-referent', 'one-referent-speaker', 'owner-speaker', 'owner-other', 'no-owner', 'present'],
    jibo: ['none', 'birthday-zero', 'birthday-adult', 'nonbirthday', 'white', 'WHITE', 'black', 'BLACK'],
    emotion: ['undefined', 'missing', 'JOYFUL', 'PLEASED', 'DETERMINED', 'CONFIDENT', 'NEUTRAL', 'INSECURE', 'HOPEFUL', 'SAD', 'FRUSTRATED'],
    city: ['none', 'boston', 'new-york'],
    region: ['CA', 'US'],
  };
  if (allowed[key] && !allowed[key].includes(value)) throw new Error(`unknown weighted context value ${key}=${value}`);
  switch (key) {
    case 'location':
      if (value === 'none') runtime.location = null;
      break;
    case 'date': setDate(runtime, value); break;
    case 'hour': setDate(runtime, runtime.location.iso.slice(0, 10), value); break;
    case 'speaker':
      if (value === 'none') setSpeaker(runtime, null);
      else if (value === 'present') setSpeaker(runtime, base.SPEAKER);
      else if (value === 'birthday') { setSpeaker(runtime, base.SPEAKER); setBirthday(runtime, base.SPEAKER); }
      else if (value === 'nonbirthday') { setSpeaker(runtime, base.SPEAKER); setNonBirthday(runtime, base.SPEAKER); }
      else if (value === 'age40') { setSpeaker(runtime, base.SPEAKER); setBirthday(runtime, base.SPEAKER, 1978); }
      break;
    case 'referent':
      if (value === 'none') setReferent(runtime, null);
      else {
        setReferent(runtime, base.REFERENT);
        const user = findUser(runtime, base.REFERENT);
        if (value === 'female' || value === 'female-adult') user.gender = 'female';
        if (value === 'male' || value === 'male-adult') user.gender = 'male';
        if (value === 'female-child') { user.gender = 'female'; user.birthdate = Date.UTC(2010, 0, 1); }
        if (value === 'male-child') { user.gender = 'male'; user.birthdate = Date.UTC(2010, 0, 1); }
        if (value === 'age10') { user.gender = 'female'; user.birthdate = Date.UTC(2008, 4, 30); }
        if (value === 'male-age10') { user.gender = 'male'; user.birthdate = Date.UTC(2008, 4, 30); }
        if (value === 'age11') { user.gender = 'female'; user.birthdate = Date.UTC(2007, 4, 30); }
        if (value === 'age12') { user.gender = 'female'; user.birthdate = Date.UTC(2006, 4, 30); }
        if (value === 'age13') { user.gender = 'female'; user.birthdate = Date.UTC(2005, 4, 30); }
        if (value === 'birthday') { user.gender = 'female'; setBirthday(runtime, base.REFERENT); }
        if (value === 'nonbirthday') { user.gender = 'female'; user.birthdate = Date.UTC(1970, 0, 1); }
      }
      break;
    case 'loop':
      if (value === 'empty') { runtime.loop.users = []; runtime.loop.owner = null; setSpeaker(runtime, null); setReferent(runtime, null); }
      else if (value === 'one') { runtime.loop.users = [findUser(runtime, base.SPEAKER)]; runtime.loop.owner = base.SPEAKER; }
      else if (value === 'two') { runtime.loop.users = [findUser(runtime, base.OWNER), findUser(runtime, base.SPEAKER)]; runtime.loop.owner = base.OWNER; }
      else if (value === 'one-referent') { runtime.loop.users = [findUser(runtime, base.REFERENT)]; runtime.loop.owner = base.REFERENT; setSpeaker(runtime, null); }
      else if (value === 'one-referent-speaker') { runtime.loop.users = [findUser(runtime, base.REFERENT)]; runtime.loop.owner = base.REFERENT; setSpeaker(runtime, base.REFERENT); }
      else if (value === 'present') { /* retain the baseline loop */ }
      else if (value === 'owner-speaker') runtime.loop.owner = base.SPEAKER;
      else if (value === 'owner-other') runtime.loop.owner = base.OWNER;
      else if (value === 'no-owner') runtime.loop.owner = null;
      break;
    case 'jibo':
      if (value === 'none') runtime.loop.jibo = null;
      else if (value === 'birthday-zero') runtime.loop.jibo.birthdate = Date.UTC(2018, 4, 30);
      else if (value === 'birthday-adult') runtime.loop.jibo.birthdate = Date.UTC(2000, 4, 30);
      else if (value === 'nonbirthday') runtime.loop.jibo.birthdate = Date.UTC(2000, 0, 1);
      else if (value === 'white' || value === 'WHITE') runtime.loop.jibo.color = 'WHITE';
      else if (value === 'black' || value === 'BLACK') runtime.loop.jibo.color = 'BLACK';
      break;
    case 'emotion':
      if (value === 'undefined') runtime.character.emotion = {};
      else if (value === 'missing') runtime.character.emotion = null;
      else {
        const valence = { JOYFUL: 1, PLEASED: 0.6, DETERMINED: 0.5, CONFIDENT: 0.7, NEUTRAL: 0, INSECURE: -0.1, HOPEFUL: 0.3, SAD: -0.7, FRUSTRATED: -0.5 }[value];
        runtime.character.emotion = { confidence: 0.2, valence, name: value };
      }
      break;
    case 'city':
      if (value === 'none') runtime.location.city = null;
      else if (value === 'boston') { runtime.location.city = 'boston'; runtime.location.state = 'Massachusetts'; runtime.location.stateAbbr = 'ma'; }
      else if (value === 'new-york') { runtime.location.city = 'new york'; runtime.location.state = 'New York'; runtime.location.stateAbbr = 'ny'; }
      break;
    case 'region':
      if (value === 'CA') { runtime.location.country = 'canada'; runtime.location.countryCode = 'CA'; runtime.location.stateAbbr = 'on'; runtime.location.state = 'Ontario'; }
      else if (value === 'US') { runtime.location.country = 'usa'; runtime.location.countryCode = 'US'; runtime.location.stateAbbr = 'ma'; runtime.location.state = 'Massachusetts'; }
      break;
    default: throw new Error(`unknown weighted context key ${key}`);
  }
}

module.exports = { runtimeFor };
