// News GUI view construction from report-skill/subskills/news/NewsViews.ts.
// AP image URLs are provider data; this helper preserves the source contract
// and does not fetch, validate, or synthesize an image.

import { getJSON, titleCase } from './utils.js';

const NIMBUS_CATEGORY_IMG_PATH = 'assets/personal-report-skill/news/categoryGradient_v01.crn';
const HEADLINE_VIEW = 'views/newsHeadline';
const STRANGE_CATEGORY = 'strange';
const SCREEN_W = 1280;
const SCREEN_H = 720;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

/** Build one source headline view per provider-backed news item. */
export async function newsViews(items) {
  const template = await getJSON(HEADLINE_VIEW);
  const views = items.map((item, index) => {
    const headlineConfig = clone(template);
    const headlineClip = headlineConfig.componentConfigs.find((component) => component.id === 'headlineClip');
    const categoryClip = headlineConfig.componentConfigs.find((component) => component.id === 'categoryClip');
    const categoryText = headlineConfig.componentConfigs.find((component) => component.id === 'categoryText');
    categoryClip.assets[0].src = NIMBUS_CATEGORY_IMG_PATH;
    categoryText.text = titleCase(item.category);
    if (item.category === STRANGE_CATEGORY) categoryText.text += ' News';

    headlineClip.assets[0].src = item.image.source;
    const imageWidth = parseInt(item.image.width, 10);
    const imageHeight = parseInt(item.image.height, 10);
    const fillHeight = imageWidth < imageHeight || (imageWidth / imageHeight > SCREEN_W / SCREEN_H);
    const scale = fillHeight ? SCREEN_H / imageHeight : SCREEN_W / imageWidth;
    headlineClip.transform.scaleX = scale;
    headlineClip.transform.scaleY = scale;
    headlineClip.position.x = Math.floor((SCREEN_W - imageWidth * scale) / 2);
    headlineClip.position.y = Math.floor((SCREEN_H - imageHeight * scale) / 2);
    headlineConfig.viewConfig.id += `_${index}`;
    return headlineConfig;
  });

  const last = views[views.length - 1];
  last.defaultSelect.removeAll = true;
  last.defaultSelect.leaveEmpty = false;
  return views;
}
