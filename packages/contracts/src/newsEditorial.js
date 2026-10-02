import { plainNewsText } from './newsBriefing.js';

const LABEL = '(?:opinions?|editorials?|op[ -]?eds?|commentary|guest (?:essay|column|opinion)|our view|column)';
const PREFIX = new RegExp(`^${LABEL}\\s*(?:[:|–—-]|$)`, 'i');
const SUFFIX = new RegExp(`(?:[:|–—-]\\s*|[\\[(]\\s*)${LABEL}\\s*[\\])]?$`, 'i');
const EXACT = new RegExp(`^${LABEL}$`, 'i');
const SECTION = /^(?:opinions?|editorials?|op-?eds?|commentary|columns?|guest-essays?|letters-to-the-editor)(?:$|\.html?$)/i;

/** Match editorial labels, not ordinary mentions of an opinion in reporting. */
export function isOpinionNews(article) {
  if (!article || typeof article !== 'object') return false;
  const title = plainNewsText(article.title).trim();
  if (PREFIX.test(title) || SUFFIX.test(title)) return true;
  const labels = [article.category, article.categories, article.genre, article.type, article.section, article.tags].flat();
  if (labels.some(value => typeof value === 'string' && value.split(',').some(label => EXACT.test(label.trim())))) return true;
  try {
    const url = new URL(article.url);
    return decodeURIComponent(url.pathname).split('/').some(section => SECTION.test(section));
  } catch { return false; } // URL validation remains the adapter's responsibility
}
