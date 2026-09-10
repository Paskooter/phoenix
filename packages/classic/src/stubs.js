// Build-to-spec classic-service stubs (CLASSIC-SERVICES.md tier 3). These needed the dead mobile
// app and/or robot hardware to actually exercise, so they were implemented to the wire contract
// (apis/<name>.normal.json output shapes) and wire-tested for dispatch + shape — but UNVERIFIED
// end-to-end without the app (recorded in DIVERGENCES.md). Each returned an empty/sane-default
// shape so a robot or app calling it got a valid answer instead of hanging.
//
// Every service that once lived here has graduated to a real, source-faithful handler:
//
//   media      (Media_20160725)      photo/recording store            -> ./media.js   (A-Gallery)
//   rom        (ROM_20171011)        cert exchange                     -> ./rom.js     (A-16)
//   ifttt      (IFTTT_20170207)      IFTTT account link                -> ./ifttt.js
//   nlp        (NLP_20161031)        classic NLP                       -> ./nlp.js
//   person     (Person_20160801)     questions/answers, properties,    -> ./person.js  (A-15)
//                                    holidays, birthdays
//   collision  (Collision_20161126)  phonetic username collision       -> ./collision.js (A-15)
//   jot        (Jibo Jot)            loop-scoped family messaging     -> ./jot.js      (A-19)
//   voiceTraining (VoiceTraining_*)  robot voice-sample enrollment    -> ./voiceTraining.js (A-20)
//
// Every classic service family with a recovered source handler has now graduated.
//
// The registration list is deliberately still exported so the entrypoint keeps a single seam for
// "services that are answers-only". It is now empty.

/** Router registrations for every stubbed classic service. Currently none — see the header. */
export function stubRegistrations() {
  return [];
}
