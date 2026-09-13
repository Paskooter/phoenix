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

const parseLogger = logger('report.news');

const ADULT_KEYWORDS = new Set([
  'attack', 'attacks', 'attacked', 'attacking', 'arrest', 'arrested', 'assault', 'assaulted',
  'bomb', 'bombed', 'bombing', 'dead', 'deadly', 'death', 'die', 'died', 'dying', 'gun', 'guns',
  'kill', 'killed', 'killing', 'murder', 'murdered', 'weapon', 'weapons', 'rape', 'raped', 'shot',
  'shooting', 'stabbed', 'stabbing', 'sex', 'sexual', 'sexy',
]);
// The reference ships a large profanity list; vendored intact from NewsParse.ts.
const BANNED_KEYWORDS = new Set([
    "4r5e", "5h1t", "5hit", "a55", "ar5e", "arrse", "arse", "ass-fucker", "assfucker", "assfukka",
    "asshole", "assholes", "asswhole", "a_s_s", "b!tch", "b00bs", "b17ch", "b1tch", "ballbag",
    "ballsack", "beastiality", "bellend", "bestiality", "bi\\+ch", "biatch", "bitcher", "bitchers",
    "bitchin", "bitching", "blow job", "blowjob", "blowjobs", "boiolas", "bollock", "bollok", "boner",
    "booobs", "boooobs", "booooobs", "booooooobs", "buceta", "bugger", "bunny fucker", "butthole", "buttmuch",
    "buttplug", "c0ck", "c0cksucker", "carpet muncher", "cawk", "cipa", "cl1t", "clit", "clits", "cnut",
    "cock-sucker", "cockface", "cockhead", "cockmunch", "cockmuncher", "cocksuck", "cocksucked", "cocksucker",
    "cocksucking", "cocksucks", "cocksuka", "cocksukka", "cok", "cokmuncher", "coksucka", "coon", "cox", "cum",
    "cummer", "cumming", "cums", "cumshot", "cunilingus", "cunillingus", "cunnilingus", "cunt", "cuntlick",
    "cuntlicker", "cuntlicking", "cunts", "cyberfuc", "cyberfuck", "cyberfucked", "cyberfucker", "cyberfuckers",
    "cyberfucking", "d1ck", "dickhead", "dildo", "dildos", "dinks", "dirsa", "dlck", "dog-fucker", "doggin", "dogging",
    "donkeyribber", "doosh", "duche", "ejakulate", "f u c k", "f u c k e r", "f4nny", "fag", "fagging", "faggitt",
    "faggot", "faggs", "fagot", "fagots", "fags", "fannyflaps", "fannyfucker", "fanyy", "fatass", "fcuk", "fcuker",
    "fcuking", "feck", "fecker", "felching", "fellate", "fellatio", "fingerfuck", "fingerfucked", "fingerfucker",
    "fingerfuckers", "fingerfucking", "fingerfucks", "fistfuck", "fistfucked", "fistfucker", "fistfuckers",
    "fistfucking", "fistfuckings", "fistfucks", "flange", "fook", "fooker", "fuck", "fucka", "fucked", "fucker",
    "fuckers", "fuckhead", "fuckheads", "fuckin", "fucking", "fuckings", "fuckingshitmotherfucker", "fuckme",
    "fucks", "fuckwhit", "fuckwit", "fudge packer", "fudgepacker", "fuk", "fuker", "fukker", "fukkin", "fuks",
    "fukwhit", "fukwit", "fux", "fux0r", "f_u_c_k", "gangbang", "gangbanged", "gangbangs", "gaylord", "gaysex",
    "goatse", "god-dam", "god-damned", "goddamn", "goddamned", "hardcoresex", "heshe", "hoar", "hoare", "hoer",
    "hore", "hotsex", "jack-off", "jackoff", "jap", "jerk-off", "jism", "jiz", "jizm", "jizz", "kawk", "knobead",
    "knobed", "knobend", "knobhead", "knobjocky", "knobjokey", "kock", "kondum", "kondums", "kum", "kummer",
    "kumming", "kums", "kunilingus", "l3i\\+ch", "l3itch", "m0f0", "m0fo", "m45terbate", "ma5terb8", "ma5terbate",
    "master-bate", "masterb8", "masterbat*", "masterbat3", "masterbate", "masterbation", "masterbations",
    "masturbate", "mo-fo", "mof0", "mofo", "mothafuck", "mothafucka", "mothafuckas", "mothafuckaz", "mothafucked",
    "mothafucker", "mothafuckers", "mothafuckin", "mothafucking", "mothafuckings", "mothafucks", "mother fucker",
    "motherfuck", "motherfucked", "motherfucker", "motherfuckers", "motherfuckin", "motherfucking", "motherfuckings",
    "motherfuckka", "motherfucks", "muff", "mutha", "muthafecker", "muthafuckker", "mutherfucker", "n1gga", "n1gger",
    "nigg3r", "nigg4h", "nigga", "niggah", "niggas", "niggaz", "nigger", "niggers", "nob jokey", "nobhead", "nobjocky",
    "nobjokey", "numbnuts", "nutsack", "p0rn", "pecker", "penisfucker", "phonesex", "phuck", "phuk", "phuked", "phuking",
    "phukked", "phukking", "phuks", "phuq", "pigfucker", "pimpis", "pisser", "pissers", "pisses", "pissflaps", "pissin",
    "pissing", "pissoff", "pron", "pube", "pusse", "pussi", "pussies", "pussys", "rimjaw", "rimming", "schlong", "scroat",
    "scrote", "scrotum", "sh!\\+", "sh!t", "sh1t", "shagger", "shaggin", "shagging", "shemale", "shi\\+", "shit", "shitdick",
    "shite", "shited", "shitey", "shitfuck", "shitfull", "shithead", "shiting", "shitings", "shits", "shitted", "shitter",
    "shitters", "shitting", "shittings", "shitty", "skank", "slut", "sluts", "smegma", "son-of-a-bitch", "s_h_i_t", "t1tt1e5",
    "t1tties", "teez", "titfuck", "tits", "titt", "tittie5", "tittiefucker", "titties", "tittyfuck", "tittywank", "titwank",
    "tw4t", "twat", "twathead", "twatty", "twunt", "twunter", "v14gra", "v1gra", "w00se", "wank", "wanker", "wanky", "whoar", "whore"
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
    const filteredCategoryItems = data.local.news[catName]
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
