// PersonalReport — port of report-skill/src/PersonalReport.ts: the full report graph.
//
//   IntentSplit ─Reactive→ UserID subgraph ─→ GetUserPrefs ─→ (OptIn | Finish | GetData)
//              └─Proactive→ GetUserPrefs ─OptIn→ OptInFactory ─Accepted/NotInLoop→ GetUserPrefs
//   GetData ─→ ParseData ─→ ToggleWeather→[Weather]→ToggleCalendar→[Calendar]→ToggleCommute→
//   [Commute]→ToggleNews→[News]→ Send-All-MIMs MAN (the mega sequence) ─→ Final
//
// Every subskill's MimLogic appends MIM paths to data.local.mimPaths; the closing MANFactory
// renders them ALL in one SEQUENCE of SLIMs (with the outro chosen by configured/services state),
// final:true.

import { createGraphSkill } from '../graph/graphSkill.js';
import { Graph } from '../graph/graph.js';
import { DefaultNode, DefaultTransition } from '../graph/nodes.js';
import { MANFactory, MANFactoryTransition } from '../graph/mims/factories.js';
import { OptInFactory, OptInType, OptInTransition } from '../graph/mims/optIn.js';
import { Names, composeMimPath } from './utils.js';
import {
  IntentSplitNode, IntentSplitTransition,
  ToggleNode, ToggleTransition,
  GetUserPrefsNode, GetUserPrefsTransition,
  GetDataNode, GetDataTransition,
  ParseDataNode,
} from './nodes.js';
import { UserIDFactory, UserIDTransition } from './userId.js';
import { WeatherFactory, WeatherTransition } from './weather.js';
import { CalendarFactory, CalendarTransition } from './calendar.js';
import { CommuteFactory, CommuteTransition } from './commute.js';
import { NewsFactory, NewsTransition } from './news.js';

export const PersonalReportTransition = Object.freeze({ Done: 'Done' });

function buildPersonalReport(gm, facade) {
  const g = new Graph(gm, 'PersonalReport', Object.values(PersonalReportTransition));

  const userIDGraph = new UserIDFactory('UserID', facade).createGraph(gm);
  const weatherGraph = new WeatherFactory().createGraph(gm);
  const calendarGraph = new CalendarFactory().createGraph(gm);
  const commuteGraph = new CommuteFactory().createGraph(gm);
  const newsGraph = new NewsFactory().createGraph(gm);

  const getDataNode = new GetDataNode('Get Data', facade);
  const intentSplitNode = new IntentSplitNode('Intent Split');
  const getUserPrefsNode = new GetUserPrefsNode('Get User Prefs');
  const parseDataNode = new ParseDataNode('Parse Data');
  const toggleWeather = new ToggleNode('Toggle Weather', Names.weather);
  const toggleCalendar = new ToggleNode('Toggle Calendar', Names.calendar);
  const toggleCommute = new ToggleNode('Toggle Commute', Names.commute);
  const toggleNews = new ToggleNode('Toggle News', Names.news);
  const finalNode = new DefaultNode('Final');

  // Proactive opt-in proposal MIM depends on whether prefs are configured.
  const proposalMimFunc = (data) => {
    const userPrefsConfigured = data.skill.session.data._personalReport.userPrefsConfigured;
    return composeMimPath(Names.personalReport, userPrefsConfigured ? 'OptInConfigured' : 'OptInNotConfigured');
  };
  const optInGraph = new OptInFactory('Opt-In', facade, {
    proposalMimProvider: proposalMimFunc,
    optInType: OptInType.VERIFY_ID,
  }).createGraph(gm);

  // The mega-MAN: everything the subskills queued, plus the outro.
  const getPaths = (data) => {
    const { mimPaths, allServicesDown, settingsError, configured } = data.local;
    if (data.skill.session.data._personalReport.singleSkill) {
      return mimPaths; // single skills speak their own outros
    }
    const playBasicOutro = !!(configured || settingsError);
    const outroMim = allServicesDown ? 'AllServicesDown'
      : playBasicOutro ? 'OutroConfigured'
        : 'OutroNotConfigured';
    return mimPaths.concat(composeMimPath(Names.personalReport, outroMim));
  };
  const getPromptData = (data) => {
    const { singleSkill } = data.skill.session.data._personalReport;
    return Object.assign({}, { singleSkill }, data.local);
  };
  const sendAllMimsMAN = new MANFactory('Send All Mims', {
    mimDataProvider: getPaths,
    promptDataProvider: getPromptData,
    viewDataProvider: (data) => data.local,
    final: true,
  }).createGraph(gm);

  g.addNode(intentSplitNode, [
    [IntentSplitTransition.Reactive, userIDGraph.initial],
    [IntentSplitTransition.Proactive, getUserPrefsNode],
  ]);

  // UserID, prefs, data
  g.addSubGraph(userIDGraph, [
    [UserIDTransition.Done, getUserPrefsNode],
    [UserIDTransition.MaxNI, finalNode],
  ]);
  g.addNode(getUserPrefsNode, [
    [GetUserPrefsTransition.OptIn, optInGraph.initial],
    [GetUserPrefsTransition.Finish, sendAllMimsMAN.initial],
    [GetUserPrefsTransition.GetData, getDataNode],
  ]);
  g.addSubGraph(optInGraph, [
    [OptInTransition.Accepted, getUserPrefsNode],
    [OptInTransition.NotInLoop, getUserPrefsNode],
    [OptInTransition.Declined, finalNode],
  ]);
  g.addNode(getDataNode, [
    [GetDataTransition.GotData, parseDataNode],
    [GetDataTransition.AllServicesDown, sendAllMimsMAN.initial],
  ]);
  g.addNode(parseDataNode, [[DefaultTransition.Done, toggleWeather]]);

  // Subskills
  g.addNode(toggleWeather, [
    [ToggleTransition.On, weatherGraph.initial],
    [ToggleTransition.Off, toggleCalendar],
  ]);
  g.addSubGraph(weatherGraph, [[WeatherTransition.Done, toggleCalendar]]);

  g.addNode(toggleCalendar, [
    [ToggleTransition.On, calendarGraph.initial],
    [ToggleTransition.Off, toggleCommute],
  ]);
  g.addSubGraph(calendarGraph, [[CalendarTransition.Done, toggleCommute]]);

  g.addNode(toggleCommute, [
    [ToggleTransition.On, commuteGraph.initial],
    [ToggleTransition.Off, toggleNews],
  ]);
  g.addSubGraph(commuteGraph, [[CommuteTransition.Done, toggleNews]]);

  g.addNode(toggleNews, [
    [ToggleTransition.On, newsGraph.initial],
    [ToggleTransition.Off, sendAllMimsMAN.initial],
  ]);
  g.addSubGraph(newsGraph, [[NewsTransition.Done, sendAllMimsMAN.initial]]);

  // Send and exit
  g.addSubGraph(sendAllMimsMAN, [[MANFactoryTransition.Success, finalNode]]);
  g.addNode(finalNode, [[DefaultTransition.Done, PersonalReportTransition.Done]]);

  g.setInitialNode(intentSplitNode);
  g.finalize();
  return g;
}

export const reportSkill = createGraphSkill({ name: 'report-skill', build: buildPersonalReport });
