#!/usr/bin/env node
// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026, pasketti and the Phoenix project.
import { mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { resolve, join, basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { packDirectory } from './pack.mjs';
import theme from './themeFormat.cjs';
import { explain } from './errors.mjs';

const usage = 'Usage: node tools/theme-kit/cli.mjs check <dir> | pack <dir> --out <dir>';
export function measurements(pack) {
  const p = pack.manifest.theme.palette;
  return { schema: 2, runtime: theme.RUNTIME, sha256: pack.descriptor.sha256,
    manifestSha256: pack.descriptor.manifestSha256, bytes: pack.bytes.length,
    manifestBytes: pack.manifestBytes.length, assetCount: pack.manifest.assets.length,
    pixels: pack.manifest.assets.reduce((n, a) => n + a.width * a.height, 0),
    contrast: { textOnSurface: theme.contrast(p.text, p.surface),
      textOnSecondary: theme.contrast(p.text, p.surfaceSecondary),
      textOnBacking: theme.contrast(p.text, p.background), accentOnSurface: theme.contrast(p.accent, p.surface) } };
}
export function output(pack, directory, stem) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const base = join(directory, `${stem}-${pack.manifest.version}`);
  const entries = [[base + '.phtheme', pack.bytes], [base + '.manifest.json', pack.manifestBytes]];
  let offset = 12 + pack.manifestBytes.length;
  for (const a of pack.manifest.assets) {
    if (a.id === pack.manifest.theme.previewAsset) entries.push([base + '.preview.png', pack.bytes.subarray(offset, offset + a.bytes)]);
    offset += a.bytes;
  }
  const created = [];
  try {
    for (const [file, bytes] of entries) {
      writeFileSync(file, bytes, { flag: 'wx', mode: 0o600 });
      created.push(file);
    }
  } catch (error) {
    for (const file of created) unlinkSync(file);
    throw error;
  }
  return entries.map(([file]) => file);
}
export async function main(args = process.argv.slice(2)) {
  const [command, directory] = args;
  if (!directory || directory.startsWith('--') || !(
    command === 'check' && args.length === 2 ||
    command === 'pack' && args.length === 4 && args[2] === '--out' && args[3] && !args[3].startsWith('--')
  )) throw new Error(usage);
  const pack = await packDirectory(resolve(directory));
  const report = measurements(pack);
  if (command === 'pack') {
    const name = basename(resolve(directory));
    report.files = output(pack, resolve(args[3]), /^[a-z][a-z0-9-]{0,39}$/.test(name) ? name : 'theme');
  }
  return report;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().then(result => console.log(JSON.stringify(result, null, 2)))
    .catch(error => { console.error(explain(error)); process.exitCode = 1; });
}
