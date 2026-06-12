// News subskill — port of report-skill/src/subskills/news/{NewsFactory,NewsData,NewsParse,
// NewsMimLogic}.ts: per-category AP fetch, banned/adult keyword filters, headline dedupe,
// category trimming (max 5), items-per-category table (1 cat -> 3 stories, 2 -> 2, else 1),
// Intro + one Headline MIM per story + Outro (single-skill only).
//
// DIVERGENCE (recorded): the reference required every item to carry an AP image and cut the
// feed header item; the Phoenix data service's RSS->AP shim has no images, so image is optional
// here and only the headline is required.

import { Graph } from '../graph/graph.js';
import { DefaultNode, DefaultTransition } from '../graph/nodes.js';
import { Names, areIntersecting, addMimPathsToLocalData, speakerIsAdult } from './utils.js';
import { LassoClient } from './lassoClient.js';

const ADULT_KEYWORDS = new Set([
  'attack', 'attacks', 'attacked', 'attacking', 'arrest', 'arrested', 'assault', 'assaulted',
  'bomb', 'bombed', 'bombing', 'dead', 'deadly', 'death', 'die', 'died', 'dying', 'gun', 'guns',
  'kill', 'killed', 'killing', 'murder', 'murdered', 'weapon', 'weapons', 'rape', 'raped', 'shot',
  'shooting', 'stabbed', 'stabbing', 'sex', 'sexual', 'sexy',
]);
// The reference ships a large profanity list; vendored intact from NewsParse.ts.
const BANNED_KEYWORDS = new Set([
  'asshole', 'assholes', 'bitcher', 'bitchers', 'bitchin', 'bitching', 'blowjob', 'blowjobs',
  'bollock', 'bollok', 'boner', 'bugger', 'butthole', 'clit', 'cock-sucker', 'cocksucker',
  'cocksucking', 'cum', 'cumming', 'cums', 'cumshot', 'cunt', 'cunts', 'dickhead', 'dildo',
  'dildos', 'fag', 'faggot', 'fagot', 'fagots', 'fags', 'fatass', 'feck', 'fecker', 'fuck',
  'fucka', 'fucked', 'fucker', 'fuckers', 'fuckhead', 'fuckheads', 'fuckin', 'fucking', 'fuckings',
  'fuckme', 'fucks', 'fuckwit', 'gangbang', 'gangbanged', 'gangbangs', 'goddamn', 'goddamned',
  'jackoff', 'jerk-off', 'jizz', 'masturbate', 'masturbation', 'masturbations', 'mofo',
  'motherfuck', 'motherfucked', 'motherfucker', 'motherfuckers', 'motherfuckin', 'motherfucking',
  'nigga', 'niggah', 'niggas', 'niggaz', 'nigger', 'niggers', 'numbnuts', 'nutsack', 'pecker',
  'pisser', 'pissers', 'pisses', 'pissin', 'pissing', 'pissoff', 'pube', 'pussies', 'pussys',
  'schlong', 'scrotum', 'shagger', 'shaggin', 'shagging', 'shemale', 'shit', 'shitdick', 'shite',
  'shited', 'shitey', 'shitfuck', 'shitfull', 'shithead', 'shiting', 'shitings', 'shits',
  'shitted', 'shitter', 'shitters', 'shitting', 'shittings', 'shitty', 'skank', 'slut', 'sluts',
  'smegma', 'son-of-a-bitch', 'tits', 'titt', 'titties', 'tittyfuck', 'twat', 'twathead',
  'twatty', 'wank', 'wanker', 'wanky', 'whoar', 'whore',
]);

// --- NewsData ------------------------------------------------------------------

export async function getData(userPrefs, data) {
  const log = data.log;
  let newsData = null;
  try {
    newsData = await LassoClient.fetchAPNews(data, userPrefs.news);
  } catch (err) {
    log?.error?.(`Error getting news data: ${err.message}`);
  }
  return [Names.news, newsData];
}

// --- NewsParse -------------------------------------------------------------------

export function newsParse(newsData) {
  if (!newsData) return undefined;
  const parsed = {};
  const uniqueHeadlines = new Set();
  newsData.forEach((rawCat) => {
    if (rawCat.error) throw Error(`There was a problem getting NewsData. ${rawCat.error}`);
    if (!(rawCat.data && rawCat.data.feed && rawCat.data.feed.entry)) throw Error('NewsData returned incomplete data.');
    if (!(rawCat.category && rawCat.category.name)) throw Error('NewsData returned incomplete category info.');

    const items = rawCat.data.feed.entry
      .map((entry) => {
        const summary = entry.summary && entry.summary[0];
        if (!summary) return undefined;
        const summaryWords = new Set(String(summary).toLowerCase().match(/\w+/g));
        if (areIntersecting(summaryWords, BANNED_KEYWORDS)) return undefined;

        let headline = null;
        let image = null;
        try {
          headline = entry['apcm:ContentMetadata'][0]['apcm:ExtendedHeadLine'][0];
          if (String(headline).includes('Correction:') || uniqueHeadlines.has(headline)) return undefined;
          image = getImageUrl(entry);
          uniqueHeadlines.add(headline);
        } catch {
          return undefined;
        }
        return { category: rawCat.category.name, adult: areIntersecting(summaryWords, ADULT_KEYWORDS), headline, image };
      })
      // Reference: headline AND image required, header item cut. Shim has no images/header.
      .filter((item) => item && !!item.headline)
      .slice(0, 10);

    parsed[rawCat.category.name] = items;
  });
  return parsed;
}

function getImageUrl(entry) {
  try {
    const media = entry.content[0].nitf[0].body[0]['body.content'][0].media;
    const preImg = !!media && media[0]['media-reference'][1].$;
    return (preImg.source && preImg.width && preImg.height) ? preImg : null;
  } catch {
    return null;
  }
}

// --- NewsMimLogic -------------------------------------------------------------------

export const MimPath = Object.freeze({
  Intro: 'Intro', Outro: 'Outro', Headline: 'Headline', AppSetup: 'AppSetup',
  ServiceDown: 'ServiceDown', IntroCategory: 'IntroCategory',
});

export class NewsMimLogic extends DefaultNode {
  async exit(data) {
    const newsData = data.local.news;
    if (!newsData) return this.finish(data, [MimPath.ServiceDown]);

    const catKeys = Object.keys(newsData);
    if (!catKeys.length) return this.finish(data, [MimPath.AppSetup]);

    const MAX_CATS = 5;
    const catNames = (catKeys.length <= MAX_CATS) ? catKeys : trimCats(catKeys, MAX_CATS);

    const newsItems = getFilteredFinalItems(data, catNames);

    if (newsItems.length) {
      // headlines feeds ${skill.news.headlines.shift()} in NewsHeadline.mim — one per SLIM.
      newsData.headlines = newsItems.map((item) => item.headline);
      data.local.views.newsImages = {};

      const mimPaths = [MimPath.Intro].concat(newsItems.map(() => MimPath.Headline));
      if (data.skill.session.data._personalReport.singleSkill === Names.news) {
        mimPaths.push(MimPath.Outro);
      }
      return this.finish(data, mimPaths);
    }
    return this.finish(data, [MimPath.ServiceDown]);
  }

  finish(data, mimPaths) {
    data.local.mimPaths = addMimPathsToLocalData(Names.news, mimPaths, data.local);
    return { transition: DefaultTransition.Done };
  }
}

function trimCats(activeCats, max) {
  const randIndex = (len) => Math.floor(Math.random() * len);
  while (activeCats.length > max) activeCats.splice(randIndex(activeCats.length), 1);
  return activeCats;
}

/** 1 active category -> 3 stories, 2 -> 2 each, otherwise 1 each; adult items filtered for kids. */
function getFilteredFinalItems(data, catNames) {
  let itemsPerCat;
  switch (catNames.length) {
    case 1: itemsPerCat = 3; break;
    case 2: itemsPerCat = 2; break;
    default: itemsPerCat = 1;
  }
  return catNames.reduce((finalItems, catName) => {
    const filteredCategoryItems = (data.local.news[catName] || [])
      .filter((newsItem) => (!newsItem.adult || speakerIsAdult(data)))
      .slice(0, itemsPerCat);
    return finalItems.concat(filteredCategoryItems);
  }, []);
}

// --- NewsFactory -------------------------------------------------------------------

export const NewsTransition = Object.freeze({ Done: 'Done' });

export class NewsFactory {
  createGraph(gm) {
    const g = new Graph(gm, 'News', Object.values(NewsTransition));
    const newsLogicNode = new NewsMimLogic('News Logic');
    const outroNode = new DefaultNode('News Outro');
    g.addNode(newsLogicNode, [[DefaultTransition.Done, outroNode]]);
    g.addNode(outroNode, [[DefaultTransition.Done, NewsTransition.Done]]);
    g.finalize();
    return g;
  }
}
