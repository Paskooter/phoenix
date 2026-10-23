// SPDX-License-Identifier: BSD-3-Clause
// Host-only author validation for additive theme APIs. No robot runtime code.
import base from './themeFormat.cjs';
import format from './format.cjs';
const own=(o,k)=>Object.hasOwn(o,k);
const extraRoles=['eye','eye-asset','eye-closed','eye-state','face-background'];
function reject(code='theme_extension_invalid') { throw Object.assign(new Error(code),{code,status:400}); }
function object(value, allowed, required=allowed) {
  if(!value || Object.getPrototypeOf(value)!==Object.prototype || Object.keys(value).some(k=>!allowed.includes(k)) || required.some(k=>!own(value,k))) reject();
}
function bounded(v,min,max,integer=false) { if(typeof v!=='number'||!Number.isFinite(v)||v<min||v>max||integer&&!Number.isSafeInteger(v)) reject(); }
function assetId(id) { if(typeof id!=='string'||! /^[a-z][a-z0-9-]{0,39}$/.test(id)) reject(); }
function color(v) { if(typeof v!=='string'||!/^#[a-fA-F0-9]{6}$/.test(v)) reject(); }
export function validateMenuLayout(v) {
  object(v,['scrollMode','buttonSize','buttonOffset','iconSize','iconOffset','labelSize','labelWidth','labelOffset']);
  if(!['paged','continuous'].includes(v.scrollMode)) reject('theme_menu_geometry_invalid');
  for(const [key,min,max] of [['buttonSize',9,90],['iconSize',0,100],['labelSize',5,30],['labelWidth',50,100]]) bounded(v[key],min,max);
  for(const key of ['buttonOffset','iconOffset','labelOffset']) { object(v[key],['x','y']); bounded(v[key].x,-50,50); bounded(v[key].y,-50,50); }
}
/** Validate extensions, then the unchanged API1 projection. */
export function validateManifest(m) {
  if(m.themeApi===1) return base.validateManifest(m);
  if(![2,3,4].includes(m.themeApi)) reject('invalid_identity_or_runtime');
  const copy=structuredClone(m), t=copy.theme, uses=[];
  object(t,['layout','palette','fonts','background','previewAsset','storeAppIcon','overrides','menuLayout','eye','eyeAsset','face'],['layout','palette','fonts','background','overrides']);
  const geometry=own(t,'menuLayout') || Array.isArray(t.overrides)&&t.overrides.some(o=>o&&own(o,'menuLayout'));
  const requiredApi=geometry||own(t,'face')?4:own(t,'eyeAsset')?3:own(t,'eye')?2:1;
  if(m.themeApi!==requiredApi) reject('invalid_identity_or_runtime');
  function ref(id,role) { assetId(id); uses.push({id,role}); }
  function replacement(v,role) { object(v,['texture','alpha']); if(v.alpha!=='replace')reject(); ref(v.texture,role); }
  if(own(t,'eye')) {
    if(own(t,'eyeAsset')||own(t,'face'))reject();
    object(t.eye,['color','texture'],['color']); color(t.eye.color);
    if((base.contrast(t.eye.color,'#000000')-1)*0.05<0.15)reject('theme_eye_too_dark');
    if(own(t.eye,'texture'))ref(t.eye.texture,'eye');
    delete t.eye;
  }
  if(own(t,'eyeAsset')) { replacement(t.eyeAsset,'eye-asset'); delete t.eyeAsset; }
  if(own(t,'face')) {
    const f=t.face; object(f,['closed','states','scalePercent','background'],[]);
    if(!Object.keys(f).length)reject();
    if(own(f,'closed'))replacement(f.closed,'eye-closed');
    if(own(f,'states')) {
      object(f.states,['listening']); object(f.states.listening,['texture','colorMode']);
      if(f.states.listening.colorMode!=='author')reject(); ref(f.states.listening.texture,'eye-state');
    }
    if(own(f,'scalePercent'))bounded(f.scalePercent,50,300,true);
    if(own(f,'background')) {
      object(f.background,['color','texture'],[]); if(Object.keys(f.background).length!==1)reject();
      if(own(f.background,'color'))color(f.background.color); else ref(f.background.texture,'face-background');
    }
    delete t.face;
  }
  if(own(t,'menuLayout')) { validateMenuLayout(t.menuLayout); delete t.menuLayout; }
  if(Array.isArray(t.overrides)) for(const o of t.overrides) if(o && own(o,'menuLayout')) { validateMenuLayout(o.menuLayout); delete o.menuLayout; }
  if(!Array.isArray(copy.assets)||copy.assets.length>base.LIMITS.assets)reject('theme_assets_invalid');
  let pixels=0, previous='';
  for(const a of copy.assets) {
    object(a,['id','role','mediaType','sha256','bytes','width','height']); assetId(a.id);
    if(a.id<=previous)reject('theme_asset_order_invalid'); previous=a.id;
    if(extraRoles.includes(a.role)) {
      if(!uses.some(u=>u.id===a.id&&u.role===a.role))reject('theme_asset_unused');
      if(a.mediaType!=='image/png'||! /^[a-f0-9]{64}$/.test(a.sha256))reject();
      const bg=a.role==='face-background';
      bounded(a.width,bg?1:256,bg?1280:256,true); bounded(a.height,bg?1:256,bg?720:256,true);
      bounded(a.bytes,1,bg?1048576:262144,true);
    }
    pixels+=a.width*a.height;
  }
  if(pixels>base.LIMITS.totalPixels)reject('theme_pixels_exceeded');
  if(uses.some(u=>!copy.assets.some(a=>a.id===u.id&&a.role===u.role)))reject('theme_asset_missing');
  if(new Set(uses.map(u=>u.id)).size!==uses.length)reject('theme_extension_invalid');
  copy.assets=copy.assets.filter(a=>!extraRoles.includes(a.role));
  copy.themeApi=1; base.validateManifest(copy);
  const bytes=Buffer.from(format.canonical(m));
  if(bytes.length>base.LIMITS.manifestBytes) reject('theme_manifest_too_large');
  return {manifest:JSON.parse(bytes),bytes};
}
/** All filters have already been decoded by the PNG normalizer. */
export function validatePixels(asset, decoded, channels) {
  if(!extraRoles.includes(asset.role)||asset.role==='face-background')return;
  if(asset.role!=='eye'&&channels!==4)reject('theme_eye_asset_pixels_invalid');
  let strong=0;
  for(let y=0;y<asset.height;y++)for(let x=0;x<asset.width;x++) {
    const at=(y*asset.width+x)*channels, [r,g,b]=decoded.subarray(at,at+3), a=channels===4?decoded[at+3]:255;
    if(asset.role==='eye') { if(r<160||g<160||b<160||a!==255)reject('theme_eye_pixels_invalid'); continue; }
    if((x<4||y<4||x>=asset.width-4||y>=asset.height-4)&&a!==0)reject('theme_eye_asset_pixels_invalid');
    if(asset.role==='eye-asset'&&(r!==g||g!==b||a>0&&r<224))reject('theme_eye_asset_pixels_invalid');
    if(asset.role==='eye-closed'&&a>0&&(r!==g||g!==b||r<224))reject('theme_eye_asset_pixels_invalid');
    if(a>=192)strong++;
  }
  if(asset.role!=='eye') { const coverage=strong/(asset.width*asset.height); if(coverage<(asset.role==='eye-closed'?0.01:0.10)||coverage>0.80)reject('theme_eye_asset_pixels_invalid'); }
}
