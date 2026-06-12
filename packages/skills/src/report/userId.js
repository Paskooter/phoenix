// UserID subgraph — port of report-skill/src/subgraphs/userid/{UserIDFactory,PrefetchWeatherNode}.ts.
// If the speaker isn't IDed (and the launch needs one), prefetch weather to hide latency, ask
// WhoIsThis (a QN MIM), then recover identity via SetLooperIDNode.

import { Graph } from '../graph/graph.js';
import { DefaultNode, DefaultTransition, TrueFalseNode, TrueFalseTransition, SetLooperIDNode, SetLooperIDTransition } from '../graph/nodes.js';
import { QNFactory, QNFactoryTransition } from '../graph/mims/factories.js';
import { Names, composeMimPath } from './utils.js';
import { LassoClient } from './lassoClient.js';

const hoursToMs = (h) => h * 3600 * 1000;

export const UserIDTransition = Object.freeze({ Done: 'Done', MaxNI: 'MaxNI' });

export class PrefetchWeatherNode extends DefaultNode {
  async exit(data) {
    const log = data.log;
    // Full report + missing ID: warm the weather cache while we ask who's there.
    if (!data.skill.session.data._personalReport.singleSkill) {
      const nowUTC = new Date((data.runtime.location && data.runtime.location.iso) || Date.now()).valueOf();
      const yestUTC = nowUTC - hoursToMs(24);
      const swallow = (err) => log?.error?.(`DarkSky prefetch error. Code: ${err.code} Message: ${err.message}`);
      Promise.resolve(LassoClient.fetchDarkSky(data, null, true)).catch(swallow);
      Promise.resolve(LassoClient.fetchDarkSky(data, yestUTC, true)).catch(swallow);
      // Constant prefetch timestamp keeps the cache key stable across turns.
      data.skill.session.data.darkSkyPrefetchUTC = nowUTC;
    }
    return { transition: DefaultTransition.Done };
  }
}

export class UserIDFactory {
  constructor(name, skill) { this.name = name; this.skill = skill; }

  createGraph(gm) {
    const g = new Graph(gm, this.name, Object.values(UserIDTransition));

    const checkSpeakerID = async (data) => {
      const singleSkill = data.skill.session.data._personalReport.singleSkill;
      const haveSpeaker = !!(data.runtime.perception && data.runtime.perception.speaker);
      const needSpeaker = (singleSkill !== Names.weather) && (singleSkill !== Names.news);
      return haveSpeaker || !needSpeaker; // !needSpeaker falls back to default news categories
    };

    const isUserIDedTFNode = new TrueFalseNode('Is User IDed?', checkSpeakerID);
    const prefetchWeatherNode = new PrefetchWeatherNode('Prefetch Weather');
    const whoIsThisMim = new QNFactory('Who Is This?', {
      mimDataProvider: composeMimPath(Names.personalReport, 'WhoIsThis'),
    }).createGraph(gm);
    const maxNINode = new DefaultNode('MaxNI');
    const setLooperNode = new SetLooperIDNode('Update Looper ID', this.skill);

    g.addNode(isUserIDedTFNode, [
      [TrueFalseTransition.False, prefetchWeatherNode],
      [TrueFalseTransition.True, UserIDTransition.Done],
    ]);
    g.addNode(prefetchWeatherNode, [[DefaultTransition.Done, whoIsThisMim.initial]]);
    g.addSubGraph(whoIsThisMim, [
      [QNFactoryTransition.Success, setLooperNode],
      [QNFactoryTransition.NoInput, maxNINode],
      [QNFactoryTransition.NoMatch, setLooperNode],
    ]);
    g.addNode(maxNINode, [[DefaultTransition.Done, UserIDTransition.MaxNI]]);
    g.addNode(setLooperNode, [
      [SetLooperIDTransition.Success, UserIDTransition.Done],
      [SetLooperIDTransition.Cancel, UserIDTransition.MaxNI],
      [SetLooperIDTransition.NotInLoop, UserIDTransition.Done],
    ]);

    g.finalize();
    return g;
  }
}
