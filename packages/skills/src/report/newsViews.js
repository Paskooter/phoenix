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

    if (item.briefing) {
      // World News does not supply trustworthy image dimensions. A title card
      // needs no extra fetch and works for stories with no photograph at all.
      headlineConfig.componentConfigs = headlineConfig.componentConfigs.filter(c => c !== headlineClip);
      categoryClip.position.y = 0;
      categoryClip.transform.scaleY = 2;
      categoryText.style.fontSize = '50';
      categoryText.position.y = 610;
      const title = clone(categoryText);
      title.id = 'briefingTitle';
      title.text = item.briefing.title;
      title.style = { ...title.style, fontSize: '48', wordWrap: true, wordWrapWidth: 1040, letterSpacing: 0 };
      title.position.y = 320;
      title.targetAnchor.y = 0.5;
      const publisher = clone(categoryText);
      publisher.id = 'briefingPublisher';
      publisher.text = item.briefing.publisher;
      publisher.style.fontSize = '30';
      publisher.position.y = 500;
      headlineConfig.componentConfigs.push(title, publisher);
      headlineConfig.viewConfig.id += `_${index}`;
      return headlineConfig;
    }

    headlineClip.assets[0].src = item.image.source;
    // Keep the source's parseInt call shape. In particular, the reference
    // accepts the legacy 0x-prefixed dimensions using JavaScript's inferred
    // radix behavior.
    const imageWidth = parseInt(item.image.width);
    const imageHeight = parseInt(item.image.height);
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
