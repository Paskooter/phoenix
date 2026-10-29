// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026, pasketti and the Phoenix project.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import theme from './themeFormat.cjs';

export const SVG_LIMITS = Object.freeze({ sourceBytes: 262144, width: 256, height: 256, deadlineMs: 5000 });
const worker = fileURLToPath(new URL('./svg-render.py', import.meta.url));
const errors = new Set(['svg_invalid', 'svg_unsafe', 'svg_dimensions_invalid', 'svg_too_complex', 'svg_decoder_unavailable']);
function error(code) { return Object.assign(new Error(code), { code, status: 400 }); }

/** Author-only conversion. Neither source paths nor SVG bytes enter arguments. */
export function rasterizeSvg(bytes) {
  if (!Buffer.isBuffer(bytes) || !bytes.length) return Promise.reject(error('svg_invalid'));
  if (bytes.length > SVG_LIMITS.sourceBytes) return Promise.reject(error('theme_asset_too_large'));
  return new Promise((resolve, reject) => {
    const child = spawn('python3', ['-I', worker], { stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks = []; let size = 0, diagnostic = '', failure, done = false;
    const timer = setTimeout(() => stop('svg_decode_timeout'), SVG_LIMITS.deadlineMs);
    function stop(code) { failure ||= code; child.kill('SIGKILL'); }
    function finish(code, value) {
      if (done) return; done = true; clearTimeout(timer);
      if (code) reject(error(code)); else resolve(value);
    }
    child.once('error', () => finish('svg_decoder_unavailable'));
    child.stdin.once('error', () => {}); // A refused input can close before stdin drains.
    child.stdout.on('data', b => {
      size += b.length;
      if (size > theme.LIMITS.assetBytes) stop('theme_asset_too_large');
      else chunks.push(b);
    });
    child.stderr.on('data', b => { diagnostic = (diagnostic + b.toString('ascii')).slice(0, 128); });
    child.once('close', (code, signal) => {
      if (failure) finish(failure);
      else if (signal === 'SIGXCPU') finish('svg_decode_timeout');
      else if (code === 0) finish(null, Buffer.concat(chunks, size));
      else finish(errors.has(diagnostic.trim()) ? diagnostic.trim() : 'svg_invalid');
    });
    child.stdin.end(bytes);
  });
}
