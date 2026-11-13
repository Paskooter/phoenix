// Directory entry point for: node --test tools/skill-kit
// Discover the same suites as tools/skill-kit/*.test.mjs, exactly once.
import {readdirSync} from 'node:fs';
Promise.all(readdirSync(new URL('.', import.meta.url))
  .filter(name => name.endsWith('.test.mjs'))
  .sort()
  .map(name => import(new URL(encodeURIComponent(name), import.meta.url).href))
).catch(function (error) { console.error(error); process.exitCode = 1; });
