// Commute subskill — E.8b placeholder for report-skill/src/subskills/commute/*. Graph shape and
// ServiceDown degradation are faithful; CommuteParse/CommuteMimLogic's depart-time + traffic
// tables (DriveNormal/Hurry/Late/Poor/Terrible, TransportNormal/Hurry/Late, MinutesLeft...) are
// the next port increment. With the settings service dead, commute only activates via
// ETCO_report_prefsFromConfig (see calendar.js for the reachable paths today).

import { Graph } from '../graph/graph.js';
import { DefaultNode, DefaultTransition } from '../graph/nodes.js';
import { Names, addMimPathsToLocalData } from './utils.js';
import { LassoClient } from './lassoClient.js';

export const MimPath = Object.freeze({ ServiceDown: 'ServiceDown', AppSetup: 'AppSetup' });

/** Fetch Google Maps commute data (CommuteData.getData). */
export async function getData(userPrefs, data) {
  const log = data.log;
  const prefs = userPrefs.commute;
  if (!prefs.complete) return [Names.commute, null]; // AppSetup territory
  try {
    const maps = await LassoClient.fetchGoogleMaps(data, prefs);
    return [Names.commute, maps || null];
  } catch (err) {
    log?.error?.(`Error getting commute data: ${err.message}`);
    return [Names.commute, null];
  }
}

/** E.8b: full CommuteParse port (duration vs normal, depart-by math against workTime). */
export async function commuteParse(maps) {
  return maps ? { maps } : undefined;
}

export class CommuteMimLogic extends DefaultNode {
  async exit(data) {
    if (!data.local.commute) {
      data.local.mimPaths = addMimPathsToLocalData(Names.commute, [MimPath.ServiceDown], data.local);
    }
    return { transition: DefaultTransition.Done };
  }
}

export const CommuteTransition = Object.freeze({ Done: 'Done' });

export class CommuteFactory {
  createGraph(gm) {
    const g = new Graph(gm, 'Commute', Object.values(CommuteTransition));
    const logicNode = new CommuteMimLogic('Commute Logic');
    const outroNode = new DefaultNode('Commute Outro');
    g.addNode(logicNode, [[DefaultTransition.Done, outroNode]]);
    g.addNode(outroNode, [[DefaultTransition.Done, CommuteTransition.Done]]);
    g.finalize();
    return g;
  }
}
