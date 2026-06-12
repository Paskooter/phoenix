// Commute subskill — full port of report-skill/src/subskills/commute/{CommuteFactory,
// CommuteData,CommuteParse,CommuteMimLogic}.ts. Depart time = arrival (normal work time, or an
// early calendar event today) minus trip duration (traffic-aware when driving); MimLogic picks
// Now / traffic (Poor/Terrible + DepartTimeNotNormal) / Normal + DepartTimeNormal / MinutesLeft
// / Hurry / Late, prefixed Drive- or Transport- by mode.

import { Graph } from '../graph/graph.js';
import { DefaultNode, DefaultTransition } from '../graph/nodes.js';
import { Names, addMimPathsToLocalData, secondsToMinutes } from './utils.js';
import { LassoClient } from './lassoClient.js';
import { DateTime } from './dateTime.js';
import { getWorkArrivalDT } from './calendar.js';

const msToMinutes = (ms) => ms / 60000;

export const MimPath = Object.freeze({
  Now: 'Now', AppSetup: 'AppSetup', ServiceDown: 'ServiceDown', MinutesLeft: 'MinutesLeft',
  ConfirmSpeaker: 'ConfirmSpeaker', DepartTimeNormal: 'DepartTimeNormal', DepartTimeNotNormal: 'DepartTimeNotNormal',
  Drive: 'Drive', Transport: 'Transport',
  Late: 'Late', Hurry: 'Hurry', Normal: 'Normal', Poor: 'Poor', Terrible: 'Terrible',
});

// --- CommuteData ----------------------------------------------------------------

export async function getData(userPrefs, data) {
  const log = data.log;
  let commuteData = null;
  try {
    if (userPrefs.commute.complete) {
      commuteData = await LassoClient.fetchGoogleMaps(data, userPrefs.commute);
    } else {
      log?.warn?.('Commute data incomplete, skipping getData');
      commuteData = { status: null, geocoded_waypoints: null, routes: null };
    }
  } catch (err) {
    log?.error?.(`Error getting commute from Lasso: ${err.message}`);
  }
  return [Names.commute, commuteData];
}

// --- CommuteParse ---------------------------------------------------------------

export async function commuteParse(mapsData, localISO, localData) {
  const userPrefs = localData.userPrefs;
  if (!userPrefs || !userPrefs.commute.complete) return undefined;

  const calSessionData = localData.calendar;
  const firstEarlyEvent = calSessionData && calSessionData.events && calSessionData.events.find((event) => event.isEarly);
  const mapsRoutes = mapsData && mapsData.routes && mapsData.routes[0];
  const mapsFirstLeg = mapsRoutes && mapsRoutes.legs && mapsRoutes.legs[0];
  if (!mapsFirstLeg) return undefined;

  const trip = mapsFirstLeg;
  const modeIsDriving = userPrefs.commute.mode === 'driving';

  const calArrival = earlyEventToday(firstEarlyEvent) ? firstEarlyEvent.dateTime : null;
  const arriveDT = calArrival || getWorkArrivalDT(null, localISO, userPrefs.commute.workTime);
  if (!arriveDT) return undefined;

  const secondsBaseline = (trip.duration && trip.duration.value) || 0;
  const secondsInTraffic = (trip.duration_in_traffic && trip.duration_in_traffic.value) || 0;
  const durationSeconds = (modeIsDriving && secondsInTraffic) || secondsBaseline;
  const extraMins = secondsToMinutes(secondsInTraffic - secondsBaseline);
  const departDT = arriveDT.clone();
  departDT.utc = arriveDT.utc - (durationSeconds * 1000);
  const minsLeft = Math.round(msToMinutes(departDT.utc - new DateTime(localISO).utc));

  return {
    departDT,
    arriveDT,
    minsLeft,
    modeIsDriving,
    eventIsEarly: earlyEventToday(firstEarlyEvent),
    durationMins: secondsToMinutes(durationSeconds),
    extraMins: (extraMins > 0) ? extraMins : 0,
  };
}

/** Early calendar events only matter for the commute when they're today. */
function earlyEventToday(event) {
  return !!event && event.isEarly && (event.dateTime.getRelativeDays() === 0);
}

// --- CommuteMimLogic --------------------------------------------------------------

export class CommuteMimLogic extends DefaultNode {
  async exit(data) {
    const mimPaths = await this._getMimPaths(data);
    data.local.mimPaths = addMimPathsToLocalData(Names.commute, mimPaths, data.local);
    return { transition: DefaultTransition.Done };
  }

  async _getMimPaths(data) {
    if (!data.local.userPrefs.commute.complete) return [MimPath.AppSetup];
    const commute = data.local.commute;
    if (!commute) return [MimPath.ServiceDown];

    const mimPaths = [];
    const minsLeft = commute.minsLeft;

    if (data.skill.session.data._personalReport.singleSkill) {
      mimPaths.push(MimPath.ConfirmSpeaker);
    }

    if (minsLeft > 120 || minsLeft < -30) {
      // Departure > 2h ahead or > 30 min past: just say how long the trip takes now.
      mimPaths.push(MimPath.Now);
    } else if (minsLeft > 0) {
      if (commute.modeIsDriving && commute.extraMins >= 5) {
        mimPaths.push(this.getTrafficMim(commute.extraMins), MimPath.DepartTimeNotNormal);
      } else {
        mimPaths.push(MimPath.Normal, MimPath.DepartTimeNormal);
      }
      mimPaths.push((minsLeft < 30) ? MimPath.MinutesLeft : null);

      data.local.views.commuteTraffic = {}; // GUI views not rendered in Phoenix sim
      data.local.views.commuteDepart = {};
    } else {
      // Within 10 minutes late: Hurry; 10-30 minutes late: Late.
      mimPaths.push((minsLeft > -10) ? MimPath.Hurry : MimPath.Late);
    }

    return this.filterAndPrefixMims(commute.modeIsDriving, mimPaths);
  }

  getTrafficMim(extraMins) {
    return (extraMins >= 15) ? MimPath.Terrible
      : (extraMins >= 5) ? MimPath.Poor
        : null;
  }

  filterAndPrefixMims(driving, paths) {
    const prefix = driving ? MimPath.Drive : MimPath.Transport;
    const needPrefix = {
      [MimPath.Poor]: true, [MimPath.Late]: true, [MimPath.Hurry]: true,
      [MimPath.Normal]: true, [MimPath.Terrible]: true,
    };
    return paths.filter((p) => !!p).map((p) => (needPrefix[p] ? prefix + p : p));
  }
}

// --- CommuteFactory ---------------------------------------------------------------

export const CommuteTransition = Object.freeze({ Done: 'Done' });

export class CommuteFactory {
  createGraph(gm) {
    const g = new Graph(gm, 'Commute', Object.values(CommuteTransition));
    const mimLogic = new CommuteMimLogic('Commute Mim Logic');
    const outro = new DefaultNode('Commute Outro');
    g.addNode(mimLogic, [[DefaultTransition.Done, outro]]);
    g.addNode(outro, [[DefaultTransition.Done, CommuteTransition.Done]]);
    g.finalize();
    return g;
  }
}
