// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026, pasketti and the Phoenix project.
import { randomUUID } from 'node:crypto';
import { mkdirSync, cpSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const templates = fileURLToPath(new URL('../../themes/', import.meta.url));
function invalid(message) { throw new Error(message); }
export function scaffold(name, template, author = 'Your name', cwd = process.cwd()) {
  if (!/^[a-z][a-z0-9-]{0,39}$/.test(name || '')) invalid('Theme name must be 1–40 lowercase letters/digits/hyphens, beginning with a letter; no paths.');
  if (!['ember', 'orbit'].includes(template)) invalid('Choose --from ember or --from orbit.');
  if (typeof author !== 'string' || !author.trim() || author.length > 100 || /[\u0000-\u001f\u007f]/.test(author)) invalid('Author must be 1–100 plain single-line characters.');
  const source = join(templates, template), directory = resolve(cwd, name);
  // Exclusive mkdir refuses existing directories and symlinks. Never delete a
  // preexisting destination; cleanup below covers only the directory we created.
  mkdirSync(directory, { mode: 0o700 });
  try {
    const m = JSON.parse(readFileSync(join(source, 'theme.json'), 'utf8'));
    m.appId = 'app-' + randomUUID(); // local placeholder, NOT a registered Store app
    m.name = name;
    m.version = '1.0.0';
    m.description = `${name}, a menu theme by ${author}, based on Phoenix ${template === 'ember' ? 'Ember' : 'Orbit'}. Customize this description before publishing.`;
    m.releaseNotes = `Initial release by ${author}.`;
    cpSync(join(source, 'assets'), join(directory, 'assets'), { recursive: true, errorOnExist: true, force: false });
    cpSync(join(source, 'LICENSE.md'), join(directory, 'LICENSE.md'), { errorOnExist: true, force: false });
    writeFileSync(join(directory, 'theme.json'), JSON.stringify(m, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    writeFileSync(join(directory, 'AUTHOR.md'), `# Theme author\n\nAuthor: ${author}\n\nBased on Phoenix ${template === 'ember' ? 'Ember' : 'Orbit'}; original artwork copyright\n(c) 2026, pasketti and the Phoenix project, BSD-3-Clause. Preserve LICENSE.md\nwhen redistributing originals or derivatives. Document your own changes and\nrights here; this host-side credit is not packed into the runtime artifact.\n`, { flag: 'wx', mode: 0o600 });
    writeFileSync(join(directory, 'README.md'), `# ${name}\n\nAuthor: ${author}\n\nBased on Phoenix ${template === 'ember' ? 'Ember' : 'Orbit'}. The fresh app ID in theme.json is a local\nplaceholder: replace it with your publisher-assigned app ID before submitting.\nDo not publish under the original Phoenix example identity. The default author\n"Your name" is also a placeholder; edit AUTHOR.md, description and releaseNotes.\n\nEdit the palette, permitted fonts/layout and images; retain LICENSE.md and credit\nthe original artwork. All asset paths are relative to this directory. See the\nkit's docs/THEMES.md for limits and exact menu/item IDs.\n\nFrom the Phoenix checkout, use the absolute path of this directory:\n\n    node tools/theme-kit/cli.mjs check <theme-directory>\n    node tools/theme-kit/cli.mjs pack <theme-directory> --out <fresh-output-directory>\n\nThe packer emits an unsigned .phtheme, a canonical manifest and a preview if\npresent. Submit the .phtheme through Publish; no local signing or direct robot\nsideload is supported. Keep host-side credit/license documentation with source\nand artifact redistributions.\n`, { flag: 'wx', mode: 0o600 });
    return { directory, appId: m.appId, author, template, notice: 'Local app ID placeholder: replace with your publisher-assigned app ID before submission.' };
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}
