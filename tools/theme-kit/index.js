// SPDX-License-Identifier: BSD-3-Clause
// Explicit directory test entry point: node --test tools/theme-kit
// Dynamic imports also work when the kit is copied without a package.json.
Promise.all([
  import('./bounds.test.mjs'), import('./failures.test.mjs'),
  import('./new.test.mjs'), import('./theme-kit.test.mjs'),
  import('./extensions.test.mjs'), import('./templates.test.mjs'), import('./docs.test.mjs'),
  import('./label-fit.test.mjs'), import('./svg.test.mjs'),
]).catch(error => { console.error(error); process.exitCode = 1; });
