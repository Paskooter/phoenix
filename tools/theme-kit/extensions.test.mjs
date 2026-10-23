// SPDX-License-Identifier: BSD-3-Clause
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { packTheme } from './pack.mjs';
import { deflateSync } from 'node:zlib';
function png(pixel, channels=4) {
  const chunk=(type,data)=>{ const b=Buffer.alloc(data.length+12); b.writeUInt32BE(data.length); b.write(type,4); data.copy(b,8); let c=0xffffffff; for(const v of b.subarray(4,-4)){c^=v; for(let i=0;i<8;i++)c=c&1?0xedb88320^(c>>>1):c>>>1;} b.writeUInt32BE((c^0xffffffff)>>>0,b.length-4); return b; };
  const h=Buffer.alloc(13); h.writeUInt32BE(256); h.writeUInt32BE(256,4); h[8]=8; h[9]=channels===4?6:2;
  const raw=Buffer.alloc(256*(1+256*channels));
  for(let y=0;y<256;y++)for(let x=0;x<256;x++){ const p=pixel(x,y); for(let c=0;c<channels;c++) raw[y*(1+256*channels)+1+x*channels+c]=p[c]; }
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',h),chunk('IDAT',deflateSync(raw)),chunk('IEND',Buffer.alloc(0))]);
}
const bars=(x,y)=>[240,240,240,x>=48&&x<208&&y>=64&&y<192?255:0];
test('API3 authored alpha is validated after PNG decoding', async()=>{
  const m=base(); m.themeApi=3; m.theme.eyeAsset={texture:'paint',alpha:'replace'};
  const blobs=[{id:'paint',role:'eye-asset',bytes:png(bars)}];
  const p=await packTheme(m,blobs); assert.equal(p.descriptor.themeApi,3);
  for(const bad of [(x,y)=>[100,100,100,bars(x,y)[3]],()=>[240,240,240,255],(x,y)=>[240,230,240,bars(x,y)[3]],()=>[240,240,240,0]]) await assert.rejects(packTheme(m,[{...blobs[0],bytes:png(bad)}]));
  await assert.rejects(packTheme(m,[{...blobs[0],bytes:png(bars,3)}]));
  await assert.rejects(packTheme({...m,theme:{...m.theme,eye:{color:'#FFFFFF'}}},blobs));
});
test('API4 face can combine replacement, state paint, background and geometry',async()=>{
  const m=base(); m.themeApi=4; m.theme.eyeAsset={texture:'paint',alpha:'replace'};
  m.theme.face={closed:{texture:'closed',alpha:'replace'},states:{listening:{texture:'listen',colorMode:'author'}},scalePercent:125,background:{color:'#101020'}};
  const blobs=[{id:'paint',role:'eye-asset',bytes:png(bars)},{id:'closed',role:'eye-closed',bytes:png(bars)},{id:'listen',role:'eye-state',bytes:png((x,y)=>[40,180,220,bars(x,y)[3]])}];
  const p=await packTheme(m,blobs); assert.equal(p.descriptor.themeApi,4);
  for(const face of [{},{scalePercent:301},{states:{speaking:{texture:'listen',colorMode:'author'}}},{background:{color:'#FFFFFF',texture:'paint'}}]) await assert.rejects(packTheme({...m,theme:{...m.theme,face}},blobs));
});
const base = () => { const m = JSON.parse(readFileSync(new URL('../../themes/ember/theme.json', import.meta.url))); m.assets=[]; m.theme.overrides=[]; m.theme.background={asset:null,opacity:0}; delete m.theme.previewAsset; delete m.theme.storeAppIcon; return m; };
test('API2 colour is explicit and refuses too-dark or mis-versioned data', async () => {
  const m=base(); m.themeApi=2; m.theme.eye={color:'#F0E8D8'};
  assert.equal((await packTheme(m,[])).descriptor.themeApi,2);
  await assert.rejects(packTheme({...m,theme:{...m.theme,eye:{color:'#101010'}}},[]));
  await assert.rejects(packTheme({...m,themeApi:1},[]));
});
test('API4 menu geometry packs without changing its data or descriptor API', async () => {
  const m=base(); m.themeApi=4;
  m.theme.menuLayout={scrollMode:'continuous',buttonSize:36,buttonOffset:{x:0,y:0},iconSize:44,iconOffset:{x:0,y:12},labelSize:14,labelWidth:90,labelOffset:{x:0,y:-28}};
  const p=await packTheme(m,[]);
  assert.deepEqual(p.manifest.theme.menuLayout,m.theme.menuLayout);
  assert.equal(p.descriptor.themeApi,4);
  for (const bad of [{...m.theme.menuLayout,buttonSize:91},{...m.theme.menuLayout,code:'x'}]) await assert.rejects(packTheme({...m,theme:{...m.theme,menuLayout:bad}},[]));
});
