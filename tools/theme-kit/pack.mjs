// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026, pasketti and the Phoenix project.
import { spawn } from 'node:child_process';
import { inflateSync, deflateSync } from 'node:zlib';
import { lstatSync, realpathSync, openSync, fstatSync, readSync, closeSync, constants } from 'node:fs';
import { resolve, sep } from 'node:path';
import theme from './themeFormat.cjs';
import format from './format.cjs';
import { validateManifest, validatePixels } from './extensions.mjs';
import { rasterizeSvg, SVG_LIMITS } from './svg.mjs';

export const ICON_TARGETS = Object.freeze({
  '@be/main-menu#main-menu': ['introduction','thingsToDo','fun','clock','personalReport','radio','snapshot','gallery','photobooth','exercise','tutorial','settings','phoenix-agent','phoenix-spotify','phoenix-tic-tac-toe'],
  '@be/main-menu#fun-stuff': ['circuitSaver','wordOfTheDay','joke','dance','surprise'],
  '@be/main-menu#personal-report': ['fullReport','weather','calendar','commute','news'],
  '@be/clock#clockMenu': ['time','date','timer','alarm'],
  '@be/create#createMenu': ['photo','photobooth'],
  '@be/exercise#exercise-menu': ['sunSalutation','basicWarrior'],
  '@be/settings#settingsMenu': ['volume','wifi','battery','about','updates','homeAssistant','themes'],
  '@be/settings#wifiMenu': [], '@be/settings#yournetworks': [], '@be/settings#networkName': [],
});
function reject(code) { const e = new Error(code); e.code = code; e.status = 400; throw e; }
function authorPolicy(m) {
  for (const p of [m.theme.palette,...m.theme.overrides.filter(o=>o.palette).map(o=>o.palette)]) for(const background of ['surface','surfaceSecondary','background']) if(theme.contrast(p.mutedText,p[background])<4.5) reject('theme_contrast_insufficient');
  for (const o of m.theme.overrides) {
    if (!Object.hasOwn(ICON_TARGETS, o.menuKey)) reject('theme_target_not_allowed');
    if ((o.layout || o.menuLayout) && ICON_TARGETS[o.menuKey].length === 0) reject('theme_layout_not_allowed');
    for (const i of o.icons || []) if (!ICON_TARGETS[o.menuKey].includes(i.itemId)) reject('theme_icon_not_allowed');
  }
}
function chunk(type, data) {
  const b = Buffer.alloc(data.length + 12); b.writeUInt32BE(data.length); b.write(type, 4); data.copy(b, 8);
  let c = 0xffffffff;
  for (const n of b.subarray(4, b.length - 4)) { c ^= n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; }
  b.writeUInt32BE((c ^ 0xffffffff) >>> 0, b.length - 4); return b;
}
const signature = Buffer.from([137,80,78,71,13,10,26,10]);
/** Decode all PNG filters; re-encode only IHDR/IDAT/IEND, with filter 0. */
function normalizePng(bytes, asset) {
  const info = theme.inspectImage(bytes, asset), stride = info.width * info.channels, expected = (stride + 1) * info.height;
  let inflated;
  try {
    const result = inflateSync(info.data, { maxOutputLength: expected, info: true });
    if (result.engine.bytesWritten !== info.data.length) reject('image_trailing_payload');
    inflated = result.buffer;
  } catch (e) { reject(e.code === 'image_trailing_payload' ? e.code : 'image_invalid'); }
  if (inflated.length !== expected) reject('image_invalid');
  const raw = Buffer.alloc(expected), decoded = Buffer.alloc(stride * info.height);
  for (let y = 0; y < info.height; y++) {
    const filter = inflated[y * (stride + 1)]; if (filter > 4) reject('image_invalid');
    for (let x = 0; x < stride; x++) {
      const at = y * stride + x, left = x >= info.channels ? decoded[at - info.channels] : 0, up = y ? decoded[at - stride] : 0,
        corner = y && x >= info.channels ? decoded[at - stride - info.channels] : 0;
      let predictor = 0;
      if (filter === 1) predictor = left;
      if (filter === 2) predictor = up;
      if (filter === 3) predictor = Math.floor((left + up) / 2);
      if (filter === 4) { const p = left + up - corner, a = Math.abs(p - left), b = Math.abs(p - up), c = Math.abs(p - corner); predictor = a <= b && a <= c ? left : b <= c ? up : corner; }
      decoded[at] = (inflated[y * (stride + 1) + x + 1] + predictor) & 255;
    }
    decoded.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  validatePixels(asset, decoded, info.channels);
  const header = Buffer.alloc(13); header.writeUInt32BE(info.width); header.writeUInt32BE(info.height, 4); header[8] = 8; header[9] = info.channels === 4 ? 6 : 2;
  return Buffer.concat([signature, chunk('IHDR', header), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}
const JPEG_DECODER = `from PIL import Image
import io,sys
im=Image.open(io.BytesIO(sys.stdin.buffer.read()))
if im.format != 'JPEG' or im.mode != 'RGB' or getattr(im,'n_frames',1) != 1: raise ValueError('invalid JPEG')
im.load()
out=Image.new('RGB',im.size); out.paste(im)
out.save(sys.stdout.buffer,format='PNG',compress_level=9)
`;
// JPEG requires Python3/Pillow: a separate decoder process, bounded input/output
// and absolute deadline. No paths or expressions from a pack enter the command.
function decodeJpeg(bytes) {
  return new Promise((resolve,rejectPromise) => {
    const child=spawn('python3',['-c',JPEG_DECODER],{stdio:['pipe','pipe','ignore']}), chunks=[];
    let size=0,done=false;
    const timer=setTimeout(()=>finish(new Error('image_decode_timeout')),10000);
    function finish(e,result) { if(done)return; done=true; clearTimeout(timer); if(e){child.kill('SIGKILL');e.code=e.message;e.status=400;rejectPromise(e);}else resolve(result); }
    child.once('error',()=>finish(new Error('image_decoder_unavailable')));
    child.stdin.once('error',()=>{});
    child.stdout.on('data',b=>{ size+=b.length; if(size>theme.LIMITS.assetBytes)finish(new Error('theme_asset_too_large'));else chunks.push(b); });
    child.once('close',code=>code===0?finish(null,Buffer.concat(chunks,size)):finish(new Error('image_invalid')));
    child.stdin.end(bytes);
  });
}
/** Local packing emits only PNG, including author-only static SVG icon input. */
export async function packTheme(input, blobs) {
  function plainTree(v,depth=1) {
    if(depth>theme.LIMITS.depth) reject('theme_invalid');
    if(v && typeof v==='object') {
      if(!Array.isArray(v) && Object.getPrototypeOf(v)!==Object.prototype) reject('theme_invalid');
      for(const key of Object.keys(v)) { if(['__proto__','prototype','constructor'].includes(key)) reject('theme_invalid'); plainTree(v[key],depth+1); }
    }
  }
  plainTree(input);
  const m = theme.parseStrict(Buffer.from(format.canonical(input)));
  if (!Array.isArray(blobs) || blobs.length > theme.LIMITS.assets) reject('theme_invalid');
  const sorted = [...blobs].sort((a,b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  m.assets = sorted.map(b => {
    const svg = b.mediaType === 'image/svg+xml';
    if (!Buffer.isBuffer(b.bytes) || b.bytes.length < (svg ? 1 : 33) || b.bytes.length > (svg ? SVG_LIMITS.sourceBytes : theme.LIMITS.assetBytes)) reject('theme_asset_too_large');
    if (svg && b.role !== 'icon') reject('theme_media_type_invalid');
    // Preflight the fixed raster size and total pixel budget before any decoder
    // runs. This provisional entry is replaced with normalized PNG hashes below.
    const info = svg ? { mediaType: 'image/png', width: SVG_LIMITS.width, height: SVG_LIMITS.height }
      : b.bytes.subarray(0,8).equals(signature) ? theme.inspectPng(b.bytes) : theme.inspectJpeg(b.bytes);
    return { id: b.id, role: b.role, mediaType: info.mediaType, sha256: theme.sha256(b.bytes), bytes: b.bytes.length, width: info.width, height: info.height };
  });
  validateManifest(m); authorPolicy(m); // dimensions/pixels before allocating decode output
  const clean = [];
  for (let i=0;i<sorted.length;i++) {
    const a=m.assets[i];
    if (sorted[i].mediaType === 'image/svg+xml') {
      const png = await rasterizeSvg(sorted[i].bytes);
      clean.push(normalizePng(png, { ...a, sha256: theme.sha256(png), bytes: png.length }));
    } else if(a.mediaType==='image/png') clean.push(normalizePng(sorted[i].bytes,a));
    else {
      theme.inspectImage(sorted[i].bytes,a);
      const png=await decodeJpeg(sorted[i].bytes), entry={...a,mediaType:'image/png',sha256:theme.sha256(png),bytes:png.length};
      clean.push(normalizePng(png,entry));
    }
  }
  m.assets = m.assets.map((a,i) => ({ ...a, mediaType: 'image/png', sha256: theme.sha256(clean[i]), bytes: clean[i].length }));
  const validated = validateManifest(m), header = Buffer.alloc(12); header.write(theme.MAGIC); header.writeUInt32BE(validated.bytes.length, 8);
  const bytes = Buffer.concat([header, validated.bytes, ...clean]);
  if (bytes.length > theme.LIMITS.artifactBytes) reject('theme_artifact_too_large');
  return { bytes, manifest: validated.manifest, manifestBytes: validated.bytes,
    descriptor: { schema: 2, kind: 'theme', runtime: theme.RUNTIME, appId: m.appId, version: m.version, minFirmware: m.minFirmware, permissions: ['menu-theme'], launchNames: [], sha256: theme.sha256(bytes), bytes: bytes.length, manifestSha256: theme.sha256(validated.bytes), manifestBytes: validated.bytes.length, assetCount: m.assets.length, themeApi: m.themeApi } };
}
/** Author-only paths are tightly bounded and never enter the manifest. */
export async function packDirectory(directory) {
  const root = realpathSync(directory);
  if (lstatSync(resolve(directory)).isSymbolicLink()) reject('theme_author_path_invalid');
  function readLocal(path, max) {
    if (typeof path !== 'string' || !/^theme\.json$|^assets\/(?:icons\/)?[a-z][a-z0-9-]{0,39}\.(?:png|jpg|jpeg|svg)$/.test(path)) reject('theme_author_path_invalid');
    const parts = path.split('/'); let file = root;
    for (const part of parts) { file = resolve(file,part); if (lstatSync(file).isSymbolicLink()) reject('theme_author_path_invalid'); }
    const stat = lstatSync(file);
    if (!stat.isFile() || !realpathSync(file).startsWith(root+sep)) reject('theme_author_path_invalid');
    const tooLarge = path === 'theme.json' ? 'theme_manifest_too_large' : 'theme_asset_too_large';
    if (path.endsWith('.svg')) max = SVG_LIMITS.sourceBytes;
    if (stat.size > max) reject(tooLarge);
    const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    try {
      const opened = fstatSync(fd);
      if (!opened.isFile()) reject('theme_author_path_invalid');
      if (opened.size > max) reject(tooLarge);
      // A source that grows after stat cannot cause an unbounded read.
      const bytes = Buffer.alloc(max + 1); let length = 0, count;
      while (length < bytes.length && (count = readSync(fd, bytes, length, bytes.length - length, null)) > 0) length += count;
      if (length > max) reject(tooLarge);
      return bytes.subarray(0, length);
    } finally { closeSync(fd); }
  }
  const source = theme.parseStrict(readLocal('theme.json',theme.LIMITS.manifestBytes));
  if (!Array.isArray(source.assets) || source.assets.length > theme.LIMITS.assets) reject('theme_assets_invalid');
  const blobs = source.assets.map(a => {
    if (!a || typeof a !== 'object' || Array.isArray(a) || Object.keys(a).sort().join(',') !== 'id,path,role') reject('theme_author_asset_invalid');
    const bytes = readLocal(a.path, theme.LIMITS.assetBytes);
    return { id: a.id, role: a.role, bytes, ...(a.path.endsWith('.svg') ? { mediaType: 'image/svg+xml' } : {}) };
  });
  source.assets = []; return packTheme(source,blobs);
}
