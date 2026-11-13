// Computer-only preview. The robot installs skill.json data, not this code.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function createPreview(skill) {
  let current = null;
  const page = () => skill.pages.find(p => p.id === current) || null;
  return {
    start() { current = skill.startPage; return page(); },
    tap(index) {
      const button = page()?.buttons[index];
      if (!button) throw new Error('Choose a button on the current page.');
      const action = button.action;
      if (action.type === 'show') current = action.page;
      else if (action.type === 'close') current = null;
      else if (action.type === 'speak') {
        if (!skill.permissions.includes('speech')) throw new Error('Speech permission is required.');
        return { speech: action.text, page: page() };
      } else throw new Error('Unsupported action.');
      return { speech: null, page: page() };
    },
    stop() { current = null; return null; }
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const skill = JSON.parse(readFileSync(new URL('./skill.json', import.meta.url), 'utf8'));
  const preview = createPreview(skill);
  console.log(preview.start());
  console.log(preview.tap(0));
  preview.stop();
}
