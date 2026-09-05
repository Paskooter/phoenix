'use strict';
const fs = require('fs');
const cases = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const sourceRoot = process.env.S05_SOURCE_ROOT || '/ref';
const PromptData = require(`${sourceRoot}/packages/baseskill/lib/graph/mims/utils/slimmer/PromptData.js`).PromptData;
const dataUtils = require(`${sourceRoot}/node_modules/jibo-data-utils`);
const originalNow = Date.now;
const log = { createChild: function () { return this; }, warn: function () {} };
function safe(fn) { try { return fn(); } catch (e) { return { error: e && e.message || String(e) }; } }
function ageSummary(age) {
  if (!age) return null;
  const out = {};
  ['milliseconds','seconds','minutes','hours','days','weeks','months','years'].forEach(k => {
    const item = age[k];
    out[k] = item ? { value: item.value, supplemented: item.supplemented, string: String(item) } : null;
  });
  out.value = age.value;
  out.supplemented = age.supplemented;
  out.string = String(age);
  return out;
}
function looperSummary(value) {
  if (value === null || value === undefined) return value === null ? null : undefined;
  return {
    id: safe(() => value.id), firstName: safe(() => value.firstName), lastName: safe(() => value.lastName), gender: safe(() => value.gender), string: safe(() => String(value)),
    birthdate: value.birthdate, birthday: value.birthday, isBirthday: value.isBirthday,
    age: ageSummary(value.age), zodiac: value.zodiac ? { value: value.zodiac.value, supplemented: value.zodiac.supplemented, string: String(value.zodiac) } : null,
  };
}
function jiboSummary(value) {
  if (value === null || value === undefined) return value === null ? null : undefined;
  return { id: safe(() => value.id), color: value.color, string: safe(() => String(value)), birthdate: value.birthdate, birthday: value.birthday, isBirthday: value.isBirthday, age: ageSummary(value.age), zodiac: value.zodiac ? { value: value.zodiac.value, supplemented: value.zodiac.supplemented, string: String(value.zodiac) } : null, emotion: value.emotion ? { valence: value.emotion.valence, confidence: value.emotion.confidence, string: safe(() => String(value.emotion)) } : null };
}
function dtSummary(value) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return { json: safe(() => value.toJSON()), string: safe(() => String(value)), display: safe(() => value.toString({display:true})), timeOnly: safe(() => value.toString({timeOnly:true})), prefix: safe(() => value.toString({prefixOnAt:true})), local: safe(() => value.getLocalTime()), ranges: {valid: safe(() => value.isInRange('12/20','1/5')), same: safe(() => value.isInRange('2/29','3/1')), invalid: safe(() => value.isInRange('bad','1/5')), zero: safe(() => value.isInRange('0/0','13/32'))} };
}
function locationSummary(value) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return { city:value.city,state:value.state,stateAbbr:value.stateAbbr,country:value.country,countryCode:value.countryCode,lat:value.lat,lng:value.lng,string:safe(()=>String(value)),prefix:safe(()=>value.prefixIn()),json:safe(()=>value.toJSON()),regions:{us:safe(()=>value.isInRegion('US')),usma:safe(()=>value.isInRegion('US-MA')),ca:safe(()=>value.isInRegion('CA')),array:safe(()=>value.isInRegion(['CA','US']))} };
}
function summarize(data) {
  return { speaker:looperSummary(data.speaker), referent:looperSummary(data.referent), jibo:jiboSummary(data.jibo), dt:{date:data.dt&&data.dt.date,day:data.dt&&data.dt.day,dayOfWeek:data.dt&&data.dt.dayOfWeek,dayOfMonth:data.dt&&data.dt.dayOfMonth,dayOfYear:data.dt&&data.dt.dayOfYear,weekOfYear:data.dt&&data.dt.weekOfYear,month:data.dt&&data.dt.month,monthOfYear:data.dt&&data.dt.monthOfYear,quarterOfYear:data.dt&&data.dt.quarterOfYear,year:data.dt&&data.dt.year,now:dtSummary(data.dt&&data.dt.now)}, location:locationSummary(data.location&&data.location.home), loop:data.loop&&{owner:looperSummary(data.loop.owner),list:data.loop.list,count:data.loop.count} };
}
const output=[];
for (const item of cases) {
  Date.now=()=>Date.parse(item.now);
  let result;
  try { result=summarize(new PromptData(item.context, log)); } catch (e) { result={thrown:e && e.message || String(e)}; }
  output.push({id:item.id,result});
}
Date.now=originalNow;
// Direct DateTime vectors exercise the helper's public source surface.
const fixed=Date.parse('2020-02-29T04:30:00.000Z'); Date.now=()=>fixed;
const dt=new dataUtils.DateTime('2020-02-29T23:30:00.000-05:00');
const periods=['year','month','week','weekend','day','hour','minute','now'];
const longPeriods={}; periods.forEach(p=>{const d=dt.clone(); d.timePeriod=p; longPeriods[p]=safe(()=>d.toString());});
output.push({id:'direct-datetime',result:{ranges:{valid:safe(()=>dt.isInRange('12/20','1/5')),same:safe(()=>dt.isInRange('2/29','3/1')),invalid:safe(()=>dt.isInRange('bad','1/5')),zero:safe(()=>dt.isInRange('0/0','13/32')),badMonth:safe(()=>dt.isInRange('13/1','13/32')),badDay:safe(()=>dt.isInRange('2/30','3/1'))},longPeriods, json:safe(()=>dt.toJSON())}});
Date.now=originalNow;
fs.writeFileSync(process.argv[3], JSON.stringify(output,null,2));
