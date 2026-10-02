// News subskill — port of report-skill/src/subskills/news/{NewsFactory,NewsData,NewsParse,
// NewsMimLogic}.ts: per-category AP fetch, banned/adult keyword filters, headline dedupe,
// category trimming (max 5), items-per-category table (1 cat -> 3 stories, 2 -> 2, else 1),
// Intro + one Headline MIM per story + Outro (single-skill only).
//
// Source behavior: every item must carry AP image metadata and the first feed item is a
// provider header, so it is removed before the report selects headlines. The RSS->AP shim
// (packages/data/src/news.js) emits the provider header entry plus a NITF preview slot for
// every story the provider gives a URL and both dimensions; a story without complete
// provider media still produces no playable item (e.g. the NPR national feed).

import { Graph } from '../graph/graph.js';
import { DefaultNode, DefaultTransition } from '../graph/nodes.js';
import { Names, areIntersecting, addMimPathsToLocalData, speakerIsAdult } from './utils.js';
import { LassoClient } from './lassoClient.js';
import { newsViews } from './newsViews.js';
import { logger } from '@phoenix/common';
import { NEWS_ADULT_KEYWORDS as ADULT_KEYWORDS, NEWS_BANNED_KEYWORDS as BANNED_KEYWORDS, validateNewsBriefing, renderNewsBriefing } from '@phoenix/contracts';

const parseLogger = logger('report.news');

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
    if (Array.isArray(rawCat.briefings) && rawCat.category?.name) {
      parsed[rawCat.category.name] = rawCat.briefings.map(validateNewsBriefing).map((briefing) => ({
        category: rawCat.category.name, adult: briefing.adult,
        headline: renderNewsBriefing(briefing.speech), image: null, briefing,
      }));
      return;
    }
    if (!(rawCat.data && rawCat.data.feed && rawCat.data.feed.entry)) throw Error('NewsData returned incomplete data.');
    if (!(rawCat.category && rawCat.category.name)) throw Error('NewsData returned incomplete category info.');

    const items = rawCat.data.feed.entry
      .map((entry) => {
        const summary = entry.summary && entry.summary[0];
        if (!summary) return undefined;
        const summaryWords = new Set(summary.toLowerCase().match(/\w+/g));
        if (areIntersecting(summaryWords, BANNED_KEYWORDS)) return undefined;

        let headline = null;
        let image = null;
        try {
          headline = entry['apcm:ContentMetadata'][0]['apcm:ExtendedHeadLine'][0];
          if (headline.includes('Correction:') || uniqueHeadlines.has(headline)) return undefined;
          image = getImageUrl(entry);
          uniqueHeadlines.add(headline);
        } catch (err) {
          parseLogger.warn('NewsData in an unexpected format.', { error: err?.message ?? String(err) });
        }
        return { category: rawCat.category.name, adult: areIntersecting(summaryWords, ADULT_KEYWORDS), headline, image };
      })
      // Keep only complete AP items, then cut the provider header and return the first 10.
      .filter((item) => item && !!item.headline && !!item.image)
      .slice(1, 11);

    parsed[rawCat.category.name] = items;
  });
  return parsed;
}

function getImageUrl(entry) {
  const media = entry.content[0].nitf[0].body[0]['body.content'][0].media;
  const preImg = !!media && media[0]['media-reference'][1].$;
  return (preImg.source && preImg.width && preImg.height) ? preImg : null;
}

// --- NewsMimLogic -------------------------------------------------------------------

export const MimPath = Object.freeze({
  Intro: 'Intro', Outro: 'Outro', Headline: 'Headline', AppSetup: 'AppSetup',
  ServiceDown: 'ServiceDown', IntroCategory: 'IntroCategory',
  BriefingIntro: 'BriefingIntro', Briefing: 'Briefing',
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
      data.local.views.newsImages = await newsViews(newsItems) || {};

      const briefingIntro = newsItems.some(item => item.briefing)
        || /^(true|1)$/i.test(process.env.PHOENIX_NEWS_BRIEFINGS_ENABLED || '');
      const mimPaths = [briefingIntro ? MimPath.BriefingIntro : MimPath.Intro]
        .concat(newsItems.map(item => item.briefing ? MimPath.Briefing : MimPath.Headline));
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
  const selected = new Set();
  return catNames.reduce((finalItems, catName) => {
    const filteredCategoryItems = data.local.news[catName]
      .filter((newsItem) => (!newsItem.adult || speakerIsAdult(data)))
      .filter((newsItem) => !newsItem.briefing || !selected.has(newsItem.briefing.id))
      .slice(0, itemsPerCat);
    for (const item of filteredCategoryItems) if (item.briefing) selected.add(item.briefing.id);
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
