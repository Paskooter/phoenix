// .mim loader. MIMs are JSON authoring units (MimConfig). Loaded once and cached by absolute path.

import { readFileSync } from 'node:fs';

const cache = new Map();

export function loadMimFile(absPath) {
  if (cache.has(absPath)) return cache.get(absPath);
  const mim = JSON.parse(readFileSync(absPath, 'utf8'));
  cache.set(absPath, mim);
  return mim;
}
